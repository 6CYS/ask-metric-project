from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from time import perf_counter
from typing import Any
from uuid import uuid4

from ask_metric.application.commands import ExecuteQueryCommand
from ask_metric.application.ports import (
    DataSourceAdapter,
    ModelService,
    OrganizationScopeProvider,
    OrgHierarchyProvider,
    PermissionDeniedError,
    PermissionService,
    QueryResultEnricher,
)
from ask_metric.application.query_scope import require_current_query_scope
from ask_metric.application.result_answering import render_fact_answer
from ask_metric.application.result_processing import process_query_result
from ask_metric.application.result_repository import artifact_from_query, attach_artifact
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.query_execution import (
    QueryExecutionPlan,
    QueryExecutionResult,
    QueryPlanner,
    UnsupportedQueryError,
    json_safe,
)
from ask_metric.domain.semantics import LogicalDSL
from ask_metric.domain.task import (
    QueryTaskStage,
    QueryTaskState,
    QueryTaskStatus,
    append_task_trace,
)
from ask_metric.domain.task_state_machine import InvalidTaskTransition, QueryTaskStateMachine
from ask_metric.infrastructure.db.models import ChatMessage, QueryRun, QueryTask
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.query.sql_builder import SqlBuilder
from ask_metric.infrastructure.query.sql_safety import validate_readonly_sql
from ask_metric.infrastructure.query.templates import QueryTemplateRepository

UnitOfWorkFactory = Callable[[], SqlAlchemyUnitOfWork]
logger = logging.getLogger(__name__)


def _china_business_date() -> date:
    """Return the bank-facing calendar date independent of container timezone."""

    return (datetime.now(UTC) + timedelta(hours=8)).date()


class QueryExecutionConflictError(ApplicationError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any]) -> None:
        super().__init__(code, message, status_code=409, details=details)


