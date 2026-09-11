from __future__ import annotations

import re
from io import BytesIO
from typing import Any, Literal
from zipfile import BadZipFile, ZipFile

from defusedxml.ElementTree import fromstring
from pydantic import BaseModel, Field, ValidationError

from ask_metric.application.test_center import (
    AccuracyCase,
    AccuracySuite,
    AccuracySuiteInput,
    TestCenterRepository,
)
from ask_metric.infrastructure.export.openxml import MAIN_NS
from ask_metric.infrastructure.export.xlsx import build_xlsx

_MAX_FILE_SIZE = 5 * 1024 * 1024
_MAX_UNCOMPRESSED_SIZE = 20 * 1024 * 1024
_MAX_CASES = 1000
_VALID_STATUSES = {"succeeded", "clarification", "out_of_scope", "failed"}
_COLUMNS = [
    "用例编号",
    "用例分类",
    "用户问题",
    "预期状态",
    "预期查询类型",
    "预期指标名称",
    "预期机构名称",
    "预期澄清字段",
    "预期返回行数",
    "预期结果值",
    "允许误差",
]


class AccuracyImportRow(BaseModel):
    row_number: int
    status: Literal["valid", "duplicate", "error"]
    question: str = ""
    message: str = ""
    case: AccuracyCase | None = None


class AccuracyImportPreview(BaseModel):
    filename: str
    mode: Literal["append", "replace"]
    total_rows: int
    valid_count: int
    duplicate_count: int
    error_count: int
    can_import: bool
    rows: list[AccuracyImportRow]
    cases: list[AccuracyCase]


class AccuracyImportConfirm(BaseModel):
    mode: Literal["append", "replace"] = "append"
    cases: list[AccuracyCase] = Field(min_length=1, max_length=_MAX_CASES)


class AccuracyImportResult(BaseModel):
    suite: AccuracySuite
    imported_count: int
    skipped_count: int


def apply_accuracy_import(
    repository: TestCenterRepository,
    suite_id: str,
    payload: AccuracyImportConfirm,
) -> AccuracyImportResult | None:
    suite = repository.get_suite(suite_id)
    if suite is None:
        return None
    merged = list(suite.cases) if payload.mode == "append" else []
    existing_ids = {item.id for item in merged}
    existing_questions = {item.question.strip() for item in merged}
    imported_count = 0
    skipped_count = 0
    for case in payload.cases:
        if case.id in existing_ids or case.question.strip() in existing_questions:
            skipped_count += 1
            continue
        merged.append(case)
        existing_ids.add(case.id)
        existing_questions.add(case.question.strip())
        imported_count += 1
    updated = repository.update_suite(
        suite.id,
        AccuracySuiteInput(
            name=suite.name,
            description=suite.description,
            cases=merged,
        ),
    )
    if updated is None:
        return None
    return AccuracyImportResult(
        suite=updated,
        imported_count=imported_count,
        skipped_count=skipped_count,
    )


def build_accuracy_import_template() -> bytes:
    example = [
        1,
        "单值查询",
        "紫金农商行2026年4月末个人活期存款余额当日数是多少？",
        "succeeded",
        "metric_value",
        "个人活期存款余额当日数",
        "紫金农商行",
        "",
        1,
        1491256.7887,
        0.01,
    ]
    instructions = [
        ["用户问题", "必填，填写实际提交给问数系统的问题。"],
        ["多值字段", "使用英文分号分隔，例如：指标A;指标B。"],
        ["预期状态", "可填写 succeeded、clarification、out_of_scope、failed。"],
        ["追加导入", "保留测试集原用例，重复编号或重复问题自动跳过。"],
        ["覆盖导入", "使用本次有效用例替换测试集原有用例。"],
        ["校验规则", "文件不超过5MB、最多1000条、不能包含公式。"],
    ]
    return build_xlsx(
        [
            ("测试案例", _COLUMNS, [example]),
            ("填写说明", ["字段", "说明"], instructions),
        ]
    )


