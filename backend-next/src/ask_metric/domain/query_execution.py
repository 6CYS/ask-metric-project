from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field

from ask_metric.domain.query_capabilities import CAPABILITIES
from ask_metric.domain.semantics import LogicalDSL


class SupportedQueryShape(StrEnum):
    METRIC_AVAILABILITY = "metric_availability"
    METRIC_VALUE = "metric_value"
    METRIC_TREND = "metric_trend"
    METRIC_PERIOD_COMPARE = "metric_period_compare"
    METRIC_RANKING = "metric_ranking"


class QueryTemplateId(StrEnum):
    METRIC_AVAILABILITY = "metric_availability"
    METRIC_VALUE_LATEST = "metric_value_latest"
    METRIC_VALUE_AS_OF = "metric_value_as_of"
    METRIC_VALUE_IN_RANGE = "metric_value_in_range"
    METRIC_VALUE_AT_DATES = "metric_value_at_dates"
    METRIC_VALUE_AT_PERIODS = "metric_value_at_periods"
    METRIC_VALUE_EXACT = "metric_value_exact"
    METRIC_VALUE_COMPARE_LATEST = "metric_value_compare_latest"
    METRIC_VALUE_COMPARE_AS_OF = "metric_value_compare_as_of"
    METRIC_TREND = "metric_trend"
    METRIC_PERIOD_COMPARE = "metric_period_compare"
    METRIC_RANKING_LATEST_ASC = "metric_ranking_latest_asc"
    METRIC_RANKING_LATEST_DESC = "metric_ranking_latest_desc"
    METRIC_RANKING_EXACT_ASC = "metric_ranking_exact_asc"
    METRIC_RANKING_EXACT_DESC = "metric_ranking_exact_desc"
    METRIC_RANKING_IN_RANGE_ASC = "metric_ranking_in_range_asc"
    METRIC_RANKING_IN_RANGE_DESC = "metric_ranking_in_range_desc"
    METRIC_RANKING_AS_OF_ASC = "metric_ranking_as_of_asc"
    METRIC_RANKING_AS_OF_DESC = "metric_ranking_as_of_desc"


class QueryExecutionPlan(BaseModel):
    shape: SupportedQueryShape
    template: QueryTemplateId
    dialect: str = Field(min_length=1)
    dsl: dict[str, Any]
    result_operations: list[dict[str, Any]] = Field(default_factory=list)
    display_metric_names: list[str] = Field(default_factory=list)
    display_org_names: list[str] = Field(default_factory=list)
    parameters: dict[str, Any] = Field(default_factory=dict, exclude=True)
    catalog: dict[str, Any] = Field(default_factory=dict)


class QueryExecutionResult(BaseModel):
    run_id: int | None = None
    task_id: str
    status: Literal["succeeded", "failed", "unsupported"]
    query_shape: str
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    comparisons: list[dict[str, Any]] = Field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    latency_ms: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    message: str | None = None
    task_version: int | None = None
    task_status: str | None = None
    idempotent_replay: bool = False
    timings_ms: dict[str, int] = Field(default_factory=dict)
    debug: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)


class QueryPlanError(ValueError):
    pass


class UnsupportedQueryError(QueryPlanError):
    """查询条件超出受治理能力；public_message 为开发方可控的对用户说明。"""

    def __init__(self, message: str, *, public_message: str | None = None) -> None:
        super().__init__(message)
        self.public_message = public_message


