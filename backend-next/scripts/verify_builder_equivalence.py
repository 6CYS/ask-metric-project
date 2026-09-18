"""plan→SqlBuilder 改造的等价回归：builder 输出必须与登记模板语义一致。

- mysql 方言：用本地验证库（.env 的 QUERY_DATABASE_URL）逐场景、多组参数分别执行
  模板 SQL 与 builder SQL，结果集（含列顺序与行序）逐行比对。
- inceptor 方言：本地无 Inceptor，对“模板渲染结果”与 builder 输出做 sqlglot AST
  规范化比对（依次尝试 hive/spark/mysql 解析），等价即通过。

任何场景 FAIL 都以非零退出码结束。凭据只用于建连，不打印。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from dotenv import dotenv_values
from sqlalchemy import create_engine, text

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

from ask_metric.domain.query_execution import (  # noqa: E402
    QueryExecutionPlan,
    QueryTemplateId,
    SupportedQueryShape,
)
from ask_metric.infrastructure.query.mysql import MySqlDataSourceAdapter  # noqa: E402
from ask_metric.infrastructure.query.sql_builder import SqlBuilder  # noqa: E402
from ask_metric.infrastructure.query.sql_safety import validate_readonly_sql  # noqa: E402
from ask_metric.infrastructure.query.templates import QueryTemplateRepository  # noqa: E402

# 结果行数上限与生产一致（max_limit+1 截断哨兵），排名场景用真实 top_n。
MAX_LIMIT_PLUS_ONE = 101
RANKING_TOP_N = 5

failures = 0


def report(passed: bool, label: str, detail: str) -> None:
    global failures
    status = "PASS" if passed else "FAIL"
    if not passed:
        failures += 1
    print(f"{status} {label} {detail}")


def _shape_of(template: QueryTemplateId) -> SupportedQueryShape:
    name = template.value
    if "ranking" in name:
        return SupportedQueryShape.METRIC_RANKING
    if name == "metric_trend":
        return SupportedQueryShape.METRIC_TREND
    if name == "metric_period_compare":
        return SupportedQueryShape.METRIC_PERIOD_COMPARE
    return SupportedQueryShape.METRIC_VALUE


def _build_plan(
    template: QueryTemplateId, dialect: str, parameters: dict[str, Any]
) -> QueryExecutionPlan:
    return QueryExecutionPlan(
        shape=_shape_of(template),
        template=template,
        dialect=dialect,
        dsl={},
        parameters=parameters,
    )


class _DataContext:
    """从验证库采样真实的指标编码、机构编码和日期，保证各场景都命中数据。"""

    def __init__(self, engine) -> None:
        with engine.connect() as connection:
            self.dates = [
                row[0]
                for row in connection.execute(
                    text(
                        "SELECT DISTINCT stat_date FROM metric_values "
                        "ORDER BY stat_date DESC LIMIT 4"
                    )
                )
            ]
            self.codes = [
                row[0]
                for row in connection.execute(
                    text(
                        "SELECT mt.metric_code FROM metric_terms AS mt "
                        "JOIN metric_values AS mv ON mv.metric_code = mt.metric_code "
                        "WHERE mt.enabled = 1 "
                        "GROUP BY mt.metric_code ORDER BY COUNT(*) DESC LIMIT 3"
                    )
                )
            ]
            self.orgs = [
                row[0]
                for row in connection.execute(
                    text(
                        "SELECT DISTINCT org_code FROM metric_values "
                        "WHERE org_code IS NOT NULL LIMIT 3"
                    )
                )
            ]
        if len(self.dates) < 4 or len(self.codes) < 2 or len(self.orgs) < 2:
            raise SystemExit("验证库数据不足：需要至少 4 个日期、2 个指标、2 个机构")


def _mysql_variants(
    template: QueryTemplateId, ctx: _DataContext
) -> list[tuple[str, dict[str, Any]]]:
    """各场景的参数组合：覆盖单/多指标、有/无机构过滤及各日期形态。"""
    base = {"limit": MAX_LIMIT_PLUS_ONE}
    multi = {**base, "metric_codes": ctx.codes[:2], "org_codes": [], "filter_orgs": False}
    scoped = {
        **base,
        "metric_codes": ctx.codes[:1],
        "org_codes": ctx.orgs[:2],
        "filter_orgs": True,
    }
    newest, second, third, fourth = ctx.dates
    ranking = RANKING_TOP_N
    name = template.value
    if "latest" in name:
        variants = [("多指标-无机构", multi), ("单指标-有机构", scoped)]
    elif "exact" in name:
        variants = [
            ("多指标-无机构", {**multi, "stat_date": newest}),
            ("单指标-有机构", {**scoped, "stat_date": second}),
        ]
    elif "as_of" in name:
        variants = [
            ("多指标-无机构", {**multi, "end_date": newest}),
            ("单指标-有机构", {**scoped, "end_date": third}),
        ]
    elif "in_range" in name or name == "metric_trend":
        variants = [
            ("多指标-无机构", {**multi, "start_date": fourth, "end_date": newest}),
            ("单指标-有机构", {**scoped, "start_date": third, "end_date": second}),
        ]
    elif name == "metric_value_at_dates":
        variants = [
            ("多指标-无机构", {**multi, "stat_dates": [newest, second, third]}),
            ("单指标-有机构", {**scoped, "stat_dates": [newest, fourth]}),
        ]
    elif name == "metric_value_at_periods":
        variants = [
            (
                "多指标-两期间",
                {**multi, "period_starts": [fourth, second], "period_ends": [third, newest]},
            ),
            (
                "单指标-三期间-有机构",
                {
                    **scoped,
                    "period_starts": [fourth, third, second],
                    "period_ends": [fourth, second, newest],
                },
            ),
        ]
    elif name == "metric_period_compare":
        variants = [
            ("多指标-无机构", {**multi, "current_date": newest, "base_date": second}),
            ("单指标-有机构", {**scoped, "current_date": second, "base_date": fourth}),
        ]
    else:
        raise SystemExit(f"未覆盖的场景: {name}")
    if "ranking" in name:
        # 排名用真实 top_n；exact 之外变体沿用上面组好的日期参数。
        return [(label, {**params, "limit": ranking}) for label, params in variants]
    return variants


def _rows_signature(rows: list[dict[str, Any]]) -> list[tuple[tuple[str, ...], tuple[Any, ...]]]:
    # 列顺序与行序都必须一致：ORDER BY 相同的两条 SQL 应返回完全一样的结果。
    return [(tuple(row.keys()), tuple(row.values())) for row in rows]


def _executable_template_sql(sql: str) -> tuple[str, str]:
    """模板在 MySQL 8 上的可执行副本：row_number 是 8.0 保留字，模板别名未转义。

    只对别名出现位置加反引号（不动 ROW_NUMBER() 窗口函数），语义完全不变；
    builder 输出由 sqlglot 自动转义，可直接执行。返回 (SQL, 备注)。
    """
    patched = (
        sql.replace("AS row_number", "AS `row_number`")
        .replace(".row_number", ".`row_number`")
        .replace("WHERE row_number", "WHERE `row_number`")
    )
    if patched == sql:
        return sql, ""
    return patched, "；模板 row_number 别名按 MySQL 8 保留字等价转义后执行"


def verify_mysql(engine) -> None:
    adapter = MySqlDataSourceAdapter(engine, statement_timeout_ms=120_000)
    repository = QueryTemplateRepository(
        PROJECT_DIR / "config" / "query-templates.json",
        PROJECT_DIR / "resources" / "sql",
    )
    builder = SqlBuilder("mysql", dict(repository.template_variables))
    ctx = _DataContext(engine)
    for template in QueryTemplateId:
        template_sql = repository.load(dialect="mysql", template=template)
        validate_readonly_sql(template_sql)
        executable_sql, patch_note = _executable_template_sql(template_sql)
        for label, parameters in _mysql_variants(template, ctx):
            plan = _build_plan(template, "mysql", dict(parameters))
            builder_sql = builder.build(plan)
            expected = adapter.execute_readonly(sql=executable_sql, parameters=dict(parameters))
            actual = adapter.execute_readonly(sql=builder_sql, parameters=dict(parameters))
            expected_rows = _rows_signature(expected.rows)
            actual_rows = _rows_signature(actual.rows)
            report(
                expected_rows == actual_rows,
                f"mysql/{template.value}[{label}]",
                f"模板 {len(expected_rows)} 行 vs builder {len(actual_rows)} 行"
                + ("" if expected_rows == actual_rows else "（结果集不一致）")
                + patch_note,
            )


def verify_inceptor() -> None:
    from sqlglot import parse_one

    repository = QueryTemplateRepository(
        PROJECT_DIR / "config" / "query-templates.json",
        PROJECT_DIR / "resources" / "sql",
    )
    builder = SqlBuilder("inceptor", dict(repository.template_variables))
    # 参数只用于通过 builder 的参数闸门，AST 比对不依赖具体取值。
    # period_start_0..11 / period_end_0..11 是 inceptor 多期间的 planner 契约参数。
    placeholder_params = {
        "metric_codes": ["M1"],
        "org_codes": [],
        "filter_orgs": False,
        "limit": RANKING_TOP_N,
        "stat_date": "2026-07-31",
        "start_date": "2026-06-01",
        "end_date": "2026-07-31",
        "stat_dates": ["2026-07-31"],
        "period_starts": ["2026-06-01"],
        "period_ends": ["2026-07-31"],
        "current_date": "2026-07-31",
        "base_date": "2026-06-30",
        "period_count": 2,
        **{f"period_start_{index}": "2026-06-01" for index in range(12)},
        **{f"period_end_{index}": "2026-07-31" for index in range(12)},
    }
    for template in QueryTemplateId:
        rendered = repository.load(dialect="inceptor", template=template)
        built = builder.build(_build_plan(template, "inceptor", dict(placeholder_params)))
        matched = False
        parse_error: Exception | None = None
        for read_dialect in ("hive", "spark", "mysql"):
            try:
                rendered_ast = parse_one(rendered, read=read_dialect)
                built_ast = parse_one(built, read=read_dialect)
            except Exception as exc:  # 尝试下一种读方言
                parse_error = exc
                continue
            # 规范化序列化后比较：等价于 AST 结构等价，允许格式差异。
            matched = rendered_ast.sql(read_dialect, normalize=True) == built_ast.sql(
                read_dialect, normalize=True
            )
            detail = f"AST 规范化比对（{read_dialect} 解析）"
            break
        else:
            detail = f"模板或 builder 输出无法解析: {parse_error}"
        report(matched, f"inceptor/{template.value}", detail if matched else detail + "，不等价")


def main() -> None:
    url = dotenv_values(PROJECT_DIR / ".env").get("QUERY_DATABASE_URL")
    if not url:
        raise SystemExit("QUERY_DATABASE_URL 未配置（backend-next/.env）")
    engine = create_engine(url)
    print("== mysql：结果集逐行比对 ==")
    verify_mysql(engine)
    print("== inceptor：AST 规范化比对 ==")
    verify_inceptor()
    if failures:
        print(f"共 {failures} 项 FAIL")
        raise SystemExit(1)
    print("全部场景 PASS")


if __name__ == "__main__":
    main()
