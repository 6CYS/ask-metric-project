"""指标扩展与管理关系共用一个版本，保持原始文档字段及绑定哈希契约。"""

from pathlib import Path

from pydantic import ValidationError

from ask_metric.application.metric_relationships import MetricRelationshipStore
from ask_metric.application.metric_semantics import SemanticExtensions
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.configuration_repository import (
    ConfigSnapshot,
    DatabaseConfigRepository,
    serialize_document,
)

SEMANTICS_RESOURCE = "analysis-semantics"


def import_metric_semantics(
    repository: DatabaseConfigRepository, content: str, *, actor: str
) -> ConfigSnapshot:
    SemanticExtensions.model_validate_json(content)
    return repository.initialize(SEMANTICS_RESOURCE, "metric-semantics", content, actor=actor)


def read_metric_semantics(repository: DatabaseConfigRepository) -> tuple[dict, str]:
    snapshot = repository.read(SEMANTICS_RESOURCE)
    try:
        document = snapshot.document()
        SemanticExtensions.model_validate(document)
    except (ValueError, ValidationError) as error:
        raise ApplicationError(
            "ANALYSIS_CONFIGURATION_ERROR", "数据库分析语义配置无效。", status_code=503
        ) from error
    # 不用 model_dump 重写旧关系的缺省 kind，否则会改变历史绑定版本。
    return document, snapshot.revision


class DatabaseMetricRelationshipStore(MetricRelationshipStore):
    def __init__(
        self,
        repository: DatabaseConfigRepository,
        topics_path: Path,
        *,
        actor: str,
        topics_document: dict | None = None,
    ):
        self.repository = repository
        self.topics_path = topics_path
        self.actor = actor
        self.topics_document = {"topics": topics_document} if topics_document is not None else None

    def _load(self):
        document, revision = read_metric_semantics(self.repository)
        extensions = SemanticExtensions.model_validate(document)
        return document, extensions.relations, revision

    def _persist(self, document: dict, *, expected_revision: str | None = None) -> str:
        SemanticExtensions.model_validate(document)
        if expected_revision is None:
            raise ValueError("数据库发布必须声明预期版本")
        try:
            return self.repository.publish(
                SEMANTICS_RESOURCE,
                serialize_document(document),
                expected_revision=expected_revision,
                actor=self.actor,
            ).revision
        except ApplicationError as error:
            if error.status_code == 409:
                raise ApplicationError(
                    "METRIC_RELATION_CONFLICT",
                    "指标关系已被更新，请刷新后重新编辑。",
                    status_code=409,
                ) from error
            raise
