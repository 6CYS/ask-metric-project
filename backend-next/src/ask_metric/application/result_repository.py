"""保存历史结果证据，与任务和回复在同一事务提交；不解析历史指代。"""

from copy import deepcopy
from datetime import UTC, datetime

from ask_metric.application.ports import PermissionDeniedError, PermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.result_context import ResultArtifact
from ask_metric.domain.task import QueryTaskState


class ResultSnapshotError(ValueError):
    pass


def authorize_saved_result(
    actor: ActorContext,
    dsl: dict | None,
    permissions: PermissionService | None,
) -> None:
    """结果引用不是授权票据；任一组成机构失权时拒绝整个快照。"""
    if permissions is None:
        return
    if not dsl or not dsl.get("orgs"):
        raise ApplicationError(
            "RESULT_SCOPE_UNAVAILABLE",
            "历史结果缺少可信机构范围，无法安全读取，请重新查询。",
            status_code=409,
        )
    try:
        authorized = permissions.authorize_logical_dsl(actor=actor, logical_dsl=dsl)
        if set(authorized.get("orgs", [])) != set(dsl.get("orgs", [])):
            raise PermissionDeniedError("结果机构范围已变化")
    except PermissionDeniedError as exc:
        raise ApplicationError(
            "ORG_SCOPE_FORBIDDEN",
            "无权访问该查询结果。",
            status_code=403,
        ) from exc


def artifact_from_query(*, task, state, result, actor: ActorContext) -> ResultArtifact:
    return ResultArtifact(
        result_id=f"result:{task.id}",
        task_id=task.id,
        conversation_id=task.conversation_id,
        owner_user_id=actor.user_id,
        tenant_id=actor.tenant_id,
        source_run_id=result.run_id,
        created_at=datetime.now(UTC),
        logical_dsl=deepcopy(result.evidence.get("logical_dsl") or state.logical_dsl or {}),
        result=result.model_dump(mode="json", exclude={"debug"}),
    )


def attach_artifact(state: QueryTaskState, artifact: ResultArtifact) -> None:
    if getattr(state, "result_artifact", None):
        raise ResultSnapshotError("结果快照已存在，不能覆盖")
    state.result_artifact = artifact.model_dump(mode="json")
