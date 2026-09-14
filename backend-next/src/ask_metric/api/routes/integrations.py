from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import AliasChoices, BaseModel, Field

from ask_metric.api.dependencies import (
    get_channel_clarification_service,
    get_query_execution_service,
    get_query_task_service,
    get_semantic_task_service,
)
from ask_metric.api.query_readiness import require_query_ready
from ask_metric.application.channel_service import ChannelClarificationService
from ask_metric.application.integration_identity import (
    ExternalUserProfile,
    IntegrationIdentityService,
)
from ask_metric.application.integration_service import (
    IntegrationAskApplicationService,
    IntegrationAskResult,
)
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import QUESTION_MAX_LENGTH
from ask_metric.application.semantic_task_service import SemanticTaskApplicationService
from ask_metric.application.task_service import QueryTaskApplicationService

router = APIRouter(prefix="/api/v1/integrations", tags=["integrations"])


class IntegrationHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=4000)


class IntegrationUser(BaseModel):
    user_code: str = Field(min_length=1, max_length=128)
    login_code: str | None = Field(default=None, max_length=64)
    user_name: str = Field(min_length=1, max_length=128)
    corpo_code: str | None = Field(default=None, max_length=128)
    corpo_name: str | None = Field(default=None, max_length=255)
    org_code: str = Field(min_length=1, max_length=128)
    org_name: str | None = Field(default=None, max_length=255)
    dept_code: str | None = Field(default=None, max_length=128)
    dept_name: str | None = Field(default=None, max_length=255)


class IntegrationAskRequest(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    source_system: str = Field(default="dingding", min_length=1, max_length=64)
    message_id: str | None = Field(default=None, min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=128)
    user_input: str = Field(min_length=1, max_length=QUESTION_MAX_LENGTH)
    clarification_id: str | None = Field(default=None, min_length=1, max_length=128)
    history: list[IntegrationHistoryMessage] = Field(
        default_factory=list,
        max_length=50,
        validation_alias=AliasChoices("history", "messages"),
        description="兼容旧协议，不用于继承查询条件；当前任务澄清使用 clarification_id。",
    )
    user: IntegrationUser = Field(validation_alias=AliasChoices("user", "user_info"))


def get_integration_identity_service() -> IntegrationIdentityService:
    return IntegrationIdentityService()


def get_integration_ask_service(
    task_service: Annotated[QueryTaskApplicationService, Depends(get_query_task_service)],
    semantic_service: Annotated[
        SemanticTaskApplicationService, Depends(get_semantic_task_service)
    ],
    execution_service: Annotated[
        QueryExecutionApplicationService, Depends(get_query_execution_service)
    ],
    clarification_service: Annotated[
        ChannelClarificationService, Depends(get_channel_clarification_service)
    ],
) -> IntegrationAskApplicationService:
    return IntegrationAskApplicationService(
        task_service=task_service,
        semantic_service=semantic_service,
        execution_service=execution_service,
        clarification_service=clarification_service,
    )


@router.post(
    "/ask", response_model=IntegrationAskResult,
    dependencies=[Depends(require_query_ready)],
)
def ask(
    payload: IntegrationAskRequest,
    request: Request,
    identity_service: Annotated[
        IntegrationIdentityService, Depends(get_integration_identity_service)
    ],
    service: Annotated[IntegrationAskApplicationService, Depends(get_integration_ask_service)],
) -> IntegrationAskResult:
    actor = identity_service.resolve(
        ExternalUserProfile(
            source_system=payload.source_system,
            user_code=payload.user.user_code,
            login_code=payload.user.login_code,
            user_name=payload.user.user_name,
            org_code=payload.user.org_code,
            org_name=payload.user.org_name,
            corpo_code=payload.user.corpo_code,
            corpo_name=payload.user.corpo_name,
            dept_code=payload.user.dept_code,
            dept_name=payload.user.dept_name,
        )
    )
    return service.ask(
        request_id=request.state.request_id,
        source_system=payload.source_system,
        message_id=payload.message_id,
        external_conversation_id=payload.conversation_id,
        user_input=payload.user_input,
        actor=actor,
        external_user_id=payload.user.user_code,
        clarification_id=payload.clarification_id,
        history=[item.model_dump() for item in payload.history],
        user_context=payload.user.model_dump(),
    )
