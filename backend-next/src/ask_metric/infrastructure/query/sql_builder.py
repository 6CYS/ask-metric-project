from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum, auto
from typing import TYPE_CHECKING

from sqlglot import exp, parse_one
from sqlglot.expressions import Select

from ask_metric.domain.query_execution import (
    QueryExecutionPlan,
    QueryPlanError,
    QueryTemplateId,
)
from ask_metric.infrastructure.query.sql_safety import validate_readonly_sql

if TYPE_CHECKING:
    from ask_metric.core.config import Settings

# 事实表标识符与批次排序仅允许来自白名单配置。
_DEFAULT_VARIABLES = {
    "fact_table": "ads_lake.adm_rmt_pub_gnrl_drv_indcr_tab",
    "fact_metric_code_field": "indcr_no",
    "fact_org_code_field": "org_no",
    "fact_data_date_field": "data_dt",
    "fact_value_field": "indcvl",
    "fact_increment_field": "indcvl_incrrng",
    "batch_order": "f.etl_date DESC, f.btch_seq_no DESC",
}

# SQL 文本中的 :named 绑定占位符；负向后行排除 :: 强制类型转换写法。
_NAMED_PARAM_PATTERN = re.compile(r"(?<!:):([A-Za-z_][A-Za-z0-9_]*)")
# SQL 实参反推校验的可接受派生参数：不由 planner 直接提供，但可由已绑定参数确定性派生。
# periods_json 由 MySQL 适配器从 period_starts/period_ends 派生（见 mysql._prepare_parameters）。
_DERIVED_PARAMETERS = {"periods_json": {"period_starts", "period_ends"}}


class _TimeKind(Enum):
    """场景日期谓词种类；具体 SQL 片段只在 _date_predicate 定义一次。"""

    NONE = auto()  # 无日期条件（取最新）
    AS_OF = auto()  # 截止 :end_date
    IN_RANGE = auto()  # :start_date 至 :end_date
    EXACT = auto()  # 精确 :stat_date
    AT_DATES = auto()  # 多时点 :stat_dates
    PERIOD_DATES = auto()  # 基期/本期两日期（inceptor 期间对比内部使用）


def _date_predicate(kind: _TimeKind, column: str) -> str | None:
    """全部场景共用的日期谓词：列引用由方言/场景上下文提供，业务值保持 :named 绑定。"""
    if kind is _TimeKind.NONE:
        return None
    if kind is _TimeKind.AS_OF:
        return f"{column} <= CAST(:end_date AS DATE)"
    if kind is _TimeKind.IN_RANGE:
        return f"{column} BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)"
    if kind is _TimeKind.EXACT:
        return f"{column} = CAST(:stat_date AS DATE)"
    if kind is _TimeKind.AT_DATES:
        return f"{column} IN :stat_dates"
    if kind is _TimeKind.PERIOD_DATES:
        return f"{column} IN (CAST(:current_date AS DATE), CAST(:base_date AS DATE))"
    raise QueryPlanError(f"Unknown time predicate kind {kind}")


class _Shape(Enum):
    """场景结构形态：方言无关的 SQL 骨架分类，构建实现由方言适配器提供。"""

    WINDOW_VALUE = auto()  # 每指标+机构取区间内最新一行
    FLAT_VALUE = auto()  # 单表取值（精确日/多时点/区间趋势）
    COMPARE = auto()  # 机构对比（锁定最新数据日后横向取值）
    RANKING = auto()  # 机构排名 TopN
    AT_PERIODS = auto()  # 多期间取值
    PERIOD_COMPARE = auto()  # 基期/本期对比
    AVAILABILITY = auto()  # 先按实体和日期粒度去重，再选全部/最早/最新覆盖
    AVAILABLE_METRICS = auto()  # 按原始记录发现指标，不要求有效数值
    AVAILABLE_DATES = auto()  # 按原始记录统计日期及共同覆盖


@dataclass(frozen=True)
class _Scenario:
    """方言无关的场景定义；每个场景只登记一次。

    required 是 planner 必须提供的绑定参数（方言的契约差异由适配器 required_params
    调整）；direction 仅 RANKING 形态使用。
    """

    shape: _Shape
    time: _TimeKind
    required: frozenset[str]
    direction: str = "ASC"


_BASE_PARAMS = frozenset({"metric_codes", "org_codes", "filter_orgs", "limit"})


def _params(*extra: str) -> frozenset[str]:
    return _BASE_PARAMS | frozenset(extra)


