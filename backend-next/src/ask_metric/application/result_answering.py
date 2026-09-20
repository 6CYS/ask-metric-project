from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Literal

from ask_metric.domain.query_execution import QueryExecutionPlan, json_safe
from ask_metric.domain.value_presentation import money_reply_fields

_MAX_FACTS_IN_ANSWER = 20
_MONEY_UNITS = {"元", "万元"}
_COUNT_UNITS = {"户"}


def _segment(text: str, *, bold: bool = False) -> dict[str, Any]:
    return {"text": text, "bold": bold}


def _paragraph_block(segments: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "paragraph", "segments": segments}


def _list_block(items: list[list[dict[str, Any]]]) -> dict[str, Any]:
    return {"type": "list", "ordered": False, "items": items}


def _table_block(
    header: list[list[dict[str, Any]]],
    rows: list[list[list[dict[str, Any]]]],
    aligns: list[str],
) -> dict[str, Any]:
    return {"type": "table", "header": header, "rows": rows, "aligns": aligns}


def _join_segments(segments: list[dict[str, Any]]) -> str:
    return "".join(str(segment.get("text") or "") for segment in segments)


def flatten_blocks(blocks: list[dict[str, Any]]) -> str:
    """把结构化块拍平成纯文本：段落顺序拼接、列表项拼行、表格按制表符分列。"""
    parts: list[str] = []
    for block in blocks:
        kind = block.get("type")
        if kind == "paragraph":
            parts.append(_join_segments(block.get("segments") or []))
        elif kind == "list":
            parts.append(
                "\n".join(_join_segments(item) for item in block.get("items") or [])
            )
        elif kind == "table":
            lines = [
                "\t".join(_join_segments(cell) for cell in block.get("header") or []),
                *(
                    "\t".join(_join_segments(cell) for cell in row)
                    for row in block.get("rows") or []
                ),
            ]
            parts.append("\n".join(lines))
    return "\n".join(part for part in parts if part)


@dataclass(frozen=True)
class ResultFact:
    """An immutable reference to one complete query or derived result row."""

    fact_id: str
    source: Literal[
        "query_result", "period_comparison", "entity_comparison"
    ]
    row_index: int
    fields: dict[str, Any]
    fingerprint: str

    def audit_record(self) -> dict[str, Any]:
        return {
            "fact_id": self.fact_id,
            "source": self.source,
            "row_index": self.row_index,
            "fingerprint": self.fingerprint,
        }


@dataclass(frozen=True)
class RenderedFactAnswer:
    message: str
    template_id: str
    fact_ids: list[str]
    facts: list[ResultFact]
    # 与 message 同源的结构化块，供前端免解析渲染；块拍平后与 message 内容一致。
    blocks: list[dict[str, Any]]

    def audit_record(self) -> dict[str, Any]:
        return {
            "mode": "deterministic_fact_renderer",
            "template_id": self.template_id,
            "fact_ids": self.fact_ids,
            "facts": [fact.audit_record() for fact in self.facts],
        }


