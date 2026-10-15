"""机构目录同步闸门：少了拒绝、丢失已有编码拒绝、新增编码须显式确认。

源表与应用库均用 sqlite 临时库构造，不连接数据湖或生产数据库。
"""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from ask_metric.application.catalog_sync import SitCatalogSyncService
from ask_metric.infrastructure.db.models import OrgTerm

EXPECTED = 61
PARAMS = {
    "source_table": "org_dim",
    "snapshot_field": "data_dt",
    "corporation_code_max": "134",
    "excluded_corporation_code": "086",
    "head_office_corporation_code": "000",
    "legal_entity_hier_code": "3",
    "head_office_hier_code": "1",
    "expected_count": EXPECTED,
}


def _source_engine(tmp_path, entity_codes: list[str]):
    engine = create_engine(f"sqlite:///{tmp_path}/source.db")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE IF NOT EXISTS org_dim (org_no TEXT, org_chn_nm TEXT, data_dt TEXT,"
            " corpt_no TEXT, org_hier_code TEXT)"
        ))
        connection.execute(text("DELETE FROM org_dim"))
        rows = [("ROOT", "江苏农商联合银行（全省汇总）", "000", "1")]
        rows += [
            (code, f"江苏合成{code[1:]}农村商业银行股份有限公司", f"{index + 1:03d}", "3")
            for index, code in enumerate(entity_codes)
        ]
        for code, name, corpt, hier in rows:
            connection.execute(
                text("INSERT INTO org_dim VALUES (:code, :name, '2026-10-01', :corpt, :hier)"),
                {"code": code, "name": name, "corpt": corpt, "hier": hier},
            )
    return engine


def _service(tmp_path) -> SitCatalogSyncService:
    engine = create_engine(f"sqlite:///{tmp_path}/app.db")
    OrgTerm.__table__.create(engine, checkfirst=True)
    return SitCatalogSyncService(sessionmaker(bind=engine))


def _aliases(service: SitCatalogSyncService, code: str) -> list[str]:
    with service.app_sessions() as session:
        return list(session.query(OrgTerm).filter_by(org_code=code).one().aliases)


def _sync(tmp_path, entity_codes: list[str], **overrides):
    service = _service(tmp_path)
    summary = service.sync_organizations(
        source_engine=_source_engine(tmp_path, entity_codes), **PARAMS, **overrides,
    )
    return service, summary


def test_fewer_than_expected_rejected(tmp_path):
    with pytest.raises(RuntimeError, match="expected at least 61"):
        _sync(tmp_path, [f"E{i:03d}" for i in range(59)])


def test_baseline_sync_and_idempotent_resync(tmp_path):
    codes = [f"E{i:03d}" for i in range(60)]
    service, summary = _sync(tmp_path, codes, confirm_org_additions=True)
    assert summary.created == EXPECTED
    # 目录不变再次同步：无新增、无丢失，全部 unchanged。
    _, second = _sync(tmp_path, codes, confirm_org_additions=False)
    assert second.unchanged == EXPECTED
    # 派生别名落库；省级根节点不派生。
    assert "合成000" in _aliases(service, "E000")
    assert "合成000农商行" in _aliases(service, "E000")
    assert _aliases(service, "ROOT") == []


def test_new_codes_rejected_without_confirmation(tmp_path):
    codes = [f"E{i:03d}" for i in range(60)]
    _sync(tmp_path, codes, confirm_org_additions=True)
    with pytest.raises(RuntimeError, match=r"new codes \['E060'\]") as error:
        _sync(tmp_path, [*codes, "E060"])
    assert "--confirm-org-additions" in str(error.value)
    # dry-run 不写入，允许预览新增编码。
    _, preview = _sync(tmp_path, [*codes, "E060"], dry_run=True)
    assert preview.created == 1


def test_new_codes_written_with_confirmation(tmp_path):
    codes = [f"E{i:03d}" for i in range(60)]
    _sync(tmp_path, codes, confirm_org_additions=True)
    _, summary = _sync(tmp_path, [*codes, "E060"], confirm_org_additions=True)
    assert summary.created == 1


def test_lost_enabled_codes_rejected_even_with_confirmation(tmp_path):
    codes = [f"E{i:03d}" for i in range(60)]
    _sync(tmp_path, codes, confirm_org_additions=True)
    # 总数不变但编码被换：丢失已启用编码一律拒绝并列出编码。
    swapped = [*codes[:-1], "E999"]
    with pytest.raises(RuntimeError, match=r"drop enabled codes \['E059'\]"):
        _sync(tmp_path, swapped, confirm_org_additions=True)


def test_manual_aliases_take_priority_over_derived(tmp_path):
    codes = [f"E{i:03d}" for i in range(60)]
    service, _ = _sync(tmp_path, codes, confirm_org_additions=True,
                       aliases_by_code={"E001": ["导出别名"]})
    with service.app_sessions() as session:
        term = session.query(OrgTerm).filter_by(org_code="E000").one()
        term.aliases = ["人工短称", "合成000"]
        session.commit()
    _sync(tmp_path, codes, confirm_org_additions=False)
    e000 = _aliases(service, "E000")
    # 人工别名在前且不与派生重复，派生只补充缺失项。
    assert e000[:2] == ["人工短称", "合成000"]
    assert e000.count("合成000") == 1
    assert "合成000农商行" in e000
    assert _aliases(service, "E001")[:1] == ["导出别名"]
