"""Skill 配置整体发布；默认、人工覆盖与请求绑定版本均由应用库保存。"""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.configuration_repository import (
    ConfigSnapshot,
    DatabaseConfigRepository,
    serialize_document,
)

SKILLS_RESOURCE = "business-skills"
CONNECTED_SKILLS = frozenset({"inquiry-analysis"})


class SkillDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=128)
    description: str = Field(min_length=1)
    content: str = Field(min_length=1)
    disable_model_invocation: bool = False


def validate_content(content: str) -> str:
    # 前端及原 Node 实现的长度均按 UTF-16 code unit 计算。
    if not content.strip() or len(content.encode("utf-16-le")) // 2 > 100_000:
        raise ValueError("Skill 正文不能为空，且不能超过 100,000 字符")
    return content


class SkillOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str
    updated_at: str
    updated_by: str

    @model_validator(mode="after")
    def check_content(self):
        validate_content(self.content)
        return self


class SkillDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: int = Field(default=1, ge=1, le=1)
    skills: list[SkillDefinition] = Field(min_length=1)
    overrides: dict[str, SkillOverride] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_names(self):
        names = [skill.name for skill in self.skills]
        if len(set(names)) != len(names) or not CONNECTED_SKILLS.issubset(names):
            raise ValueError("Skill 名称重复或缺少已接入的 Skill")
        if any(name not in names for name in self.overrides):
            raise ValueError("人工覆盖引用了不存在的 Skill")
        return self


def import_skills(
    repository: DatabaseConfigRepository,
    skills: list[dict[str, Any]],
    *,
    actor: str,
    overrides: dict[str, Any] | None = None,
) -> ConfigSnapshot:
    default = SkillDocument.model_validate({"skills": skills})
    current = SkillDocument.model_validate({"skills": skills, "overrides": overrides or {}})
    # 当前有效正文与默认版本同事务导入；重跑不能覆盖已发布的人工修改。
    return repository.initialize(
        SKILLS_RESOURCE,
        "business-skills",
        serialize_document(current.model_dump()),
        actor=actor,
        default_content=serialize_document(default.model_dump()),
    )


class DatabaseBusinessSkills:
    def __init__(self, repository: DatabaseConfigRepository):
        self.repository = repository

    def _load(self, version_id: str | None = None) -> tuple[ConfigSnapshot, SkillDocument]:
        snapshot = (
            self.repository.version(SKILLS_RESOURCE, version_id)
            if version_id
            else self.repository.read(SKILLS_RESOURCE)
        )
        try:
            return snapshot, SkillDocument.model_validate(snapshot.document())
        except (ValidationError, ValueError) as error:
            raise ApplicationError(
                "SKILL_CONFIG_INVALID", "数据库 Skill 配置无效，请联系管理员", status_code=503,
            ) from error

    @staticmethod
    def _items(document: SkillDocument) -> list[dict[str, Any]]:
        items = []
        for skill in document.skills:
            override = document.overrides.get(skill.name)
            content = override.content if override else skill.content
            revision = hashlib.sha256(
                json.dumps(
                    [skill.name, skill.description, content],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            items.append(
                {
                    "name": skill.name,
                    "display_name": next(
                        (
                            line[2:].strip()
                            for line in skill.content.split("\n")
                            if line.startswith("# ")
                        ),
                        "",
                    )
                    or skill.name,
                    "description": skill.description,
                    "content": content,
                    "revision": revision,
                    "editable": skill.name in CONNECTED_SKILLS,
                    "modified": override is not None,
                    "updated_at": override.updated_at if override else None,
                    "updated_by": override.updated_by if override else None,
                }
            )
        return sorted(items, key=lambda item: not item["editable"])

    def list(self) -> list[dict[str, Any]]:
        return self._items(self._load()[1])

    def runtime(self, version_id: str | None = None) -> dict[str, Any]:
        snapshot, document = self._load(version_id)
        definitions = {skill.name: skill for skill in document.skills}
        return {
            "version_id": snapshot.id,
            "skills": [
                {
                    "name": item["name"],
                    "description": item["description"],
                    "content": item["content"],
                    "disable_model_invocation": definitions[item["name"]].disable_model_invocation,
                }
                for item in self._items(document)
                if item["editable"]
            ],
        }

    def change(
        self,
        name: str,
        revision: str,
        *,
        content: str | None = None,
        actor: str,
        restore: bool = False,
    ) -> dict[str, Any]:
        snapshot, document = self._load()
        item = next((item for item in self._items(document) if item["name"] == name), None)
        if item is None:
            raise ApplicationError("SKILL_NOT_FOUND", "Skill 不存在", status_code=404)
        if not item["editable"]:
            raise ApplicationError(
                "SKILL_NOT_CONNECTED", "该 Skill 尚未接入当前问数，仅可查看", status_code=400
            )
        if not revision:
            raise ApplicationError(
                "SKILL_REVISION_REQUIRED", "缺少 Skill 版本，请刷新后重试", status_code=400
            )
        if revision != item["revision"]:
            raise ApplicationError(
                "SKILL_REVISION_CONFLICT", "Skill 已被修改，请刷新后核对最新内容", status_code=409
            )
        source_id = None
        if restore:
            default = self.repository.default(SKILLS_RESOURCE)
            defaults = SkillDocument.model_validate(default.document())
            definition = next(skill for skill in defaults.skills if skill.name == name)
            document.skills = [
                definition if skill.name == name else skill for skill in document.skills
            ]
            document.overrides.pop(name, None)
            source_id = default.id
        else:
            try:
                validate_content(content if content is not None else "")
            except ValueError as error:
                raise ApplicationError(
                    "SKILL_CONTENT_INVALID", str(error), status_code=400
                ) from error
            document.overrides[name] = SkillOverride(
                content=content or "",
                updated_at=datetime.now(UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
                updated_by=actor,
            )
        try:
            saved = self.repository.publish(
                SKILLS_RESOURCE,
                serialize_document(document.model_dump()),
                expected_revision=snapshot.revision,
                actor=actor,
                action="restore-default" if restore else "publish",
                source_version_id=source_id,
            )
        except ApplicationError as error:
            if error.status_code == 409:
                raise ApplicationError(
                    "SKILL_REVISION_CONFLICT",
                    "Skill 已被修改，请刷新后核对最新内容",
                    status_code=409,
                ) from error
            raise
        return next(
            item
            for item in self._items(SkillDocument.model_validate(saved.document()))
            if item["name"] == name
        )