def render_fact_answer(
    plan: QueryExecutionPlan,
    rows: list[dict[str, Any]],
    comparisons: list[dict[str, Any]],
) -> RenderedFactAnswer:
    """Render factual answers without allowing a model to rewrite query facts."""

    row_source: Literal["query_result", "period_comparison"] = (
        "period_comparison"
        if plan.shape.value == "metric_period_compare"
        else "query_result"
    )
    row_facts = _build_facts(rows, source=row_source)
    comparison_facts = _build_facts(comparisons, source="entity_comparison")
    selected = comparison_facts or row_facts

    if plan.shape.value == "metric_availability":
        groups: dict[tuple[str, str], list[str]] = {}
        for row in rows:
            key = (str(row.get("org_name", row.get("org_code", ""))),
                   str(row.get("metric_name", row.get("metric_code", ""))))
            groups.setdefault(key, []).append(str(row["available_period"]))
        selection = plan.parameters.get("selection", "all")
        label = {"earliest": "最早有数据的期间", "latest": "最新有数据的期间"}.get(
            selection, "有数据的期间")
        items: list[list[dict[str, Any]]] = []
        for (org, metric), periods in groups.items():
            items.append([
                _segment(f"{org}的{metric}{label}："),
                _segment("、".join(periods[:20]), bold=True),
                _segment("；更多期间请查看数据明细。" if len(periods) > 20 else "。"),
            ])
        message = (
            "\n".join(_join_segments(item) for item in items)
            or "查询完成，暂无匹配的有值日期。"
        )
        blocks = [_list_block(items)] if items else [_paragraph_block([_segment(message)])]
        return RenderedFactAnswer(message=message, template_id="metric_availability",
                                  fact_ids=[fact.fact_id for fact in row_facts],
                                  facts=row_facts, blocks=blocks)

    if not selected:
        message = "查询完成，暂无匹配数据。"
        return RenderedFactAnswer(
            message=message,
            template_id="no_data",
            fact_ids=[],
            facts=[*row_facts, *comparison_facts],
            blocks=[_paragraph_block([_segment(message)])],
        )
    if len(selected) > _MAX_FACTS_IN_ANSWER:
        message = (
            f"查询完成，共返回 {len(selected)} 行，"
            "具体结果请查看下方表格或下载明细。"
        )
        return RenderedFactAnswer(
            message=message,
            template_id="large_result_summary",
            fact_ids=[fact.fact_id for fact in selected],
            facts=[*row_facts, *comparison_facts],
            blocks=[_paragraph_block([_segment(message)])],
        )
    if comparison_facts:
        message, blocks = _render_entity_comparisons(comparison_facts, rows)
        template_id = "entity_comparison"
    elif plan.shape.value == "metric_period_compare":
        message, blocks = _render_period_comparisons(row_facts)
        template_id = "period_comparison"
    elif plan.shape.value == "metric_ranking":
        message, blocks = _render_standard_facts(row_facts)
        template_id = "ranking_top_n"
    else:
        message, blocks = _render_standard_facts(row_facts)
        template_id = (
            "single_metric_value" if len(row_facts) == 1 else "multi_dimension_result"
        )
    return RenderedFactAnswer(
        message=message,
        template_id=template_id,
        fact_ids=[fact.fact_id for fact in selected],
        facts=[*row_facts, *comparison_facts],
        blocks=blocks,
    )


