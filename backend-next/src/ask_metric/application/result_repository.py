"""Result snapshots share the task transaction and existing JSON storage.

No process-local cache: references survive restarts, and an optimistic task update
commits the result, focus and chat message together. Source artifacts are immutable.
"""

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from ask_metric.application.ports import PermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.domain.query_execution import QueryExecutionResult
from ask_metric.domain.result_context import ConversationFocus, ResultArtifact, ResultReference
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.models import QueryTask


class ResultReferenceError(ValueError):
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
        context=deepcopy(getattr(state, "context_snapshot", None) or {}),
        logical_dsl=deepcopy(state.logical_dsl or {}),
        result=result.model_dump(mode="json", exclude={"debug"}),
    )


def attach_artifact(state: QueryTaskState, artifact: ResultArtifact) -> None:
    if getattr(state, "result_artifact", None):
        raise ResultReferenceError("结果快照已存在，不能覆盖")
    state.result_artifact = artifact.model_dump(mode="json")
    if not getattr(state, "internal_analysis_id", None):
        set_focus(state, artifact, task_id=artifact.task_id)


def set_focus(state: QueryTaskState, artifact: ResultArtifact, *, task_id: str) -> None:
    state.conversation_focus = ConversationFocus(
        task_id=task_id,
        result_id=artifact.result_id,
        source_task_id=artifact.task_id,
    ).model_dump(mode="json")


def hydrate_legacy_results(tasks, messages):
    """Read old persisted result messages without modifying historical task rows."""
    by_task = {}
    for message in messages:
        payload = message.payload or {}
        if payload.get("kind") == "query_result" and payload.get("status") == "succeeded":
            by_task.setdefault(message.task_id, []).append(payload.get("result") or {})
    hydrated = []
    for task in tasks:
        raw = task.state_json or {}
        if (
            task.status != "SUCCEEDED"
            or raw.get("result_artifact")
            or raw.get("conversation_focus")
            or not raw.get("context_snapshot")
            or not raw.get("logical_dsl")
        ):
            hydrated.append(task)
            continue
        run_id = (raw.get("execution") or {}).get("run_id")
        result = next(
            (
                r
                for r in reversed(by_task.get(task.id, []))
                if r.get("task_id") == task.id and r.get("run_id") == run_id
            ),
            None,
        )
        if not result:
            hydrated.append(task)
            continue
        state = QueryTaskState.model_validate(raw)
        try:
            actor = ActorContext.model_validate(state.actor_context)
            artifact = artifact_from_query(
                task=task,
                state=state,
                result=QueryExecutionResult.model_validate(result),
                actor=actor,
            )
        except ValueError:
            hydrated.append(task)
            continue
        artifact.created_at = task.completed_at or task.created_at
        attach_artifact(state, artifact)
        # A detached representation: reading a legacy result must never dirty the ORM task.
        values = {column.name: getattr(task, column.name) for column in QueryTask.__table__.columns}
        values["state_json"] = state.model_dump(mode="json")
        hydrated.append(QueryTask(**values))
    return hydrated


def result_inventory(tasks) -> tuple[list[dict[str, Any]], str | None]:
    """Model receives metadata only; neither result cells nor SQL enter its prompt."""
    summaries = []
    focus_id = None
    for index, task in enumerate(tasks):
        if (task.state_json or {}).get("internal_analysis_id"):
            continue
        if task.status != "SUCCEEDED":
            continue
        state = task.state_json or {}
        focus = state.get("conversation_focus") or {}
        focus_id = focus.get("result_id", focus_id)
        raw = state.get("result_artifact")
        if not raw:
            continue
        artifact = ResultArtifact.model_validate(raw)
        context = artifact.context
        metric_label = "、".join(m["name"] for m in context.get("metrics", []))
        orgs = context.get("orgs", [])
        org_label = "、".join(o["name"] for o in orgs) if len(orgs) <= 3 else f"{len(orgs)}家机构"
        time = context.get("time", {})
        label = f"{org_label} · {time.get('start') or time.get('preset', '')}"
        if time.get("end") != time.get("start"):
            label += f"至{time.get('end')}"
        label += f" · {metric_label}"
        summaries.append(
            {
                "result_id": artifact.result_id,
                "task_id": artifact.task_id,
                "turn_index": index + 1,
                "question": task.original_question,
                "summary": label,
                "metrics": context.get("metrics", []),
                "orgs": context.get("orgs", []),
                "time": context.get("time", {}),
                "query_shape": artifact.result.get("query_shape"),
                "row_count": artifact.result.get("row_count", 0),
                "truncated": artifact.result.get("truncated", False),
                "kind": "DERIVED" if artifact.parent_result_id else "ORIGINAL",
                "parent_result_id": artifact.parent_result_id,
            }
        )
    return summaries, focus_id