class QueryPlanner:
    """将受校验的 LogicalDSL 转成已登记的模板编号、绑定参数及结果操作。

    DSL 是指标、机构、时间等结构化查询条件，并非 SQL；不支持的条件必须报错，
    不能删掉条件后扩大查询范围。SQL 文本由模板仓库提供，模型不参与拼接。
    """
    def __init__(
        self,
        *,
        dialect: str,
        max_limit: int = 1000,
    ) -> None:
        self.dialect = dialect
        self.max_limit = max_limit

    def build(
        self,
        dsl: LogicalDSL,
        query_shape: str,
        *,
        org_names: list[str] | None = None,
        display_metric_names: list[str] | None = None,
        display_org_names: list[str] | None = None,
    ) -> QueryExecutionPlan:
        if dsl.task.value != "metric_query":
            raise UnsupportedQueryError(f"Task {dsl.task.value} is not executable yet")
        if query_shape == "metric_detail":
            raise UnsupportedQueryError("Detail queries are unsupported by metric_values")
        unsupported_dimensions = [
            dimension for dimension in dsl.dimensions if dimension not in {"org", "机构"}
        ]
        if unsupported_dimensions or dsl.filters:
            raise UnsupportedQueryError(
                "Dimensions and filters are not supported by the initial metric_values templates"
            )
        try:
            shape = SupportedQueryShape(query_shape)
        except ValueError as exc:
            raise UnsupportedQueryError(f"Query shape {query_shape} is not supported") from exc
        if shape == SupportedQueryShape.METRIC_PERIOD_COMPARE:
            comparisons = [op for op in dsl.ops if op.get("type") == "period_compare"]
            if len(comparisons) != 1 or comparisons[0].get("method") != "custom":
                raise UnsupportedQueryError(
                    "Dynamic period comparison is disabled; "
                    "use an official precomputed comparison metric"
                )
            dates = _period_parameters(dsl)
            if dates["base_date"] >= dates["current_date"]:
                raise QueryPlanError("Comparison base date must precede current date")
        _validate_time_range(dsl)
        metric_codes = _validate_codes(dsl.metrics, "metric_codes")
        normalized_orgs = _validate_codes(
            org_names if org_names is not None else dsl.orgs,
            "org_names",
            allow_empty=True,
        )
        _validate_operation_support(dsl, shape)
        # 机构过滤统一使用机构编码：metric_values 同时携带 org_code 与展示用 org_name，
        # 编码与目录、权限裁剪同源，比名称匹配更可靠（mysql 与 inceptor 一致）。
        base_parameters: dict[str, Any] = {
            "metric_codes": metric_codes,
            "org_codes": normalized_orgs,
            "filter_orgs": bool(normalized_orgs),
            # 多取一行作截断标志：否则恰好返回上限行数时无法判断是否还有数据。
            "limit": self.max_limit + 1,
        }
        result_operations = [
            operation for operation in dsl.ops if operation.get("type") == "entity_compare"
        ]
        if shape == SupportedQueryShape.METRIC_AVAILABILITY:
            operation = next(item for item in dsl.ops if item.get("type") == "availability")
            if dsl.time.preset or any(dsl.options.get(key) for key in (
                "target_dates", "time_windows", "current_date", "base_date", "time_mode",
            )):
                raise UnsupportedQueryError("Availability supports one optional date range only")
            if not normalized_orgs:
                raise QueryPlanError("Availability requires an explicit authorized organization")
            grain, selection = operation.get("grain", "month"), operation.get("selection", "all")
            if grain not in {"day", "month"} or selection not in {"all", "earliest", "latest"}:
                raise QueryPlanError("Invalid availability grain or selection")
            template = QueryTemplateId.METRIC_AVAILABILITY
            base_parameters.update({
                "filter_dates": dsl.time.start is not None,
                "start_date": dsl.time.start, "end_date": dsl.time.end,
                "grain": grain, "selection": selection,
            })
        elif shape == SupportedQueryShape.METRIC_VALUE:
            template, value_parameters = _value_plan(dsl, compare_entities=bool(result_operations))
            if self.dialect == "inceptor" and "period_starts" in value_parameters:
                # Inceptor deployments differ in JSON_TABLE/array expansion support.
                # Fetch the bounded date set and keep period selection in the application
                # contract instead of embedding user-controlled SQL fragments.
                starts = value_parameters["period_starts"]
                ends = value_parameters["period_ends"]
                value_parameters.update({"start_date": min(starts), "end_date": max(ends)})
                value_parameters["period_count"] = len(starts)
                for index in range(12):
                    source_index = index if index < len(starts) else 0
                    value_parameters[f"period_start_{index}"] = starts[source_index]
                    value_parameters[f"period_end_{index}"] = ends[source_index]
            base_parameters.update(value_parameters)
        elif shape == SupportedQueryShape.METRIC_TREND:
            template = QueryTemplateId.METRIC_TREND
            base_parameters.update(_trend_parameters(dsl))
        elif shape == SupportedQueryShape.METRIC_PERIOD_COMPARE:
            template = QueryTemplateId.METRIC_PERIOD_COMPARE
            base_parameters.update(_period_parameters(dsl))
            result_operations.extend(
                operation for operation in dsl.ops if operation.get("type") == "period_compare"
            )
        else:
            template, ranking_parameters = self._ranking_plan(
                dsl,
                org_names=normalized_orgs,
            )
            base_parameters.update(ranking_parameters)
        return QueryExecutionPlan(
            shape=shape,
            template=template,
            dialect=self.dialect,
            dsl=dsl.model_dump(mode="json"),
            result_operations=result_operations,
            display_metric_names=display_metric_names or [],
            display_org_names=display_org_names or [],
            parameters=base_parameters,
        )

    def _ranking_plan(
        self,
        dsl: LogicalDSL,
        *,
        org_names: list[str],
    ) -> tuple[QueryTemplateId, dict[str, Any]]:
        if dsl.options.get("target_dates") or dsl.options.get("time_windows"):
            raise UnsupportedQueryError(
                "Ranking across multiple dates or time windows is not supported"
            )
        operation = next(
            (item for item in dsl.ops if item.get("type") in {"ranking", "top_n"}),
            None,
        )
        if operation is None:
            raise QueryPlanError("Ranking shape requires ranking or top_n operation")
        raw_limit = operation.get("top_n") or operation.get("n")
        if operation.get("type") == "ranking" and raw_limit is None and org_names:
            raise UnsupportedQueryError(
                "A single organization's rank must use an official precomputed ranking metric"
            )
        if raw_limit is None:
            raw_limit = 10
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int):
            raise QueryPlanError("Ranking limit must be an integer")
        if raw_limit < 1 or raw_limit > self.max_limit:
            raise QueryPlanError(f"Ranking limit must be between 1 and {self.max_limit}")
        direction = operation.get("order", "desc")
        if direction not in {"asc", "desc"}:
            raise QueryPlanError("Ranking direction must be asc or desc")
        parameters: dict[str, Any] = {"limit": raw_limit}
        if dsl.time.preset == "latest":
            template = QueryTemplateId(f"metric_ranking_latest_{direction}")
            return template, parameters
        if dsl.time.start is None or dsl.time.end is None:
            raise QueryPlanError("Ranking requires a complete time range or latest")
        if dsl.options.get("time_mode") == "as_of":
            template = QueryTemplateId(f"metric_ranking_as_of_{direction}")
            parameters["end_date"] = dsl.time.end
        elif dsl.time.start == dsl.time.end:
            template = QueryTemplateId(f"metric_ranking_exact_{direction}")
            parameters["stat_date"] = dsl.time.end
        else:
            template = QueryTemplateId(f"metric_ranking_in_range_{direction}")
            parameters.update({"start_date": dsl.time.start, "end_date": dsl.time.end})
        return template, parameters


