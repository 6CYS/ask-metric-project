"""使用隔离目录验证业务默认；兼容旧目录，不连接模型和业务数据库。"""

import pytest

from ask_metric.application.analysis_execution import GeneralAnalysisService
from ask_metric.application.catalog_references import explicit_catalog_references
from ask_metric.application.field_resolution import resolve_catalog_field
from ask_metric.application.metric_candidates import MetricCandidateIndex
from ask_metric.application.metric_semantics import MetricSemantics
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.analysis_methods import AnalysisPlan
from ask_metric.domain.semantics import MetricCatalogItem


def profit_catalog(structured=False):
    rows = [
        ("P", "净利润金额", "当日数", ["净利润当日值"]),
        ("PY", "净利润金额", "较同期", ["净利润同比"]),
        ("PR", "净利润金额", "较同期增幅", ["净利润同比增幅"]),
        ("A", "净利润金额_考核", "当日数", ["考核净利润当日值"]),
        ("AY", "净利润金额_考核", "较同期", ["考核净利润同比"]),
        ("AR", "净利润金额_考核", "较年初增幅", []),
    ]
    return [MetricCatalogItem(
        code=code, name=base + basis, aliases=aliases,
        **({"source_metric_code": base, "base_name": base, "value_basis": basis}
           if structured else {}),
    ) for code, base, basis, aliases in rows]


@pytest.mark.parametrize("structured", [False, True])
@pytest.mark.parametrize("question,code,defaulted", [
    ("对比紫金和民丰最近的净利润。", "P", True),
    ("那只比较净利润呢？", "P", True),
    ("比较净利润金额", "P", True),
    ("比较普通净利润", "P", True),
    ("比较考核净利润", "A", True),
    ("净利润金额_考核", "A", True),
    ("净利润当日数", "P", False),
    ("净利润较同期", "PY", False),
    ("净利润同比", "PY", False),
    ("净利润同比增幅", "PR", False),
    ("考核净利润较同期", "AY", False),
    ("净利润金额_考核较年初增幅", "AR", False),
])
def test_business_default_preserves_explicit_qualifiers(structured, question, code, defaulted):
    mentions = MetricCandidateIndex(profit_catalog(structured)).mentions(question)
    assert len(mentions) == 1
    resolution = mentions[0]["resolution"]
    assert resolution["status"] == "resolved"
    assert resolution["value"]["codes"] == [code]
    assert bool(resolution.get("metadata", {}).get("default_value_basis")) is defaulted


@pytest.mark.parametrize("raw,code", [
    ("净利润", "P"), ("考核净利润", "A"), ("净利润较同期", "PY"),
    ("净利润金额_考核较年初增幅", "AR"), ("AR", "AR"),
])
def test_field_binding_uses_same_default_and_keeps_formal_codes(raw, code):
    result = resolve_catalog_field("metric", [raw], profit_catalog())
    assert result["status"] == "resolved"
    assert result["value"]["codes"] == [code]
    if raw == "净利润":
        binding = result["metadata"]["metric_defaults"][0]
        assert binding["resolution_source"] == "business_default"
        assert set(binding["context_codes"]) == {
            item.code for item in profit_catalog()}


@pytest.mark.parametrize("raw", [
    "净利润较同期增", "净利润较上月增幅", "人均净利润", "扣非净利润", "净利润率",
    "美元净利润", "税前净利润", "净利润日均",
])
def test_default_does_not_swallow_missing_or_incomplete_qualifiers(raw):
    result = resolve_catalog_field("metric", [raw], profit_catalog())
    assert result["status"] != "resolved"
    mentions = MetricCandidateIndex(profit_catalog()).mentions(raw)
    assert all(mention["resolution"]["status"] != "resolved" for mention in mentions)


def test_missing_ordinary_default_never_substitutes_assessment():
    items = [item for item in profit_catalog() if item.code != "P"]
    result = resolve_catalog_field("metric", ["净利润"], items)
    assert result["status"] != "resolved"


