"""复用知识校验和召回算法，仅将同源文档读写换成共享数据库事务。"""

import json
from collections.abc import Callable

from sqlalchemy import Connection, delete, insert, select
from sqlalchemy.exc import SQLAlchemyError

from ask_metric.application.business_knowledge import (
    BusinessKnowledgeStore,
    KnowledgeDocument,
    KnowledgeEntry,
)
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.configuration_repository import (
    ConfigSnapshot,
    DatabaseConfigRepository,
    serialize_document,
)
from ask_metric.infrastructure.db.business_knowledge import knowledge_entries, knowledge_metrics
from ask_metric.infrastructure.db.configuration import config_resources

KNOWLEDGE_RESOURCE = "business-knowledge"


def project_knowledge(connection: Connection, snapshot: ConfigSnapshot) -> None:
    document = KnowledgeDocument.model_validate_json(snapshot.content)
    connection.execute(delete(knowledge_metrics))
    connection.execute(delete(knowledge_entries))
    entries = []
    metrics: list[dict[str, str | int]] = []
    for position, entry in enumerate(document.entries):
        entries.append(
            {
                "entry_id": entry.id,
                "version_id": snapshot.id,
                "sort_order": position,
                "title": entry.title,
                "enabled": entry.enabled,
                "content_json": json.dumps(entry.model_dump(mode="json"), ensure_ascii=False),
            }
        )
        metrics.extend(
            {
                "entry_id": entry.id,
                "metric_code": code,
                "sort_order": index,
            }
            for index, code in enumerate(entry.metric_codes)
        )
    if entries:
        connection.execute(insert(knowledge_entries), entries)
    if metrics:
        connection.execute(insert(knowledge_metrics), metrics)


def import_knowledge(
    repository: DatabaseConfigRepository,
    content: str,
    *,
    actor: str,
) -> ConfigSnapshot:
    KnowledgeDocument.model_validate_json(content)
    return repository.initialize(
        KNOWLEDGE_RESOURCE,
        "business_knowledge",
        content,
        actor=actor,
        projection=project_knowledge,
    )


class DatabaseBusinessKnowledgeStore(BusinessKnowledgeStore):
    def __init__(self, repository: DatabaseConfigRepository, *, actor: str = "system"):
        self.repository, self.actor = repository, actor

    def _load(self) -> tuple[KnowledgeDocument, str]:
        try:
            # 一条SQL读取当前版本与该版本的条目，避免两次读取跨越并发发布。
            with self.repository.engine.connect() as connection:
                rows = (
                    connection.execute(
                        select(config_resources.c.revision, knowledge_entries.c.content_json)
                        .outerjoin(
                            knowledge_entries,
                            knowledge_entries.c.version_id == config_resources.c.current_version_id,
                        )
                        .where(config_resources.c.resource_key == KNOWLEDGE_RESOURCE)
                        .order_by(knowledge_entries.c.sort_order)
                    )
                    .mappings()
                    .all()
                )
            if not rows:
                raise ApplicationError(
                    "CONFIG_NOT_INITIALIZED",
                    "业务知识尚未导入数据库，请联系管理员。",
                    status_code=503,
                )
            entries = [
                KnowledgeEntry.model_validate_json(row["content_json"])
                for row in rows
                if row["content_json"] is not None
            ]
            return KnowledgeDocument(entries=entries), rows[0]["revision"]
        except (SQLAlchemyError, ValueError) as error:
            raise ApplicationError(
                "BUSINESS_KNOWLEDGE_UNAVAILABLE",
                "业务知识存储暂不可用，请稍后重试。",
                status_code=503,
            ) from error

    def _change(
        self,
        revision: str,
        change: Callable[[list[KnowledgeEntry]], KnowledgeEntry],
    ) -> dict:
        document, current_revision = self._load()
        if current_revision != revision:
            self._conflict()
        item = change(document.entries)
        try:
            snapshot = self.repository.publish(
                KNOWLEDGE_RESOURCE,
                serialize_document(document.model_dump(mode="json")),
                expected_revision=revision,
                actor=self.actor,
                projection=project_knowledge,
            )
        except ApplicationError as error:
            if error.code == "CONFIG_VERSION_CONFLICT":
                self._conflict()
            raise
        return {"item": item.model_dump(mode="json"), "revision": snapshot.revision}

    @staticmethod
    def _conflict() -> None:
        raise ApplicationError(
            "BUSINESS_KNOWLEDGE_CONFLICT",
            "业务知识已被更新，请刷新后重新编辑。",
            status_code=409,
        )