_T = QueryTemplateId
# 场景唯一注册表：场景 →（形态、日期谓词、必需参数）。新增场景只在这里加一行；
# 必需参数缺失即中止，不拼出不完整 SQL。
_SCENARIOS: dict[QueryTemplateId, _Scenario] = {
    _T.DATA_AVAILABLE_METRICS: _Scenario(
        _Shape.AVAILABLE_METRICS, _TimeKind.NONE,
        frozenset({"metric_codes", "org_codes", "start_date", "end_date", "offset", "page_end"}),
    ),
    _T.DATA_AVAILABILITY: _Scenario(
        _Shape.AVAILABLE_DATES, _TimeKind.NONE,
        frozenset({
            "metric_codes", "org_codes", "filter_metrics", "start_date", "end_date",
            "require_all", "combination_count", "offset", "page_end",
        }),
    ),
    _T.METRIC_AVAILABILITY: _Scenario(
        _Shape.AVAILABILITY, _TimeKind.NONE,
        _params("filter_dates", "start_date", "end_date", "grain", "selection"),
    ),
    _T.METRIC_VALUE_LATEST: _Scenario(_Shape.WINDOW_VALUE, _TimeKind.NONE, _params()),
    _T.METRIC_VALUE_AS_OF: _Scenario(_Shape.WINDOW_VALUE, _TimeKind.AS_OF, _params("end_date")),
    _T.METRIC_VALUE_IN_RANGE: _Scenario(
        _Shape.WINDOW_VALUE, _TimeKind.IN_RANGE, _params("start_date", "end_date")
    ),
    _T.METRIC_VALUE_AT_DATES: _Scenario(
        _Shape.FLAT_VALUE, _TimeKind.AT_DATES, _params("stat_dates")
    ),
    _T.METRIC_VALUE_AT_PERIODS: _Scenario(
        _Shape.AT_PERIODS, _TimeKind.NONE, _params("period_starts", "period_ends")
    ),
    _T.METRIC_VALUE_EXACT: _Scenario(_Shape.FLAT_VALUE, _TimeKind.EXACT, _params("stat_date")),
    _T.METRIC_VALUE_COMPARE_LATEST: _Scenario(_Shape.COMPARE, _TimeKind.NONE, _params()),
    _T.METRIC_VALUE_COMPARE_AS_OF: _Scenario(_Shape.COMPARE, _TimeKind.AS_OF, _params("end_date")),
    _T.METRIC_TREND: _Scenario(
        _Shape.FLAT_VALUE, _TimeKind.IN_RANGE, _params("start_date", "end_date")
    ),
    _T.METRIC_PERIOD_COMPARE: _Scenario(
        _Shape.PERIOD_COMPARE, _TimeKind.NONE, _params("current_date", "base_date")
    ),
    _T.METRIC_RANKING_LATEST_ASC: _Scenario(_Shape.RANKING, _TimeKind.NONE, _params(), "ASC"),
    _T.METRIC_RANKING_LATEST_DESC: _Scenario(_Shape.RANKING, _TimeKind.NONE, _params(), "DESC"),
    _T.METRIC_RANKING_EXACT_ASC: _Scenario(
        _Shape.RANKING, _TimeKind.EXACT, _params("stat_date"), "ASC"
    ),
    _T.METRIC_RANKING_EXACT_DESC: _Scenario(
        _Shape.RANKING, _TimeKind.EXACT, _params("stat_date"), "DESC"
    ),
    _T.METRIC_RANKING_IN_RANGE_ASC: _Scenario(
        _Shape.RANKING, _TimeKind.IN_RANGE, _params("start_date", "end_date"), "ASC"
    ),
    _T.METRIC_RANKING_IN_RANGE_DESC: _Scenario(
        _Shape.RANKING, _TimeKind.IN_RANGE, _params("start_date", "end_date"), "DESC"
    ),
    _T.METRIC_RANKING_AS_OF_ASC: _Scenario(
        _Shape.RANKING, _TimeKind.AS_OF, _params("end_date"), "ASC"
    ),
    _T.METRIC_RANKING_AS_OF_DESC: _Scenario(
        _Shape.RANKING, _TimeKind.AS_OF, _params("end_date"), "DESC"
    ),
}


