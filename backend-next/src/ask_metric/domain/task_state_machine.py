from ask_metric.domain.task import QueryTaskStage, QueryTaskStatus


class InvalidTaskTransition(ValueError):
    pass


_STATUS_TRANSITIONS: dict[QueryTaskStatus, frozenset[QueryTaskStatus]] = {
    QueryTaskStatus.RUNNING: frozenset(
        {
            QueryTaskStatus.WAITING_USER,
            QueryTaskStatus.SUCCEEDED,
            QueryTaskStatus.FAILED,
            QueryTaskStatus.CANCELLED,
            QueryTaskStatus.EXPIRED,
        }
    ),
    QueryTaskStatus.WAITING_USER: frozenset(
        {
            QueryTaskStatus.RUNNING,
            QueryTaskStatus.CANCELLED,
            QueryTaskStatus.EXPIRED,
        }
    ),
    QueryTaskStatus.SUCCEEDED: frozenset(),
    QueryTaskStatus.FAILED: frozenset(),
    QueryTaskStatus.CANCELLED: frozenset(),
    QueryTaskStatus.EXPIRED: frozenset(),
}

_STAGE_TRANSITIONS: dict[QueryTaskStage, frozenset[QueryTaskStage]] = {
    QueryTaskStage.INTENT_ROUTING: frozenset(
        {
            QueryTaskStage.SLOT_EXTRACTION,
            QueryTaskStage.VALIDATION,
            QueryTaskStage.CLARIFICATION,
            QueryTaskStage.LOGICAL_DSL,
            QueryTaskStage.RESULT_FORMATTING,
        }
    ),
    QueryTaskStage.SLOT_EXTRACTION: frozenset(
        {
            QueryTaskStage.ENTITY_RESOLUTION,
            QueryTaskStage.VALIDATION,
            QueryTaskStage.CLARIFICATION,
            QueryTaskStage.LOGICAL_DSL,
        }
    ),
    QueryTaskStage.ENTITY_RESOLUTION: frozenset(
        {QueryTaskStage.VALIDATION, QueryTaskStage.CLARIFICATION}
    ),
    QueryTaskStage.VALIDATION: frozenset(
        {QueryTaskStage.CLARIFICATION, QueryTaskStage.LOGICAL_DSL}
    ),
    QueryTaskStage.CLARIFICATION: frozenset(
        {
            QueryTaskStage.SLOT_EXTRACTION,
            QueryTaskStage.ENTITY_RESOLUTION,
            QueryTaskStage.VALIDATION,
            QueryTaskStage.LOGICAL_DSL,
        }
    ),
    QueryTaskStage.LOGICAL_DSL: frozenset(
        {QueryTaskStage.PLANNING, QueryTaskStage.EXECUTION}
    ),
    QueryTaskStage.LEGACY_QUERY_SPEC: frozenset({QueryTaskStage.PLANNING}),
    QueryTaskStage.PLANNING: frozenset(
        {QueryTaskStage.EXECUTION, QueryTaskStage.CLARIFICATION}
    ),
    QueryTaskStage.EXECUTION: frozenset({QueryTaskStage.RESULT_FORMATTING}),
    QueryTaskStage.RESULT_FORMATTING: frozenset(),
}


class QueryTaskStateMachine:
    """集中校验允许的状态/阶段迁移；frozenset 是不可修改的允许值集合。

    状态回答“任务运行中还是已结束”，阶段回答“正在做语义解析还是执行查询”。
    校验通过只表示允许迁移，实际更新和版本竞争控制仍由应用服务及仓库完成。
    """
    @staticmethod
    def require_transition(
        *,
        current_status: str,
        current_stage: str,
        next_status: QueryTaskStatus,
        next_stage: QueryTaskStage,
    ) -> None:
        try:
            status = QueryTaskStatus(current_status)
            stage = QueryTaskStage(current_stage)
        except ValueError as exc:
            raise InvalidTaskTransition(
                f"Unknown task state: status={current_status}, stage={current_stage}"
            ) from exc

        if next_status != status and next_status not in _STATUS_TRANSITIONS[status]:
            raise InvalidTaskTransition(
                f"Task status cannot transition from {status} to {next_status}"
            )
        if next_stage != stage and next_stage not in _STAGE_TRANSITIONS[stage]:
            raise InvalidTaskTransition(
                f"Task stage cannot transition from {stage} to {next_stage}"
            )

        if (
            next_status == QueryTaskStatus.WAITING_USER
            and next_stage != QueryTaskStage.CLARIFICATION
        ):
            raise InvalidTaskTransition("WAITING_USER tasks must be in CLARIFICATION stage")
        if status == QueryTaskStatus.WAITING_USER and next_status == QueryTaskStatus.RUNNING:
            if stage != QueryTaskStage.CLARIFICATION:
                raise InvalidTaskTransition(
                    "Only a CLARIFICATION task can resume from WAITING_USER"
                )