class QueryExecutionApplicationService:
    def __init__(
        self,
        *,
        planner: QueryPlanner,
        templates: QueryTemplateRepository,
        data_source: DataSourceAdapter,
        permission_service: PermissionService,
        model_service: ModelService | None = None,
        uow_factory: UnitOfWorkFactory | None = None,
        today_provider: Callable[[], date] = _china_business_date,
        result_enricher: QueryResultEnricher | None = None,
        sql_builder: SqlBuilder | None = None,
        query_sql_engine: str = "builder",
        org_hierarchy_provider: OrgHierarchyProvider | None = None,
        organization_scope_provider: OrganizationScopeProvider | None = None,
    ) -> None:
        self.planner = planner
        self.templates = templates
        self.data_source = data_source
        self.permission_service = permission_service
        self.model_service = model_service
        self.uow_factory = uow_factory or SqlAlchemyUnitOfWork
        self.today_provider = today_provider
        self.result_enricher = result_enricher
        self.sql_builder = sql_builder
        self.query_sql_engine = query_sql_engine
        self.org_hierarchy_provider = org_hierarchy_provider
        self.organization_scope_provider = organization_scope_provider

    def execute(self, command: ExecuteQueryCommand) -> QueryExecutionResult:
        """先登记执行，再只读查询，最后持久化结果；跨数据库不假定是同一事务。"""
        execution_total_started = perf_counter()
        prepared = self._prepare(command)
        # 返回结果对象说明准备阶段已结束（如幂等重放或规划失败），不能再次执行 SQL。
        if isinstance(prepared, QueryExecutionResult):
            return prepared
        run_id, plan, sql, execution_version, timings_ms = prepared
        # 元数据事务已提交 RUNNING 状态并释放连接，再访问独立的业务查询数据库。
        sql_started = perf_counter()
        try:
            execution = self.data_source.execute_readonly(
                sql=sql,
                parameters=plan.parameters,
            )
            timings_ms["sql_execution_ms"] = _elapsed_ms(sql_started)
            fetched_rows = list(execution.rows)
            truncated = (
                plan.shape.value != "metric_ranking" and len(fetched_rows) > self.planner.max_limit
            )
            visible_rows = fetched_rows[: self.planner.max_limit] if truncated else fetched_rows
            if self.result_enricher is not None:
                visible_rows = self.result_enricher.enrich(visible_rows)
            formatting_started = perf_counter()
            rows, comparisons = process_query_result(plan, visible_rows)
            timings_ms["result_formatting_ms"] = _elapsed_ms(formatting_started)
        except UnsupportedQueryError as exc:
            # 执行阶段才发现的“不支持”：与规划期不支持同构，
            # 状态 unsupported、public_message 面向用户，不记错误日志。
            public_message = getattr(exc, "public_message", None) or "当前问题暂不支持执行。"
            timings_ms["sql_execution_ms"] = _elapsed_ms(sql_started)
            timings_ms["execution_total_ms"] = _elapsed_ms(execution_total_started)
            timings_ms["total_ms"] = _total_timing(timings_ms)
            result = QueryExecutionResult(
                run_id=run_id,
                task_id=command.task_id,
                status="unsupported",
                query_shape=plan.shape.value,
                error_code="QUERY_UNSUPPORTED",
                error_message=public_message,
                task_version=execution_version + 1,
                task_status=QueryTaskStatus.FAILED.value,
                timings_ms=timings_ms,
                debug={
                    "error": _error_debug(
                        code="QUERY_UNSUPPORTED",
                        stage=QueryTaskStage.EXECUTION.value,
                        node="sql_execution",
                        retryable=False,
                    ),
                    "query": {
                        "template": plan.template.value,
                    },
                },
            )
            self._finish_failure(
                command=command,
                result=result,
                expected_version=execution_version,
                failed_node="sql_execution",
            )
            return result
        except Exception as exc:
            public_message = "查询执行失败，请稍后重试。"
            logger.error(
                "query_execution_failed task_id=%s run_id=%s exception_type=%s",
                command.task_id,
                run_id,
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
                extra={"trans_api": "sql_execution", "exception_type": type(exc).__name__},
            )
            timings_ms["sql_execution_ms"] = _elapsed_ms(sql_started)
            timings_ms["execution_total_ms"] = _elapsed_ms(execution_total_started)
            timings_ms["total_ms"] = _total_timing(timings_ms)
            result = QueryExecutionResult(
                run_id=run_id,
                task_id=command.task_id,
                status="failed",
                query_shape=plan.shape.value,
                error_code="QUERY_EXECUTION_FAILED",
                error_message=public_message,
                task_version=execution_version + 1,
                task_status=QueryTaskStatus.FAILED.value,
                timings_ms=timings_ms,
                debug={
                    "error": _error_debug(
                        code="QUERY_EXECUTION_FAILED",
                        stage=QueryTaskStage.EXECUTION.value,
                        node="sql_execution",
                    ),
                    "query": {
                        "template": plan.template.value,
                    },
                },
            )
            self._finish_failure(
                command=command,
                result=result,
                expected_version=execution_version,
                failed_node="sql_execution",
            )
            return result
        coverage_notice = _result_coverage_notice(
            plan,
            rows,
            current_system_date=self.today_provider(),
        )
        missing_metric_notice = _missing_metric_notice(plan, visible_rows, truncated=truncated)
        truncation_notice = (
            f"查询结果超过{self.planner.max_limit}行，本次仅展示前{self.planner.max_limit}行。"
            if truncated
            else None
        )
        message = _execution_message(plan, rows, coverage_notice=coverage_notice)
        message = _prepend_coverage_notice(message, truncation_notice)
        rendered_answer = None
        if rows:
            answer_started = perf_counter()
            rendered_answer = render_fact_answer(plan, rows, comparisons)
            message = _prepend_coverage_notice(
                rendered_answer.message,
                coverage_notice,
            )
            message = _prepend_coverage_notice(message, truncation_notice)
            timings_ms["answer_rendering_ms"] = _elapsed_ms(answer_started)
        if missing_metric_notice:
            message = f"{message}\n\n{missing_metric_notice}"
        result = QueryExecutionResult(
            run_id=run_id,
            task_id=command.task_id,
            status="succeeded",
            evidence={
                "logical_dsl": plan.dsl,
                "catalog": plan.catalog,
                "template": plan.template.value,
                "coverage_notice": coverage_notice,
                "missing_metric_notice": missing_metric_notice,
                "response_kind": (
                    "availability" if plan.shape.value == "metric_availability" else "values"
                ),
            },
            query_shape=plan.shape.value,
            columns=list(rows[0]) if rows else [],
            rows=rows,
            comparisons=comparisons,
            row_count=len(rows),
            truncated=truncated,
            message=message,
            latency_ms=execution.latency_ms,
            task_version=execution_version + 1,
            task_status=QueryTaskStatus.SUCCEEDED.value,
            timings_ms=timings_ms,
            debug={
                "query": {
                    "template": plan.template.value,
                },
                "result": {
                    "row_count": len(visible_rows),
                    "fetched_row_count": len(fetched_rows),
                    "truncated": truncated,
                    "coverage_notice": coverage_notice,
                    "missing_metric_notice": missing_metric_notice,
                    "answer": (
                        rendered_answer.audit_record()
                        if rendered_answer is not None
                        else {
                            "mode": "deterministic_fact_renderer",
                            "template_id": "no_data",
                            "fact_ids": [],
                            "facts": [],
                        }
                    ),
                },
            },
        )
        result.timings_ms["execution_total_ms"] = _elapsed_ms(execution_total_started)
        result.timings_ms["total_ms"] = _total_timing(result.timings_ms)
        self._finish_success(
            command=command,
            result=result,
            expected_version=execution_version,
        )
        return result

    def _prepare(
        self, command: ExecuteQueryCommand
    ) -> (
        tuple[
            int,
            QueryExecutionPlan,
            str,
            int,
            dict[str, int],
        ]
        | QueryExecutionResult
    ):
        planning_started = perf_counter()
        with self.uow_factory() as uow:
            owned_getter = getattr(uow.tasks, "get_owned_for_update", None)
            task = (
                owned_getter(command.task_id, command.actor.user_id or "")
                if owned_getter
                else uow.tasks.get_for_update(command.task_id)
            )
            if task is None:
                raise ApplicationError(
                    "TASK_NOT_FOUND",
                    f"QueryTask {command.task_id} was not found",
                    status_code=404,
                )
            state = QueryTaskState.model_validate(task.state_json or {})
            require_current_query_scope(task.state_json or {})
            if (state.debug.get("basic_query") and state.execution
                    and state.execution.get("status") == "succeeded"):
                # 工具重放也必须按当前权限/目录复核，不能把旧结果当成永久授权。
                try:
                    self._authorize_query(
                        uow=uow, actor=command.actor, logical_dsl=state.logical_dsl,
                        strict_codes=True,
                    )
                except PermissionDeniedError as exc:
                    raise ApplicationError(
                        "ORG_SCOPE_FORBIDDEN", "无权访问该查询结果。", status_code=403,
                    ) from exc
                except UnsupportedQueryError as exc:
                    raise ApplicationError(
                        "QUERY_UNSUPPORTED", "结果引用的目录项已不可用。", status_code=422,
                    ) from exc
            replay = _execution_replay(state, command.request_id)
            if replay is not None:
                return replay
            _require_version(task, command.expected_version)
            _require_executable(task)
            try:
                dsl, plan, sql = self._build_governed_plan(
                    uow=uow,
                    actor=command.actor,
                    logical_dsl=state.logical_dsl,
                    query_shape=task.query_shape or "",
                    strict_codes=bool(state.debug.get("basic_query")),
                )
            except Exception as exc:
                state.timings_ms["query_planning_ms"] = _elapsed_ms(planning_started)
                return self._record_planning_failure(uow, task, state, command, exc)
            run = QueryRun(
                task_id=task.id,
                conversation_id=task.conversation_id,
                user_message=state.resolved_question or task.original_question,
                intent=dsl.task.value,
                query_shape=plan.shape.value,
                query_plan={
                    **plan.model_dump(mode="json"),
                    "question_audit": {
                        "original_question": task.original_question,
                        "resolved_question": state.resolved_question,
                        "clarification_answers": state.clarification_answers,
                    },
                },
                sql_text=sql,
                sql_params=json_safe(plan.parameters),
                status="running",
                raw_org_text=_audit_text(dsl.orgs),
            )
            uow.runs.add(run)
            uow.flush()
            state.execution = {
                "request_id": command.request_id,
                "run_id": run.id,
                "status": "running",
            }
            state.timings_ms["query_planning_ms"] = _elapsed_ms(planning_started)
            append_task_trace(
                state,
                stage=QueryTaskStage.PLANNING.value,
                status="completed",
                node="query_plan_ready",
                detail={"query_shape": plan.shape.value, "template": plan.template.value},
            )
            append_task_trace(
                state,
                stage=QueryTaskStage.EXECUTION.value,
                status=QueryTaskStatus.RUNNING.value,
                node="sql_execution_started",
                detail={"run_id": run.id},
            )
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=command.expected_version,
                status=QueryTaskStatus.RUNNING.value,
                current_stage=QueryTaskStage.EXECUTION.value,
                state_json=state.model_dump(mode="json"),
                intent=task.intent,
                query_shape=task.query_shape,
                error_code=None,
                error_message=None,
            )
            if updated is None:
                raise _version_conflict(task.id, command.expected_version)
            uow.commit()
            return (
                run.id,
                plan,
                sql,
                command.expected_version + 1,
                dict(state.timings_ms),
            )

    def _authorize_query(
        self,
        *,
        uow: SqlAlchemyUnitOfWork,
        actor,
        logical_dsl: dict[str, Any] | None,
        strict_codes: bool = False,
    ) -> tuple[LogicalDSL, list[Any], list[Any]]:
        # 执行前按当前权限和正式目录再校验一次；历史保存的 DSL 不能直接当作授权。
        dsl = LogicalDSL.model_validate(logical_dsl)
        authorized = self.permission_service.authorize_logical_dsl(
            actor=actor,
            logical_dsl=dsl.model_dump(mode="json"),
        )
        dsl = LogicalDSL.model_validate(authorized)
        organization_catalog = uow.organization_catalog.list_enabled()
        metric_catalog = uow.metric_catalog.list_enabled()
        known_metrics = {item.code for item in metric_catalog}
        if any(code not in known_metrics for code in dsl.metrics):
            raise UnsupportedQueryError("Metric code is not in the enabled official catalog")
        if strict_codes:
            known_orgs = {item.code for item in organization_catalog}
            if any(code not in known_orgs for code in dsl.orgs):
                raise UnsupportedQueryError("Organization code is not in the enabled catalog")
        _resolve_org_names(dsl.orgs, organization_catalog)
        return dsl, metric_catalog, organization_catalog

    def _build_governed_plan(
        self,
        *,
        uow: SqlAlchemyUnitOfWork,
        actor,
        logical_dsl: dict[str, Any] | None,
        query_shape: str,
        strict_codes: bool = False,
    ) -> tuple[LogicalDSL, QueryExecutionPlan, str]:
        dsl, metric_catalog, organization_catalog = self._authorize_query(
            uow=uow, actor=actor, logical_dsl=logical_dsl, strict_codes=strict_codes,
        )
        display_org_names = _resolve_org_names(dsl.orgs, organization_catalog)
        display_metric_names = _resolve_metric_names(dsl.metrics, metric_catalog)
        # SQL 机构条件统一传机构编码（mysql/inceptor 一致）；名称仅用于展示
        org_names = _resolve_source_org_codes(dsl.orgs, organization_catalog)
        if strict_codes and any(operation.get("type") == "top_n" for operation in dsl.ops):
            # 仅结构化通道（strict_codes）的排名反查：dsl.orgs 是范围机构（至多一个，
            # 缺省=层级根节点），候选集合扩展为其直接下级；语义通道的排名自带候选机构，
            # 不走这里。扩展不放权，非管理员与本人权限范围取交集。
            org_names = self._ranking_org_scope(
                actor=actor, dsl=dsl, organization_catalog=organization_catalog,
            )
        plan = self.planner.build(
            dsl,
            query_shape,
            org_names=org_names,
            display_metric_names=display_metric_names,
            display_org_names=display_org_names,
        )
        plan.catalog = {
            "metrics": [
                {"code": item.code, "name": item.name, "unit": item.unit}
                for item in metric_catalog if item.code in dsl.metrics
            ],
            "organizations": [
                {"code": item.code, "name": item.name}
                for item in organization_catalog if item.name in display_org_names
            ],
        }
        # SQL 来源按 query_sql_engine 切换：builder 由 SqlBuilder 确定性组装，
        # templates 回退到登记的模板文件；两条路径都过同一道只读校验。
        if self.query_sql_engine == "builder" and self.sql_builder is not None:
            sql = self.sql_builder.build(plan)
        else:
            sql = self.templates.load(dialect=plan.dialect, template=plan.template)
        validate_readonly_sql(sql)
        return dsl, plan, sql

    def _ranking_org_scope(
        self,
        *,
        actor,
        dsl: LogicalDSL,
        organization_catalog: list[Any],
    ) -> list[str]:
        """排名候选集合：范围机构的直接下级；范围缺省=层级根节点（全省汇总）。

        下级集合对非管理员再与本人权限范围取交集，扩展不放权。
        排名只需要下级行，不包含范围机构自身。
        """
        if self.org_hierarchy_provider is None:
            raise UnsupportedQueryError("Org hierarchy provider is not configured")
        if len(dsl.orgs) > 1:
            raise UnsupportedQueryError(
                "Ranking requires at most one scope org",
                public_message="排名查询至多指定一个范围机构，请明确在哪个机构范围内排名。",
            )
        if dsl.orgs:
            scope_code = _resolve_source_org_codes(dsl.orgs, organization_catalog)[0]
        else:
            # 空机构集合只有管理员能走到（普通用户已被权限层填成本人机构）
            scope_code = self.org_hierarchy_provider.root_code()
            if scope_code is None:
                raise UnsupportedQueryError(
                    "Ranking scope org is missing",
                    public_message="排名查询需要指定一个范围机构，请明确在哪个机构范围内排名。",
                )
        children = self.org_hierarchy_provider.children_of(scope_code)
        if actor is not None and getattr(actor, "role_code", None) != "SYSTEM_ADMIN":
            if self.organization_scope_provider is None:
                # 无权限范围提供者时不能静默跳过交集：下级扩展不放权，直接拒绝。
                raise PermissionDeniedError(
                    "Ranking requires an organization scope provider"
                )
            allowed = self.organization_scope_provider.allowed_org_codes(
                getattr(actor, "org_id", "") or ""
            )
            children = [code for code in children if code in allowed]
        if not children:
            raise UnsupportedQueryError(
                "Ranking scope org has no child orgs",
                public_message="该机构暂无下级机构数据，不能按机构排名；可指定上级机构后重试。",
            )
        return children

    def _record_planning_failure(
        self,
        uow: SqlAlchemyUnitOfWork,
        task: QueryTask,
        state: QueryTaskState,
        command: ExecuteQueryCommand,
        exc: Exception,
    ) -> QueryExecutionResult:
        forbidden = isinstance(exc, PermissionDeniedError)
        unsupported = isinstance(exc, UnsupportedQueryError)
        status = "unsupported" if unsupported else "failed"
        code = (
            "ORG_SCOPE_FORBIDDEN"
            if forbidden
            else "QUERY_UNSUPPORTED"
            if unsupported
            else "QUERY_PLANNING_FAILED"
        )
        error_debug = _error_debug(
            code=code,
            stage=QueryTaskStage.PLANNING.value,
            node="query_planning",
            retryable=not forbidden and not unsupported,
        )
        public_message = (
            "无权查询所选机构。"
            if forbidden
            else (
                (getattr(exc, "public_message", None) or "当前问题暂不支持执行。")
                if unsupported
                else "查询计划生成失败，请稍后重试。"
            )
        )
        if not forbidden and not unsupported:
            logger.error(
                "query_planning_failed task_id=%s exception_type=%s",
                task.id,
                type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
                extra={"trans_api": "query_planning", "exception_type": type(exc).__name__},
            )
        run = QueryRun(
            task_id=task.id,
            conversation_id=task.conversation_id,
            user_message=task.original_question,
            intent=task.intent or "metric_query",
            query_shape=task.query_shape,
            query_plan={
                "shape": task.query_shape,
                "dialect": self.planner.dialect,
                "dsl": state.logical_dsl,
                "error": error_debug,
            },
            status=status,
            failed_node="planning",
            error_type=code,
            error_message=public_message,
        )
        uow.runs.add(run)
        uow.flush()
        result = QueryExecutionResult(
            run_id=run.id,
            task_id=task.id,
            status=status,
            query_shape=task.query_shape or "unknown",
            error_code=code,
            error_message=public_message,
            task_version=command.expected_version + 1,
            task_status=QueryTaskStatus.FAILED.value,
            timings_ms=dict(state.timings_ms),
            debug={"error": error_debug},
        )
        state.execution = {
            "request_id": command.request_id,
            "run_id": run.id,
            "status": status,
            "summary": _result_summary(result),
        }
        state.debug["error"] = result.debug.get("error", {})
        append_task_trace(
            state,
            stage=QueryTaskStage.PLANNING.value,
            status=QueryTaskStatus.FAILED.value,
            node="query_planning_failed",
            detail={
                "error_code": code,
                "error_reference": error_debug["error_reference"],
            },
        )
        _add_result_message(uow, task, result)
        updated = uow.tasks.update_optimistically(
            task_id=task.id,
            expected_version=command.expected_version,
            status=QueryTaskStatus.FAILED.value,
            current_stage=task.current_stage,
            state_json=state.model_dump(mode="json"),
            intent=task.intent,
            query_shape=task.query_shape,
            error_code=code,
            error_message=public_message,
            completed_at=datetime.now(UTC),
        )
        if updated is None:
            raise _version_conflict(task.id, command.expected_version)
        uow.commit()
        return result

    def _finish_success(
        self,
        *,
        command: ExecuteQueryCommand,
        result: QueryExecutionResult,
        expected_version: int,
    ) -> None:
        with self.uow_factory() as uow:
            owned_getter = getattr(uow.tasks, "get_owned_for_update", None)
            task = (
                owned_getter(command.task_id, command.actor.user_id or "")
                if owned_getter
                else uow.tasks.get_for_update(command.task_id)
            )
            if task is None:
                raise RuntimeError("QueryTask disappeared during execution")
            _require_version(task, expected_version)
            state = QueryTaskState.model_validate(task.state_json or {})
            state.timings_ms.update(result.timings_ms)
            run = uow.runs.get(result.run_id or 0)
            if run is None:
                raise RuntimeError("QueryRun disappeared during execution")
            run.status = "succeeded"
            run.row_count = result.row_count
            run.latency_ms = result.latency_ms
            _apply_run_org_match(run, result.rows)
            state.execution = {
                "request_id": command.request_id,
                "run_id": run.id,
                "status": "succeeded",
                "summary": _result_summary(result),
            }
            state.debug["query"] = result.debug.get("query", {})
            state.debug["result"] = result.debug.get("result", {})
            append_task_trace(
                state,
                stage=QueryTaskStage.EXECUTION.value,
                status="completed",
                node="sql_execution_completed",
                detail={"run_id": run.id, "row_count": result.row_count},
            )
            append_task_trace(
                state,
                stage=QueryTaskStage.RESULT_FORMATTING.value,
                status=QueryTaskStatus.SUCCEEDED.value,
                node="result_formatted",
            )
            # 结果证据用于历史查看和导出，不再创建跨任务上下文。
            attach_artifact(state, artifact_from_query(
                task=task, state=state, result=result, actor=command.actor,
            ))
            _add_result_message(uow, task, result)
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=expected_version,
                status=QueryTaskStatus.SUCCEEDED.value,
                current_stage=QueryTaskStage.RESULT_FORMATTING.value,
                state_json=state.model_dump(mode="json"),
                intent=task.intent,
                query_shape=task.query_shape,
                error_code=None,
                error_message=None,
                completed_at=datetime.now(UTC),
            )
            if updated is None:
                raise _version_conflict(task.id, expected_version)
            uow.commit()


    def _finish_failure(
        self,
        *,
        command: ExecuteQueryCommand,
        result: QueryExecutionResult,
        expected_version: int,
        failed_node: str,
    ) -> None:
        with self.uow_factory() as uow:
            owned_getter = getattr(uow.tasks, "get_owned_for_update", None)
            task = (
                owned_getter(command.task_id, command.actor.user_id or "")
                if owned_getter
                else uow.tasks.get_for_update(command.task_id)
            )
            if task is None:
                raise RuntimeError("QueryTask disappeared during execution")
            _require_version(task, expected_version)
            state = QueryTaskState.model_validate(task.state_json or {})
            state.timings_ms.update(result.timings_ms)
            run = uow.runs.get(result.run_id or 0)
            if run is None:
                raise RuntimeError("QueryRun disappeared during execution")
            run.status = "failed"
            run.failed_node = failed_node
            run.error_type = result.error_code or "QUERY_EXECUTION_FAILED"
            run.error_message = result.error_message or "查询执行失败，请稍后重试。"
            run.query_plan = {
                **(run.query_plan or {}),
                "error": result.debug.get("error", {}),
            }
            state.execution = {
                "request_id": command.request_id,
                "run_id": run.id,
                "status": "failed",
                "summary": _result_summary(result),
            }
            state.debug["error"] = result.debug.get(
                "error",
                _error_debug(
                    code=result.error_code or "QUERY_EXECUTION_FAILED",
                    stage=QueryTaskStage.EXECUTION.value,
                    node=failed_node,
                ),
            )
            state.debug["result"] = {"error": result.error_message}
            append_task_trace(
                state,
                stage=QueryTaskStage.EXECUTION.value,
                status=QueryTaskStatus.FAILED.value,
                node=failed_node,
                detail={
                    "run_id": run.id,
                    "error_code": result.error_code,
                    "error_reference": state.debug["error"].get("error_reference"),
                },
            )
            _add_result_message(uow, task, result)
            updated = uow.tasks.update_optimistically(
                task_id=task.id,
                expected_version=expected_version,
                status=QueryTaskStatus.FAILED.value,
                current_stage=QueryTaskStage.EXECUTION.value,
                state_json=state.model_dump(mode="json"),
                intent=task.intent,
                query_shape=task.query_shape,
                error_code=result.error_code,
                error_message=result.error_message,
                completed_at=datetime.now(UTC),
            )
            if updated is None:
                raise _version_conflict(task.id, expected_version)
            uow.commit()


