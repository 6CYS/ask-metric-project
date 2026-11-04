"""目录知识返回契约；合成目录仅用于隔离测试，不代表正式业务定义。"""

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from ask_metric.api.routes import catalogs
from ask_metric.api.routes import analysis
from ask_metric.application.metric_semantics import MetricSemantics
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem
from ask_metric.infrastructure.model.catalog_vectors import CatalogVectorCache, catalog_embedding_texts
from ask_metric.infrastructure.model.provider import ModelServiceUnavailable, InvalidModelResponse


def search_catalog(items, *, keyword="测试余额", embedding_scores=None, limit=10):
    settings = SimpleNamespace(semantic_config_path=Path("unused"), _config_center=None)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        settings=settings, catalog_vector_cache=None,
    )))
    uow = nullcontext()
    uow.metric_catalog = SimpleNamespace(list_enabled=lambda: items)
    matching = SimpleNamespace(
        embedding_top_k=5, embedding_batch_size=10, embedding_cache_wait_seconds=1,
    )
    with (
        patch.object(catalogs, "SemanticConfigRepository") as repository,
        patch.object(catalogs, "get_model_service") as model_service,
        patch.object(catalogs, "metric_embedding_scores", return_value=embedding_scores),
    ):
        repository.return_value.load.return_value.metric_matching = matching
        model_service.return_value.is_enabled.return_value = False
        return catalogs.search_metric_catalog(request, keyword, uow, limit)


@pytest.mark.parametrize(("explanation", "description"), [
    ("测试指标说明", "测试口径：仅统计已确认记录。"),
    ("", ""),
    ("测试指标说明", ""),
])
def test_search_preserves_maintained_definition_and_missing_values(explanation, description):
    item = MetricCatalogItem(
        code="test-balance", name="测试余额", unit="元", aliases=["测试余额别名"],
        explanation=explanation, description=description,
    )

    result = search_catalog([item])

    assert result["total"] == 1
    assert result["items"] == [{
        "metric_code": item.code, "metric_name": item.name, "unit": item.unit,
        "synonyms": item.aliases, "score": 1.0, "match_type": "exact",
        "metric_explanation": explanation, "description": description,
    }]
    assert result["semantic_suggestions"] == []


def test_search_includes_suggestion_knowledge_without_changing_match_status():
    items = [
        MetricCatalogItem(code="balance", name="测试余额", explanation="余额说明",
                          description="余额测试口径"),
        MetricCatalogItem(code="count", name="客户户数", explanation="户数说明",
                          description="户数测试口径"),
    ]

    result = search_catalog(items, embedding_scores={"count": 0.6}, limit=1)

    assert result["total"] == 1
    assert result["items"][0]["description"] == "余额测试口径"
    assert result["semantic_suggestions"] == [{
        "metric_code": "count", "metric_name": "客户户数", "unit": None,
        "synonyms": [], "score": 0.6, "match_type": "semantic",
        "metric_explanation": "户数说明", "description": "户数测试口径",
    }]


def test_embedding_texts_include_explanation_and_preserve_catalog_order():
    items = [
        MetricCatalogItem(code="a", name="甲指标", aliases=["甲别名"],
                          explanation="仅用于测试的业务含义", description="甲口径"),
        MetricCatalogItem(code="b", name="乙指标"),
    ]

    texts = catalog_embedding_texts(items)

    assert len(texts) == 2
    assert all(value in texts[0] for value in ("甲指标", "甲别名", "仅用于测试的业务含义", "甲口径"))
    assert texts[1].strip() == "乙指标"


def test_explanation_update_invalidates_cached_metric_representation():
    class EmbeddingModel:
        def embed(self, texts):
            return [[0.0, 1.0] if "新版说明" in value else [1.0, 0.0] for value in texts]

    model, cache = EmbeddingModel(), CatalogVectorCache()
    before = [MetricCatalogItem(code="a", name="测试余额", explanation="旧版说明")]
    after = [MetricCatalogItem(code="a", name="测试余额", explanation="新版说明")]

    old_vectors = cache.embed(model, "查询", catalog_embedding_texts(before))
    new_vectors = cache.embed(model, "查询", catalog_embedding_texts(after))

    assert list(old_vectors[1]) == [1.0, 0.0]
    assert list(new_vectors[1]) == [0.0, 1.0]


