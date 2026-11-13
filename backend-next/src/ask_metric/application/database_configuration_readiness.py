"""就绪检查复用运行读取器，发现漏导入；不建表、不填充默认正文或调用模型。"""

from ask_metric.application.agent_runtime_configuration import (
    AGENT_RUNTIME_RESOURCE,
    AgentRuntimeDocument,
)
from ask_metric.application.business_skills import DatabaseBusinessSkills
from ask_metric.application.database_business_knowledge import DatabaseBusinessKnowledgeStore
from ask_metric.application.database_metric_semantics import read_metric_semantics
from ask_metric.application.database_model_configuration import (
    DatabaseModelConfigRepository,
    DatabasePromptConfigRepository,
)
from ask_metric.application.database_runtime_configuration import (
    INQUIRY_TOPICS_RESOURCE,
    DatabaseSemanticConfigRepository,
    read_business_topics,
)
from ask_metric.infrastructure.configuration_repository import DatabaseConfigRepository


def validate_database_configuration(repository: DatabaseConfigRepository) -> None:
    DatabaseBusinessKnowledgeStore(repository).read()
    DatabaseBusinessSkills(repository).runtime()
    read_metric_semantics(repository)
    read_business_topics(repository)
    DatabaseSemanticConfigRepository(repository).load()
    DatabaseModelConfigRepository(repository).load()
    DatabasePromptConfigRepository(repository).load()
    runtime = AgentRuntimeDocument.model_validate(
        repository.read(AGENT_RUNTIME_RESOURCE).document()
    )
    if runtime.topicQueryEnabled:
        # 引用、布局和预算的完整校验仍由 Agent 原校验器完成，不建立第二套规则。
        repository.read(INQUIRY_TOPICS_RESOURCE).document()
