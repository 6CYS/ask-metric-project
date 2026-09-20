from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from string import Formatter
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator, model_validator

_MAX_EXTRA_BODY_BYTES = 32_768
_MAX_EXTRA_BODY_DEPTH = 8
_SENSITIVE_BODY_FIELDS = {"accesskey", "access_key", "api_key", "apikey", "authorization"}


def _validate_json_object(value: dict[str, Any], *, field_name: str) -> dict[str, Any]:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must contain JSON-compatible values") from exc
    if len(encoded.encode("utf-8")) > _MAX_EXTRA_BODY_BYTES:
        raise ValueError(f"{field_name} must not exceed {_MAX_EXTRA_BODY_BYTES} bytes")

    def visit(item: Any, *, depth: int) -> None:
        if depth > _MAX_EXTRA_BODY_DEPTH:
            raise ValueError(f"{field_name} nesting must not exceed {_MAX_EXTRA_BODY_DEPTH}")
        if isinstance(item, dict):
            for key, nested in item.items():
                if not isinstance(key, str) or not key or len(key) > 128:
                    raise ValueError(f"{field_name} keys must be non-empty strings up to 128 chars")
                if any(character in key for character in ("\r", "\n", "\0")):
                    raise ValueError(f"{field_name} keys cannot contain control characters")
                if key.casefold() in _SENSITIVE_BODY_FIELDS:
                    raise ValueError(f"{field_name} cannot contain credential field {key!r}")
                visit(nested, depth=depth + 1)
        elif isinstance(item, list):
            for nested in item:
                visit(nested, depth=depth + 1)

    visit(value, depth=1)
    return value


def _reject_reserved_extra_body_fields(
    value: dict[str, Any], *, reserved: set[str]
) -> None:
    conflicts = sorted(set(value) & reserved)
    if conflicts:
        raise ValueError(
            "extra_body cannot override managed request fields: " + ", ".join(conflicts)
        )


class ModelAuthenticationConfig(BaseModel):
    type: Literal["none", "bearer", "header"] = "bearer"
    header: str = Field(default="Authorization", pattern=r"^[A-Za-z0-9-]+$")
    prefix: str = "Bearer "

    @model_validator(mode="after")
    def normalize_authentication(self) -> ModelAuthenticationConfig:
        if "\r" in self.prefix or "\n" in self.prefix:
            raise ValueError("Authentication prefix cannot contain line breaks")
        if self.type == "none":
            self.prefix = ""
        elif self.type == "header":
            self.prefix = self.prefix or ""
        return self


