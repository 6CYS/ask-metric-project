"""Agent 非敏感运行参数；凭据只保存安全配置引用，不将密钥发给浏览器或写入快照。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ask_metric.infrastructure.configuration_repository import (
    DatabaseConfigRepository,
    serialize_document,
)
from ask_metric.infrastructure.model.configuration import _validate_json_object

AGENT_RUNTIME_RESOURCE = "agent-runtime"


class AgentModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    baseUrl: str
    name: str
    apiKeyEnv: Literal["AGENT_MODEL_API_KEY"] = "AGENT_MODEL_API_KEY"
    authHeader: str = Field(pattern=r"^[A-Za-z0-9-]+$")
    authPrefix: str
    userMessageSuffix: str
    extraBody: dict
    contextWindow: int = Field(gt=0, strict=True)
    maxTokens: int = Field(gt=0, strict=True)

    @field_validator("extraBody")
    @classmethod
    def validate_body(cls, value: dict) -> dict:
        return _validate_json_object(value, field_name="extraBody")

    @field_validator("authPrefix")
    @classmethod
    def validate_prefix(cls, value: str) -> str:
        if "\r" in value or "\n" in value:
            raise ValueError("认证前缀不能包含换行")
        return value


class AgentRetry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    maxRetries: int = Field(gt=0, strict=True)
    baseDelayMs: int = Field(gt=0, strict=True)


class AgentCompaction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    reserveTokens: int = Field(gt=0, strict=True)
    keepRecentTokens: int = Field(gt=0, strict=True)


class AgentRuntimeDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    model: AgentModel
    modelRetry: AgentRetry
    modelStreamIdleTimeoutMs: int = Field(gt=0, strict=True)
    modelFirstResponseTimeoutMs: int = Field(gt=0, strict=True)
    answerStreaming: bool
    topicQueryEnabled: bool
    compaction: AgentCompaction

    @model_validator(mode="after")
    def validate_budget(self):
        if self.model.maxTokens >= self.model.contextWindow:
            raise ValueError("输出预算必须小于模型上下文窗口")
        if (
            self.compaction.enabled
            and self.compaction.reserveTokens + self.compaction.keepRecentTokens
            >= self.model.contextWindow
        ):
            raise ValueError("压缩与保留预算必须小于模型上下文窗口")
        return self


def import_agent_runtime(repository: DatabaseConfigRepository, content: str, *, actor: str):
    document = AgentRuntimeDocument.model_validate_json(content)
    return repository.initialize(
        AGENT_RUNTIME_RESOURCE,
        "agent-runtime",
        serialize_document(document.model_dump(mode="json")),
        actor=actor,
    )
