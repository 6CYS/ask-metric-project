from __future__ import annotations

import calendar
import re
from datetime import date, timedelta
from typing import Any

from ask_metric.domain.metric_matching import normalize_semantic_text
from ask_metric.domain.semantics import (
    LogicalDSL,
    LogicalFilter,
    LogicalTimeRange,
    MetricCatalogItem,
    OrganizationCatalogItem,
    SlotFrame,
)
from ask_metric.infrastructure.semantic.configuration import SemanticConfig


class SemanticValidationError(ValueError):
    def __init__(self, missing: list[str], message: str) -> None:
        super().__init__(message)
        self.missing = missing


_CALENDAR_MONTH_TOKEN = r"(?:\d{1,2}|[一二三四五六七八九十]{1,3})"


def normalize_slot_frame(
    frame: SlotFrame,
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
) -> SlotFrame:
    frame.missing = [
        item for item in frame.missing if item in {"metrics", "time", "orgs", "dimensions", "ops"}
    ]
    metric_by_code = {item.code: item for item in metrics}
    normalized_metrics = []
    invalid_metrics = False
    for metric in frame.metrics:
        catalog_item = metric_by_code.get(metric.code)
        if catalog_item is None or catalog_item.name != metric.name:
            invalid_metrics = True
            continue
        if catalog_item.code not in {item.code for item in normalized_metrics}:
            normalized_metrics.append(metric)
    frame.metrics = normalized_metrics
    requires_metric = frame.task.value in {"metric_query", "metric_explanation"}
    if invalid_metrics or (requires_metric and not frame.metrics):
        if "metrics" not in frame.missing:
            frame.missing.append("metrics")

    known_org_names = {item.name for item in organizations}
    aliases = {
        normalize_semantic_text(value): item.name
        for item in organizations
        for value in [item.name, *item.aliases]
    }
    normalized_orgs: list[str] = []
    for org in frame.orgs:
        standard_name = aliases.get(normalize_semantic_text(org))
        if standard_name and standard_name not in normalized_orgs:
            normalized_orgs.append(standard_name)
        elif org in known_org_names and org not in normalized_orgs:
            normalized_orgs.append(org)
    frame.orgs = normalized_orgs
    return frame


def to_logical_dsl(
    frame: SlotFrame,
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
    config: SemanticConfig,
    today: date,
    resolved_time_override: LogicalTimeRange | None = None,
) -> LogicalDSL:
    if frame.missing:
        raise SemanticValidationError(frame.missing, "SlotFrame still requires clarification")
    metric_by_code = {item.code: item for item in metrics}
    org_by_name = {item.name: item.code for item in organizations}
    metric_codes = []
    for metric in frame.metrics:
        item = metric_by_code.get(metric.code)
        if item is None or item.name != metric.name:
            raise SemanticValidationError(["metrics"], "Metric is not in the official catalog")
        metric_codes.append(item.code)
    dimensions = [config.dimension_names.get(value, value) for value in frame.dimensions]
    filters = [
        LogicalFilter(
            dimension=config.dimension_names.get(item.field, item.field),
            op=item.op,
            value=item.value,
        )
        for item in frame.filters
    ]
    return LogicalDSL(
        task=frame.task,
        metrics=metric_codes,
        # 引用追问且时间未变时，沿用来源已确认的规范区间，不以今天重新解释
        time=(
            resolved_time_override
            if resolved_time_override is not None
            else parse_time_expression(frame.time, today=today, default=config.default_time)
        ),
        orgs=[org_by_name.get(name, name) for name in frame.orgs],
        dimensions=dimensions,
        filters=filters,
        ops=[_normalize_operation(item.model_dump(mode="json"), config) for item in frame.ops],
        options=frame.options,
    )