def _validate_operation_support(dsl: LogicalDSL, shape: SupportedQueryShape) -> None:
    operation_types = [str(item.get("type") or "") for item in dsl.ops]
    unsupported = sorted(
        {item for item in operation_types if item in {"aggregate", "detail", "drill_down"}}
    )
    if unsupported:
        raise UnsupportedQueryError(
            "Operations are not supported by governed metric templates: " + ", ".join(unsupported)
        )
    if shape == SupportedQueryShape.METRIC_AVAILABILITY and len(dsl.ops) != 1:
        raise UnsupportedQueryError("Availability requires exactly one operation")
    unexpected = sorted(set(operation_types) - CAPABILITIES[shape.value].operations)
    if unexpected:
        raise UnsupportedQueryError(
            f"Operations cannot be combined with {shape.value}: " + ", ".join(unexpected)
        )


def _value_plan(
    dsl: LogicalDSL, *, compare_entities: bool
) -> tuple[QueryTemplateId, dict[str, Any]]:
    start = dsl.time.start
    end = dsl.time.end
    if dsl.time.preset == "latest":
        template = (
            QueryTemplateId.METRIC_VALUE_COMPARE_LATEST
            if compare_entities
            else QueryTemplateId.METRIC_VALUE_LATEST
        )
        return template, {}
    time_windows = _time_windows(dsl.options.get("time_windows"))
    if time_windows:
        return QueryTemplateId.METRIC_VALUE_AT_PERIODS, {
            "period_starts": [start for start, _ in time_windows],
            "period_ends": [end for _, end in time_windows],
        }
    target_dates = _target_dates(dsl.options.get("target_dates"))
    if target_dates:
        return QueryTemplateId.METRIC_VALUE_AT_DATES, {"stat_dates": target_dates}
    if start is None or end is None:
        raise QueryPlanError("Metric value queries require a complete time range or latest")
    if start == end:
        return QueryTemplateId.METRIC_VALUE_EXACT, {"stat_date": end}
    if not compare_entities:
        return QueryTemplateId.METRIC_VALUE_IN_RANGE, {
            "start_date": start,
            "end_date": end,
        }
    template = (
        QueryTemplateId.METRIC_VALUE_COMPARE_AS_OF
        if compare_entities
        else QueryTemplateId.METRIC_VALUE_AS_OF
    )
    return template, {"end_date": end}


