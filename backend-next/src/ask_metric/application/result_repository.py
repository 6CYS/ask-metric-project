"""保存历史结果证据，与任务和回复在同一事务提交；不解析历史指代。"""

from copy import deepcopy
from datetime import UTC, datetime

from ask_metric.application.requests import ActorContext
from ask_metric.domain.result_context import ResultArtifact
from ask_metric.domain.task import QueryTaskState


class ResultSnapshotError(ValueError):
    pass


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
