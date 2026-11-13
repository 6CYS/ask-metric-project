"""仍在使用的主题与语义参数从共享版本表读取；不重新启用退役流程。"""

from pydantic import ValidationError

from ask_metric.application.metric_relationships import _Topics
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.configuration_repository import (
    ConfigSnapshot,
    DatabaseConfigRepository,
)
from ask_metric.infrastructure.semantic.configuration import (
    SemanticConfig,
    SemanticConfigRepository,
)

TOPICS_RESOURCE = "business-topics"
INQUIRY_TOPICS_RESOURCE = "inquiry-topics"
SEMANTIC_RESOURCE = "semantic-runtime"


def validate_business_topics(document: dict) -> None:
    _Topics.model_validate(document)
    for topic in document["topics"].values():
        if not topic.get("version") or not isinstance(topic.get("default_sections"), list):
            raise ValueError("主题缺少运行版本或默认章节")


def import_runtime_configuration(
    repository: DatabaseConfigRepository, key: str, content: str, *, actor: str
) -> ConfigSnapshot:
    import json

    document = json.loads(content)
    if key == TOPICS_RESOURCE:
        validate_business_topics(document)
    elif key == SEMANTIC_RESOURCE:
        SemanticConfig.model_validate(document)
    elif key == INQUIRY_TOPICS_RESOURCE:
        # 完整的引用、布局及执行预算校验复用 Agent 的 validateTopicRegistry；
        # 导入材料应先通过该校验，运行读取仍再次执行同一校验。
        if not isinstance(document, dict) or not isinstance(document.get("topics"), list):
            raise ValueError("Agent 主题导入格式无效")
    else:
        raise ValueError("不支持的业务配置资源")
    return repository.initialize(key, key, content, actor=actor)


def read_business_topics(repository: DatabaseConfigRepository) -> dict:
    document = repository.read(TOPICS_RESOURCE).document()
    try:
        validate_business_topics(document)
    except (ValueError, KeyError, TypeError, ValidationError) as error:
        raise ApplicationError(
            "TOPIC_CONFIG_INVALID", "数据库业务主题配置无效。", status_code=503
        ) from error
    topics: dict = document["topics"]
    return topics


class DatabaseSemanticConfigRepository(SemanticConfigRepository):
    def __init__(self, repository: DatabaseConfigRepository):
        self.repository = repository

    def load(self) -> SemanticConfig:
        try:
            return SemanticConfig.model_validate(self.repository.read(SEMANTIC_RESOURCE).document())
        except (ValueError, ValidationError) as error:
            raise ApplicationError(
                "SEMANTIC_CONFIG_INVALID", "数据库语义运行配置无效。", status_code=503
            ) from error