def _execution_replay(state: QueryTaskState, request_id: str) -> QueryExecutionResult | None:
    """幂等重放：同一 request_id 的重复执行返回原结果，不重跑 SQL。

    成功结果一律从不可变 ResultArtifact 回读完整 rows/comparisons；
    摘要只承载失败/进行中状态，快照缺失时显式报错，不能用摘要伪造空表。
    """
    execution = state.execution or {}
    if execution.get("request_id") != request_id:
        return None
    summary = execution.get("summary")
    if summary is None:
        raise QueryExecutionConflictError(
            "QUERY_ALREADY_RUNNING",
            "The query is already running",
            details={"run_id": execution.get("run_id")},
        )
    if execution.get("status") == "succeeded":
        artifact = getattr(state, "result_artifact", None) or {}
        saved = artifact.get("result")
        if artifact.get("source_run_id") != execution.get("run_id") or not isinstance(saved, dict):
            raise QueryExecutionConflictError(
                "RESULT_SNAPSHOT_MISSING",
                "The succeeded query result snapshot is missing",
                details={"run_id": execution.get("run_id")},
            )
        return QueryExecutionResult.model_validate({**saved, "idempotent_replay": True})
    return QueryExecutionResult.model_validate({**summary, "idempotent_replay": True})


def _require_version(task: QueryTask, expected_version: int) -> None:
    if task.version != expected_version:
        raise _version_conflict(task.id, expected_version, actual_version=task.version)


