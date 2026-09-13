from ask_metric.application.conversation_context_service import (
    CandidateLogicalDslValidator,
    QueryContextMerger,
    _matched_organizations,
)
from ask_metric.application.result_repository import (
    ResultReferenceError,
    ResultRepository,
    attach_artifact,
    crop_artifact,
    select_org,
    set_focus,
)
from ask_metric.domain.conversation_context import ContextPatch, QueryContextSnapshot
from ask_metric.domain.metric_matching import MetricMatcher, normalize_semantic_text
from ask_metric.domain.query_execution import QueryExecutionResult
from ask_metric.domain.result_context import ResultReference


def prepare_result_action(*, uow, task, state, actor, permission_service, planner):
    """解析历史结果引用并准备找回、裁剪或机构选择；返回值供语义服务继续处理。

    先核对用户和原文依据，再由 ResultRepository 复核结果归属及当前权限。
    模型只能提出引用候选，不能凭空构造可访问的结果编号或修改已保存的证据。
    """
    if actor is None:
        raise ResultReferenceError("历史结果操作需要可信用户身份")
    shadow = state.debug["multiturn_shadow"]
    reference = ResultReference.model_validate(shadow.get("result_action"))
    if reference.reference_text not in task.original_question:
        raise ResultReferenceError("结果指代依据与当前问题不一致，请明确要引用的结果")
    raw_patch = shadow.get("understanding", {}).get("patch") or {}
    if reference.operation != "SELECT_ORG" and any(
        raw_patch.get(g) for g in ("set", "add", "remove")
    ):
        raise ResultReferenceError("找回或裁剪结果不能同时修改查询条件，请明确要执行的操作")
    if shadow.get("understanding", {}).get("ambiguities"):
        raise ResultReferenceError("本次结果操作含有未确认条件，请补充完整说明")
    repository = ResultRepository(
        uow=uow,
        conversation_id=task.conversation_id,
        actor=actor,
        permission_service=permission_service,
    )
    named_orgs = _matched_organizations(
        reference.reference_text,
        uow.organization_catalog.list_enabled(),
    )
    metrics = uow.metric_catalog.list_enabled()
    direct_metrics = MetricMatcher(metrics).resolve(reference.reference_text)
    direct_codes = {m.code for m in direct_metrics.matches}
    if direct_metrics.ambiguous_candidates:
        direct_codes = set()
    quote = reference.filter_evidence.get("metrics", "")
    supported_metrics = [
        m.code
        for m in metrics
        if m.code in reference.metric_codes
        and (
            m.code in direct_codes
            or (
                quote
                and quote in reference.reference_text
                and normalize_semantic_text(quote) in normalize_semantic_text(m.name)
            )
        )
    ]
    time_quote = reference.filter_evidence.get("time", "")
    shape_quote = reference.filter_evidence.get("query_shape", "")
    # Unsupported qualifiers broaden the candidate set instead of silently
    # eliminating alternatives. A vague org reference cannot invent a metric.
    reference = reference.model_copy(
        update={
            "metric_codes": supported_metrics,
            "org_codes": [o.code for o in named_orgs],
            "start": reference.start
            if time_quote and time_quote in reference.reference_text
            else None,
            "end": reference.end if time_quote and time_quote in reference.reference_text else None,
            "query_shape": reference.query_shape
            if shape_quote and shape_quote in reference.reference_text
            else None,
        }
    )
    if named_orgs:
        # Do not let a CURRENT label silently discard an explicit named entity.
        # Entity catalog binding supplies candidates; it does not classify intent.
        reference = reference.model_copy(
            update={
                "org_codes": sorted(set(reference.org_codes) | {o.code for o in named_orgs}),
                "scope": "HISTORY" if reference.scope == "CURRENT" else reference.scope,
            }
        )
    frozen_scope = getattr(state, "result_reference_scope", None)
    if frozen_scope is not None:
        repository.summaries = [
            s for s in repository.summaries if s["result_id"] in frozen_scope["result_ids"]
        ]
        repository.focus_id = frozen_scope.get("focus_result_id")
    selected_id = getattr(state, "selected_result_id", None)
    candidates = repository.candidates(reference, selected_id=selected_id)
    explicit_task = state.channel_context.get("reply_to_task_id")
    if explicit_task:
        target_task = next((t for t in repository.tasks if t.id == explicit_task), None)
        target_focus = (
            ((target_task.state_json or {}).get("conversation_focus") or {}) if target_task else {}
        )
        candidates = [s for s in candidates if s["result_id"] == target_focus.get("result_id")]
    if not candidates:
        raise ResultReferenceError("没有找到符合描述的历史结果，请补充指标、日期或轮次后重新提问")
    if len(candidates) > 1:
        return candidates
    source = repository.get(candidates[0]["result_id"])
    state.selected_result_id = source.result_id
    state.debug["result_reference"] = {
        "operation": reference.operation,
        "source_result_id": source.result_id,
        "source_task_id": source.task_id,
        "source_run_id": source.source_run_id,
        "business_sql_calls": 0,
        "resolved_selector": reference.model_dump(mode="json"),
    }
    state.debug["execution_route"] = {
        "selected_pipeline": "HISTORICAL_RESULT",
        "single_turn_semantic_executed": False,
    }
    if reference.operation == "SELECT_ORG":
        code = select_org(source, reference.row_number)
        organizations = uow.organization_catalog.list_enabled()
        organization = next((o for o in organizations if o.code == code), None)
        if organization is None:
            raise ResultReferenceError("结果中的机构已不在有效目录中，请重新确认")
        base = QueryContextSnapshot.model_validate(source.context)
        # A row supplies an entity, not the ranking operation that produced it.
        base = base.model_copy(
            update={
                "ops": [],
                "options": {},
                "dimensions": [],
                "filters": [],
                "query_shape": "metric_value",
            }
        )
        patch = ContextPatch.model_validate(shadow["understanding"].get("patch") or {})
        if any("orgs" in group for group in (patch.set, patch.add, patch.remove)):
            raise ResultReferenceError("机构应从所选结果行取得，不能同时指定另一机构")
        patch = patch.model_copy(
            update={
                "set": {
                    **patch.set,
                    "orgs": [{"code": organization.code, "name": organization.name}],
                }
            }
        )
        merged = QueryContextMerger().merge(base=base, patch=patch)
        validation = CandidateLogicalDslValidator().validate(
            context_merge=merged,
            actor=actor,
            metrics=uow.metric_catalog.list_enabled(),
            organizations=organizations,
            permission_service=permission_service,
            planner=planner,
        )
        if validation.status != "VALID":
            raise ResultReferenceError("结果机构已确认，但新查询条件尚未通过校验，请补充指标或时间")
        shadow.update(
            conversation_act="FOLLOW_UP",
            context_merge=merged.model_dump(mode="json"),
            candidate_dsl_validation=validation.model_dump(mode="json"),
        )
        state.debug["result_reference"]["selected_org_code"] = code
        state.debug["result_reference"]["row_number"] = reference.row_number
        return None

    target = source
    if reference.operation == "CROP":
        target = crop_artifact(source, task_id=task.id, limit=reference.limit)
        attach_artifact(state, target)
    else:
        set_focus(state, target, task_id=task.id)
    if source.context:
        state.context_snapshot = {**source.context, "task_id": task.id}
    state.logical_dsl = source.logical_dsl
    result = QueryExecutionResult.model_validate(target.result)
    result.task_id = task.id
    result.run_id = None
    result.latency_ms = 0
    result.timings_ms = {}
    if reference.operation == "READ":
        result.message = (
            f"已找回第{candidates[0]['turn_index']}轮保存的历史结果，共 {result.row_count} 行。"
        )
        if result.truncated:
            result.message += "该结果仅保存了部分行。"
    result.debug = {"result_reference": state.debug["result_reference"]}
    return result