class _DialectAdapter:
    """方言描述对象：mysql/inceptor 的全部差异收拢在各自子类里。

    子类持有：sqlglot 解析方言、取值类输出列清单、日期列引用、事实层结构
    （mysql 直接读 metric_values 视图；inceptor 组 normalized/facts 清洗去重 CTE）、
    多期间展开策略（mysql JSON_TABLE / inceptor 12 行 UNION）以及各形态构建方法。
    新增方言 = 新写一个子类并登记进 _DIALECTS，场景注册表不需要改动。
    """

    name: str = ""
    read_dialect: str = ""

    def __init__(self, variables: dict[str, str]) -> None:
        self.variables = variables

    def required_params(self, template: QueryTemplateId, scenario: _Scenario) -> frozenset[str]:
        # 默认与场景注册表一致；方言的 planner 契约差异由子类覆盖。
        return scenario.required

    def build(self, template: QueryTemplateId, scenario: _Scenario) -> Select:
        handlers: dict[_Shape, Callable[[_Scenario], Select]] = {
            _Shape.WINDOW_VALUE: self.window_value,
            _Shape.FLAT_VALUE: self.flat_value,
            _Shape.COMPARE: self.compare,
            _Shape.RANKING: self.ranking,
            _Shape.AT_PERIODS: self.at_periods,
            _Shape.PERIOD_COMPARE: self.period_compare,
            _Shape.AVAILABILITY: self.availability,
            _Shape.AVAILABLE_METRICS: self.available_metrics,
            _Shape.AVAILABLE_DATES: self.available_dates,
        }
        return handlers[scenario.shape](scenario)

    # ---------- 形态构建（默认未实现） ----------

    def _unsupported(self, scenario: _Scenario) -> QueryPlanError:
        # 报错文案指明是方言适配器缺形态实现，与场景注册表缺条目区分。
        return QueryPlanError(
            f"Dialect {self.name} does not implement {scenario.shape.name} scenarios in SqlBuilder"
        )

    def window_value(self, scenario: _Scenario) -> Select:
        raise self._unsupported(scenario)

    def flat_value(self, scenario: _Scenario) -> Select:
        raise self._unsupported(scenario)

    def compare(self, scenario: _Scenario) -> Select:
        raise self._unsupported(scenario)

    def ranking(self, scenario: _Scenario) -> Select:
        raise self._unsupported(scenario)

    def at_periods(self, scenario: _Scenario) -> Select:
        raise self._unsupported(scenario)

    def period_compare(self, scenario: _Scenario) -> Select:
        raise self._unsupported(scenario)

    def availability(self, scenario: _Scenario) -> Select:
        raise self._unsupported(scenario)

    def _record_source(self) -> tuple[str, str, str, str]:
        """原始记录覆盖仅引用机构、指标和业务日期，不复用数值清洗/批次去重。"""
        raise NotImplementedError

    def _available_records(self, *, metrics_only: bool) -> Select:
        table, metric, org, day = self._record_source()
        metric_filter = f"{metric} IN :metric_codes"
        if not metrics_only:
            metric_filter = f"(:filter_metrics = FALSE OR {metric_filter})"
        columns = f"{metric} AS metric_code"
        if not metrics_only:
            columns += f", {org} AS org_code, {day} AS stat_date"
        return self._parse(
            f"SELECT DISTINCT {columns} FROM {table} WHERE {org} IN :org_codes "
            f"AND {metric_filter} AND {day} IS NOT NULL "
            f"AND (:start_date IS NULL OR {day} >= CAST(:start_date AS DATE)) "
            f"AND (:end_date IS NULL OR {day} <= CAST(:end_date AS DATE))"
        )

    def available_metrics(self, scenario: _Scenario) -> Select:
        # 统计与分页在同一次查询中返回；空页仍保留总数。
        return self._parse(
            "SELECT s.metric_count, r.metric_code FROM stats s LEFT JOIN ranked r "
            "ON r.rn > :offset AND r.rn <= :page_end ORDER BY r.metric_code"
        ).with_("available", as_=self._available_records(metrics_only=True)).with_(
            "stats", as_=self._parse("SELECT COUNT(*) AS metric_count FROM available")
        ).with_("ranked", as_=self._parse(
            "SELECT metric_code, ROW_NUMBER() OVER (ORDER BY metric_code) AS rn FROM available"
        ))

    def available_dates(self, scenario: _Scenario) -> Select:
        dates = self._parse(
            "SELECT stat_date FROM pairs GROUP BY stat_date "
            "HAVING :require_all = FALSE OR COUNT(*) = :combination_count"
        )
        return self._parse(
            "SELECT CASE WHEN :require_all = TRUE THEN 'common' ELSE 'any' END AS scope, "
            "'' AS org_code, '' AS metric_code, s.date_count, s.earliest, s.latest, r.stat_date "
            "FROM stats s LEFT JOIN ranked r ON r.rn > :offset AND r.rn <= :page_end "
            "ORDER BY r.stat_date DESC"
        ).with_("pairs", as_=self._available_records(metrics_only=False)).with_(
            "dates", as_=dates
        ).with_("stats", as_=self._parse(
            "SELECT COUNT(*) AS date_count, MIN(stat_date) AS earliest, "
            "MAX(stat_date) AS latest FROM dates"
        )).with_("ranked", as_=self._parse(
            "SELECT stat_date, ROW_NUMBER() OVER (ORDER BY stat_date DESC) AS rn FROM dates"
        ))

    def _availability_result(self, periods: Select) -> Select:
        # 每个指标/机构独立计算边界，不能把多实体的日期隐式取交集。
        bounds = self._parse(
            "SELECT *, MIN(available_period) OVER (PARTITION BY metric_code, org_code) "
            "AS earliest_period, MAX(available_period) OVER (PARTITION BY metric_code, org_code) "
            "AS latest_period FROM available_periods"
        )
        return self._parse(
            "SELECT metric_code, org_code, available_period, first_date, last_date "
            "FROM availability_bounds WHERE :selection = 'all' "
            "OR (:selection = 'earliest' AND available_period = earliest_period) "
            "OR (:selection = 'latest' AND available_period = latest_period) "
            "ORDER BY metric_code, org_code, available_period LIMIT :limit"
        ).with_("available_periods", as_=periods).with_("availability_bounds", as_=bounds)

    # ---------- 共用片段 ----------

    def _parse(self, sql: str) -> Select:
        """解析内部固定 SQL 片段（开发者常量 + 白名单标识符，不含用户输入）。"""
        parsed = parse_one(sql, read=self.read_dialect)
        if not isinstance(parsed, Select):
            raise QueryPlanError("Internal SQL fragment is not a SELECT")
        return parsed

    def _org_filter(self, prefix: str) -> str:
        # 惯用写法：无机构条件时 :filter_orgs=FALSE 直接放行，避免空列表 IN 条件。
        return f"(:filter_orgs = FALSE OR {prefix}org_code IN :org_codes)"