def _require_executable(task: QueryTask) -> None:
    try:
        QueryTaskStateMachine.require_transition(
            current_status=task.status,
            current_stage=task.current_stage,
            next_status=QueryTaskStatus.RUNNING,
            next_stage=QueryTaskStage.EXECUTION,
        )
    except InvalidTaskTransition as exc:
        raise QueryExecutionConflictError(
            "INVALID_TASK_TRANSITION",
            "The task cannot be executed in its current state",
            details={"task_id": task.id},
        ) from exc


def _version_conflict(
    task_id: str, expected_version: int, *, actual_version: int | None = None
) -> QueryExecutionConflictError:
    return QueryExecutionConflictError(
        "TASK_VERSION_CONFLICT",
        "The QueryTask was updated by another request",
        details={
            "task_id": task_id,
            "expected_version": expected_version,
            "actual_version": actual_version,
        },
    )


def _apply_run_org_match(run: QueryRun, rows: list[dict[str, Any]]) -> None:
    names = list(
        dict.fromkeys(str(row["org_name"]) for row in rows if row.get("org_name") is not None)
    )
    if not names:
        return
    run.matched_text = _audit_text(names)
    run.matched_org_name = names[0] if len(names) == 1 else _audit_text(names)
    run.org_match_type = "single" if len(names) == 1 else "multiple"


