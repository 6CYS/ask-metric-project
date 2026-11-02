from __future__ import annotations

import re


class UnsafeSqlError(ValueError):
    pass


_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|do)\b",
    re.IGNORECASE,
)


def validate_readonly_sql(sql: str) -> None:
    value = _strip_comments(sql).strip()
    if not value:
        raise UnsafeSqlError("SQL template is empty")
    if ";" in value.rstrip(";"):
        raise UnsafeSqlError("Multiple SQL statements are not allowed")
    statement = value.rstrip(";").lstrip().lower()
    if not (statement.startswith("select ") or statement.startswith("with ")):
        raise UnsafeSqlError("Only SELECT or WITH...SELECT statements are allowed")
    if _FORBIDDEN.search(statement):
        raise UnsafeSqlError("SQL template contains a forbidden statement")
    if statement.startswith("with ") and "select" not in statement:
        raise UnsafeSqlError("WITH statements must contain SELECT")


def _strip_comments(sql: str) -> str:
    without_blocks = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\r\n]*", " ", without_blocks)