def test_duplicate_default_members_remain_ambiguous():
    items = [*profit_catalog(), MetricCatalogItem(code="P2", name="净利润当日数")]
    assert resolve_catalog_field("metric", ["净利润"], items)["status"] != "resolved"


def test_formal_identity_is_not_replaced_by_business_default():
    items = [*profit_catalog(), MetricCatalogItem(code="OTHER", name="净利润")]
    assert resolve_catalog_field("metric", ["净利润"], items)["value"]["codes"] == ["OTHER"]
    mention = MetricCandidateIndex(items).mentions("净利润")[0]
    assert mention["resolution"]["value"]["codes"] == ["OTHER"]


def test_shared_generic_alias_does_not_override_approved_ordinary_default():
    items = profit_catalog()
    for item in items:
        item.aliases.append("净利润")
    assert resolve_catalog_field("metric", ["净利润"], items)["value"]["codes"] == ["P"]


def test_unrelated_alias_collision_is_not_silently_reassigned():
    items = [*profit_catalog(),
             MetricCatalogItem(code="OTHER", name="其他统计金额", aliases=["净利润"])]
    assert resolve_catalog_field("metric", ["净利润"], items)["status"] != "resolved"


def test_catalog_discovery_returns_same_identity_and_real_binding():
    semantics = MetricSemantics(profit_catalog(), secret="isolated-default-test", actor_id="tester")
    for raw, code in [("净利润", "P"), ("考核净利润", "A"), ("净利润同比", "PY")]:
        catalog = semantics.search(raw)
        assert catalog["metric_resolution"]["value"]["codes"] == [code]
        assert catalog["items"][0]["code"] == code
        assert semantics.resolve(catalog["items"][0]["binding_ref"])["code"] == code
    # 发现不会删掉其他正式候选，也不修改原目录。
    assert len(semantics.search("净利润")["items"]) > 1
    assert all(item.base_name is None for item in semantics.items.values())


def test_default_is_not_mistaken_for_explicit_basis_during_plan_validation():
    def codes(question):
        return explicit_catalog_references(question, metrics=profit_catalog(),
                                           organizations=[], organization_aliases={})["metrics"]
    assert codes("那只比较净利润呢") == set()
    assert codes("比较净利润当日数") == {"P"}
    assert codes("比较考核净利润较同期") == {"AY"}


def test_analysis_default_still_requires_answering_the_metric(monkeypatch):
    semantics = MetricSemantics(
        [*profit_catalog(), MetricCatalogItem(code="I", name="营业收入金额当日数")],
        secret="isolated-plan-test", actor_id="tester",
    )
    # 本测试只调用纯计划校验，不装配查询执行器和数据库。
    service = GeneralAnalysisService(None, None, None, secret="isolated-plan-test")
    monkeypatch.setattr(service, "semantics", lambda _actor: semantics)

    def plan(code, *, gap=False):
        value = {"objective": "比较收入与净利润", "scope_notice": "隔离合成目录",
                 "requirements": [{"id": "q1", "question": "收入是多少？"}],
                 "steps": [{"id": "read", "method": "observe", "answers": ["q1"],
                            "metric_refs": [semantics.binding(semantics.descriptor(code), code)],
                            "rationale": "核对正式指标"}]}
        if gap:
            value["requirements"].append({"id": "q2", "question": "净利润是多少？",
                                           "gap_reason": "尚未取得所需证据"})
        return AnalysisPlan.model_validate(value)

    with pytest.raises(ApplicationError) as error:
        service.validate_plan(plan("I"), None, "比较营业收入和净利润")
    assert error.value.code == "ANALYSIS_EXPLICIT_METRIC_MISSING"
    assert any(item["code"] == "P" for item in error.value.details["missing_metrics"])
    service.validate_plan(plan("I", gap=True), None, "比较营业收入和净利润")
    service.validate_plan(plan("AY"), None, "只比较净利润")
    with pytest.raises(ApplicationError):
        service.validate_plan(plan("AY"), None, "只比较净利润当日数")