def _audit_text(values: list[str], *, max_length: int = 255) -> str | None:
    joined = ",".join(values)
    if not joined:
        return None
    if len(joined) <= max_length:
        return joined
    return joined[: max_length - 3] + "..."


def _resolve_org_names(orgs: list[str], catalog: list[Any]) -> list[str]:
    by_identifier = {
        identifier: item.name for item in catalog for identifier in [item.code, item.name]
    }
    unknown = [value for value in orgs if value not in by_identifier]
    if unknown:
        raise UnsupportedQueryError(f"Unknown organization identifiers: {', '.join(unknown)}")
    return [by_identifier[value] for value in orgs]


def _resolve_metric_names(metric_codes: list[str], catalog: list[Any]) -> list[str]:
    by_code = {item.code: item.name for item in catalog}
    return list(dict.fromkeys(by_code.get(code, "未登记指标") for code in metric_codes))


def _resolve_source_org_codes(orgs: list[str], catalog: list[Any]) -> list[str]:
    by_identifier = {
        identifier: item
        for item in catalog
        for identifier in [item.code, item.name, *(item.aliases or [])]
    }
    unknown = [value for value in orgs if value not in by_identifier]
    if unknown:
        raise UnsupportedQueryError(f"Unknown organization identifiers: {', '.join(unknown)}")
    source_codes: list[str] = []
    for value in orgs:
        item = by_identifier[value]
        if item.code not in source_codes:
            source_codes.append(item.code)
    return source_codes