def _build_facts(
    rows: list[dict[str, Any]],
    *,
    source: Literal[
        "query_result", "period_comparison", "entity_comparison"
    ],
) -> list[ResultFact]:
    facts = []
    for index, row in enumerate(rows):
        fields = json_safe(dict(row))
        canonical = json.dumps(
            {"source": source, "row_index": index, "fields": fields},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        facts.append(
            ResultFact(
                fact_id=f"fact_{fingerprint[:16]}",
                source=source,
                row_index=index,
                fields=fields,
                fingerprint=fingerprint,
            )
        )
    return facts


def _render_standard_facts(
    facts: list[ResultFact],
) -> tuple[str, list[dict[str, Any]]]:
    """message 由 segments 拼接得到，保证正文与结构化块同源不漂移。"""
    grouped: OrderedDict[str | None, list[ResultFact]] = OrderedDict()
    for fact in facts:
        date_label = _format_date(fact.fields.get("stat_date"))
        grouped.setdefault(date_label, []).append(fact)

    if len(facts) == 1:
        fact = facts[0]
        stat_date = _format_date(fact.fields.get("stat_date"))
        prefix = f"{stat_date}，" if stat_date else ""
        segments = (
            ([_segment(prefix)] if prefix else [])
            + _standard_fact_body(fact.fields)
            + [_segment("。")]
        )
        return _join_segments(segments), [_paragraph_block(segments)]

    sections = []
    blocks: list[dict[str, Any]] = []
    multiple_dates = len(grouped) > 1
    for date_label, date_facts in grouped.items():
        segments: list[dict[str, Any]] = []
        if date_label:
            separator = "：" if multiple_dates or len(date_facts) > 1 else "，"
            segments.append(_segment(f"{date_label}{separator}"))
        for index, fact in enumerate(date_facts):
            if index:
                segments.append(_segment("；"))
            segments.extend(_standard_fact_body(fact.fields))
        segments.append(_segment("。"))
        sections.append(_join_segments(segments))
        blocks.append(_paragraph_block(segments))
    return "".join(sections), blocks


def _standard_fact_body(fields: dict[str, Any]) -> list[dict[str, Any]]:
    """单条事实正文的片段序列；关键数值（指标值/名次）标 bold。"""
    org = str(fields.get("org_name") or "")
    metric = str(fields.get("metric_name") or "查询指标")
    value = fields.get("metric_value")
    unit = str(fields.get("unit") or "")
    rank = fields.get("rank")
    subject = f"{org}{metric}" or "查询结果"
    if "排名" in metric and value is not None:
        return [
            _segment(f"{subject}为"),
            _segment(f"第{_format_integer(value)}名", bold=True),
        ]
    if rank is not None:
        rank_text = _format_integer(rank)
        return [
            _segment(f"第{rank_text}名", bold=True),
            _segment(f"{subject}为"),
            _segment(_format_value(value, unit, metric), bold=True),
        ]
    return [
        _segment(f"{subject}为"),
        _segment(_format_value(value, unit, metric), bold=True),
    ]


_PERIOD_COMPARE_HEADER = ["机构指标", "期间", "数值", "对比基期", "差额", "变动率"]
_PERIOD_COMPARE_ALIGNS = ["left", "left", "right", "left", "right", "right"]


def _render_period_comparisons(
    facts: list[ResultFact],
) -> tuple[str, list[dict[str, Any]]]:
    """正常行进表格块；current_missing/base_missing/base_zero 异常行降级为段落块。"""
    messages = []
    table_rows: list[list[list[dict[str, Any]]]] = []
    degraded_blocks: list[dict[str, Any]] = []
    for fact in facts:
        fields = fact.fields
        subject = _subject(fields)
        status = str(fields.get("status") or "")
        current_date = _format_date(fields.get("current_date")) or "本期"
        base_date = _format_date(fields.get("base_date")) or "基期"
        unit = str(fields.get("unit") or "")
        current = fields.get("current_value")
        base = fields.get("base_value")
        if status == "current_missing":
            text = f"{subject}未查询到{current_date}数据"
            messages.append(text)
            degraded_blocks.append(_paragraph_block([_segment(text)]))
            continue
        current_text = _format_value(current, unit, str(fields.get("metric_name") or ""))
        if status == "base_missing":
            text = f"{subject}{current_date}为{current_text}，未查询到{base_date}数据"
            messages.append(text)
            degraded_blocks.append(_paragraph_block([_segment(text)]))
            continue
        base_text = _format_value(base, unit, str(fields.get("metric_name") or ""))
        difference = fields.get("difference")
        difference_text = _format_value(
            difference, unit, str(fields.get("metric_name") or "")
        )
        if status == "base_zero":
            text = (
                f"{subject}{current_date}为{current_text}，{base_date}为{base_text}，"
                f"差额为{difference_text}，因基期值为0无法计算变动率"
            )
            messages.append(text)
            degraded_blocks.append(_paragraph_block([_segment(text)]))
            continue
        change_rate = _format_ratio_as_percent(fields.get("change_rate"))
        difference_decimal = _decimal_or_none(difference) or Decimal("0")
        direction = "增加" if difference_decimal >= 0 else "减少"
        absolute_difference = _format_value(
            abs(difference_decimal),
            unit,
            str(fields.get("metric_name") or ""),
        )
        messages.append(
            f"{subject}{current_date}为{current_text}，{base_date}为{base_text}，"
            f"较基期{direction}{absolute_difference}，"
            f"变动率为{change_rate}"
        )
        table_rows.append([
            [_segment(subject)],
            [_segment(current_date)],
            [_segment(current_text, bold=True)],
            [_segment(f"{base_date}为{base_text}")],
            [_segment(f"{direction}{absolute_difference}", bold=True)],
            [_segment(change_rate, bold=True)],
        ])
    blocks: list[dict[str, Any]] = []
    if table_rows:
        blocks.append(_table_block(
            [[_segment(title)] for title in _PERIOD_COMPARE_HEADER],
            table_rows,
            list(_PERIOD_COMPARE_ALIGNS),
        ))
    blocks.extend(degraded_blocks)
    return "；".join(messages) + "。", blocks


_ENTITY_COMPARE_HEADER = [
    "日期", "指标", "机构", "数值", "对比机构", "对比数值", "差额", "倍数", "较高机构",
]
_ENTITY_COMPARE_ALIGNS = [
    "left", "left", "left", "right", "left", "right", "right", "right", "left",
]


def _render_entity_comparisons(
    facts: list[ResultFact], rows: list[dict[str, Any]]
) -> tuple[str, list[dict[str, Any]]]:
    metric_names = {
        str(row.get("metric_code")): str(row.get("metric_name") or "")
        for row in rows
    }
    messages = []
    table_rows: list[list[list[dict[str, Any]]]] = []
    for fact in facts:
        fields = fact.fields
        metric_code = str(fields.get("metric_code") or "")
        metric = metric_names.get(metric_code) or "查询指标"
        date_label = _format_date(fields.get("stat_date"))
        unit = str(fields.get("unit") or "")
        left_org = str(fields.get("left_org") or "左侧机构")
        right_org = str(fields.get("right_org") or "右侧机构")
        left = _format_value(fields.get("left_value"), unit, metric)
        right = _format_value(fields.get("right_value"), unit, metric)
        difference = _format_value(fields.get("difference"), unit, metric)
        prefix = f"{date_label}，" if date_label else ""
        body = (
            f"{prefix}{left_org}{metric}为{left}，{right_org}为{right}，"
            f"差额为{difference}"
        )
        ratio = fields.get("ratio")
        ratio_text = ""
        if ratio is not None:
            ratio_text = f"{_format_decimal_plain(ratio)}倍"
            body += f"，前者为后者的{_format_decimal_plain(ratio)}倍"
        higher_org = fields.get("higher_org")
        if higher_org:
            body += f"，{higher_org}较高"
        messages.append(body)
        table_rows.append([
            [_segment(date_label or "")],
            [_segment(metric)],
            [_segment(left_org)],
            [_segment(left, bold=True)],
            [_segment(right_org)],
            [_segment(right, bold=True)],
            [_segment(difference, bold=True)],
            [_segment(ratio_text, bold=True)],
            [_segment(str(higher_org or ""))],
        ])
    blocks = [_table_block(
        [[_segment(title)] for title in _ENTITY_COMPARE_HEADER],
        table_rows,
        list(_ENTITY_COMPARE_ALIGNS),
    )]
    return "；".join(messages) + "。", blocks


def _subject(fields: dict[str, Any]) -> str:
    return "".join(
        str(fields.get(key) or "") for key in ("org_name", "metric_name")
    ) or "查询指标"


def _format_value(value: Any, unit: str, metric_name: str) -> str:
    if value is None:
        return "暂无数据"
    if "排名" in metric_name:
        return f"第{_format_integer(value)}名"
    decimal = _decimal_or_none(value)
    if decimal is None:
        return f"{value}{unit}"
    if unit in _MONEY_UNITS:
        reply = money_reply_fields(decimal, unit)
        if not reply:
            return "暂无数据"
        return f"{Decimal(reply['reply_value']):,.2f}{reply['reply_unit']}"
    if unit in _COUNT_UNITS:
        return f"{decimal.quantize(Decimal('1'), rounding=ROUND_HALF_UP):,.0f}{unit}"
    if unit in {"%", "％"}:
        # Stored percentage values already use percentage points: do not multiply by 100.
        return _format_percentage(decimal)
    return f"{_format_decimal_plain(decimal)}{unit}"


def _format_ratio_as_percent(value: Any) -> str:
    decimal = _decimal_or_none(value)
    if decimal is None:
        return "无法计算"
    return _format_percentage(decimal * Decimal("100"))


def _format_percentage(value: Decimal) -> str:
    rounded = value.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
    # Decimal preserves signed zero after rounding; avoid displaying "-0%".
    return f"{_format_decimal_plain(rounded) if rounded else '0'}%"


def _format_integer(value: Any) -> str:
    decimal = _decimal_or_none(value)
    if decimal is None:
        return str(value)
    return f"{decimal.quantize(Decimal('1'), rounding=ROUND_HALF_UP):,.0f}"


def _format_decimal_plain(value: Any) -> str:
    decimal = _decimal_or_none(value)
    if decimal is None:
        return str(value)
    text = format(decimal, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value).replace(",", ""))
    except (InvalidOperation, ValueError):
        return None


def _format_date(value: Any) -> str | None:
    parsed: date | None
    if isinstance(value, datetime):
        parsed = value.date()
    elif isinstance(value, date):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = date.fromisoformat(value)
        except ValueError:
            parsed = None
    else:
        parsed = None
    if parsed is None:
        return None
    return f"{parsed.year}年{parsed.month:02d}月{parsed.day:02d}日"
