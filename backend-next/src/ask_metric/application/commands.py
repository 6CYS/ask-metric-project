from dataclasses import dataclass

from ask_metric.application.requests import ActorContext, IncomingRequest
from ask_metric.domain.basic_query import BasicQuerySpec


@dataclass(frozen=True)
class SubmitQuestionCommand:
    request: IncomingRequest
    actor: ActorContext
    idempotency_key: str
    basic_query: BasicQuerySpec | None = None


@dataclass(frozen=True)
class ExecuteQueryCommand:
    task_id: str
    expected_version: int
    request_id: str
    actor: ActorContext