def _result_summary(result: QueryExecutionResult) -> dict[str, Any]:
    return result.model_dump(
        mode="json",
        exclude={"rows", "comparisons"},
    )


def _add_result_message(
    uow: SqlAlchemyUnitOfWork,
    task: QueryTask,
    result: QueryExecutionResult,
) -> None:
    if result.status == "succeeded":
        content = result.message or f"查询完成，共返回 {result.row_count} 行。"
    else:
        content = result.error_message or "查询失败。"
    uow.messages.add(
        ChatMessage(
            id=str(uuid4()),
            conversation_id=task.conversation_id,
            task_id=task.id,
            role="assistant",
            content=content,
            created_at=datetime.now(UTC),
            payload={
                "kind": "query_result",
                "run_id": result.run_id,
                "status": result.status,
                "row_count": result.row_count,
                "latency_ms": result.latency_ms,
                "error_code": result.error_code,
                "result": result.model_dump(mode="json"),
            },
        )
    )


def _execution_message(
    plan: QueryExecutionPlan,
    rows: list[dict[str, Any]],
    *,
    coverage_notice: str | None = None,
) -> str:
    if rows:
        return _prepend_coverage_notice(
            f"查询完成，共返回 {len(rows)} 行。",
            coverage_notice,
        )
    organization_names = plan.display_org_names
    if len(organization_names) > 3:
        orgs = f"所选{len(organization_names)}家机构"
    else:
        orgs = "、".join(organization_names) or "所选机构"
    if plan.parameters.get("stat_date"):
        period = str(plan.parameters["stat_date"])
    elif plan.parameters.get("period_starts") and plan.parameters.get("period_ends"):
        period = "所选多个时间范围"
    elif plan.parameters.get("start_date") and plan.parameters.get("end_date"):
        period = f"{plan.parameters['start_date']}至{plan.parameters['end_date']}"
    elif plan.parameters.get("current_date"):
        period = str(plan.parameters["current_date"])
    elif plan.parameters.get("end_date"):
        period = f"截至{plan.parameters['end_date']}"
    elif plan.dsl.get("time", {}).get("preset") == "latest":
        period = "最新一期"
    else:
        period = "当前时间范围"
    metrics = "、".join(plan.display_metric_names) or "所选指标"
    return f"{period}，{orgs}在当前数据库未查询到{metrics}数据。"