def preview_accuracy_import(
    content: bytes,
    *,
    filename: str,
    suite: AccuracySuite,
    mode: Literal["append", "replace"],
) -> AccuracyImportPreview:
    if not filename.lower().endswith(".xlsx"):
        raise ValueError("仅支持 .xlsx 格式的Excel文件")
    if not content:
        raise ValueError("上传的Excel文件为空")
    if len(content) > _MAX_FILE_SIZE:
        raise ValueError("Excel文件不能超过5MB")
    table = _read_first_xlsx_sheet(content)
    if not table:
        raise ValueError("Excel中未找到测试案例工作表")
    headers = [str(value).strip() for value in table[0]]
    if "用户问题" not in headers:
        raise ValueError("Excel缺少必填列：用户问题")
    if len(headers) != len(set(headers)):
        raise ValueError("Excel表头存在重复列")
    rows = [row for row in table[1:] if any(_text(value) for value in row)]
    if len(rows) > _MAX_CASES:
        raise ValueError("单次最多导入1000条测试案例")

    existing_ids = {item.id for item in suite.cases} if mode == "append" else set()
    existing_questions = (
        {item.question.strip() for item in suite.cases} if mode == "append" else set()
    )
    seen_ids: set[int] = set()
    seen_questions: set[str] = set()
    next_id = max(existing_ids, default=0) + 1
    previews: list[AccuracyImportRow] = []
    cases: list[AccuracyCase] = []
    for offset, values in enumerate(rows, start=2):
        record = {
            header: values[index] if index < len(values) else None
            for index, header in enumerate(headers)
        }
        try:
            case, next_id = _parse_case(record, next_id=next_id)
        except ValueError as exc:
            previews.append(
                AccuracyImportRow(
                    row_number=offset,
                    status="error",
                    question=_text(record.get("用户问题")),
                    message=str(exc),
                )
            )
            continue
        duplicate_reason = ""
        if case.id in existing_ids or case.id in seen_ids:
            duplicate_reason = f"用例编号{case.id}重复"
        elif case.question in existing_questions or case.question in seen_questions:
            duplicate_reason = "用户问题重复"
        if duplicate_reason:
            previews.append(
                AccuracyImportRow(
                    row_number=offset,
                    status="duplicate",
                    question=case.question,
                    message=duplicate_reason,
                    case=case,
                )
            )
            continue
        seen_ids.add(case.id)
        seen_questions.add(case.question)
        cases.append(case)
        previews.append(
            AccuracyImportRow(
                row_number=offset,
                status="valid",
                question=case.question,
                case=case,
            )
        )

    error_count = sum(item.status == "error" for item in previews)
    duplicate_count = sum(item.status == "duplicate" for item in previews)
    return AccuracyImportPreview(
        filename=filename,
        mode=mode,
        total_rows=len(rows),
        valid_count=len(cases),
        duplicate_count=duplicate_count,
        error_count=error_count,
        can_import=bool(cases) and error_count == 0,
        rows=previews,
        cases=cases,
    )


def _parse_case(record: dict[str, object], *, next_id: int) -> tuple[AccuracyCase, int]:
    question = _text(record.get("用户问题"))
    if not question:
        raise ValueError("用户问题不能为空")
    raw_id = _text(record.get("用例编号"))
    if raw_id:
        case_id = _non_negative_integer(raw_id, "用例编号", minimum=1)
        next_id = max(next_id, case_id + 1)
    else:
        case_id = next_id
        next_id += 1
    status = _optional_text(record.get("预期状态"))
    if status and status not in _VALID_STATUSES:
        raise ValueError(f"预期状态不支持：{status}")
    row_count = _optional_integer(record.get("预期返回行数"), "预期返回行数")
    expected_value = _optional_float(record.get("预期结果值"), "预期结果值")
    tolerance = _optional_float(record.get("允许误差"), "允许误差")
    if tolerance is not None and tolerance < 0:
        raise ValueError("允许误差不能小于0")
    try:
        case = AccuracyCase(
            id=case_id,
            category=_text(record.get("用例分类")),
            question=question,
            expected_status=status,
            expected_shape=_optional_text(record.get("预期查询类型")),
            expected_metric_names=_list_value(record.get("预期指标名称")),
            expected_org_names=_list_value(record.get("预期机构名称")),
            expected_missing=_list_value(record.get("预期澄清字段")),
            expected_row_count=row_count,
            expected_value=expected_value,
            value_tolerance=0.01 if tolerance is None else tolerance,
        )
    except ValidationError as exc:
        message = exc.errors(include_url=False)[0].get("msg", "字段格式不正确")
        raise ValueError(str(message)) from exc
    return case, next_id