class ResultRepository:
    def __init__(
        self,
        *,
        uow,
        conversation_id: str,
        actor: ActorContext,
        permission_service: PermissionService,
    ):
        self.uow = uow
        self.conversation_id = conversation_id
        self.actor = actor
        self.permission_service = permission_service
        if not uow.conversations.get_owned(conversation_id, actor.user_id or ""):
            raise ResultReferenceError("无权访问该会话的结果")
        self.tasks = uow.tasks.list_for_conversation(conversation_id)
        if any(
            t.status == "SUCCEEDED"
            and not (t.state_json or {}).get("result_artifact")
            and not (t.state_json or {}).get("conversation_focus")
            for t in self.tasks
        ):
            self.tasks = hydrate_legacy_results(
                self.tasks,
                uow.messages.list_for_conversation(conversation_id),
            )
        self.summaries, self.focus_id = result_inventory(self.tasks)

    def candidates(self, reference: ResultReference, *, selected_id: str | None = None):
        summaries = self.summaries
        if selected_id:
            summaries = [s for s in summaries if s["result_id"] == selected_id]
        elif reference.scope == "CURRENT":
            summaries = [s for s in summaries if s["result_id"] == self.focus_id]
        elif reference.scope == "TURN":
            # A READ turn has no new artifact; resolve that turn's persisted focus.
            task = next(
                (t for i, t in enumerate(self.tasks) if i + 1 == reference.turn_index), None
            )
            focus = ((task.state_json or {}).get("conversation_focus") or {}) if task else {}
            summaries = [s for s in summaries if s["result_id"] == focus.get("result_id")]
        else:
            summaries = [
                s for s in summaries if reference.kind == "ANY" or s["kind"] == reference.kind
            ]
        matches = []
        for summary in summaries:
            if reference.metric_codes and not set(reference.metric_codes).issubset(
                {m["code"] for m in summary["metrics"]}
            ):
                continue
            if reference.org_codes and not set(reference.org_codes).issubset(
                {o["code"] for o in summary["orgs"]}
            ):
                continue
            if reference.start and summary["time"].get("start") != reference.start:
                continue
            if reference.end and summary["time"].get("end") != reference.end:
                continue
            if reference.query_shape and summary["query_shape"] != reference.query_shape:
                continue
            # Never disclose metadata for artifacts from a different tenant.
            artifact = self.get(summary["result_id"])
            if artifact:
                matches.append(summary)
        return matches

    def get(self, result_id: str, *, authorize: bool = True) -> ResultArtifact:
        raw = next(
            (
                (task.state_json or {}).get("result_artifact")
                for task in self.tasks
                if ((task.state_json or {}).get("result_artifact") or {}).get("result_id")
                == result_id
                and task.status == "SUCCEEDED"
            ),
            None,
        )
        if raw is None:
            raise ResultReferenceError("引用的结果不存在或已删除，请重新查询")
        artifact = ResultArtifact.model_validate(raw)
        if (
            artifact.conversation_id != self.conversation_id
            or artifact.owner_user_id != self.actor.user_id
            or artifact.tenant_id != self.actor.tenant_id
        ):
            raise ResultReferenceError("无权访问该结果")
        if artifact.expires_at and artifact.expires_at <= datetime.now(UTC):
            raise ResultReferenceError("历史结果已过期，请重新查询")
        if authorize:
            rows = artifact.result.get("rows", [])
            # Authorize actual result organizations as well as original query scope.
            self.permission_service.authorize_logical_dsl(
                actor=self.actor,
                logical_dsl=artifact.logical_dsl,
            )
            row_orgs = {str(row["org_code"]) for row in rows if row.get("org_code")}
            requested = row_orgs or set(artifact.logical_dsl.get("orgs") or [])
            authorized = self.permission_service.authorize_logical_dsl(
                actor=self.actor,
                logical_dsl={**artifact.logical_dsl, "orgs": sorted(requested), "options": {}},
            )
            if not requested.issubset(set(authorized.get("orgs") or [])):
                raise ResultReferenceError("当前权限不能读取完整历史结果，请重新查询")
        return artifact.model_copy(deep=True)


def crop_artifact(source: ResultArtifact, *, task_id: str, limit: int) -> ResultArtifact:
    rows = source.result.get("rows", [])
    if source.result.get("comparisons"):
        raise ResultReferenceError("比较结果不能按行裁剪，请选择明细或排名结果")
    if source.result.get("truncated") and limit > len(rows):
        raise ResultReferenceError("已保存结果不包含所需行数，请重新查询")
    result = deepcopy(source.result)
    result.update(
        task_id=task_id,
        run_id=None,
        rows=deepcopy(rows[:limit]),
        row_count=len(rows[:limit]),
        truncated=False,
        latency_ms=0,
        message=f"已从历史结果保留前 {len(rows[:limit])} 行，原始结果仍保留。",
        timings_ms={},
    )
    return source.model_copy(
        update={
            "result_id": f"result:{task_id}",
            "task_id": task_id,
            "parent_result_id": source.result_id,
            "operation": "CROP",
            "created_at": datetime.now(UTC),
            "result": result,
        },
        deep=True,
    )


def select_org(source: ResultArtifact, row_number: int) -> str:
    rows = source.result.get("rows", [])
    if row_number > len(rows):
        raise ResultReferenceError("历史结果中不存在该行，不能推测机构")
    code = rows[row_number - 1].get("org_code")
    if not code:
        raise ResultReferenceError("该结果行没有可信机构编号，请明确机构后查询")
    return str(code)