def parse_time_expression(
    expression: str | None, *, today: date, default: str = "latest"
) -> LogicalTimeRange:
    if not expression:
        return LogicalTimeRange(preset="latest" if default == "latest" else None)
    value = expression.strip()
    if value in {"latest", "最新", "最近", "最新一期", "最近一期", "当前最新"}:
        return LogicalTimeRange(preset="latest")
    current_year_match = re.fullmatch(rf"今年({_CALENDAR_MONTH_TOKEN})月(末)?", value)
    if current_year_match:
        month = _parse_calendar_month(current_year_match.group(1))
        return _month_range(today.year, month, month_end=bool(current_year_match.group(2)))
    years_ago_match = re.fullmatch(rf"(\d+)年前({_CALENDAR_MONTH_TOKEN})月(末)?", value)
    if years_ago_match:
        years = int(years_ago_match.group(1))
        month = _parse_calendar_month(years_ago_match.group(2))
        return _month_range(today.year - years, month, month_end=bool(years_ago_match.group(3)))
    two_years_ago_month_match = re.fullmatch(
        rf"前年({_CALENDAR_MONTH_TOKEN})月(末)?", value
    )
    if two_years_ago_month_match:
        month = _parse_calendar_month(two_years_ago_month_match.group(1))
        return _month_range(
            today.year - 2,
            month,
            month_end=bool(two_years_ago_month_match.group(2)),
        )
    previous_year_month_match = re.fullmatch(
        rf"(?:去年|上年)({_CALENDAR_MONTH_TOKEN})月(末)?", value
    )
    if previous_year_month_match:
        month = _parse_calendar_month(previous_year_month_match.group(1))
        return _month_range(
            today.year - 1,
            month,
            month_end=bool(previous_year_month_match.group(2)),
        )
    compare_match = re.fullmatch(
        rf"(\d{{4}})年({_CALENDAR_MONTH_TOKEN})月末(?:较|比|对比|比较)"
        rf"({_CALENDAR_MONTH_TOKEN})月末",
        value,
    )
    if compare_match:
        year = int(compare_match.group(1))
        current_month = _parse_calendar_month(compare_match.group(2))
        current_date = date(year, current_month, calendar.monthrange(year, current_month)[1])
        return LogicalTimeRange(start=current_date, end=current_date)
    if value in {"今天", "今日"}:
        return LogicalTimeRange(start=today, end=today)
    if value == "昨天":
        target = today - timedelta(days=1)
        return LogicalTimeRange(start=target, end=target)
    fixed_holiday_match = re.fullmatch(
        r"(?:(\d{4})年)?(双十一|双十二|元旦|国庆)", value
    )
    if fixed_holiday_match:
        year_text, holiday = fixed_holiday_match.groups()
        year = int(year_text or today.year)
        month, day = {
            "双十一": (11, 11),
            "双十二": (12, 12),
            "元旦": (1, 1),
            "国庆": (10, 1),
        }[holiday]
        target = date(year, month, day)
        return LogicalTimeRange(start=target, end=target)
    if value == "本月":
        return LogicalTimeRange(start=today.replace(day=1), end=today)
    if value in {"上个月", "上月"}:
        end = today.replace(day=1) - timedelta(days=1)
        return LogicalTimeRange(start=end.replace(day=1), end=end)
    if value in {"本季度", "本季"}:
        start_month = ((today.month - 1) // 3) * 3 + 1
        return LogicalTimeRange(start=date(today.year, start_month, 1), end=today)
    if value in {"上季度", "上季"}:
        current_quarter_start_month = ((today.month - 1) // 3) * 3 + 1
        current_quarter_start = date(today.year, current_quarter_start_month, 1)
        end = current_quarter_start - timedelta(days=1)
        start_month = ((end.month - 1) // 3) * 3 + 1
        return LogicalTimeRange(start=date(end.year, start_month, 1), end=end)
    explicit_quarter_match = re.fullmatch(
        r"(?:(今年|本年)|(\d{4})年)?(?:第)?([一二三四1-4])季度",
        value,
    )
    if explicit_quarter_match:
        year = int(explicit_quarter_match.group(2) or today.year)
        quarter_text = explicit_quarter_match.group(3)
        quarter = (
            int(quarter_text)
            if quarter_text.isdigit()
            else {"一": 1, "二": 2, "三": 3, "四": 4}[quarter_text]
        )
        start_month = (quarter - 1) * 3 + 1
        end_month = start_month + 2
        return LogicalTimeRange(
            start=date(year, start_month, 1),
            end=date(year, end_month, calendar.monthrange(year, end_month)[1]),
        )
    if value in {"今年", "本年"}:
        return LogicalTimeRange(start=date(today.year, 1, 1), end=today)
    if value in {"去年", "上年"}:
        year = today.year - 1
        return LogicalTimeRange(start=date(year, 1, 1), end=date(year, 12, 31))
    if value == "前年":
        year = today.year - 2
        return LogicalTimeRange(start=date(year, 1, 1), end=date(year, 12, 31))
    iso_range_match = re.fullmatch(
        r"(\d{4}-\d{1,2}-\d{1,2})\s*(?:至|到|~|～)\s*(\d{4}-\d{1,2}-\d{1,2})",
        value,
    )
    if iso_range_match:
        start, end = (date.fromisoformat(item) for item in iso_range_match.groups())
        if start > end:
            raise SemanticValidationError(["time"], "Time range start is after end")
        return LogicalTimeRange(start=start, end=end)
    range_match = re.fullmatch(
        rf"(\d{{4}})年({_CALENDAR_MONTH_TOKEN})月份?(?:末|底)?\s*"
        rf"(?:至|到|~|～|-)\s*"
        rf"(?:(\d{{4}})年)?({_CALENDAR_MONTH_TOKEN})月份?(?:末|底)?",
        value,
    )
    if range_match:
        start_year = int(range_match.group(1))
        start_month = _parse_calendar_month(range_match.group(2))
        end_year = int(range_match.group(3) or start_year)
        end_month = _parse_calendar_month(range_match.group(4))
        start = date(start_year, start_month, 1)
        end = date(end_year, end_month, calendar.monthrange(end_year, end_month)[1])
        if start > end:
            raise SemanticValidationError(["time"], "Time range start is after end")
        return LogicalTimeRange(
            start=start,
            end=end,
        )
    month_match = re.fullmatch(rf"(\d{{4}})年({_CALENDAR_MONTH_TOKEN})月(末)?", value)
    if month_match:
        year = int(month_match.group(1))
        month = _parse_calendar_month(month_match.group(2))
        return _month_range(year, month, month_end=bool(month_match.group(3)))
    yearless_month_match = re.fullmatch(rf"({_CALENDAR_MONTH_TOKEN})月(末)?", value)
    if yearless_month_match:
        month = _parse_calendar_month(yearless_month_match.group(1))
        return _month_range(today.year, month, month_end=bool(yearless_month_match.group(2)))
    date_match = re.fullmatch(r"(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?", value)
    if date_match:
        target = date(*map(int, date_match.groups()))
        return LogicalTimeRange(start=target, end=target)
    yearless_date_match = re.fullmatch(r"(\d{1,2})月(\d{1,2})日", value)
    if yearless_date_match:
        target = date(today.year, *map(int, yearless_date_match.groups()))
        return LogicalTimeRange(start=target, end=target)
    recent_match = re.fullmatch(r"近\s*(\d+)\s*天", value)
    if recent_match:
        days = int(recent_match.group(1))
        if days < 1 or days > 3660:
            raise SemanticValidationError(["time"], "Relative time is outside supported range")
        return LogicalTimeRange(start=today - timedelta(days=days - 1), end=today)
    recent_month_match = re.fullmatch(
        r"近\s*(\d+|[一二两三四五六七八九十]+)\s*个?月",
        value,
    )
    if recent_month_match:
        months = _parse_month_count(recent_month_match.group(1))
        if months < 1 or months > 120:
            raise SemanticValidationError(["time"], "Relative time is outside supported range")
        month_index = today.year * 12 + today.month - months
        start_year, start_month_zero = divmod(month_index, 12)
        return LogicalTimeRange(
            start=date(start_year, start_month_zero + 1, 1),
            end=today,
        )
    raise SemanticValidationError(["time"], f"Unsupported time expression: {expression}")


def _month_range(year: int, month: int, *, month_end: bool) -> LogicalTimeRange:
    end = date(year, month, calendar.monthrange(year, month)[1])
    return LogicalTimeRange(start=end if month_end else date(year, month, 1), end=end)


def _parse_calendar_month(value: str) -> int:
    month = _parse_month_count(value)
    if not 1 <= month <= 12:
        raise SemanticValidationError(["time"], f"Invalid calendar month: {value}")
    return month


def _parse_month_count(value: str) -> int:
    if value.isdigit():
        return int(value)
    digits = {
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    if value == "十":
        return 10
    if "十" in value:
        left, right = value.split("十", 1)
        return digits.get(left, 1) * 10 + digits.get(right, 0)
    return digits.get(value, 0)


def query_shape_for(frame: SlotFrame) -> str:
    task_shapes = {
        "anomaly_detection": "anomaly",
        "trend_forecast": "forecast",
        "metric_explanation": "metric_explanation",
        "data_lineage": "data_lineage",
        "insight_report": "insight_report",
    }
    if frame.task.value != "metric_query":
        return task_shapes[frame.task.value]
    operation_types = {item.type for item in frame.ops}
    if operation_types & {"detail", "drill_down"}:
        return "metric_detail"
    if "aggregate" in operation_types:
        return "metric_aggregate"
    if operation_types & {"ranking", "top_n"}:
        return "metric_ranking"
    if "period_compare" in operation_types:
        return "metric_period_compare"
    if "trend" in operation_types:
        return "metric_trend"
    return "metric_value"


def _normalize_operation(operation: dict[str, Any], config: SemanticConfig) -> dict[str, Any]:
    if operation["type"] not in config.operations:
        raise SemanticValidationError(["ops"], "Operation is not allowed")
    if "dimension" in operation:
        operation["dimension"] = config.dimension_names.get(
            operation["dimension"], operation["dimension"]
        )
    return operation
