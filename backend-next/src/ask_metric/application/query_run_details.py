"""读取已保存执行及其同源结果，不生成 SQL、不触发业务查询。"""

from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import select

from ask_metric.application.ports import PermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.application.result_repository import authorize_saved_result
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.models import QueryRun
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork


class QueryConditionItem(BaseModel):
    code: str
    name: str | None = None


class QueryMetricCondition(QueryConditionItem):
    unit: str | None = None


class QueryConditions(BaseModel):
    orgs: list[QueryConditionItem] = Field(default_factory=list)
    metrics: list[QueryMetricCondition] = Field(default_factory=list)
    time: dict[str, Any] = Field(default_factory=dict)


class SavedQueryRows(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    truncated: bool
    offset: int
    limit: int
    next_offset: int | None
    has_more: bool


class QueryRunSqlDetail(BaseModel):
    task_id: str
    run_id: int
    result_id: str | None = None
    status: str
    sql_text: str | None
    sql_params: dict[str, Any] | None
    sql_availability: Literal["available", "not_recorded"]
    row_count: int | None
    latency_ms: int | None
    conditions: QueryConditions
    result: SavedQueryRows | None = None
    result_unavailable_reason: Literal["not_saved", "different_run"] | None = None
    notice: str | None = None


def read_query_run_sql(
    *,
    uow: SqlAlchemyUnitOfWork,
    actor: ActorContext,
    permissions: PermissionService,
    task_id: str,
    run_id: int | None,
    offset: int,
    limit: int,
) -> QueryRunSqlDetail:
    with uow:
        task = uow.tasks.get_owned(task_id, actor.user_id or "") if actor.user_id else None
        if task is None:
            raise _not_found()
        state = task.state_json or {}
        artifact = state.get("result_artifact") or {}
        source_id = artifact.get("source_run_id")
        selected_id = run_id or source_id or (state.get("execution") or {}).get("run_id")
        if selected_id is None:
            # 只有唯一记录才可恢复 SQL 身份；不能用时间排序猜历史回答来源。
            if uow.session is None:
                raise RuntimeError("UnitOfWork has not been entered")
            ids = list(
                uow.session.scalars(select(QueryRun.id).where(QueryRun.task_id == task_id).limit(2))
            )
            if len(ids) > 1:
                raise ApplicationError(
                    "QUERY_RUN_SOURCE_UNAVAILABLE",
                    "历史记录未保存明确的执行来源，无法确定对应 SQL。",
                    status_code=409,
                )
            selected_id = ids[0] if ids else None
        run = uow.runs.get(selected_id) if selected_id is not None else None
        if run is None or run.task_id != task_id:
            raise _not_found()
        saved = artifact.get("result")
        same_source = source_id == run.id
        has_saved = isinstance(saved, dict) and isinstance(saved.get("rows"), list)
        result = saved if same_source and has_saved else None
        if isinstance(result, dict) and (
            result.get("run_id") not in (None, run.id)
            or result.get("task_id") not in (None, task_id)
            or artifact.get("task_id") not in (None, task_id)
        ):
            raise ApplicationError(
                "RESULT_SOURCE_MISMATCH",
                "保存结果与执行来源不一致，无法展示对应明细。",
                status_code=409,
            )
        plan = run.query_plan or {}
        plan_dsl = plan.get("dsl") or {}
        snapshot_dsl = (artifact.get("logical_dsl") or {}) if same_source else {}
        evidence_dsl = (result.get("evidence") or {}).get("logical_dsl") or {} if result else {}
        # SQL 条件和同源快照都必须在当前权限内；分页不能绕过未展示行的机构校验。
        scopes = [value for value in (plan_dsl, snapshot_dsl, evidence_dsl) if value.get("orgs")]
        dsl = scopes[0] if scopes else plan_dsl or snapshot_dsl or evidence_dsl
        if run.sql_text or run.sql_params or result is not None or scopes:
            authorize_saved_result(actor, dsl if dsl.get("orgs") else None, permissions)
            for scope in scopes:
                if scope != dsl:
                    authorize_saved_result(actor, scope, permissions)
            result_orgs = sorted(
                {row["org_code"] for row in (result or {}).get("rows", []) if row.get("org_code")}
            )
            if result_orgs:
                authorize_saved_result(actor, {**dsl, "orgs": result_orgs}, permissions)
        page = _result_page(result, offset=offset, limit=limit) if result is not None else None
        has_sql = bool(run.sql_text and run.sql_text.strip())
        return QueryRunSqlDetail(
            task_id=task_id,
            run_id=run.id,
            result_id=artifact.get("result_id") if result is not None else None,
            status=run.status,
            sql_text=run.sql_text if has_sql else None,
            sql_params=run.sql_params,
            sql_availability="available" if has_sql else "not_recorded",
            row_count=run.row_count,
            latency_ms=run.latency_ms,
            conditions=_conditions(dsl, plan, result),
            result=page,
            result_unavailable_reason=(
                None if result is not None else "different_run" if has_saved else "not_saved"
            ),
            notice=None if has_sql else "此执行记录未保存 SQL，无法还原当时的执行语句。",
        )


def _not_found() -> ApplicationError:
    return ApplicationError("QUERY_RUN_NOT_FOUND", "未找到可访问的查询执行记录。", status_code=404)


def _result_page(result: dict[str, Any], *, offset: int, limit: int) -> SavedQueryRows:
    rows = result.get("rows") or []
    page = rows[offset : offset + limit]
    end = offset + len(page)
    return SavedQueryRows(
        columns=result.get("columns") or [],
        rows=page,
        row_count=result.get("row_count", len(rows)),
        truncated=result.get("truncated", False),
        offset=offset,
        limit=limit,
        next_offset=end if end < len(rows) else None,
        has_more=end < len(rows),
    )


def _conditions(
    dsl: dict[str, Any],
    plan: dict[str, Any],
    result: dict[str, Any] | None,
) -> QueryConditions:
    catalog = plan.get("catalog") or {}
    rows = (result or {}).get("rows") or []
    org_names = {row["org_code"]: row.get("org_name") for row in rows if row.get("org_code")}
    metric_names = {
        row["metric_code"]: row.get("metric_name") for row in rows if row.get("metric_code")
    }
    orgs = {item["code"]: item for item in catalog.get("organizations", []) if item.get("code")}
    metrics = {item["code"]: item for item in catalog.get("metrics", []) if item.get("code")}
    time = {
        key: value
        for key, value in (dsl.get("time") or {}).items()
        if key in {"start", "end", "preset"}
    }
    time.update(
        {
            key: value
            for key, value in (dsl.get("options") or {}).items()
            if key in {"target_dates", "time_windows", "current_date", "base_date", "time_mode"}
        }
    )
    return QueryConditions(
        orgs=[
            QueryConditionItem(
                code=code,
                name=orgs.get(code, {}).get("name") or org_names.get(code),
            )
            for code in dsl.get("orgs", [])
        ],
        metrics=[
            QueryMetricCondition(
                code=code,
                name=metrics.get(code, {}).get("name") or metric_names.get(code),
                unit=metrics.get(code, {}).get("unit"),
            )
            for code in dsl.get("metrics", [])
        ],
        time=time,
    )