def test_analysis_suggestions_require_formal_lookup_and_definition_version():
    item = MetricCatalogItem(code="test-count", name="测试户数", explanation="统计已确认的客户数量")
    semantics = MetricSemantics([item], secret="test-secret", actor_id="user-1")

    discovery = semantics.search("服务对象有多少", embedding_scores={item.code: 0.8})

    assert discovery["total"] == 0
    assert discovery["items"] == []
    suggestion = discovery["semantic_suggestions"][0]
    assert suggestion["explanation"] == item.explanation
    assert suggestion["match_type"] == "semantic"
    assert "binding_ref" not in suggestion
    formal = semantics.search(item.code)["items"][0]
    assert semantics.resolve(formal["binding_ref"])["code"] == item.code
    changed = MetricSemantics([item.model_copy(update={"explanation": "新版测试定义"})],
                              secret="test-secret", actor_id="user-1")
    with pytest.raises(ApplicationError, match="已更新"):
        changed.resolve(formal["binding_ref"])


def test_analysis_suggestions_do_not_change_exact_priority_or_pagination():
    items = [MetricCatalogItem(code=str(i), name=f"测试指标{i}") for i in range(4)]
    semantics = MetricSemantics(items, secret="test-secret", actor_id="user-1")
    before = semantics.search("测试指标", page=2, page_size=2)
    after = semantics.search("测试指标", page=2, page_size=2, embedding_scores={"0": 0.9})
    assert after["items"] == before["items"]
    assert after["total"] == before["total"] == 4
    assert semantics.search("测试指标3", page_size=1)["items"][0]["code"] == "3"


@pytest.mark.parametrize("failure", [ModelServiceUnavailable("unavailable"), InvalidModelResponse("invalid")])
def test_analysis_retrieval_failure_keeps_lexical_results_and_reports_failure(failure):
    item = MetricCatalogItem(code="test-balance", name="测试余额")
    semantics = MetricSemantics([item], secret="test-secret", actor_id="user-1")
    service = SimpleNamespace(semantics=lambda actor: semantics)
    settings = SimpleNamespace(semantic_config_path=Path("unused"), _config_center=None)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        settings=settings, catalog_vector_cache=None,
    )))
    with (patch.object(analysis, "SemanticConfigRepository") as repository,
          patch.object(analysis, "get_model_service") as model,
          patch.object(analysis, "metric_embedding_scores", side_effect=failure)):
        repository.return_value.load.return_value.metric_matching = SimpleNamespace(
            embedding_top_k=5, embedding_batch_size=10, embedding_cache_wait_seconds=1)
        model.return_value.is_enabled.return_value = True
        result = analysis.discover_metrics(request, None, service, "余额", 1, 12)
    assert result["items"][0]["code"] == item.code
    assert result["semantic_retrieval"]["status"] == "unavailable"
    assert result["semantic_suggestions"] == []


def test_analysis_exact_lookup_does_not_call_embedding_service():
    semantics = MetricSemantics([MetricCatalogItem(code="test-count", name="测试户数")],
                               secret="test-secret", actor_id="user-1")
    with patch.object(analysis, "get_model_service") as model:
        result = analysis.discover_metrics(None, None, SimpleNamespace(semantics=lambda actor: semantics),
                                          "test-count", 1, 12)
    model.assert_not_called()
    assert result["items"][0]["match_type"] == "exact"


def test_analysis_topic_members_remain_unbound_semantic_suggestions():
    items = [MetricCatalogItem(code="seed", name="检索入口"),
             *[MetricCatalogItem(code=f"group-{i}", name=f"主题成员{i}") for i in range(12)],
             MetricCatalogItem(code="outside", name="独立候选")]
    semantics = MetricSemantics(items, secret="test-secret", actor_id="user-1")
    semantics.topic_groups = {"test": {"name": "测试主题", "default_sections": [],
        "codes": [item.code for item in items[:-1]]}}
    scores = {item.code: 0.9 - i * 0.01 for i, item in enumerate(items[1:])}
    result = semantics.search("检索入口", embedding_scores=scores, page_size=12)
    assert [item["code"] for item in result["items"]] == ["seed"]
    assert [item["code"] for item in result["semantic_suggestions"]] == [
        f"group-{i}" for i in range(12)
    ]
    assert all("binding_ref" not in item for item in result["semantic_suggestions"])
