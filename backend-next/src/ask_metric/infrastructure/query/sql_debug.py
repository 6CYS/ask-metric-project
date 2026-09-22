"""只生成诊断展示文本；实际查询始终使用原模板和绑定参数。"""
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.dialects import mysql

from ask_metric.infrastructure.query.inceptor import _normalize_optional_expanding_parameters
from ask_metric.infrastructure.query.mysql import _prepare_parameters


def render_debug_sql(sql: str, parameters: dict[str, Any], dialect: str) -> str:
    prepared = (
        _normalize_optional_expanding_parameters(parameters)
        if dialect == "inceptor" else _prepare_parameters(parameters)
    )
    statement = text(sql)
    # 使用SQLAlchemy解析参数和转义字面量，避免字符串替换误伤引号、相似参数名。
    statement = statement.bindparams(*(
        bindparam(name, value=prepared[name], expanding=isinstance(prepared[name], (list, tuple)))
        for name in statement._bindparams
    ))
    return str(statement.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))