class ModelEndpointConfig(BaseModel):
    enabled: bool = True
    base_url: str = ""
    base_url_env: str = Field(default="", pattern=r"^(?:MODEL_[A-Z0-9_]+)?$")
    path: str = Field(min_length=1)
    model: str = Field(min_length=1)
    send_model: bool = True
    api_key_env: str = Field(default="", pattern=r"^(?:MODEL_[A-Z0-9_]+)?$")
    authentication: ModelAuthenticationConfig = Field(
        default_factory=ModelAuthenticationConfig
    )
    timeout_seconds: float = Field(default=60, gt=0, le=600)
    extra_body: dict[str, Any] = Field(default_factory=dict)

    @field_validator("extra_body")
    @classmethod
    def validate_extra_body(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _validate_json_object(value, field_name="extra_body")

    @model_validator(mode="after")
    def normalize_endpoint(self) -> ModelEndpointConfig:
        self.base_url = self.base_url.rstrip("/")
        self.path = "/" + self.path.lstrip("/")
        if not self.base_url and not self.base_url_env:
            raise ValueError("Model endpoint requires base_url or base_url_env")
        if self.base_url and not self.base_url.startswith(("http://", "https://")):
            raise ValueError("Model endpoint base_url must use http or https")
        if self.authentication.type != "none" and not self.api_key_env:
            raise ValueError("Authenticated model endpoints require api_key_env")
        return self


class ChatModelConfig(ModelEndpointConfig):
    model: str = Field(min_length=1)
    temperature: float | None = Field(default=0, ge=0, le=2)
    max_tokens: int | None = Field(default=4096, gt=0)
    response_format: Literal["text", "json_object"] = "json_object"
    send_response_format: bool = True
    enable_thinking: bool = False
    send_enable_thinking: bool = True
    user_message_suffix: str = ""
    chat_template_kwargs: dict[str, Any] = Field(
        default_factory=lambda: {"enable_thinking": False}
    )

    @field_validator("chat_template_kwargs")
    @classmethod
    def validate_chat_template_kwargs(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = _validate_json_object(value, field_name="chat_template_kwargs")
        enable_thinking = validated.get("enable_thinking")
        if enable_thinking is not None and not isinstance(enable_thinking, bool):
            raise ValueError("chat_template_kwargs.enable_thinking must be a boolean")
        return validated

    @model_validator(mode="after")
    def validate_user_message_suffix(self) -> ChatModelConfig:
        if "\r" in self.user_message_suffix:
            raise ValueError("Chat user message suffix cannot contain carriage returns")
        _reject_reserved_extra_body_fields(
            self.extra_body,
            reserved={
                "chat_template_kwargs",
                "enable_thinking",
                "max_tokens",
                "messages",
                "model",
                "response_format",
                "stream",
                "temperature",
            },
        )
        return self


class EmbeddingModelConfig(ModelEndpointConfig):
    dimensions: int | None = Field(default=None, gt=0)
    encoding_format: Literal["float", "base64"] | None = "float"
    user: str | None = None

    @model_validator(mode="after")
    def validate_embedding_extra_body(self) -> EmbeddingModelConfig:
        _reject_reserved_extra_body_fields(
            self.extra_body,
            reserved={"dimensions", "encoding_format", "input", "model", "user"},
        )
        return self


class RerankerModelConfig(ModelEndpointConfig):
    top_n: int = Field(default=20, gt=0, le=1000)
    return_documents: bool = False
    send_top_n: bool = True
    send_return_documents: bool = True
    documents_field: Literal["documents", "texts"] = "documents"

    @model_validator(mode="after")
    def validate_reranker_extra_body(self) -> RerankerModelConfig:
        _reject_reserved_extra_body_fields(
            self.extra_body,
            reserved={
                "documents",
                "model",
                "query",
                "return_documents",
                "texts",
                "top_n",
            },
        )
        return self


class ModelRolesConfig(BaseModel):
    chat: ChatModelConfig
    embedding: EmbeddingModelConfig
    reranker: RerankerModelConfig


class ModelRuntimeConfig(BaseModel):
    schema_version: Literal[2] = 2
    provider: str = Field(min_length=1)
    models: ModelRolesConfig


class PromptTemplate(BaseModel):
    version: str = Field(min_length=1)
    display_name: str = ""
    description: str = ""
    editable_fields: list[
        Literal["system", "user_template", "query_prefix", "query_template"]
    ] = Field(default_factory=list)
    enable_thinking: bool = False
    system: str | None = None
    user_template: str | None = None
    query_prefix: str | None = None
    query_template: str | None = None


class PromptRuntimeConfig(BaseModel):
    schema_version: int = 1
    prompts: dict[str, PromptTemplate]


class ModelConfigRepository:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> ModelRuntimeConfig:
        return ModelRuntimeConfig.model_validate(_read_json(self.path))

    def save(self, config: ModelRuntimeConfig) -> None:
        _write_json(self.path, config.model_dump(mode="json"))


class PromptConfigRepository:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> PromptRuntimeConfig:
        data = _read_json(self.path)
        # 持久配置可来自旧版本；退役提示词不再加载或暴露，保留磁盘文件供回退。
        data.get("prompts", {}).pop("intent_routing", None)
        return PromptRuntimeConfig.model_validate(data)

    def save(self, config: PromptRuntimeConfig) -> None:
        _write_json(self.path, config.model_dump(mode="json"))

    def validate_update(self, updated: PromptRuntimeConfig) -> None:
        current = self.load()
        if set(updated.prompts) != set(current.prompts):
            raise ValueError("Prompt names cannot be added or removed at runtime")
        content_fields = ("system", "user_template", "query_prefix", "query_template")
        for name, current_prompt in current.prompts.items():
            next_prompt = updated.prompts[name]
            if next_prompt.editable_fields != current_prompt.editable_fields:
                raise ValueError(f"Prompt {name!r} editable fields cannot be changed")
            for field_name in content_fields:
                before = getattr(current_prompt, field_name)
                after = getattr(next_prompt, field_name)
                if before == after:
                    continue
                if field_name not in current_prompt.editable_fields:
                    raise ValueError(f"Prompt {name!r} field {field_name!r} is protected")
                if _template_variables(before) != _template_variables(after):
                    raise ValueError(
                        f"Prompt {name!r} field {field_name!r} must preserve its variables"
                    )

    def render(self, prompt_name: str, variables: dict[str, Any]) -> list[dict[str, str]]:
        prompt = self.load().prompts.get(prompt_name)
        if prompt is None:
            raise KeyError(f"Prompt {prompt_name!r} is not configured")
        messages: list[dict[str, str]] = []
        if prompt.system:
            messages.append({"role": "system", "content": _render(prompt.system, variables)})
        if prompt.user_template:
            messages.append(
                {"role": "user", "content": _render(prompt.user_template, variables)}
            )
        if not messages:
            raise ValueError(f"Prompt {prompt_name!r} is not a chat prompt")
        return messages

    def thinking_enabled(self, prompt_name: str, *, default: bool = False) -> bool:
        prompt = self.load().prompts.get(prompt_name)
        return prompt.enable_thinking if prompt is not None else default


class ConfigVersion(BaseModel):
    id: str
    resource_type: Literal["prompt", "sql"]
    resource_key: str
    version_number: int
    action: Literal["publish", "rollback"]
    created_at: datetime
    created_by: str
    source_version_id: str | None = None
    snapshot: dict[str, Any] | str


class ConfigHistoryRepository:
    def __init__(self, root: Path) -> None:
        self.root = root

    def record(
        self,
        *,
        resource_type: Literal["prompt", "sql"],
        resource_key: str,
        snapshot: dict[str, Any] | str,
        created_by: str,
        action: Literal["publish", "rollback"] = "publish",
        source_version_id: str | None = None,
    ) -> ConfigVersion:
        versions = self.list(resource_type=resource_type, resource_key=resource_key)
        value = ConfigVersion(
            id=str(uuid4()),
            resource_type=resource_type,
            resource_key=resource_key,
            version_number=len(versions) + 1,
            action=action,
            created_at=datetime.now(UTC),
            created_by=created_by,
            source_version_id=source_version_id,
            snapshot=snapshot,
        )
        filename = f"{value.version_number:06d}-{value.id}.json"
        path = self._directory(resource_type, resource_key) / filename
        _write_json(path, value.model_dump(mode="json"))
        return value

    def list(
        self, *, resource_type: Literal["prompt", "sql"], resource_key: str
    ) -> list[ConfigVersion]:
        directory = self._directory(resource_type, resource_key)
        if not directory.exists():
            return []
        return [
            ConfigVersion.model_validate(_read_json(path))
            for path in sorted(directory.glob("*.json"), reverse=True)
        ]

    def get(
        self,
        *,
        resource_type: Literal["prompt", "sql"],
        resource_key: str,
        version_id: str,
    ) -> ConfigVersion:
        version = next(
            (
                item
                for item in self.list(resource_type=resource_type, resource_key=resource_key)
                if item.id == version_id
            ),
            None,
        )
        if version is None:
            raise KeyError(f"Configuration version {version_id!r} was not found")
        return version

    def _directory(self, resource_type: str, resource_key: str) -> Path:
        safe_key = re.sub(r"[^a-zA-Z0-9_.-]+", "_", resource_key)
        return self.root / resource_type / safe_key


def resolve_config_path(project_dir: Path, configured_path: Path) -> Path:
    if configured_path.is_absolute():
        return configured_path
    return project_dir / configured_path


def _render(template: str, variables: dict[str, Any]) -> str:
    required = _template_variables(template)
    missing = sorted(required - variables.keys())
    if missing:
        raise ValueError(f"Missing prompt variables: {', '.join(missing)}")
    return template.format_map(variables)


def _template_variables(template: str | None) -> set[str]:
    if not template:
        return set()
    return {
        field_name
        for _, field_name, _, _ in Formatter().parse(template)
        if field_name is not None
    }


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)