class _MySqlAdapter(_DialectAdapter):
    """mysql 方言：直接读 metric_values 视图，左连 metric_terms 取正式名称与单位。"""

    name = "mysql"
    read_dialect = "mysql"

    def _record_source(self) -> tuple[str, str, str, str]:
        return "metric_values", "metric_code", "org_code", "stat_date"

    def availability(self, scenario: _Scenario) -> Select:
        period = (
            "CASE WHEN :grain = 'month' THEN DATE_FORMAT(stat_date, '%Y-%m') "
            "ELSE DATE_FORMAT(stat_date, '%Y-%m-%d') END"
        )
        periods = self._parse(
            f"SELECT metric_code, org_code, {period} AS available_period, "
            "MIN(stat_date) AS first_date, MAX(stat_date) AS last_date FROM metric_values "
            "WHERE metric_code IN :metric_codes AND " + self._org_filter("") +
            " AND metric_value IS NOT NULL AND (:filter_dates = FALSE OR "
            "stat_date BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)) "
            f"GROUP BY metric_code, org_code, {period}"
        )
        return self._availability_result(periods)

    def _value_columns(self) -> list[str]:
        # mysql 取值类查询的统一输出列：名称来自 metric_terms，缺失时回退事实表名称。
        return [
            "mv.metric_code",
            "COALESCE(mt.metric_name, mv.metric_name) AS metric_name",
            "mt.unit",
            "mv.org_code",
            "mv.org_name",
            "mv.metric_value",
            "mv.stat_date",
        ]

    def _value_from(self) -> Select:
        # 事实表左连目录表取正式名称与单位；目录缺失不丢行。
        return (
            exp.select(*self._value_columns(), dialect=self.read_dialect)
            .from_("metric_values AS mv", dialect=self.read_dialect)
            .join(
                "metric_terms AS mt",
                on="mt.metric_code = mv.metric_code",
                join_type="LEFT",
                dialect=self.read_dialect,
            )
        )

    def _flat_value(self, scenario: _Scenario, order_by: str) -> Select:
        # 单表取值骨架：日期谓词、排序与输出列由场景/方言参数化。
        predicate = _date_predicate(scenario.time, "mv.stat_date")
        if predicate is None:  # 防御：FLAT 场景注册时必带日期谓词
            raise QueryPlanError(f"Scenario {scenario.shape.name} requires a date predicate")
        return (
            self._value_from()
            .where("mv.metric_code IN :metric_codes", dialect=self.read_dialect)
            .where(self._org_filter("mv."), dialect=self.read_dialect)
            .where(predicate, dialect=self.read_dialect)
            .order_by(order_by, dialect=self.read_dialect)
            .limit(":limit")
        )

    def flat_value(self, scenario: _Scenario) -> Select:
        # 单表取值：精确日按指标+机构排序；多时点/区间趋势先按日期排序。
        if scenario.time is _TimeKind.EXACT:
            order_by = "mv.metric_code, mv.org_name"
        else:
            order_by = "mv.stat_date, mv.metric_code, mv.org_name"
        return self._flat_value(scenario, order_by=order_by)

    def window_value(self, scenario: _Scenario) -> Select:
        # 每指标+机构取区间内最新一行：内层 ROW_NUMBER 标记，外层取 row_number=1。
        inner = exp.select(
            "metric_code",
            "metric_name",
            "org_code",
            "org_name",
            "metric_value",
            "stat_date",
            "ROW_NUMBER() OVER ("
            "PARTITION BY metric_code, org_code ORDER BY stat_date DESC"
            ") AS row_number",
            dialect=self.read_dialect,
        ).from_("metric_values", dialect=self.read_dialect)
        inner = inner.where("metric_code IN :metric_codes", dialect=self.read_dialect).where(
            self._org_filter(""), dialect=self.read_dialect
        )
        predicate = _date_predicate(scenario.time, "stat_date")
        if predicate is not None:
            inner = inner.where(predicate, dialect=self.read_dialect)
        return (
            exp.select(
                "ranked.metric_code",
                "COALESCE(mt.metric_name, ranked.metric_name) AS metric_name",
                "mt.unit",
                "ranked.org_code",
                "ranked.org_name",
                "ranked.metric_value",
                "ranked.stat_date",
                dialect=self.read_dialect,
            )
            .from_(inner.subquery("ranked"))
            .join(
                "metric_terms AS mt",
                on="mt.metric_code = ranked.metric_code",
                join_type="LEFT",
                dialect=self.read_dialect,
            )
            .where("ranked.row_number = 1", dialect=self.read_dialect)
            .order_by("ranked.metric_code, ranked.org_name", dialect=self.read_dialect)
            .limit(":limit")
        )

    def _target_dates(self, predicate: str | None) -> Select:
        # 每指标的命中日期：机构对比/排名先定位截止日内的最新数据日。
        target = (
            exp.select("metric_code", "MAX(stat_date) AS stat_date", dialect=self.read_dialect)
            .from_("metric_values", dialect=self.read_dialect)
            .where("metric_code IN :metric_codes", dialect=self.read_dialect)
            .where(self._org_filter(""), dialect=self.read_dialect)
        )
        if predicate is not None:
            target = target.where(predicate, dialect=self.read_dialect)
        return target.group_by("metric_code", dialect=self.read_dialect)

    def compare(self, scenario: _Scenario) -> Select:
        # 机构对比：先按指标锁定最新数据日，再取该日全部机构行横向对比。
        return (
            self._value_from()
            .with_(
                "target_dates",
                as_=self._target_dates(_date_predicate(scenario.time, "stat_date")),
            )
            .join(
                "target_dates AS td",
                on="td.metric_code = mv.metric_code AND td.stat_date = mv.stat_date",
                dialect=self.read_dialect,
            )
            .where(self._org_filter("mv."), dialect=self.read_dialect)
            .order_by("mv.metric_code, mv.org_name", dialect=self.read_dialect)
            .limit(":limit")
        )

    def ranking(self, scenario: _Scenario) -> Select:
        # 先在授权/日期范围内排除缺数，再按指标选择同一业务日；普通取值路径不变。
        candidates = self._value_from().select(
            "COUNT(*) OVER (PARTITION BY mv.metric_code, mv.org_code, mv.stat_date) "
            "AS fact_count", dialect=self.read_dialect,
        ).where("mv.metric_code IN :metric_codes", dialect=self.read_dialect).where(
            self._org_filter("mv."), dialect=self.read_dialect,
        ).where("mv.metric_value IS NOT NULL", dialect=self.read_dialect)
        predicate = _date_predicate(scenario.time, "mv.stat_date")
        if predicate is not None:
            candidates = candidates.where(predicate, dialect=self.read_dialect)
        ranked_values = self._parse(
            "SELECT mv.*, ROW_NUMBER() OVER (PARTITION BY mv.metric_code "
            f"ORDER BY mv.metric_value {scenario.direction}, mv.org_code) AS `rank`, "
            "COUNT(*) OVER (PARTITION BY mv.metric_code) AS rank_population, "
            "MAX(CASE WHEN mv.fact_count > 1 THEN 1 ELSE 0 END) "
            "OVER (PARTITION BY mv.metric_code) AS rank_data_conflict "
            "FROM candidate_values AS mv"
        )
        query = exp.select(
            "metric_code", "metric_name", "unit", "org_code", "org_name",
            "metric_value", "stat_date", "`rank`", "rank_population", "rank_data_conflict",
            dialect=self.read_dialect,
        ).with_("candidate_values", as_=candidates)
        if scenario.time is not _TimeKind.EXACT:
            ranked_values = ranked_values.join(
                "target_dates AS td",
                on="td.metric_code = mv.metric_code AND td.stat_date = mv.stat_date",
                dialect=self.read_dialect,
            )
            query = query.with_("target_dates", as_=self._parse(
                "SELECT metric_code, MAX(stat_date) AS stat_date FROM candidate_values "
                "GROUP BY metric_code"
            ))
        # 有值机构数量与冲突在 TopN 截断前统计；低名次重复也必须阻断整张榜单。
        return (
            query.with_("ranked_values", as_=ranked_values)
            .from_("ranked_values", dialect=self.read_dialect)
            .where("`rank` <= :limit", dialect=self.read_dialect)
            .order_by("metric_code, `rank`", dialect=self.read_dialect)
        )

    def at_periods(self, scenario: _Scenario) -> Select:
        # 多期间取值：JSON_TABLE 展开适配器生成的期间列表（业务值仍在绑定参数里），
        # 每期间+指标+机构取最新一行；不同期间可能命中同一行，外层 DISTINCT 去重。
        requested_periods = self._parse(
            "SELECT periods.period_start, periods.period_end FROM JSON_TABLE("
            ":periods_json, '$[*]' COLUMNS ("
            "period_start DATE PATH '$.start', period_end DATE PATH '$.end'"
            ")) AS periods"
        )
        ranked_values = (
            exp.select(
                "mv.metric_code",
                "mv.metric_name",
                "mv.org_code",
                "mv.org_name",
                "mv.metric_value",
                "mv.stat_date",
                "ROW_NUMBER() OVER ("
                "PARTITION BY periods.period_start, periods.period_end, "
                "mv.metric_code, mv.org_code ORDER BY mv.stat_date DESC"
                ") AS row_number",
                dialect=self.read_dialect,
            )
            .from_("requested_periods AS periods", dialect=self.read_dialect)
            .join(
                "metric_values AS mv",
                on="mv.stat_date >= periods.period_start AND mv.stat_date <= periods.period_end",
                dialect=self.read_dialect,
            )
            .where("mv.metric_code IN :metric_codes", dialect=self.read_dialect)
            .where(self._org_filter("mv."), dialect=self.read_dialect)
        )
        selected_values = (
            exp.select(
                "metric_code", "metric_name", "org_code", "org_name", "metric_value", "stat_date",
                dialect=self.read_dialect,
            )
            .distinct()
            .from_("ranked_values", dialect=self.read_dialect)
            .where("row_number = 1", dialect=self.read_dialect)
        )
        return (
            exp.select(
                "selected.metric_code",
                "COALESCE(mt.metric_name, selected.metric_name) AS metric_name",
                "mt.unit",
                "selected.org_code",
                "selected.org_name",
                "selected.metric_value",
                "selected.stat_date",
                dialect=self.read_dialect,
            )
            .with_("requested_periods", as_=requested_periods)
            .with_("ranked_values", as_=ranked_values)
            .with_("selected_values", as_=selected_values)
            .from_("selected_values AS selected", dialect=self.read_dialect)
            .join(
                "metric_terms AS mt",
                on="mt.metric_code = selected.metric_code",
                join_type="LEFT",
                dialect=self.read_dialect,
            )
            .order_by("selected.stat_date, selected.metric_code, selected.org_name",
                      dialect=self.read_dialect)
            .limit(":limit")
        )

    def period_compare(self, scenario: _Scenario) -> Select:
        # 基期/本期对比：先构造两个期间日期，再左连事实行；无数据的期间不输出。
        requested_periods = exp.select(
            "CAST(:current_date AS DATE) AS stat_date", "'current' AS period",
            dialect=self.read_dialect,
        ).union(
            exp.select(
                "CAST(:base_date AS DATE) AS stat_date", "'base' AS period",
                dialect=self.read_dialect,
            ),
            distinct=False,
        )
        return (
            exp.select(
                *self._value_columns(),
                "periods.period",
                dialect=self.read_dialect,
            )
            .with_("requested_periods", as_=requested_periods)
            .from_("requested_periods AS periods", dialect=self.read_dialect)
            .join(
                "metric_values AS mv",
                on="mv.stat_date = periods.stat_date "
                "AND mv.metric_code IN :metric_codes "
                f"AND {self._org_filter('mv.')}",
                join_type="LEFT",
                dialect=self.read_dialect,
            )
            .join(
                "metric_terms AS mt",
                on="mt.metric_code = mv.metric_code",
                join_type="LEFT",
                dialect=self.read_dialect,
            )
            .where("mv.metric_code IS NOT NULL", dialect=self.read_dialect)
            .order_by("mv.metric_code, mv.org_name, periods.period", dialect=self.read_dialect)
            .limit(":limit")
        )


