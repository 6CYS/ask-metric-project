from dataclasses import dataclass, field
from typing import Any, Literal

from ask_metric.application.requests import ActorContext, IncomingRequest
from ask_metric.domain.basic_query import BasicQuerySpec


@dataclass(frozen=True)
class QueryReference:
    """单来源追问引用：组合修改条件；兼容旧机构/日期协议，后端校验后冻结。"""

    task_id: str
    version: int
    change_field: Literal["orgs", "time", "compose"] = "compose"
    mode: Literal["explicit", "candidate"] = "explicit"


@dataclass(frozen=True)
class SubmitQuestionCommand:
    request: IncomingRequest
    actor: ActorContext
    idempotency_key: str
    basic_query: BasicQuerySpec | None = None
    query_reference: QueryReference | None = None


@dataclass(frozen=True)
class AnalyzeSemanticCommand:
    task_id: str
    expected_version: int
    request_id: str = ""
    actor: ActorContext | None = None
    channel: str = "web"


@dataclass(frozen=True)
class ExecuteQueryCommand:
    task_id: str
    expected_version: int
    request_id: str
    actor: ActorContext


@dataclass(frozen=True)
class RequestClarificationCommand:
    task_id: str
    expected_version: int
    clarification_id: str
    prompt: str
    clarification_type: str
    options: list[Any] = field(default_factory=list)
    request_id: str = ""
    channel: str = "web"
    external_message_id: str | None = None
    channel_context: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SubmitClarificationCommand:
    task_id: str
    expected_version: int
    clarification_id: str
    answers: Any
    actor: ActorContext
    channel: str
    channel_context: dict[str, Any]
    request_id: str


@dataclass(frozen=True)
class CancelClarificationCommand:
    task_id: str
    expected_version: int
    clarification_id: str
    actor: ActorContext
    request_id: str


@dataclass(frozen=True)
class CancelTaskCommand:
    """通用逻辑取消：RUNNING/WAITING_USER 任务取消，不承诺数据库驱动即时停止 SQL。"""

    task_id: str
    expected_version: int
    actor: ActorContext
    request_id: str
