from __future__ import annotations

import re
from io import BytesIO
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, ZipFile

from ask_metric.infrastructure.export.openxml import (
    CONTENT_NS,
    MAIN_NS,
    OFFICE_REL_BASE,
    PKG_REL_NS,
    REL_NS,
)

_INVALID_XML_CHARS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")
_XML_NAME = re.compile(r"[A-Za-z_:][A-Za-z0-9_.:-]*\Z")
_MAX_CELL_TEXT_LENGTH = 32_767


def build_xlsx(sheets: list[tuple[str, list[str], list[list[object]]]]) -> bytes:
    """Build a small standards-compliant XLSX workbook without runtime dependencies."""
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _content_types(len(sheets)))
        archive.writestr("_rels/.rels", _package_relationships())
        archive.writestr("xl/workbook.xml", _workbook(sheets))
        archive.writestr("xl/_rels/workbook.xml.rels", _workbook_relationships(len(sheets)))
        for index, (_, columns, rows) in enumerate(sheets, start=1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", _worksheet([columns, *rows]))
    return output.getvalue()


def _xml(document: str) -> bytes:
    return ('<?xml version="1.0" encoding="utf-8"?>' + document).encode("utf-8")


def _element(
    name: str,
    *,
    attributes: dict[str, object] | None = None,
    children: list[str] | None = None,
    text: str | None = None,
    empty: bool = False,
) -> str:
    """Serialize XML while escaping all values that can originate outside this module."""
    if not _XML_NAME.fullmatch(name):
        raise ValueError("invalid internal XML element name")
    rendered_attributes: list[str] = []
    for attribute, value in (attributes or {}).items():
        if not _XML_NAME.fullmatch(attribute):
            raise ValueError("invalid internal XML attribute name")
        rendered_attributes.append(f" {attribute}={quoteattr(str(value))}")
    opening = f"<{name}{''.join(rendered_attributes)}"
    if empty:
        return opening + "/>"
    content = "".join(children or [])
    if text is not None:
        content += escape(text)
    return f"{opening}>{content}</{name}>"


def _content_types(sheet_count: int) -> bytes:
    children = [
        _element(
            "Default",
            attributes={
                "Extension": "rels",
                "ContentType": "application/vnd.openxmlformats-package.relationships+xml",
            },
            empty=True,
        ),
        _element(
            "Default",
            attributes={"Extension": "xml", "ContentType": "application/xml"},
            empty=True,
        ),
        _element(
            "Override",
            attributes={
                "PartName": "/xl/workbook.xml",
                "ContentType": (
                    "application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet.main+xml"
                ),
            },
            empty=True,
        ),
    ]
    for index in range(1, sheet_count + 1):
        children.append(
            _element(
                "Override",
                attributes={
                    "PartName": f"/xl/worksheets/sheet{index}.xml",
                    "ContentType": (
                        "application/vnd.openxmlformats-officedocument."
                        "spreadsheetml.worksheet+xml"
                    ),
                },
                empty=True,
            )
        )
    return _xml(_element("Types", attributes={"xmlns": CONTENT_NS}, children=children))


def _package_relationships() -> bytes:
    relationship = _element(
        "Relationship",
        attributes={
            "Id": "rId1",
            "Type": f"{OFFICE_REL_BASE}/officeDocument",
            "Target": "xl/workbook.xml",
        },
        empty=True,
    )
    return _xml(
        _element("Relationships", attributes={"xmlns": PKG_REL_NS}, children=[relationship])
    )


def _workbook(sheets: list[tuple[str, list[str], list[list[object]]]]) -> bytes:
    sheet_elements = [
        _element(
            "sheet",
            attributes={"name": name[:31], "sheetId": index, "r:id": f"rId{index}"},
            empty=True,
        )
        for index, (name, _, _) in enumerate(sheets, start=1)
    ]
    sheet_root = _element("sheets", children=sheet_elements)
    return _xml(
        _element(
            "workbook",
            attributes={"xmlns": MAIN_NS, "xmlns:r": REL_NS},
            children=[sheet_root],
        )
    )


def _workbook_relationships(sheet_count: int) -> bytes:
    relationships = [
        _element(
            "Relationship",
            attributes={
                "Id": f"rId{index}",
                "Type": f"{OFFICE_REL_BASE}/worksheet",
                "Target": f"worksheets/sheet{index}.xml",
            },
            empty=True,
        )
        for index in range(1, sheet_count + 1)
    ]
    return _xml(
        _element("Relationships", attributes={"xmlns": PKG_REL_NS}, children=relationships)
    )


def _worksheet(rows: list[list[object]]) -> bytes:
    rendered_rows: list[str] = []
    for row_index, values in enumerate(rows, start=1):
        rendered_cells: list[str] = []
        for column_index, value in enumerate(values, start=1):
            reference = f"{_column_name(column_index)}{row_index}"
            if isinstance(value, bool):
                rendered_value = _element("v", text="1" if value else "0")
                cell = _element(
                    "c", attributes={"r": reference, "t": "b"}, children=[rendered_value]
                )
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                rendered_value = _element("v", text=str(value))
                cell = _element(
                    "c", attributes={"r": reference, "t": "n"}, children=[rendered_value]
                )
            else:
                cell_text = "" if value is None else str(value)
                cell_text = _INVALID_XML_CHARS.sub("", cell_text)
                if len(cell_text) > _MAX_CELL_TEXT_LENGTH:
                    suffix = "...（内容过长，请使用查询结果导出）"
                    cell_text = cell_text[: _MAX_CELL_TEXT_LENGTH - len(suffix)] + suffix
                inline = _element("is", children=[_element("t", text=cell_text)])
                cell = _element(
                    "c", attributes={"r": reference, "t": "inlineStr"}, children=[inline]
                )
            rendered_cells.append(cell)
        rendered_rows.append(
            _element("row", attributes={"r": row_index}, children=rendered_cells)
        )
    data = _element("sheetData", children=rendered_rows)
    return _xml(_element("worksheet", attributes={"xmlns": MAIN_NS}, children=[data]))


def _column_name(index: int) -> str:
    name = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name