def _target_dates(value: Any) -> list[date]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) < 2:
        raise QueryPlanError("target_dates must contain at least two dates")
    parsed: list[date] = []
    for item in value:
        try:
            target = date.fromisoformat(item) if isinstance(item, str) else item
        except ValueError as exc:
            raise QueryPlanError("target_dates contains an invalid date") from exc
        if not isinstance(target, date):
            raise QueryPlanError("target_dates contains an invalid date")
        if target not in parsed:
            parsed.append(target)
    return sorted(parsed)


def _time_windows(value: Any) -> list[tuple[date, date]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) < 2:
        raise QueryPlanError("time_windows must contain at least two ranges")
    windows: list[tuple[date, date]] = []
    for item in value:
        if not isinstance(item, dict):
            raise QueryPlanError("time_windows contains an invalid range")
        start = _option_date(item.get("start"))
        end = _option_date(item.get("end"))
        if start is None or end is None or start > end:
            raise QueryPlanError("time_windows contains an invalid range")
        if (start, end) not in windows:
            windows.append((start, end))
    if len(windows) < 2:
        raise QueryPlanError("time_windows must contain at least two distinct ranges")
    if len(windows) > 12:
        raise QueryPlanError("time_windows cannot contain more than 12 ranges")
    return windows


def _trend_parameters(dsl: LogicalDSL) -> dict[str, Any]:
    if dsl.time.start is None or dsl.time.end is None:
        raise QueryPlanError("Trend queries require start and end dates")
    return {"start_date": dsl.time.start, "end_date": dsl.time.end}


def _period_parameters(dsl: LogicalDSL) -> dict[str, Any]:
    operation = next(
        (item for item in dsl.ops if item.get("type") == "period_compare"),
        None,
    )
    if operation is None:
        raise QueryPlanError("Period comparison operation is missing")
    current_date = _option_date(dsl.options.get("current_date")) or dsl.time.end
    if current_date is None:
        raise QueryPlanError("Period comparison requires a current date")
    base_date = _resolve_base_date(current_date, operation, dsl.options)
    return {"current_date": current_date, "base_date": base_date}


def _validate_time_range(dsl: LogicalDSL) -> None:
    start = dsl.time.start
    end = dsl.time.end
    if dsl.time.preset == "latest":
        if start is not None or end is not None:
            raise QueryPlanError("Latest time cannot include start or end dates")
        return
    if (start is None) != (end is None):
        raise QueryPlanError("Time range requires both start and end dates")
    if start is not None and end is not None and start > end:
        raise QueryPlanError("Time range start cannot be after end")


def _resolve_base_date(
    current_date: date, operation: dict[str, Any], options: dict[str, Any]
) -> date:
    method = operation.get("method")
    if method == "custom":
        value = options.get("base_date")
        if value is None and options.get("base_month") is not None:
            import calendar

            base_month = int(options["base_month"])
            base_year = current_date.year - (1 if base_month > current_date.month else 0)
            return date(base_year, base_month, calendar.monthrange(base_year, base_month)[1])
        try:
            return date.fromisoformat(value)
        except (TypeError, ValueError) as exc:
            raise QueryPlanError("Custom comparison requires ISO base_date") from exc
    months = 12 if method == "yoy" else 3 if method == "qoq" else 1
    return _shift_months(current_date, -months)


def _option_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError as exc:
            raise QueryPlanError("Date options must use ISO format") from exc
    raise QueryPlanError("Date options must use ISO format")


def _shift_months(value: date, delta: int) -> date:
    import calendar

    month_index = value.year * 12 + value.month - 1 + delta
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _validate_codes(values: list[str], name: str, *, allow_empty: bool = False) -> list[str]:
    if not values and not allow_empty:
        raise QueryPlanError(f"{name} cannot be empty")
    if len(values) > 100:
        raise QueryPlanError(f"{name} exceeds the maximum item count")
    normalized = []
    for value in values:
        if not isinstance(value, str) or not value.strip() or len(value) > 255:
            raise QueryPlanError(f"{name} contains an invalid value")
        normalized.append(value.strip())
    return list(dict.fromkeys(normalized))


def json_safe(value: Any) -> Any:
    if isinstance(value, (date, Decimal)):
        return str(value)
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value
