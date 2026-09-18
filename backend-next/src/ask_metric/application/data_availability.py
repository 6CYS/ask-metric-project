"""按业务日期统计有记录的日期；不展开覆盖表，不推断连续或有效数值。"""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ask_metric.domain.query_execution import QueryTemplateId


class AvailabilityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dimension: Literal["dates", "metrics"] = "dates"
    metric_codes: list[str] = Field(default_factory=list, max_length=100)
    org_codes: list[str] = Field(default_factory=list, max_length=100)
    match: Literal["any", "all"] = "any"
    start: date | None = None
    end: date | None = None
    page: int = Field(default=1, ge=1, le=100000)
    page_size: int = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def validate_scope(self):
        self.metric_codes = list(dict.fromkeys(self.metric_codes))
        self.org_codes = list(dict.fromkeys(self.org_codes))
        if any(
            not code.strip() or len(code) > 150 for code in [*self.metric_codes, *self.org_codes]
        ):
            raise ValueError("目录编码无效")
        if self.start and self.end and self.start > self.end:
            raise ValueError("起始日期不能晚于结束日期")
        if self.dimension == "metrics" and self.match != "any":
            raise ValueError("指标发现仅支持范围内至少一条记录，不能使用共同日期模式")
        if self.match == "all" and not (self.metric_codes and self.org_codes):
            raise ValueError("共同日期需明确机构和指标")
        if self.match == "all" and len(self.metric_codes) * len(self.org_codes) > 100:
            raise ValueError("逐项覆盖最多支持100个机构指标组合，请缩小范围")
        return self


def _date_text(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        value = value.date()
    return value.isoformat() if isinstance(value, date) else str(value)[:10]


def coverage_result(spec, rows, metrics, orgs):
    """SQL 去重并统计总数，空结果仍保留明确的查询范围。"""

    def empty(scope, org_code="", metric_code=""):
        return {
            "scope": scope,
            "org_code": org_code,
            "metric_code": metric_code,
            "org_name": orgs.get(org_code),
            "metric_name": metrics.get(metric_code),
            "date_count": 0,
            "earliest": None,
            "latest": None,
            "dates": [],
            "has_more": False,
        }

    groups = {("any", "", ""): empty("any")}
    detailed = spec.match == "all"
    if detailed:
        groups = {("common", "", ""): empty("common")}
    for row in rows:
        key = (row["scope"], row["org_code"], row["metric_code"])
        if key not in groups:
            raise ValueError("覆盖结果超出本次范围")
        group = groups[key]
        group.update(
            date_count=int(row["date_count"]),
            earliest=_date_text(row["earliest"]),
            latest=_date_text(row["latest"]),
        )
        if row["stat_date"] is not None:
            group["dates"].append(_date_text(row["stat_date"]))
        group["has_more"] = spec.page * spec.page_size < group["date_count"]
    return {
        "status": "succeeded",
        "request": spec.model_dump(mode="json"),
        "mode": "common" if detailed else "overview",
        "metric_count": len(metrics),
        "org_count": len(orgs),
        "org_names": [orgs[code] for code in spec.org_codes if code in orgs],
        "metric_names": [metrics[code] for code in spec.metric_codes if code in metrics],
        "groups": list(groups.values()),
        "page": spec.page,
        "page_size": spec.page_size,
        "notice": "按业务日期统计有记录的日期，不保证连续覆盖或指标值有效。",
    }


def available_metrics_result(spec, rows, metrics, orgs):
    """只展示启用目录中的指标；总数和分页由同一条只读 SQL 产生。"""
    total = int(rows[0]["metric_count"]) if rows else 0
    items = [
        {"metric_code": row["metric_code"], "metric_name": metrics[row["metric_code"]]}
        for row in rows
        if row["metric_code"] is not None
    ]
    return {
        "status": "succeeded",
        "mode": "metrics",
        "request": spec.model_dump(mode="json"),
        "metric_count": total,
        "org_count": len(orgs),
        "org_names": [orgs[code] for code in spec.org_codes if code in orgs],
        "items": items,
        "groups": [],
        "page": spec.page,
        "page_size": spec.page_size,
        "has_more": spec.page * spec.page_size < total,
        "notice": "范围内至少有一条记录的正式指标，不代表所有机构、日期均有有效数值。",
    }


def execute_availability(
    spec: AvailabilityRequest,
    actor,
    execution,
    dialect: str,
    metrics: dict[str, str],
    orgs: dict[str, str],
) -> dict[str, Any]:
    if set(spec.metric_codes) - metrics.keys() or set(spec.org_codes) - orgs.keys():
        raise ValueError("指标或机构未登记或已停用，请重新检索目录")
    requested_orgs = spec.org_codes or list(orgs)
    dsl = {"orgs": requested_orgs}
    if not spec.org_codes:
        dsl["options"] = {"organization_scope": "synchronized_catalog"}
    authorized = execution.permission_service.authorize_logical_dsl(actor=actor, logical_dsl=dsl)
    allowed = set(authorized.get("orgs", [])) & orgs.keys()
    selected_orgs = {code: name for code, name in orgs.items() if code in allowed}
    selected_metrics = {
        code: name
        for code, name in metrics.items()
        if not spec.metric_codes or code in spec.metric_codes
    }
    render = available_metrics_result if spec.dimension == "metrics" else coverage_result
    if not selected_orgs or (spec.dimension == "metrics" and not selected_metrics):
        return render(spec, [], selected_metrics, selected_orgs)
    template = (
        QueryTemplateId.DATA_AVAILABLE_METRICS
        if spec.dimension == "metrics"
        else QueryTemplateId.DATA_AVAILABILITY
    )
    sql = execution.templates.load(dialect=dialect, template=template)
    result = execution.data_source.execute_readonly(
        sql=sql,
        parameters={
            "metric_codes": list(selected_metrics)
            if spec.dimension == "metrics"
            else spec.metric_codes or [""],
            "filter_metrics": bool(spec.metric_codes),
            "org_codes": list(selected_orgs),
            "start_date": spec.start,
            "end_date": spec.end,
            "require_all": spec.match == "all",
            "combination_count": len(spec.org_codes) * len(spec.metric_codes),
            "offset": (spec.page - 1) * spec.page_size,
            "page_end": spec.page * spec.page_size,
        },
    )
    return render(spec, result.rows, selected_metrics, selected_orgs)
