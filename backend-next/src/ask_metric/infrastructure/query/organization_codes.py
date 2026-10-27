"""取数边界转换来源编码；目录身份仍用于权限、结果与历史会话。"""

from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock
from time import perf_counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ask_metric.application.ports import DataSourceAdapter
from ask_metric.core.config import Settings
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.models import OrgTerm


def _mapping_error() -> ApplicationError:
    return ApplicationError(
        "ORG_SOURCE_MAPPING_INVALID", "机构目录与数据来源的编码映射无法确认，请核对机构目录。",
        status_code=409,
    )


@dataclass(frozen=True)
class OrganizationCodeMapping:
    snapshot_date: str
    codes: dict[str, str]


class OrganizationCodeMappingLoader:
    def __init__(self, settings: Settings, source: DataSourceAdapter,
                 sessions: Callable[[], Session]) -> None:
        self.settings = settings
        self.source = source
        self.sessions = sessions

    def load(self) -> OrganizationCodeMapping:
        with self.sessions() as session:
            catalog = {row.org_code: (row.org_name, row.hierarchy_level)
                       for row in session.scalars(select(OrgTerm).where(OrgTerm.enabled.is_(True)))}
        if not catalog:
            raise _mapping_error()
        s = self.settings
        # 字段来自已校验的部署配置；headbnk_org_no 是该来源的指标事实机构码。
        result = self.source.execute_readonly(sql=(
            f"SELECT {s.sit_org_code_field} AS catalog_code, "
            f"{s.sit_org_name_field} AS org_name, {s.sit_org_hierarchy_field} AS hierarchy_level, "
            f"headbnk_org_no AS fact_code, {s.sit_org_snapshot_field} AS snapshot_date "
            f"FROM {s.sit_org_table} WHERE {s.sit_org_code_field} IN :catalog_codes "
            f"AND {s.sit_org_snapshot_field} = "
            f"(SELECT MAX({s.sit_org_snapshot_field}) FROM {s.sit_org_table})"
        ), parameters={"catalog_codes": list(catalog)})
        codes: dict[str, str] = {}
        dates = set()
        for row in result.rows:
            code = str(row.get("catalog_code") or "")
            fact_code = str(row.get("fact_code") or "").strip()
            if (code in codes or code not in catalog or not fact_code or len(fact_code) > 128
                    or catalog[code] != (row.get("org_name"), row.get("hierarchy_level"))
                    or not row.get("snapshot_date")):
                raise _mapping_error()
            codes[code] = fact_code
            dates.add(str(row["snapshot_date"]))
        if set(codes) != set(catalog) or len(set(codes.values())) != len(codes) or len(dates) != 1:
            raise _mapping_error()
        return OrganizationCodeMapping(snapshot_date=dates.pop(), codes=codes)


@dataclass(frozen=True)
class OrganizationMappedExecution:
    rows: list[dict[str, Any]]
    latency_ms: int
    source_parameters: dict[str, Any]
    organization_mapping: dict[str, Any]


class OrganizationMappedDataSource:
    def __init__(self, source: DataSourceAdapter, loader: OrganizationCodeMappingLoader) -> None:
        self.source = source
        self.loader = loader
        self._mapping: OrganizationCodeMapping | None = None
        self._lock = Lock()

    def execute_readonly(
        self, *, sql: str, parameters: dict[str, Any],
        before_execute: Callable[[dict[str, Any], dict[str, Any]], None] | None = None,
    ) -> OrganizationMappedExecution:
        started = perf_counter()
        # 一个执行服务内的多指标、覆盖探测与补查复用同一快照，不逐机构查目录。
        with self._lock:
            if self._mapping is None:
                self._mapping = self.loader.load()
            mapping = self._mapping
        requested = parameters.get("org_codes")
        if (not isinstance(requested, (list, tuple)) or not requested
                or parameters.get("filter_orgs") is False):
            raise _mapping_error()
        if any(code not in mapping.codes for code in requested):
            raise _mapping_error()
        selected = {code: mapping.codes[code] for code in requested}
        source_parameters = dict(parameters, org_codes=list(selected.values()))
        if "rank_subject_codes" in parameters:
            subjects = parameters["rank_subject_codes"]
            if (not isinstance(subjects, (list, tuple))
                    or any(code not in selected for code in subjects)):
                raise _mapping_error()
            source_parameters["rank_subject_codes"] = [selected[code] for code in subjects]
        provenance = {"snapshot_date": mapping.snapshot_date, "codes": selected}
        if before_execute is not None:
            before_execute(source_parameters, provenance)
        result = self.source.execute_readonly(sql=sql, parameters=source_parameters)
        by_source = {value: key for key, value in selected.items()}
        rows = []
        for source_row in result.rows:
            row = dict(source_row)
            code = row.get("org_code")
            # 排名元数据和覆盖汇总可以没有机构；带机构的行必须属于已授权映射。
            if code not in (None, ""):
                if code not in by_source:
                    raise _mapping_error()
                row["org_code"] = by_source[code]
            rows.append(row)
        return OrganizationMappedExecution(
            rows=rows, latency_ms=max(0, round((perf_counter() - started) * 1000)),
            source_parameters=source_parameters,
            organization_mapping=provenance,
        )