def _missing_metric_notice(
    plan: QueryExecutionPlan,
    rows: list[dict[str, Any]],
    *,
    truncated: bool,
) -> str | None:
    """Disclose wholly absent metrics only when the returned selection is complete."""
    if plan.shape.value == "metric_availability" and not truncated and rows:
        returned = {(row.get("metric_code"), row.get("org_code")) for row in rows}
        missing = [(metric, org) for metric in plan.parameters["metric_codes"]
                   for org in plan.parameters["org_codes"] if (metric, org) not in returned]
        if missing:
            metrics = {item["code"]: item["name"] for item in plan.catalog.get("metrics", [])}
            orgs = {item["code"]: item["name"] for item in plan.catalog.get("organizations", [])}
            labels = [f"{orgs.get(org, org)}的{metrics.get(metric, metric)}"
                      for metric, org in missing[:8]]
            return "以下查询对象在所选范围没有可用日期：" + "、".join(labels) + (
                f"等{len(missing)}项。" if len(missing) > 8 else "。")
    if truncated or not rows or plan.shape.value not in {"metric_value", "metric_trend"}:
        return None
    requested = list(dict.fromkeys(plan.parameters.get("metric_codes", [])))
    if len(requested) < 2 or any(not row.get("metric_code") for row in rows):
        return None
    returned = {row["metric_code"] for row in rows}
    missing = [code for code in requested if code not in returned]
    if not missing or not returned.intersection(requested):
        return None
    names = dict(zip(plan.parameters["metric_codes"], plan.display_metric_names, strict=False))
    missing_plan = plan.model_copy(
        update={"display_metric_names": [names.get(code, code) for code in missing]}
    )
    return "另外，" + _execution_message(missing_plan, [])