class _InceptorAdapter(_DialectAdapter):
    """inceptor 方言：sqlglot 没有 inceptor 方言；其兼容 Hive 语法（RLIKE、
    反引号别名均可用 hive 解析）。

    事实层组 normalized（字符串数值清洗 + 批次去重）/ facts（有效最新批次）两层
    CTE；取值类输出列只含编码与数值，名称由 CatalogResultEnricher 在应用层补齐。
    """

    name = "inceptor"
    read_dialect = "hive"

    def _record_source(self) -> tuple[str, str, str, str]:
        return (
            f"{self.variables['fact_table']} f",
            f"f.{self.variables['fact_metric_code_field']}",
            f"f.{self.variables['fact_org_code_field']}",
            self._date_field,
        )

    def availability(self, scenario: _Scenario) -> Select:
        period = (
            "CASE WHEN :grain = 'month' THEN SUBSTR(CAST(stat_date AS STRING), 1, 7) "
            "ELSE SUBSTR(CAST(stat_date AS STRING), 1, 10) END"
        )
        periods = self._parse(
            f"SELECT metric_code, org_code, {period} AS available_period, "
            "MIN(stat_date) AS first_date, MAX(stat_date) AS last_date FROM facts "
            f"GROUP BY metric_code, org_code, {period}"
        )
        predicate = (
            f"(:filter_dates = FALSE OR {self._date_field} BETWEEN "
            "CAST(:start_date AS DATE) AND CAST(:end_date AS DATE))"
        )
        # normalized/facts 必须排在依赖它们的覆盖 CTE 前。
        final = self._availability_result(periods)
        final.args["with_"].set("expressions", [
            exp.CTE(this=self._normalized(predicate),
                    alias=exp.TableAlias(this=exp.to_identifier("normalized"))),
            exp.CTE(this=self._facts(), alias=exp.TableAlias(this=exp.to_identifier("facts"))),
            *final.args["with_"].expressions,
        ])
        return final

    # inceptor 取值类查询的统一输出列。
    _VALUE_COLUMNS = (
        "metric_code",
        "org_code",
        "metric_value",
        "stat_date",
        "metric_increment",
    )

    def required_params(self, template: QueryTemplateId, scenario: _Scenario) -> frozenset[str]:
        # inceptor 多期间不用 JSON_TABLE，planner 改传 start/end + 12 组期间参数。
        if template is QueryTemplateId.METRIC_VALUE_AT_PERIODS:
            return _BASE_PARAMS | frozenset({"start_date", "end_date", "period_count"})
        return scenario.required

    @property
    def _date_field(self) -> str:
        return f"f.{self.variables['fact_data_date_field']}"

    def _normalized(self, predicate: str | None, *, detect_conflicts: bool = False) -> Select:
        # 数据湖事实表清洗层：字符串数值白名单清洗（剔除 -999.999 缺失哨兵），
        # 并按批次优先级 ROW_NUMBER 去重；标识符全部来自白名单标识符配置。
        v = self.variables
        metric = f"f.{v['fact_metric_code_field']}"
        org = f"f.{v['fact_org_code_field']}"
        data_date = f"f.{v['fact_data_date_field']}"
        value = f"f.{v['fact_value_field']}"
        increment = f"f.{v['fact_increment_field']}"
        value_case = (
            f"CASE WHEN TRIM({value}) RLIKE '^[+-]?[0-9]+([.][0-9]+)?$' "
            f"AND CAST(TRIM({value}) AS DECIMAL(38, 10)) <> CAST(-999.999 AS DECIMAL(38, 10)) "
            f"THEN CAST(TRIM({value}) AS DECIMAL(38, 10)) ELSE NULL END"
        )
        increment_case = (
            f"CASE WHEN {increment} IS NOT NULL "
            f"AND CAST({increment} AS DECIMAL(38, 10)) <> CAST(-999.999 AS DECIMAL(38, 10)) "
            f"THEN CAST({increment} AS DECIMAL(38, 10)) ELSE NULL END"
        )
        version_function = "RANK" if detect_conflicts else "ROW_NUMBER"
        sql = (
            f"SELECT {metric} AS metric_code, {org} AS org_code, {data_date} AS stat_date, "
            f"{value_case} AS metric_value, {increment_case} AS metric_increment, "
            f"{version_function}() OVER (PARTITION BY {org}, {metric}, {data_date} "
            f"ORDER BY {v['batch_order']}) AS version_rank "
            f"FROM {v['fact_table']} AS f "
            f"WHERE {metric} IN :metric_codes "
            f"AND (:filter_orgs = FALSE OR {org} IN :org_codes)"
        )
        if predicate is not None:
            sql += f" AND {predicate}"
        return self._parse(sql)

    def _facts(self) -> Select:
        # 清洗后的事实集：只保留最新批次且数值有效的行。
        return self._parse(
            "SELECT metric_code, org_code, stat_date, metric_value, metric_increment "
            "FROM normalized WHERE version_rank = 1 AND metric_value IS NOT NULL"
        )

    def _query(self, predicate: str | None, final: Select) -> Select:
        # 公共骨架：normalized + facts 两层 CTE 挂到最终查询上。
        return final.with_("normalized", as_=self._normalized(predicate)).with_(
            "facts", as_=self._facts()
        )

    def flat_value(self, scenario: _Scenario) -> Select:
        # 单表取值：精确日按指标+机构排序；多时点/区间趋势先按日期排序。
        if scenario.time is _TimeKind.EXACT:
            order_by = "metric_code, org_code"
        else:
            order_by = "stat_date, metric_code, org_code"
        final = (
            exp.select(*self._VALUE_COLUMNS, dialect=self.read_dialect)
            .from_("facts", dialect=self.read_dialect)
            .order_by(order_by, dialect=self.read_dialect)
            .limit(":limit")
        )
        return self._query(_date_predicate(scenario.time, self._date_field), final)

    def window_value(self, scenario: _Scenario) -> Select:
        # 每指标+机构取最新数据日一行（date_rank=1）。
        selected = self._parse(
            "SELECT *, ROW_NUMBER() OVER ("
            "PARTITION BY metric_code, org_code ORDER BY stat_date DESC"
            ") AS date_rank FROM facts"
        )
        final = (
            exp.select(*self._VALUE_COLUMNS, dialect=self.read_dialect)
            .from_("selected", dialect=self.read_dialect)
            .where("date_rank = 1", dialect=self.read_dialect)
            .order_by("metric_code, org_code", dialect=self.read_dialect)
            .limit(":limit")
        )
        return self._query(
            _date_predicate(scenario.time, self._date_field), final
        ).with_("selected", as_=selected)

    def _target_dates(self) -> Select:
        return self._parse(
            "SELECT metric_code, MAX(stat_date) AS stat_date FROM facts GROUP BY metric_code"
        )

    def compare(self, scenario: _Scenario) -> Select:
        # 机构对比：先按指标锁定最新数据日，再取该日全部机构行横向对比。
        final = (
            exp.select(
                "f.metric_code", "f.org_code", "f.metric_value", "f.stat_date",
                "f.metric_increment",
                dialect=self.read_dialect,
            )
            .from_("facts AS f", dialect=self.read_dialect)
            .join(
                "target_dates AS t",
                on="t.metric_code = f.metric_code AND t.stat_date = f.stat_date",
                dialect=self.read_dialect,
            )
            .order_by("f.metric_code, f.org_code", dialect=self.read_dialect)
            .limit(":limit")
        )
        return self._query(
            _date_predicate(scenario.time, self._date_field), final
        ).with_("target_dates", as_=self._target_dates())

    def ranking(self, scenario: _Scenario) -> Select:
        # 机构排名：先定位各指标最新数据日（exact 时谓词已把 facts 收敛到目标日），
        # 再按指标分区排名；TopN 用 WHERE rank <= :limit。
        ranked = self._parse(
            "SELECT f.*, ROW_NUMBER() OVER ("
            f"PARTITION BY f.metric_code ORDER BY f.metric_value "
            f"{scenario.direction}, f.org_code"
            ") AS `rank`, COUNT(*) OVER (PARTITION BY f.metric_code) AS rank_population, "
            "MAX(CASE WHEN f.fact_count > 1 THEN 1 ELSE 0 END) "
            "OVER (PARTITION BY f.metric_code) AS rank_data_conflict "
            "FROM facts AS f "
            "JOIN target_dates AS t ON t.metric_code = f.metric_code "
            "AND t.stat_date = f.stat_date"
        )
        final = (
            exp.select(
                *self._VALUE_COLUMNS,
                "`rank`",
                "rank_population",
                "rank_data_conflict",
                dialect=self.read_dialect,
            )
            .from_("ranked", dialect=self.read_dialect)
            .where("`rank` <= :limit", dialect=self.read_dialect)
            .order_by("metric_code, `rank`", dialect=self.read_dialect)
        )
        # 最高有效批次仍有多条事实时标记整榜，不能用任意物理行决定名次。
        facts = self._parse(
            "SELECT metric_code, org_code, stat_date, MAX(metric_value) AS metric_value, "
            "MAX(metric_increment) AS metric_increment, COUNT(*) AS fact_count "
            "FROM normalized WHERE version_rank = 1 "
            "GROUP BY metric_code, org_code, stat_date HAVING MAX(metric_value) IS NOT NULL"
        )
        return (
            final.with_("normalized", as_=self._normalized(
                _date_predicate(scenario.time, self._date_field), detect_conflicts=True,
            )).with_("facts", as_=facts)
            .with_("target_dates", as_=self._target_dates())
            .with_("ranked", as_=ranked)
        )

    def at_periods(self, scenario: _Scenario) -> Select:
        # 多期间取值：Inceptor 部署的 JSON_TABLE 支持不一致，期间列表改为
        # 12 行 UNION ALL + :period_count 截断（planner 已生成 period_start_0..11）。
        union: Select | None = None
        for index in range(12):
            # UNION 的列名由首个分支决定，后续分支不重复写别名。
            columns = (
                (
                    f"{index} AS period_no",
                    f"CAST(:period_start_{index} AS DATE) AS period_start",
                    f"CAST(:period_end_{index} AS DATE) AS period_end",
                )
                if index == 0
                else (
                    f"{index}",
                    f"CAST(:period_start_{index} AS DATE)",
                    f"CAST(:period_end_{index} AS DATE)",
                )
            )
            row = exp.select(*columns, dialect=self.read_dialect).where(
                f":period_count > {index}", dialect=self.read_dialect
            )
            union = row if union is None else union.union(row, distinct=False)
        if union is None:  # pragma: no cover - range(12) 恒非空
            raise QueryPlanError("requested_periods cannot be empty")
        ranked = self._parse(
            "SELECT p.period_no, f.*, ROW_NUMBER() OVER ("
            "PARTITION BY p.period_no, f.metric_code, f.org_code ORDER BY f.stat_date DESC"
            ") AS period_rank FROM requested_periods AS p "
            "JOIN facts AS f ON f.stat_date BETWEEN p.period_start AND p.period_end"
        )
        final = (
            exp.select(*self._VALUE_COLUMNS, dialect=self.read_dialect)
            .from_("ranked", dialect=self.read_dialect)
            .where("period_rank = 1", dialect=self.read_dialect)
            .order_by("period_no, metric_code, org_code", dialect=self.read_dialect)
            .limit(":limit")
        )
        # CTE 按依赖排序：requested_periods 最先定义，ranked 依赖 facts 放最后。
        return (
            self._query(
                _date_predicate(_TimeKind.IN_RANGE, self._date_field),
                final.with_("requested_periods", as_=union, dialect=self.read_dialect),
            ).with_("ranked", as_=ranked)
        )

    def period_compare(self, scenario: _Scenario) -> Select:
        # 基期/本期对比：facts 收敛到两个期间日期后按日期标注 current/base。
        final = (
            exp.select(
                *self._VALUE_COLUMNS,
                "CASE WHEN stat_date = CAST(:current_date AS DATE) "
                "THEN 'current' ELSE 'base' END AS period",
                dialect=self.read_dialect,
            )
            .from_("facts", dialect=self.read_dialect)
            .order_by("metric_code, org_code, stat_date DESC", dialect=self.read_dialect)
            .limit(":limit")
        )
        return self._query(
            _date_predicate(_TimeKind.PERIOD_DATES, self._date_field),
            final,
        )


