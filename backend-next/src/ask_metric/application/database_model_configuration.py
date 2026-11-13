"""模型、提示词与历史复用共享版本表；请求固定快照，发布与历史同事务。"""

import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.configuration_repository import (
    ConfigSnapshot,
    DatabaseConfigRepository,
    serialize_document,
)
from ask_metric.infrastructure.model.configuration import (
    ConfigHistoryRepository,
    ConfigVersion,
    ModelConfigRepository,
    ModelRuntimeConfig,
    PromptConfigRepository,
    PromptRuntimeConfig,
    PromptTemplate,
)

MODELS_RESOURCE = "backend-models"
PROMPTS_RESOURCE = "backend-prompt-index"
PROMPT_PREFIX = "backend-prompt:"


def prompt_key(name: str) -> str:
    if not name or len(PROMPT_PREFIX + name) > 190:
        raise ValueError("提示词名称无效")
    return PROMPT_PREFIX + name


def same_imported_prompt_history(
    saved: list[ConfigSnapshot], incoming: list[ConfigSnapshot]
) -> bool:
    """没有历史身份的初始模板可幂等重导；真实历史必须保留原ID及操作来源。"""
    return len(saved) == len(incoming) and all(
        before.document() == after.document()
        and (
            "history_created_at" not in after.document()
            or (
                before.id == after.id
                and before.created_by == after.created_by
                and before.action == after.action
                and before.source_version_id == after.source_version_id
            )
        )
        for before, after in zip(reversed(saved), incoming, strict=True)
    )


def import_model_configuration(
    repository: DatabaseConfigRepository,
    content: str,
    *,
    actor: str,
) -> ConfigSnapshot:
    # 延续现有角色策略；不因迁库重新启用已退役的检索模型。
    config = ModelRuntimeConfig.model_validate_json(content)
    return repository.initialize(
        MODELS_RESOURCE, "models", serialize_document(config.model_dump(mode="json")), actor=actor
    )


def import_prompt_configuration(
    repository: DatabaseConfigRepository,
    content: str,
    *,
    actor: str,
    history: dict[str, list[ConfigVersion]] | None = None,
) -> ConfigSnapshot:
    document = json.loads(content)
    document.get("prompts", {}).pop("intent_routing", None)
    config = PromptRuntimeConfig.model_validate(document)
    if set(history or {}) - set(config.prompts) - {"intent_routing"}:
        raise ValueError("存在不属于当前提示词目录的历史，请先核对迁移范围")
    prepared: dict[str, list[ConfigSnapshot]] = {}
    for name, prompt in config.prompts.items():
        key = prompt_key(name)
        versions = sorted((history or {}).get(name, []), key=lambda item: item.version_number)
        imported = []
        for item in versions:
            if item.resource_type != "prompt" or item.resource_key != name:
                raise ValueError("提示词历史归属不一致")
            value = PromptTemplate.model_validate(item.snapshot)
            snapshot = repository._snapshot(
                key,
                serialize_document(
                    {
                        "prompt": value.model_dump(mode="json"),
                        "history_created_at": item.created_at.isoformat(),
                    }
                ),
                item.created_by,
                item.version_number,
                item.action,
                item.source_version_id,
            )
            imported.append(
                replace(snapshot, id=item.id, created_ms=int(item.created_at.timestamp() * 1000))
            )
        if (
            not imported
            or PromptTemplate.model_validate(
                imported[-1].document()["prompt"],
            )
            != prompt
        ):
            imported.append(
                repository._snapshot(
                    key,
                    serialize_document({"prompt": prompt.model_dump(mode="json")}),
                    actor,
                    imported[-1].version_number + 1 if imported else 1,
                    "publish",
                )
            )
        prepared[name] = imported
    # 先校验全部输入；索引最后发布。中断后可幂等重试，未发布索引不会暴露半套提示词。
    for name, snapshots in prepared.items():
        existing = None
        try:
            existing = repository.read(prompt_key(name))
        except ApplicationError as error:
            if error.code != "CONFIG_NOT_INITIALIZED":
                raise
        if existing is not None:
            saved = repository.versions(prompt_key(name))
            # 无旧历史时重跑导入不应因新生成 UUID/时间而被误判；有历史仍逐项核对身份。
            if PromptTemplate.model_validate(existing.document()["prompt"]) != config.prompts[
                name
            ] or not same_imported_prompt_history(saved, snapshots):
                raise ApplicationError(
                    "CONFIG_VERSION_CONFLICT", "已存在不同的提示词历史", status_code=409
                )
            continue
        repository.initialize_history(prompt_key(name), "prompt", snapshots)
    return repository.initialize(
        PROMPTS_RESOURCE,
        "prompt-index",
        serialize_document(
            {
                "schema_version": config.schema_version,
                "names": list(config.prompts),
            }
        ),
        actor=actor,
    )


