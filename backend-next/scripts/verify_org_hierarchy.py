"""机构层级只读核实：判断数据湖是否具备开启支行钻取的数据前提。

全部检查均为 SELECT，不发任何写语句；可重复执行。凭据只用于建连，不打印。

检查项：
a) 机构表 org_hier_code 分布；经 information_schema（失败回退 DESCRIBE）探测
   上级机构字段（supr_org_no/up_org_no/parent_org_no 等候选名及命名启发式）；
   找到后抽样验证支行上级是否闭环落在 1/3 层级集合内。
b) 事实表 distinct org_no 与机构表 1/3 层级范围对比，识别支行级记录；
   按 org_hier_code 分层统计事实表覆盖的指标数（机构表取最新 etl_date 快照）。
c) 可加性抽查（--metric-codes，默认 5 个法人层已验证可加指标）：
   最近两个数据日期快照，逐法人核对 法人值 ≈ Σ其支行（存量与两期间变动，
   容差 0.01）。无上级字段或无支行事实时跳过。

结论（报告末尾）：
- HIERARCHY_OK：层级字段存在、父子闭环、有支行事实且可加性抽查通过 → 建议开启；
- HIERARCHY_INCOMPLETE：缺上级字段或父子不闭环；
- NO_BRANCH_FACTS：事实表无支行级数据（本地 dev 库预期命中此项）。
退出码非零表示核实未通过（结论不是可开启状态）。

默认连 QUERY_DATABASE_URL 指向的 SIT 数据湖；--local 改连 APP_DATABASE_URL
对本地 ask_metric_app 跑同构检查（org_terms / metric_values）。
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from dotenv import dotenv_values
from sqlalchemy import create_engine, text

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

TOLERANCE = Decimal("0.01")
# 上级机构字段候选名：优先精确匹配，再用启发式正则兜底。
PARENT_FIELD_CANDIDATES = (
    "supr_org_no",
    "up_org_no",
    "parent_org_no",
    "prnt_org_no",
    "sup_org_no",
    "uppr_org_no",
    "super_org_no",
    "parent_org_code",
)
# 启发式正则须与“org”同时成立（见下方过滤），避免误命中 updated_at 等非机构列。
PARENT_FIELD_HINT = re.compile(r"(supr|parent|prnt|upper|(^|_)up(_|$))", re.IGNORECASE)
# 表名/字段名只允许标识符（可带库名前缀），防止拼接注入。
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?")
# 法人层已验证可加（法人 = Σ其支行，见 check_additivity）的默认抽查指标。
DEFAULT_METRIC_CODES = (
    "ORG_PSON_LNGTERM_LOAN_BAL",
    "ORG_CORP_LOAN_EXCLD_DSCNT_BAL",
    "ORG_CORP_DEPT_BAL",
    "ORG_100W_BLW_LOAN_BAL",
    "ORG_BAD_LOAN_BAL",
)
HEAD_OFFICE_HIER_CODE = "1"
BRANCH_HIER_CODE = "2"
LEGAL_ENTITY_HIER_CODE = "3"
CLOSURE_SAMPLE_LIMIT = 200


@dataclass(frozen=True)
class SourceLayout:
    """同一套检查在 SIT 数据湖与本地 dev 库上的表/字段映射。"""

    org_table: str
    org_code_field: str
    org_name_field: str
    hierarchy_field: str  # 本地库列为空时按“无层级数据”处理
    parent_field: str  # 本地库固定列名；SIT 由 information_schema 探测
    org_snapshot_field: str | None
    fact_table: str
    fact_metric_field: str
    fact_org_field: str
    fact_date_field: str
    fact_value_field: str
    fact_batch_order: str | None  # 同机构同日期多批记录时的版本排序


def _sit_layout(args: argparse.Namespace) -> SourceLayout:
    # 默认值与 src/ask_metric/core/config.py 的 sit_org_*/sit_fact_* 保持一致。
    return SourceLayout(
        org_table=args.org_table,
        org_code_field="org_no",
        org_name_field="org_chn_nm",
        hierarchy_field="org_hier_code",
        parent_field="",
        org_snapshot_field="etl_date",
        fact_table=args.fact_table,
        fact_metric_field="indcr_no",
        fact_org_field="org_no",
        fact_date_field="data_dt",
        fact_value_field="indcvl",
        fact_batch_order="etl_date DESC, btch_seq_no DESC",
    )


def _local_layout() -> SourceLayout:
    return SourceLayout(
        org_table="org_terms",
        org_code_field="org_code",
        org_name_field="org_name",
        hierarchy_field="hierarchy_level",
        parent_field="parent_org_code",
        org_snapshot_field=None,
        fact_table="metric_values",
        fact_metric_field="metric_code",
        fact_org_field="org_code",
        fact_date_field="stat_date",
        fact_value_field="metric_value",
        fact_batch_order=None,
    )


def _check_identifier(name: str, label: str) -> None:
    if not IDENTIFIER.fullmatch(name):
        raise SystemExit(f"{label} 含非法字符，拒绝拼接进 SQL：{name!r}")


def _org_columns(connection, org_table: str) -> list[str]:
    """列出机构表全部列名；优先 information_schema，失败回退 DESCRIBE。"""
    parts = org_table.split(".")
    try:
        if len(parts) == 2:
            rows = connection.execute(
                text(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table"
                ),
                {"schema": parts[0], "table": parts[1]},
            ).fetchall()
        else:
            rows = connection.execute(
                text(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table"
                ),
                {"table": parts[0]},
            ).fetchall()
        columns = [str(row[0]) for row in rows]
        if columns:
            return columns
    except Exception as exc:  # inceptor 等方言可能不支持 information_schema
        print(f"information_schema 查询失败（{type(exc).__name__}），回退 DESCRIBE")
    rows = connection.execute(text(f"DESCRIBE {org_table}")).fetchall()
    return [str(row[0]) for row in rows]


def _latest_snapshot_filter(layout: SourceLayout) -> str:
    if not layout.org_snapshot_field:
        return ""
    return (
        f" AND {layout.org_snapshot_field} = "
        f"(SELECT MAX({layout.org_snapshot_field}) FROM {layout.org_table})"
    )


def check_org_levels(connection, layout: SourceLayout) -> dict[str, Any]:
    """检查 a)：层级分布、上级字段探测、父子闭环抽样。"""
    columns = _org_columns(connection, layout.org_table)
    print(f"[a] 机构表列（{len(columns)}）: {columns}")
    has_level_column = layout.hierarchy_field in columns
    distribution: dict[str, int] = {}
    if has_level_column:
        rows = connection.execute(
            text(
                f"SELECT {layout.hierarchy_field} AS lvl, COUNT(*) FROM {layout.org_table} "
                f"WHERE {layout.hierarchy_field} IS NOT NULL"
                f"{_latest_snapshot_filter(layout)} "
                f"GROUP BY {layout.hierarchy_field} ORDER BY lvl"
            )
        ).fetchall()
        distribution = {str(lvl): int(count) for lvl, count in rows}
    if has_level_column:
        print(f"[a] org_hier_code 分布（最新快照，非空值）: {distribution or '无层级数据'}")
    else:
        print(f"[a] 机构表无层级列 {layout.hierarchy_field}，无层级数据")
    # 层级列存在但全 NULL（如本地 0004 后未启用扩展）按无层级数据处理，
    # 下游范围/闭环/可加性检查一律退化为不按层级过滤。
    has_level_data = has_level_column and bool(distribution)
    parent_field = layout.parent_field if layout.parent_field in columns else ""
    if not parent_field:
        lowered = {col.lower(): col for col in columns}
        for candidate in PARENT_FIELD_CANDIDATES:
            if candidate in lowered:
                parent_field = lowered[candidate]
                break
        else:
            hinted = [
                col
                for col in columns
                if "org" in col.lower()
                and PARENT_FIELD_HINT.search(col)
                and col.lower() not in {layout.hierarchy_field.lower(), "org_hier_code"}
            ]
            if hinted:
                parent_field = hinted[0]
                print(f"[a] 上级机构字段（启发式命中，需人工确认）: {parent_field}")
    if not parent_field:
        print("[a] 未发现上级机构字段")
        return {"distribution": distribution, "parent_field": "", "closure": None,
            "has_level_column": has_level_data}

    # 上级字段存在但全 NULL 等同于无数据（本地 0004 后未启用扩展时的状态）。
    non_null = connection.execute(
        text(
            f"SELECT COUNT(*) FROM {layout.org_table} "
            f"WHERE {parent_field} IS NOT NULL AND {parent_field} <> ''"
            f"{_latest_snapshot_filter(layout)}"
        )
    ).scalar_one()
    print(f"[a] 上级机构字段: {parent_field}（非空 {int(non_null)} 行）")
    if not non_null:
        return {"distribution": distribution, "parent_field": "", "closure": None,
            "has_level_column": has_level_data}

    if not has_level_data:
        # 无层级数据无法判定 1/3 层级集合，闭环检查无从谈起。
        print("[a] 跳过父子闭环抽样：机构表无层级列")
        return {"distribution": distribution, "parent_field": parent_field, "closure": None,
            "has_level_column": has_level_data}
    # 父子闭环抽样：支行的上级必须落在 1/3 层级集合内。
    scope_codes = {
        str(row[0])
        for row in connection.execute(
            text(
                f"SELECT {layout.org_code_field} FROM {layout.org_table} "
                f"WHERE {layout.hierarchy_field} IN (:head, :legal)"
                f"{_latest_snapshot_filter(layout)}"
            ),
            {"head": HEAD_OFFICE_HIER_CODE, "legal": LEGAL_ENTITY_HIER_CODE},
        ).fetchall()
    }
    sample = connection.execute(
        text(
            f"SELECT {layout.org_code_field}, {parent_field} FROM {layout.org_table} "
            f"WHERE {layout.hierarchy_field} = :branch AND {parent_field} IS NOT NULL "
            f"AND {parent_field} <> ''{_latest_snapshot_filter(layout)} "
            f"LIMIT {CLOSURE_SAMPLE_LIMIT}"
        ),
        {"branch": BRANCH_HIER_CODE},
    ).fetchall()
    broken = [
        (str(code), str(parent)) for code, parent in sample if str(parent) not in scope_codes
    ]
    closure = {"sampled": len(sample), "broken": broken[:10]}
    print(
        f"[a] 父子闭环抽样: {len(sample)} 家支行，"
        f"上级不在 1/3 层级的 {len(broken)} 家{f'，示例 {broken[:5]}' if broken else ''}"
    )
    return {"distribution": distribution, "parent_field": parent_field, "closure": closure,
            "has_level_column": has_level_data}


def check_fact_coverage(
    connection, layout: SourceLayout, has_level_column: bool
) -> dict[str, Any]:
    """检查 b)：事实表机构覆盖与分层指标数。"""
    fact_orgs = {
        str(row[0])
        for row in connection.execute(
            text(f"SELECT DISTINCT {layout.fact_org_field} FROM {layout.fact_table}")
        ).fetchall()
        if row[0] is not None
    }
    # 有层级列时范围 = 1/3 层级（现行 61 家口径）；无层级列时退化为机构表全量。
    if has_level_column:
        scope_filter = f"WHERE {layout.hierarchy_field} IN (:head, :legal)"
        params: dict[str, Any] = {
            "head": HEAD_OFFICE_HIER_CODE,
            "legal": LEGAL_ENTITY_HIER_CODE,
        }
    else:
        scope_filter = ""
        params = {}
    scope_orgs = {
        str(row[0])
        for row in connection.execute(
            text(
                f"SELECT {layout.org_code_field} FROM {layout.org_table} "
                f"{scope_filter}{_latest_snapshot_filter(layout)}"
            ),
            params,
        ).fetchall()
    }
    branch_orgs = sorted(fact_orgs - scope_orgs)
    print(
        f"[b] 事实表 distinct 机构 {len(fact_orgs)}，机构表范围 {len(scope_orgs)}，"
        f"范围外（支行级）机构 {len(branch_orgs)} 个"
        f"{f'，示例 {branch_orgs[:5]}' if branch_orgs else ''}"
    )

    coverage: dict[str, int] = {}
    if has_level_column:
        # join 机构表最新 etl_date 快照，分层统计事实表覆盖的指标数。
        snapshot_join = ""
        if layout.org_snapshot_field:
            snapshot_join = (
                f" AND o.{layout.org_snapshot_field} = "
                f"(SELECT MAX({layout.org_snapshot_field}) FROM {layout.org_table})"
            )
        rows = connection.execute(
            text(
                f"SELECT o.{layout.hierarchy_field} AS lvl, "
                f"COUNT(DISTINCT f.{layout.fact_metric_field}) "
                f"FROM (SELECT DISTINCT {layout.fact_org_field} AS org_code, "
                f"{layout.fact_metric_field} AS metric_code FROM {layout.fact_table}) f "
                f"JOIN {layout.org_table} o ON o.{layout.org_code_field} = f.org_code"
                f"{snapshot_join} "
                f"GROUP BY o.{layout.hierarchy_field} ORDER BY lvl"
            )
        ).fetchall()
        coverage = {str(lvl): int(count) for lvl, count in rows if lvl is not None}
    print(f"[b] 事实表覆盖指标数（按机构层级）: {coverage or '无层级数据，未分层'}")
    return {"fact_orgs": len(fact_orgs), "scope_orgs": len(scope_orgs), "branch_orgs": branch_orgs}


def check_additivity(
    connection, layout: SourceLayout, parent_field: str, metric_codes: list[str]
) -> dict[str, str]:
    """检查 c)：法人 = Σ其支行（最近两个快照，存量 + 两期变动）。"""
    if not parent_field:
        print("[c] 跳过：无上级机构字段，无法确定法人-支行归属")
        return {}
    dates = [
        row[0]
        for row in connection.execute(
            text(
                f"SELECT DISTINCT {layout.fact_date_field} FROM {layout.fact_table} "
                f"ORDER BY {layout.fact_date_field} DESC LIMIT 2"
            )
        ).fetchall()
    ]
    if len(dates) < 2:
        print("[c] 跳过：事实表快照不足两期")
        return {}
    dates = sorted(dates)
    print(f"[c] 核验快照: {dates[0]} / {dates[1]}")

    snapshot = _latest_snapshot_filter(layout)
    branch_parent = {
        str(code): str(parent)
        for code, parent in connection.execute(
            text(
                f"SELECT {layout.org_code_field}, {parent_field} FROM {layout.org_table} "
                f"WHERE {layout.hierarchy_field} = :branch "
                f"AND {parent_field} IS NOT NULL AND {parent_field} <> ''{snapshot}"
            ),
            {"branch": BRANCH_HIER_CODE},
        ).fetchall()
    }
    children_by_parent: dict[str, list[str]] = {}
    for branch, parent in branch_parent.items():
        children_by_parent.setdefault(parent, []).append(branch)

    verdicts: dict[str, str] = {}
    for metric_code in metric_codes:
        # 每个日期取各机构值；数据湖同机构多批记录时按批次排序取最新一批。
        values: dict[Any, dict[str, Decimal]] = {}
        for day in dates:
            order = f" ORDER BY {layout.fact_batch_order}" if layout.fact_batch_order else ""
            rows = connection.execute(
                text(
                    f"SELECT {layout.fact_org_field}, {layout.fact_value_field} "
                    f"FROM {layout.fact_table} "
                    f"WHERE {layout.fact_metric_field} = :metric "
                    f"AND {layout.fact_date_field} = :day{order}"
                ),
                {"metric": metric_code, "day": day},
            ).fetchall()
            per_org: dict[str, Decimal] = {}
            for org, value in rows:
                if org is None or value is None or str(org) in per_org:
                    continue
                per_org[str(org)] = Decimal(str(value))
            values[day] = per_org
        checked = 0
        failed: list[str] = []
        for parent, children in sorted(children_by_parent.items()):
            pairs = []
            for day in dates:
                day_values = values[day]
                if parent not in day_values:
                    break
                child_sum = sum(
                    (day_values[child] for child in children if child in day_values),
                    Decimal("0"),
                )
                pairs.append((day_values[parent], child_sum))
            if len(pairs) < 2:
                continue  # 该法人缺任一快照数据，不纳入判定
            checked += 1
            stock_ok = all(abs(total - child_sum) < TOLERANCE for total, child_sum in pairs)
            delta_ok = abs(
                (pairs[1][0] - pairs[0][0]) - (pairs[1][1] - pairs[0][1])
            ) < TOLERANCE
            if not (stock_ok and delta_ok):
                failed.append(parent)
        if not checked:
            verdicts[metric_code] = "SKIP（无完整父子快照数据）"
        elif failed:
            verdicts[metric_code] = f"FAIL（{len(failed)}/{checked} 法人不平，示例 {failed[:3]}）"
        else:
            verdicts[metric_code] = f"PASS（核对 {checked} 家法人）"
    for metric_code, verdict in verdicts.items():
        print(f"[c] {metric_code}: {verdict}")
    return verdicts


def conclude(
    org_check: dict[str, Any], fact_check: dict[str, Any], additivity: dict[str, str]
) -> tuple[str, bool]:
    """汇总结论与“是否建议开启支行钻取”；返回 (结论, 建议开启)。"""
    if not fact_check["branch_orgs"]:
        return "NO_BRANCH_FACTS（事实表无支行级数据，无钻取对象）", False
    if not org_check["parent_field"]:
        return "HIERARCHY_INCOMPLETE（未发现上级机构字段或无上级数据）", False
    closure = org_check.get("closure")
    if closure is None:
        return "HIERARCHY_INCOMPLETE（缺层级列，无法验证父子闭环）", False
    if closure.get("broken"):
        return "HIERARCHY_INCOMPLETE（支行上级未闭环落在 1/3 层级集合内）", False
    failed = [code for code, verdict in additivity.items() if verdict.startswith("FAIL")]
    if failed:
        return f"HIERARCHY_OK，但可加性抽查未通过（{failed}），不建议开启支行钻取", False
    return "HIERARCHY_OK", True


def main() -> int:
    parser = argparse.ArgumentParser(description="机构层级只读核实（SIT 数据湖 / 本地库）")
    parser.add_argument(
        "--config", type=Path, default=PROJECT_DIR / ".env", help="环境配置文件路径"
    )
    parser.add_argument(
        "--local", action="store_true", help="对本地 ask_metric_app 跑同构检查"
    )
    parser.add_argument("--org-table", default="ads_lake.fdm_pub_org_inf_all")
    parser.add_argument("--fact-table", default="ads_lake.adm_rmt_pub_gnrl_drv_indcr_tab")
    parser.add_argument(
        "--metric-codes",
        default=",".join(DEFAULT_METRIC_CODES),
        help="可加性抽查指标编码，逗号分隔",
    )
    args = parser.parse_args()

    env = dotenv_values(args.config)
    url = env.get("APP_DATABASE_URL") if args.local else env.get("QUERY_DATABASE_URL")
    if not url:
        name = "APP_DATABASE_URL" if args.local else "QUERY_DATABASE_URL"
        raise SystemExit(f"{name} 未配置（{args.config}）")
    layout = _local_layout() if args.local else _sit_layout(args)
    for label, name in (
        ("机构表", layout.org_table),
        ("事实表", layout.fact_table),
        ("层级字段", layout.hierarchy_field),
    ):
        _check_identifier(name, label)

    metric_codes = [code.strip() for code in args.metric_codes.split(",") if code.strip()]
    mode = "本地 ask_metric_app" if args.local else "SIT 数据湖"
    print(f"机构层级核实（{mode}，只读）")
    engine = create_engine(url)
    with engine.connect() as connection:
        org_check = check_org_levels(connection, layout)
        fact_check = check_fact_coverage(connection, layout, org_check["has_level_column"])
        parent_field = (
            org_check["parent_field"] if org_check["has_level_column"] else ""
        )
        additivity = check_additivity(connection, layout, parent_field, metric_codes)
    conclusion, recommend = conclude(org_check, fact_check, additivity)
    print(f"结论: {conclusion}")
    print(f"是否建议开启支行钻取: {'是' if recommend else '否'}")
    return 0 if conclusion == "HIERARCHY_OK" and recommend else 1


if __name__ == "__main__":
    raise SystemExit(main())
