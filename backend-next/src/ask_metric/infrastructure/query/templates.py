from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, Field, field_validator

from ask_metric.domain.query_execution import QueryTemplateId
from ask_metric.infrastructure.query.sql_safety import validate_readonly_sql


class QueryTemplateRegistration(BaseModel):
    path: str = Field(min_length=1)
    editable: bool = True
    enabled: bool = True


class QueryTemplateRead(BaseModel):
    dialect: str
    template: QueryTemplateId
    sql: str
    parameters: list[str]
    editable: bool
    enabled: bool


class QueryTemplateConfig(BaseModel):
    version: str = Field(min_length=1)
    dialects: dict[str, dict[QueryTemplateId, QueryTemplateRegistration]]

    @field_validator("dialects", mode="before")
    @classmethod
    def normalize_registrations(cls, value):
        return {
            dialect: {
                name: ({"path": registration} if isinstance(registration, str) else registration)
                for name, registration in registrations.items()
            }
            for dialect, registrations in value.items()
        }


class QueryTemplateRepository:
    """加载受管理的 SQL 模板；区分配置中的标识符与用户查询的业务参数。

    表名、字段名等模板变量经白名单格式校验后替换；指标、机构、日期等业务值
    由数据库适配器绑定，不能用字符串格式化塞进 SQL。
    """
    def __init__(
        self,
        config_path: Path,
        resource_root: Path,
        *,
        template_variables: dict[str, str] | None = None,
    ) -> None:
        self.config_path = config_path.resolve()
        self.resource_root = resource_root.resolve()
        self.template_variables = {
            "fact_table": "ads_lake.adm_rmt_pub_gnrl_drv_indcr_tab",
            "fact_metric_code_field": "indcr_no",
            "fact_org_code_field": "org_no",
            "fact_data_date_field": "data_dt",
            "fact_value_field": "indcvl",
            "fact_increment_field": "indcvl_incrrng",
            "batch_order": "f.etl_date DESC, f.btch_seq_no DESC",
            **(template_variables or {}),
            # Older persisted Inceptor templates may still contain this token.
            # Keep upgrades readable, but never allow an environment setting to
            # turn it back into a load-date filter.
            "partition_predicate": "1 = 1",
        }
        _validate_template_variables(self.template_variables)

    def load_config(self) -> QueryTemplateConfig:
        with self.config_path.open("r", encoding="utf-8") as file:
            return QueryTemplateConfig.model_validate(json.load(file))

    def load(self, *, dialect: str, template: QueryTemplateId) -> str:
        registration = self.registration(dialect=dialect, template=template)
        if not registration.enabled:
            raise ValueError(f"Template {dialect}/{template.value} is disabled")
        raw = self._template_path(dialect, registration).read_text(encoding="utf-8").strip()
        return self._render(raw)

    def registration(self, *, dialect: str, template: QueryTemplateId) -> QueryTemplateRegistration:
        mapping = self.load_config().dialects.get(dialect)
        if mapping is None or template not in mapping:
            raise KeyError(f"Template {dialect}/{template.value} is not registered")
        return mapping[template]

    def list_templates(self) -> list[QueryTemplateRead]:
        config = self.load_config()
        values: list[QueryTemplateRead] = []
        for dialect, registrations in config.dialects.items():
            for template, registration in registrations.items():
                sql = self._render(
                    self._template_path(dialect, registration).read_text(encoding="utf-8").strip()
                )
                values.append(
                    QueryTemplateRead(
                        dialect=dialect,
                        template=template,
                        sql=sql,
                        parameters=sorted(set(re.findall(r":([a-zA-Z_][a-zA-Z0-9_]*)", sql))),
                        editable=registration.editable,
                        enabled=registration.enabled,
                    )
                )
        return values

    def save_template(
        self,
        *,
        dialect: str,
        template: QueryTemplateId,
        sql: str,
        enabled: bool,
    ) -> QueryTemplateRead:
        registration = self.registration(dialect=dialect, template=template)
        if not registration.editable:
            raise ValueError(f"Template {dialect}/{template.value} is protected")
        validate_readonly_sql(sql)
        path = self._template_path(dialect, registration)
        temporary_path = path.with_suffix(path.suffix + ".tmp")
        temporary_path.write_text(sql.strip() + "\n", encoding="utf-8")
        temporary_path.replace(path)
        config = self.load_config()
        config.dialects[dialect][template].enabled = enabled
        temporary_config = self.config_path.with_suffix(self.config_path.suffix + ".tmp")
        temporary_config.write_text(
            json.dumps(config.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_config.replace(self.config_path)
        return next(
            item
            for item in self.list_templates()
            if item.dialect == dialect and item.template == template
        )

    def validate_template(self, sql: str) -> list[str]:
        validate_readonly_sql(sql)
        return sorted(set(re.findall(r":([a-zA-Z_][a-zA-Z0-9_]*)", sql)))

    def _template_path(self, dialect: str, registration: QueryTemplateRegistration) -> Path:
        relative = PurePosixPath(registration.path)
        expected_prefix = PurePosixPath(dialect)
        invalid_path = (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.parent == PurePosixPath(".")
        )
        if invalid_path:
            raise ValueError("SQL template path must be a registered dialect-relative path")
        if relative.parts[0] != expected_prefix.as_posix():
            raise ValueError("SQL template path does not match its dialect")
        resolved = (self.resource_root / Path(*relative.parts)).resolve()
        if not resolved.is_relative_to(self.resource_root):
            raise ValueError("SQL template path escapes the resource root")
        if not resolved.is_file():
            raise FileNotFoundError(f"SQL template does not exist: {relative.as_posix()}")
        return resolved

    def _render(self, sql: str) -> str:
        rendered = sql
        for name, value in self.template_variables.items():
            rendered = rendered.replace("{{" + name + "}}", value)
        # Upgrade safety for SQL previously published from the admin UI. Those
        # files may contain the formerly rendered load-date predicate rather
        # than {{partition_predicate}}. Business queries must never require the
        # load/slice date to equal the requested data-date range.
        rendered = re.sub(
            r"(?im)^[ \t]*AND\s+f\.[A-Za-z_][A-Za-z0-9_]*\s+BETWEEN\s+"
            r"CAST\(:partition_start_date\s+AS\s+DATE\)\s+AND\s+"
            r"CAST\(:partition_end_date\s+AS\s+DATE\)[ \t]*$",
            "",
            rendered,
        ).strip()
        if re.search(r"\{\{[a-z_]+\}\}", rendered):
            raise ValueError("SQL template contains an unknown template variable")
        return rendered


def _validate_template_variables(values: dict[str, str]) -> None:
    if not re.fullmatch(
        r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}", values["fact_table"]
    ):
        raise ValueError("SIT_FACT_TABLE must be a qualified SQL identifier")
    for name in (
        "fact_metric_code_field",
        "fact_org_code_field",
        "fact_data_date_field",
        "fact_value_field",
        "fact_increment_field",
    ):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", values[name]):
            raise ValueError(f"{name} must be a SQL identifier")
    if not re.fullmatch(
        r"f\.[A-Za-z_][A-Za-z0-9_]*\s+(?:ASC|DESC),\s*"
        r"f\.[A-Za-z_][A-Za-z0-9_]*\s+(?:ASC|DESC)",
        values["batch_order"],
        re.IGNORECASE,
    ):
        raise ValueError("SIT_BATCH_ORDER must order etl_date and btch_seq_no")