# 方言注册表：新增方言在此登记适配器即可，场景定义无需改动。
_DIALECTS: dict[str, type[_DialectAdapter]] = {
    "mysql": _MySqlAdapter,
    "inceptor": _InceptorAdapter,
}


class SqlBuilder:
    """按查询计划的场景编号确定性组装只读 SQL。

    治理边界：SQL 结构由本模块的开发者常量决定；表名/列名等标识符只取自
    白名单校验过的 identifiers；指标、机构、日期等业务值一律保留为
    :named 绑定占位符，由数据库适配器绑定，不拼入 SQL 文本。
    场景在 _SCENARIOS 方言无关注册一次，方言差异收拢在 _DialectAdapter
    子类；复杂固定片段（数值清洗 CASE、JSON_TABLE 等）用 parse_one 解析后与
    表达式 API 组装的结果拼接。
    """

    def __init__(
        self,
        dialect: str,
        identifiers: dict[str, str] | None = None,
    ) -> None:
        adapter_class = _DIALECTS.get(dialect)
        if adapter_class is None:
            raise QueryPlanError(f"SqlBuilder does not support dialect {dialect}")
        self.dialect = dialect
        self.variables = {**_DEFAULT_VARIABLES, **(identifiers or {})}
        _validate_identifiers(self.variables)
        self._adapter = adapter_class(self.variables)
        self.read_dialect = self._adapter.read_dialect

    def build(self, plan: QueryExecutionPlan) -> str:
        if plan.dialect != self.dialect:
            raise QueryPlanError(
                f"Plan dialect {plan.dialect} does not match builder dialect {self.dialect}"
            )
        scenario = _SCENARIOS.get(plan.template)
        if scenario is None:
            raise QueryPlanError(
                f"Query scenario {plan.template.value} is not registered "
                "in the SqlBuilder scenario registry"
            )
        required = self._adapter.required_params(plan.template, scenario)
        missing = sorted(name for name in required if name not in plan.parameters)
        if missing:
            raise QueryPlanError(
                f"Plan for {plan.template.value} misses parameters: {', '.join(missing)}"
            )
        sql = self._adapter.build(plan.template, scenario).sql(self.read_dialect)
        self._validate_bound_parameters(plan, sql)
        # 出口校验只读形态，所有查询场景均经过同一道闸门。
        validate_readonly_sql(sql)
        return sql

    @staticmethod
    def _validate_bound_parameters(plan: QueryExecutionPlan, sql: str) -> None:
        """SQL 实参反推：生成的 SQL 中每个 :named 占位符都必须能由 plan.parameters
        （或登记的可派生参数）绑定，缺失即中止，不把绑不上的 SQL 交给适配器。"""
        available = set(plan.parameters)
        for derived, sources in _DERIVED_PARAMETERS.items():
            if sources <= available:
                available.add(derived)
        missing = sorted(set(_NAMED_PARAM_PATTERN.findall(sql)) - available)
        if missing:
            raise QueryPlanError(
                f"SQL for {plan.template.value} binds parameters missing from the plan: "
                + ", ".join(missing)
            )