class DatabaseModelConfigRepository(ModelConfigRepository):
    def __init__(self, repository: DatabaseConfigRepository, *, actor: str = "runtime"):
        super().__init__(Path("unused"))
        self.repository = repository
        self.actor = actor
        self.snapshot: ConfigSnapshot | None = None
        self.expected_revision: str | None = None

    def read_document(self) -> dict:
        if self.snapshot is None:
            self.snapshot = self.repository.read(MODELS_RESOURCE)
        return self.snapshot.document()

    def load(self) -> ModelRuntimeConfig:
        try:
            return super().load()
        except ValueError as error:
            raise ApplicationError(
                "MODEL_CONFIG_INVALID", "数据库模型配置无效", status_code=503
            ) from error

    @property
    def revision(self) -> str:
        self.read_document()
        assert self.snapshot is not None
        return self.snapshot.revision

    def save(self, config: ModelRuntimeConfig) -> None:
        self.snapshot = self.repository.publish(
            MODELS_RESOURCE,
            serialize_document(config.model_dump(mode="json")),
            expected_revision=self.expected_revision or self.revision,
            actor=self.actor,
        )


class DatabasePromptConfigRepository(PromptConfigRepository):
    def __init__(self, repository: DatabaseConfigRepository):
        super().__init__(Path("unused"))
        self.repository = repository
        self.snapshots: dict[str, ConfigSnapshot] | None = None
        self.schema_version = 1

    def load(self) -> PromptRuntimeConfig:
        if self.snapshots is None:
            index = self.repository.read(PROMPTS_RESOURCE).document()
            names = index.get("names")
            if (
                not isinstance(names, list)
                or not names
                or any(not isinstance(name, str) for name in names)
                or len(set(names)) != len(names)
            ):
                raise ApplicationError(
                    "PROMPT_CONFIG_INVALID", "数据库提示词索引无效", status_code=503
                )
            self.schema_version = index["schema_version"]
            snapshots = self.repository.read_many([prompt_key(name) for name in names])
            self.snapshots = {name: snapshots[prompt_key(name)] for name in names}
        try:
            return PromptRuntimeConfig(
                schema_version=self.schema_version,
                prompts={
                    name: PromptTemplate.model_validate(snapshot.document()["prompt"])
                    for name, snapshot in self.snapshots.items()
                },
            )
        except (ValidationError, KeyError) as error:
            raise ApplicationError(
                "PROMPT_CONFIG_INVALID", "数据库提示词配置无效", status_code=503
            ) from error

    @property
    def revisions(self) -> dict[str, str]:
        self.load()
        assert self.snapshots is not None
        return {name: item.revision for name, item in self.snapshots.items()}

    def save(self, config: PromptRuntimeConfig) -> None:
        raise RuntimeError("数据库提示词必须逐项发布并保留历史")

    def publish_prompt(
        self,
        name: str,
        prompt: PromptTemplate,
        *,
        actor: str,
        expected_revision: str | None = None,
        source_version_id: str | None = None,
    ) -> PromptTemplate:
        current = self.load()
        if name not in current.prompts:
            raise ApplicationError("PROMPT_NOT_FOUND", "Prompt was not found", status_code=404)
        current.prompts[name] = prompt
        try:
            self.validate_update(current)
        except ValueError as error:
            raise ApplicationError("PROMPT_UPDATE_INVALID", str(error), status_code=422) from error
        assert self.snapshots is not None
        if source_version_id is not None:
            source = self.repository.version(prompt_key(name), source_version_id)
            if PromptTemplate.model_validate(source.document()["prompt"]) != prompt:
                raise ApplicationError(
                    "CONFIG_VERSION_CONFLICT", "回滚内容与历史不一致", status_code=409
                )
        snapshot = self.repository.publish(
            prompt_key(name),
            serialize_document({"prompt": prompt.model_dump(mode="json")}),
            expected_revision=expected_revision or self.snapshots[name].revision,
            actor=actor,
            action="rollback" if source_version_id is not None else "publish",
            source_version_id=source_version_id,
        )
        self.snapshots[name] = snapshot
        return prompt


class DatabasePromptHistoryRepository(ConfigHistoryRepository):
    def __init__(self, repository: DatabaseConfigRepository):
        super().__init__(Path("unused"))
        self.repository = repository

    def list(self, *, resource_type, resource_key) -> list[ConfigVersion]:
        if resource_type != "prompt" or resource_key == "intent_routing":
            return []
        return [
            ConfigVersion(
                id=item.id,
                resource_type="prompt",
                resource_key=resource_key,
                version_number=item.version_number,
                action="rollback" if item.action == "rollback" else "publish",
                created_at=item.document().get("history_created_at")
                or datetime.fromtimestamp(item.created_ms / 1000, UTC),
                created_by=item.created_by,
                source_version_id=item.source_version_id,
                snapshot=item.document()["prompt"],
            )
            for item in self.repository.versions(prompt_key(resource_key))
        ]

    def record(self, **kwargs) -> ConfigVersion:
        raise RuntimeError("数据库历史必须与提示词当前版本同事务发布")
