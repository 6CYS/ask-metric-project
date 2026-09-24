"""日期表达解析：business-context 日期字段与新执行链共用的确定性日历文法。"""

from __future__ import annotations

import calendar
import re
from datetime import date, timedelta

from ask_metric.domain.semantics import LogicalTimeRange


class SemanticValidationError(ValueError):
    def __init__(self, missing: list[str], message: str) -> None:
        super().__init__(message)
        self.missing = missing


_CALENDAR_MONTH_TOKEN = r"(?:\d{1,2}|[一二三四五六七八九十]{1,3})"


def normalize_calendar_text(text: str) -> str:
    """统一日期词内部的排版空白；不拼接数字片段，也不删除一般文本分隔。"""
    number = r"0-9零〇一二两三四五六七八九十"
    text = re.sub(rf"(?<=[{number}])\s+(?=[年月日])", "", text)
    text = re.sub(rf"(?<=[年月])\s+(?=[{number}])", "", text)
    text = re.sub(r"(?<=月)\s+(?=[份末底])", "", text)
    # 提取和从原句剥离日期共用相同写法，避免“月份”残留为待识别指标。
    return re.sub(
        rf"({_CALENDAR_MONTH_TOKEN}月)份?(底)?",
        lambda match: match.group(1) + ("末" if match.group(2) else ""),
        text,
    )


# 日期补全和指标残句识别共用周期语法，避免同一日期词在两处被解释为不同含义。
CALENDAR_PERIOD_PATTERN = (
    r"(?:(?P<year>\d{4})年|(?P<relative>今年|本年|去年|上年|前年))?"
    r"(?P<period>(?:第)?[一二三四1-4]季度|[上下]半年)"
)


def parse_time_expression(
    expression: str | None,
    *,
    today: date,
    default: str = "latest",
    reference_year: int | None = None,
) -> LogicalTimeRange:
    if not expression:
        return LogicalTimeRange(preset="latest" if default == "latest" else None)
    value = normalize_calendar_text(expression).strip()
    if value in {"latest", "最新", "最近", "最新一期", "最近一期", "当前最新"}:
        return LogicalTimeRange(preset="latest")
    year_boundary = re.fullmatch(r"(?:(\d{4})年|(今年|本年|去年|上年|前年)|年)(末|底|初)", value)
    if year_boundary:
        explicit_year, relative, boundary = year_boundary.groups()
        # 年初/年末是单日；明确相对年份不继承历史年份。
        year = int(explicit_year) if explicit_year else (
            today.year if relative else reference_year or today.year
        )
        year -= {"去年": 1, "上年": 1, "前年": 2}.get(relative, 0)
        target = date(year, 1, 1) if boundary == "初" else date(year, 12, 31)
        return LogicalTimeRange(start=target, end=target)
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
    calendar_period = re.fullmatch(CALENDAR_PERIOD_PATTERN, value)
    if calendar_period:
        default_year = (
            today.year if calendar_period.group("relative") else reference_year or today.year
        )
        year = int(calendar_period.group("year") or default_year)
        year -= {"去年": 1, "上年": 1, "前年": 2}.get(calendar_period.group("relative"), 0)
        token = calendar_period.group("period")
        if token.endswith("半年"):
            span = 6
            index = 1 if token == "上半年" else 2
        else:
            span = 3
            number = token.removeprefix("第").removesuffix("季度")
            index = (
                int(number) if number.isdigit()
                else {"一": 1, "二": 2, "三": 3, "四": 4}[number]
            )
        start_month = (index - 1) * span + 1
        end_month = start_month + span - 1
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
        return _month_range(
            reference_year or today.year, month, month_end=bool(yearless_month_match.group(2))
        )
    date_match = re.fullmatch(r"(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?", value)
    if date_match:
        target = date(*map(int, date_match.groups()))
        return LogicalTimeRange(start=target, end=target)
    yearless_date_match = re.fullmatch(r"(\d{1,2})月(\d{1,2})日", value)
    if yearless_date_match:
        target = date(reference_year or today.year, *map(int, yearless_date_match.groups()))
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


# 离散多点分隔符：顿号、中英逗号、"和/及/与"。刻意不含"至/到/~/-"，
# 那些是连续区间的写法，区间不能被拆成离散点（见 semantics.py 的 options 说明）。
_DISCRETE_SEPARATOR = re.compile(r"\s*[、,，]\s*|\s*[和及与]\s*")


def parse_discrete_dates(
    expression: str | None,
    *,
    today: date,
    reference_year: int | None = None,
) -> list[date] | None:
    """把"2026年2月末、3月末、4月末"解析为多个离散单日点的列表。

    仅当能按离散分隔符拆出至少两段、且每段都解析成【单日点】(start==end) 时，
    返回去重升序后的日期列表；任一段无法解析或是区间/预设，则返回 None，
    交由调用方回退到 parse_time_expression 走既有单点/区间路径。
    """
    if not expression:
        return None
    normalized = normalize_calendar_text(expression).strip()
    parts = [part for part in _DISCRETE_SEPARATOR.split(normalized) if part and part.strip()]
    # 只有一段说明没有离散分隔（含区间表达），不构成离散集合。
    if len(parts) < 2:
        return None
    resolved: list[date] = []
    inferred_year = reference_year
    for part in parts:
        try:
            single = parse_time_expression(part, today=today, reference_year=inferred_year)
        except SemanticValidationError:
            return None
        # 任一段是区间/latest/无法定位单日 → 整体不是离散集合，回退。
        if single.start is None or single.end is None or single.start != single.end:
            return None
        resolved.append(single.start)
        # 首个成功片段确定年份，供后续无年份片段继承（"3月末"继承"2026年"）。
        inferred_year = single.start.year
    unique = sorted(dict.fromkeys(resolved))
    return unique if len(unique) >= 2 else None


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