def _validate_identifiers(values: dict[str, str]) -> None:
    if not re.fullmatch(
        r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}", values["fact_table"]
    ):
        raise ValueError("SIT_FACT_TABLE must be a qualified SQL identifier")
    for name in (
        "fact_metric_code_field",
        "fact_org_code_field",
        "fact_data_date_field",
        "fact_value_field",
        "fact_increment_field",
    ):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", values[name]):
            raise ValueError(f"{name} must be a SQL identifier")
    if not re.fullmatch(
        r"f\.[A-Za-z_][A-Za-z0-9_]*\s+(?:ASC|DESC),\s*"
        r"f\.[A-Za-z_][A-Za-z0-9_]*\s+(?:ASC|DESC)",
        values["batch_order"],
        re.IGNORECASE,
    ):
        raise ValueError("SIT_BATCH_ORDER must order etl_date and btch_seq_no")


def sql_builder_from_settings(settings: Settings) -> SqlBuilder:
    """运行时与验证工具共用同一份经过白名单校验的事实表配置。"""
    return SqlBuilder(settings.query_database_dialect, {
        "fact_table": settings.sit_fact_table,
        "fact_metric_code_field": settings.sit_fact_metric_code_field,
        "fact_org_code_field": settings.sit_fact_org_code_field,
        "fact_data_date_field": settings.sit_fact_data_date_field,
        "fact_value_field": settings.sit_fact_value_field,
        "fact_increment_field": settings.sit_fact_increment_field,
        "batch_order": "f." + settings.sit_batch_order.replace(", ", ", f."),
    })