def _result_coverage_notice(
    plan: QueryExecutionPlan,
    rows: list[dict[str, Any]],
    *,
    current_system_date: date,
) -> str | None:
    if not rows:
        return None
    if plan.dsl.get("time", {}).get("preset") == "latest":
        actual_dates = sorted(
            {
                parsed
                for row in rows
                for parsed in [_parse_result_date(row.get("stat_date") or row.get("current_date"))]
                if parsed is not None
            }
        )
        if not actual_dates:
            return None
        system_date = _format_result_date(current_system_date)
        if len(actual_dates) == 1:
            return (
                f"截至当前系统日期{system_date}，当前数据源中本次查询可获取的"
                f"最新一期为{_format_result_date(actual_dates[0])}。"
            )
        return (
            f"截至当前系统日期{system_date}，当前数据源已返回本次查询中各指标、"
            f"各机构可获取的最新一期数据，统计日期从"
            f"{_format_result_date(actual_dates[0])}至"
            f"{_format_result_date(actual_dates[-1])}不等，具体日期以各条结果为准。"
        )
    period_starts = [
        parsed
        for value in plan.parameters.get("period_starts", [])
        if (parsed := _parse_result_date(value)) is not None
    ]
    period_ends = [
        parsed
        for value in plan.parameters.get("period_ends", [])
        if (parsed := _parse_result_date(value)) is not None
    ]
    requested_end = (
        max(period_ends)
        if period_ends
        else _parse_result_date(
            plan.parameters.get("stat_date")
            or plan.parameters.get("current_date")
            or plan.parameters.get("end_date")
        )
    )
    if requested_end is None:
        return None
    actual_dates = [
        parsed
        for row in rows
        for parsed in [_parse_result_date(row.get("stat_date") or row.get("current_date"))]
        if parsed is not None
    ]
    if not actual_dates:
        return None
    latest_actual = max(actual_dates)
    requested_start = (
        min(period_starts)
        if period_starts
        else _parse_result_date(plan.parameters.get("start_date"))
    )
    selects_latest_in_range = (
        plan.template.value in {"metric_value_in_range", "metric_value_at_periods"}
        and requested_start is not None
    )
    multiple_periods = plan.template.value == "metric_value_at_periods"
    if latest_actual >= requested_end:
        if not selects_latest_in_range:
            return None
        if multiple_periods:
            return "本次查询包含多个时间范围，以下展示各时间范围内查询到的最新一期数据。"
        return (
            f"本次查询范围为{_format_result_date(requested_start)}"
            f"至{_format_result_date(requested_end)}，"
            f"以下结果为该范围内最新一期（{_format_result_date(latest_actual)}）的数据。"
        )
    if multiple_periods and requested_start is not None:
        requested_range = (
            f"本次查询包含多个时间范围（最早从{_format_result_date(requested_start)}开始，"
            f"最晚至{_format_result_date(requested_end)}），"
        )
    elif requested_start is not None:
        requested_range = (
            f"本次查询范围为{_format_result_date(requested_start)}"
            f"至{_format_result_date(requested_end)}，"
        )
    else:
        requested_range = f"本次查询截至{_format_result_date(requested_end)}，"
    result_description = (
        f"以下展示各时间范围内当前查询到的最新一期数据，最晚统计日期为"
        f"{_format_result_date(latest_actual)}。"
        if multiple_periods
        else f"以下结果为当前已查询范围内最新一期（{_format_result_date(latest_actual)}）的数据。"
        if selects_latest_in_range
        else "以下展示已查询到的数据。"
    )
    return (
        f"{requested_range}当前仅查询到截至{_format_result_date(latest_actual)}的数据，"
        f"尚未覆盖到查询结束日期。{result_description}"
    )


def _prepend_coverage_notice(message: str, coverage_notice: str | None) -> str:
    if not coverage_notice:
        return message
    body = message.strip()
    duplicate_prefixes = (
        f"数据覆盖提示：{coverage_notice}",
        coverage_notice,
    )
    while body:
        matched_prefix = next(
            (prefix for prefix in duplicate_prefixes if body.startswith(prefix)),
            None,
        )
        if matched_prefix is None:
            break
        body = body[len(matched_prefix) :].lstrip()
    return f"{coverage_notice}\n\n{body}" if body else coverage_notice


def _parse_result_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def _format_result_date(value: date) -> str:
    return f"{value.year}年{value.month:02d}月{value.day:02d}日"


def _error_debug(
    *,
    code: str,
    stage: str,
    node: str,
    retryable: bool = True,
) -> dict[str, Any]:
    return {
        "code": code,
        "stage": stage,
        "node": node,
        "retryable": retryable,
        "error_reference": uuid4().hex,
        "occurred_at": datetime.now(UTC).isoformat(),
    }


def _elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))


def _total_timing(timings_ms: dict[str, int]) -> int:
    return sum(
        timings_ms.get(key, 0)
        for key in ("task_creation_ms", "analyze_total_ms", "execution_total_ms")
    )