def _read_first_xlsx_sheet(content: bytes) -> list[list[object]]:
    try:
        with ZipFile(BytesIO(content)) as archive:
            if len(archive.infolist()) > 200:
                raise ValueError("Excel文件包含过多内部文件")
            if sum(item.file_size for item in archive.infolist()) > _MAX_UNCOMPRESSED_SIZE:
                raise ValueError("Excel解压后内容过大")
            if "xl/worksheets/sheet1.xml" not in archive.namelist():
                raise ValueError("Excel缺少第一个工作表")
            shared = _read_shared_strings(archive)
            root = _element_from_bytes(archive.read("xl/worksheets/sheet1.xml"))
    except BadZipFile as exc:
        raise ValueError("上传文件不是有效的Excel文件") from exc
    rows: list[list[object]] = []
    for row in root.findall(f".//{{{MAIN_NS}}}row"):
        values: dict[int, object] = {}
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            if cell.find(f"{{{MAIN_NS}}}f") is not None:
                raise ValueError("Excel中不能包含公式")
            reference = cell.attrib.get("r", "A1")
            index = _column_index(reference)
            values[index] = _cell_value(cell, shared)
        width = max(values, default=-1) + 1
        rows.append([values.get(index) for index in range(width)])
    return rows


def _element_from_bytes(content: bytes) -> Any:
    """Parse workbook XML with DTD and entity expansion explicitly disabled."""
    return fromstring(content)


def _read_shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = _element_from_bytes(archive.read("xl/sharedStrings.xml"))
    return [
        "".join(text.text or "" for text in item.findall(f".//{{{MAIN_NS}}}t"))
        for item in root.findall(f"{{{MAIN_NS}}}si")
    ]


def _cell_value(cell: Any, shared: list[str]) -> object:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(
            text.text or "" for text in cell.findall(f".//{{{MAIN_NS}}}t")
        )
    value = cell.findtext(f"{{{MAIN_NS}}}v")
    if value is None:
        return ""
    if cell_type == "s":
        try:
            return shared[int(value)]
        except (IndexError, ValueError) as exc:
            raise ValueError("Excel共享文本索引无效") from exc
    if cell_type in {"str", "e"}:
        return value
    if cell_type == "b":
        return value == "1"
    try:
        number = float(value)
        return int(number) if number.is_integer() else number
    except ValueError:
        return value


def _column_index(reference: str) -> int:
    match = re.match(r"([A-Z]+)", reference.upper())
    if not match:
        return 0
    value = 0
    for character in match.group(1):
        value = value * 26 + ord(character) - 64
    return value - 1


def _text(value: object) -> str:
    return "" if value is None else str(value).strip()


def _optional_text(value: object) -> str | None:
    return _text(value) or None


def _list_value(value: object) -> list[str]:
    return list(
        dict.fromkeys(
            item.strip()
            for item in re.split(r"[;；\n]", _text(value))
            if item.strip()
        )
    )


def _non_negative_integer(value: object, field: str, *, minimum: int = 0) -> int:
    text = _text(value)
    try:
        number = float(text)
    except ValueError as exc:
        raise ValueError(f"{field}必须是整数") from exc
    if not number.is_integer() or number < minimum:
        raise ValueError(f"{field}必须是大于等于{minimum}的整数")
    return int(number)


def _optional_integer(value: object, field: str) -> int | None:
    return None if not _text(value) else _non_negative_integer(value, field)


def _optional_float(value: object, field: str) -> float | None:
    text = _text(value).replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError as exc:
        raise ValueError(f"{field}必须是数值") from exc
