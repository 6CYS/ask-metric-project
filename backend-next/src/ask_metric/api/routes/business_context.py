"""业务字段事实接口：复用启用目录与权限，禁止调用自然语言模型或执行指标 SQL。"""

from datetime import date, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.catalogs import get_overview_permissions, get_overview_settings, get_uow
from ask_metric.application.field_resolution import resolve_catalog_field, resolve_date_field, source_calendar_constraints, source_organization_codes
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.analysis_selection import issue_selection, verify_selection
from ask_metric.application.semantic_transition import SemanticTransition, validate_transition, verify_transition_fragment
from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import Settings
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.organization_scope import (
    AuthorizedCohortScope,
    ChildrenOfScope,
    OrganizationScopeError,
    is_authorized_cohort_source,
)
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.infrastructure.db.org_hierarchy import SqlAlchemyOrgHierarchyProvider
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork

router = APIRouter(prefix="/api/v1/business-context", tags=["business-context"])
# 与语义提议的businessText边界一致，完整多指标表达不能被单名称的旧长度限制截断。
RawName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class SuggestedOrganization(BaseModel):
    """agent-service 模型推断的机构建议；code/name 至少其一，服务端独立复核。"""
    model_config = ConfigDict(extra="forbid")
    code: Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)] | None = None
    name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)] | None = None
    excerpt: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def code_or_name_required(self) -> "SuggestedOrganization":
        if not (self.code or self.name):
            raise ValueError("suggested 元素的 code/name 至少其一为非空字符串")
        return self


class ModelCalendarValue(BaseModel):
    """模型直接换算的日期值；字符串原样接收，由 validate_calendar_value 复核，不做隐式日期转换。"""
    model_config = ConfigDict(extra="forbid")
    start: str = Field(min_length=1, max_length=64)
    end: str = Field(min_length=1, max_length=64)
    dates: list[str] | None = Field(default=None, max_length=100)


class ResolveFieldRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity: Literal["metric", "organization", "date"]
    raw_values: list[RawName] = Field(default_factory=list, max_length=100)
    suggested: list[SuggestedOrganization] | None = Field(default=None, max_length=100)
    reference_year: int | None = Field(default=None, ge=1, le=9999)
    business_date: date | None = None
    source_question: str | None = Field(default=None, min_length=1, max_length=8000)
    # 仅 entity=date 消费：模型随请求提交的换算结果，确定性解析优先，本字段补长尾。
    model_value: ModelCalendarValue | None = None

    @model_validator(mode="after")
    def raw_values_or_suggested_required(self) -> "ResolveFieldRequest":
        # 建议通道只属于机构；指标/日期仍须有原值，避免空指标被误标为 resolved。
        if self.entity != "organization" and not self.raw_values:
            raise ValueError("metric/date 必须提供非空 raw_values")
        if not self.raw_values and not self.suggested:
            raise ValueError("raw_values 与 suggested 至少其一非空")
        return self


class MetricMentionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=8000)


class HistoricalGoalSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spec: BasicQuerySpec
    receipt: str = Field(min_length=1, max_length=16000, repr=False)


class HistoricalGoalContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=128)
    sources: list[HistoricalGoalSource] = Field(min_length=1, max_length=100)


class InspectGoalRequest(MetricMentionsRequest):
    business_date: date
    reference_year: int | None = Field(default=None, ge=1, le=9999)
    history: HistoricalGoalContext | None = None


class PlanAdmissionStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_ref: str = Field(min_length=1, max_length=128)
    fragment: int = Field(ge=0, le=99)
    origin: Literal["user_explicit", "history", "analysis_selected"]
    spec: BasicQuerySpec
    source_question: str | None = Field(default=None, min_length=1, max_length=8000)
    source_semantic_receipt: str | None = Field(default=None, min_length=1, max_length=16000, repr=False)
    bindings: list[dict] = Field(default_factory=list, max_length=100)
    exclusions: list[dict] = Field(default_factory=list, max_length=100)
    transition: SemanticTransition | None = None


class PlanAdmissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=128)
    goal: str = Field(min_length=1, max_length=8000)
    business_date: date
    analysis: bool = False
    reference_year: int | None = Field(default=None, ge=1, le=9999)
    steps: list[PlanAdmissionStep] = Field(min_length=1, max_length=100)
    fragment_bindings: dict[str, list[dict]] = Field(default_factory=dict)
    # 仅宿主从本轮入场冻结任务提供；解释保留目标，不生成任何执行许可。
    context_sources: list[SemanticTransition] = Field(default_factory=list, max_length=100)


@router.post("/admit-plan")
def admit_semantic_plan(
    payload: PlanAdmissionRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
    settings: Annotated[Settings, Depends(get_overview_settings)],
) -> dict:
    from ask_metric.api.routes.tasks import _verify_metric_coverage, SourceMetricBinding, SourceMetricSpan
    with uow:
        if uow.conversations.get_owned(payload.conversation_id, actor.user_id) is None:
            raise HTTPException(status_code=404, detail="任务会话不可读取")
        catalog = uow.metric_catalog.list_enabled()
        organizations = uow.organization_catalog.list_enabled()
        allowed = permissions.authorized_org_codes(actor=actor, available_org_codes={item.code for item in organizations})
    # 内部义务对账保留原句中的真实目录身份；失权不能让另一机构变成“唯一共享机构”。
    # 对外目录和inspect接口仍仅投影可见目录，实际执行范围在下方独立鉴权。
    facts = inspect_goal(payload.goal, payload.business_date, catalog, organizations, reference_year=payload.reference_year)
    def verify_transition_source(transition: SemanticTransition) -> None:
        try:
            for source in transition.field_sources:
                basis = SemanticTransition(**source.model_dump(exclude={"field"}), changes=[])
                verify_transition_source(basis)
                validate_transition(basis, basis.before, question=payload.goal, today=payload.business_date,
                                    metrics=catalog, organizations=organizations, allowed=allowed,
                                    reference_year=payload.reference_year)
            if transition.source_semantic_receipt:
                # 回执约束旧完整范围，不能拿新范围验证旧票后跳过差异检查。
                verify_selection(transition.source_semantic_receipt, owner=actor.user_id,
                    conversation=payload.conversation_id, session=payload.session_id,
                    codes=transition.before.metric_codes,
                    scope=transition.before.model_dump(mode="json", exclude_none=True),
                    catalog=catalog, secret=settings.jwt_secret)
            elif transition.source_question:
                # 旧单目标 Frame 未签准入票，保留其既有指标来源校验；新目标统一签完整范围票。
                _verify_metric_coverage(transition.source_question, transition.before.metric_codes, catalog,
                    [SourceMetricBinding.model_validate(item) for item in transition.bindings],
                    [SourceMetricSpan.model_validate(item) for item in transition.exclusions])
            else:
                raise ApplicationError("TRANSITION_SOURCE_MISSING", "跨轮变更缺少冻结来源回执或原始绑定依据。", status_code=409)
        except (ApplicationError, ValidationError) as error:
            if isinstance(error, ApplicationError) and error.code.startswith("TRANSITION_"):
                raise
            raise ApplicationError("TRANSITION_SOURCE_INVALID", "跨轮变更的冻结来源身份或范围校验失败。", status_code=409) from None
    verified_contexts: list[SemanticTransition] = []
    rejected_contexts: list[tuple[int, SemanticTransition, ApplicationError]] = []
    for number, context in enumerate(payload.context_sources):
        if context.changes:
            raise ApplicationError("TRANSITION_CONTEXT_INVALID", "保留上下文只能引用已确认完整条件，不能携带变更或执行动作。", status_code=409)
        try:
            verify_transition_source(context)
            validate_transition(context, context.before, question=payload.goal, today=payload.business_date,
                metrics=catalog, organizations=organizations, allowed=allowed,
                analysis=payload.analysis, reference_year=payload.reference_year)
            verified_contexts.append(context)
        except ApplicationError as error:
            # 非执行上下文可能已失权；先保留诊断，只有通过校验的来源能解释本轮义务。
            rejected_contexts.append((number, context, error))
    def verify_fragment_context(fragment: dict) -> None:
        execution = [step.transition for step in payload.steps if step.transition is not None]
        specs = [step.spec for step in payload.steps if step.transition is not None]
        def verify(contexts: list[SemanticTransition]) -> None:
            verify_transition_fragment(fragment, execution + contexts, after_specs=specs,
                metrics=catalog, today=payload.business_date, reference_year=facts.get("reference_year"))
        try:
            verify(verified_contexts)
        except ApplicationError as uncovered:
            if uncovered.code != "PLAN_TARGETS_INCOMPLETE" or not rejected_contexts:
                raise
            # 被拒来源仅用于区分失败原因，绝不作为已解释依据或生成执行票。
            diagnostics = [{"index": number, "code": error.code} for number, _, error in rejected_contexts]
            for _, context, error in rejected_contexts:
                try:
                    verify(verified_contexts + [context])
                except ApplicationError:
                    continue
                raise ApplicationError(error.code, error.message, status_code=error.status_code,
                    details={"context_sources": diagnostics}) from None
            try:
                verify(verified_contexts + [context for _, context, _ in rejected_contexts])
            except ApplicationError:
                raise ApplicationError(uncovered.code, uncovered.message, status_code=uncovered.status_code,
                    details={"context_sources": diagnostics}) from None
            error = rejected_contexts[0][2]
            raise ApplicationError(error.code, error.message, status_code=error.status_code,
                details={"context_sources": diagnostics}) from None
    # 重规划保留的旧草案不能与新来源重复取同一份事实；操作或比较总体不同的查询独立核验。
    for number, step in enumerate(payload.steps):
        for previous in payload.steps[:number]:
            same_operation = step.spec.operation == previous.spec.operation and step.spec.selection == previous.spec.selection and step.spec.comparison_scope == previous.spec.comparison_scope
            if same_operation and step.spec.time == previous.spec.time and set(step.spec.org_codes) & set(previous.spec.org_codes) and set(step.spec.metric_codes) & set(previous.spec.metric_codes):
                raise ApplicationError("PLAN_SOURCE_OVERLAP", "提案含重叠的查询来源。未执行草案请用完整new提案重组为不重叠的来源；已有正式结果请引用复用。", status_code=409)
    for step in payload.steps:
        if step.spec.organization_scope or not set(step.spec.org_codes) <= allowed or (step.spec.comparison_scope and (step.spec.comparison_scope.organization_scope or not set(step.spec.comparison_scope.org_codes) <= allowed)):
            raise HTTPException(status_code=403, detail="任务范围不可签发")
        if step.origin == "analysis_selected" and not payload.analysis:
            raise ApplicationError("ANALYSIS_NOT_AUTHORIZED", "普通查询不能使用分析选指标来源。", status_code=409)
        if step.transition is not None:
            transition = step.transition
            if step.origin == "user_explicit":
                raise ApplicationError("TRANSITION_SOURCE_INVALID", "跨轮变更必须声明历史或获授权的分析来源。", status_code=409)
            verify_transition_source(transition)
            validate_transition(transition, step.spec, question=payload.goal, today=payload.business_date,
                metrics=catalog, organizations=organizations, allowed=allowed,
                analysis=payload.analysis, reference_year=payload.reference_year)
            continue
        if step.origin == "history":
            if step.source_semantic_receipt:
                # 历史来源复用已签发身份与范围，但当前权限、目录和会话归属仍重新核验。
                verify_selection(step.source_semantic_receipt, owner=actor.user_id, conversation=payload.conversation_id, session=payload.session_id,
                    codes=step.spec.metric_codes, scope=step.spec.model_dump(mode="json", exclude_none=True), catalog=catalog, secret=settings.jwt_secret)
            elif not step.source_question:
                raise ApplicationError("HISTORY_SOURCE_MISSING", "历史条件需要保留原始绑定依据。", status_code=409)
            else:
                _verify_metric_coverage(step.source_question, step.spec.metric_codes, catalog,
                    [SourceMetricBinding.model_validate(item) for item in step.bindings],
                    [SourceMetricSpan.model_validate(item) for item in step.exclusions])
    # 新目标仍逐片段对账；已验证的变更按轨迹对账，不再把旧 subject、排除项当新增查询义务。
    ordinary = [step for step in payload.steps if step.transition is None]
    has_transition = len(ordinary) != len(payload.steps)
    for number, fragment in enumerate(facts["fragments"]):
        new_steps = [step for step in ordinary if step.fragment == number]
        steps = [step for step in payload.steps if step.fragment == number]
        fragment_transitions = [step.transition for step in steps if step.transition is not None]
        if not new_steps:
            if has_transition:
                verify_fragment_context(fragment)
                continue
            if payload.analysis:
                continue
            raise ApplicationError("PLAN_TARGETS_INCOMPLETE", "原始问题还有目标没有进入任务。", status_code=409)
        for step in new_steps:
            if fragment["organizations"] and not set(step.spec.org_codes) <= set(fragment["organizations"]):
                raise ApplicationError("PLAN_TARGET_BINDING_CONFLICT", "机构与指标日期的原始绑定不符。", status_code=409)
            # 榜单是整个比较总体上的操作；各机构分别取前N再求并集不能替代原榜单。
            if step.spec.operation.kind == "ranking" and fragment["organizations"] and set(step.spec.org_codes) != set(fragment["organizations"]):
                raise ApplicationError("PLAN_RANKING_SCOPE_INCOMPLETE", "同一榜单的完整比较机构须进入同一查询目标，请合并机构后重提。", status_code=409)
            ranges = fragment["calendar"]["ranges"]
            if ranges and not any(step.spec.time.start.isoformat() >= value["start"] and step.spec.time.end.isoformat() <= value["end"] for value in ranges):
                raise ApplicationError("PLAN_TARGET_BINDING_CONFLICT", "目标日期不属于对应原始片段。", status_code=409)
        requested = list(dict.fromkeys(code for step in steps for code in step.spec.metric_codes))
        newly_requested = {code for step in new_steps for code in step.spec.metric_codes}
        bindings = [SourceMetricBinding.model_validate(item) for item in payload.fragment_bindings.get(str(number), [])]
        explicit = [item for item in fragment["mentions"] if item["resolution"]["status"] == "resolved"]
        required = {code for item in explicit for code in item["resolution"]["value"]["codes"]}
        if (payload.analysis or all(step.origin == "history" for step in steps)) and not fragment["mentions"]:
            required = set(requested)
        else:
            # 分析可以增加目录指标，但明确提及和已确认的指标仍须逐片段完整绑定。
            from ask_metric.api.routes.tasks import _verify_metric_bindings
            required = _verify_metric_bindings(fragment["question"], fragment["mentions"], bindings, [], metric_candidate_index(catalog))
            # 混合片段中的旧 subject 已由变更轨迹解释；继承条件不要求本轮重复声明。
            if fragment_transitions:
                old_metrics = {code for transition in fragment_transitions for code in transition.before.metric_codes}
                old_metrics.update(code for transition in fragment_transitions for change in transition.changes
                    if change.field == "metrics" for code in change.before)
                required -= old_metrics - set(requested)
                complete = required <= set(requested) and newly_requested <= required
            else:
                complete = required <= set(requested) and (all(step.origin == "history" for step in steps) or required == set(requested))
            if not payload.analysis and not complete:
                raise ApplicationError("PLAN_TARGETS_INCOMPLETE", "普通查询须整批覆盖原始指标；若是分析中的支持步骤，应使用analyze保留完整目标并分阶段取证。", status_code=409)
        orgs = fragment["organizations"]
        calendars = fragment["calendar"]["ranges"]
        # 独立核验每个显式机构、指标、日期组合；仅核对集合并集会漏掉半份目标。
        coverage_codes = required & set(requested) if payload.analysis else required
        # transition 已逐字段独立核验；原始机构/日期组合义务只约束普通新目标。
        if fragment_transitions:
            coverage_codes &= newly_requested
        for code in coverage_codes:
            # 继承目标未在本轮重复机构名称时，沿用各指标自己的机构绑定，不能生成跨目标笛卡尔积。
            bound_orgs = orgs or list(dict.fromkeys(org for step in steps if code in step.spec.metric_codes for org in step.spec.org_codes))
            for org in bound_orgs:
                covering = [step for step in steps if code in step.spec.metric_codes and
                    (org in step.spec.org_codes or step.spec.comparison_scope and org in step.spec.comparison_scope.org_codes)]
                if not covering:
                    raise ApplicationError("PLAN_TARGETS_INCOMPLETE", "原始机构与指标组合没有完整进入任务。", status_code=409)
                for calendar in calendars:
                    expected_dates = calendar.get("dates")
                    if expected_dates:
                        actual = {value for step in covering for value in
                            (step.spec.time.dates or ([step.spec.time.start] if step.spec.time.start == step.spec.time.end else []))}
                        complete = set(expected_dates) <= {value.isoformat() for value in actual}
                    else:
                        complete = any(step.spec.time.start.isoformat() == calendar["start"] and
                            step.spec.time.end.isoformat() == calendar["end"] and not step.spec.time.dates for step in covering)
                    if not complete:
                        raise ApplicationError("PLAN_TARGETS_INCOMPLETE", "原始机构、指标和日期的组合未完整覆盖。", status_code=409)
    if any(step.fragment >= len(facts["fragments"]) for step in ordinary):
        raise ApplicationError("PLAN_FRAGMENT_INVALID", "新目标声明的原始片段不存在。", status_code=409)
    receipts = []
    for step in payload.steps:
        scope = step.spec.model_dump(mode="json", exclude_none=True)
        receipts.append({"target_ref": step.target_ref, "receipt": issue_selection(owner=actor.user_id, conversation=payload.conversation_id,
            session=payload.session_id, goal=payload.goal, codes=step.spec.metric_codes, scope=scope, catalog=catalog, secret=settings.jwt_secret)})
    return {"status": "admitted", "receipts": receipts,
        **({"context_diagnostics": [{"index": number, "code": error.code, "ignored": True}
            for number, _, error in rejected_contexts]} if rejected_contexts else {})}


@router.post("/inspect-goal")
def inspect_business_goal(
    payload: InspectGoalRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
    settings: Annotated[Settings, Depends(get_overview_settings)],
) -> dict:
    with uow:
        metrics = uow.metric_catalog.list_enabled()
        organizations = uow.organization_catalog.list_enabled()
        allowed = permissions.authorized_org_codes(actor=actor, available_org_codes={item.code for item in organizations})
        if payload.history:
            if uow.conversations.get_owned(payload.history.conversation_id, actor.user_id) is None:
                raise HTTPException(status_code=404, detail="历史任务会话不可读取")
            # 旧票仅证明用户曾持有该机构身份，供来源消歧；当前数据访问仍单独鉴权。
            for source in payload.history.sources:
                verify_selection(source.receipt, owner=actor.user_id, conversation=payload.history.conversation_id,
                    session=payload.history.session_id, codes=source.spec.metric_codes,
                    scope=source.spec.model_dump(mode="json", exclude_none=True), catalog=metrics, secret=settings.jwt_secret)
                allowed.update(source.spec.org_codes)
    return inspect_goal(payload.question, payload.business_date, metrics, [item for item in organizations if item.code in allowed], reference_year=payload.reference_year)


class ResolveCohortRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["authorized_cohort"]
    cohort: Literal["rural_commercial_banks"]
    source_text: RawName


class ResolveChildrenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["children_of"]
    parent_name: RawName
    source_text: RawName


ResolveScopeRequest = Annotated[
    ResolveCohortRequest | ResolveChildrenRequest, Field(discriminator="kind")
]


def get_scope_hierarchy(
    settings: Annotated[Settings, Depends(get_overview_settings)],
) -> SqlAlchemyOrgHierarchyProvider:
    return SqlAlchemyOrgHierarchyProvider(
        root_level=settings.sit_org_head_office_hier_code,
        cohort_level=settings.sit_org_legal_entity_hier_code,
    )


@router.post("/resolve-scope")
def resolve_scope(
    payload: ResolveScopeRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
    hierarchy: Annotated[SqlAlchemyOrgHierarchyProvider, Depends(get_scope_hierarchy)],
) -> dict:
    """机构集合意图由 Agent 绑定原文，服务端独立解析正式目录和当前账号权限。"""
    if payload.kind == "authorized_cohort" and not is_authorized_cohort_source(
        payload.cohort, payload.source_text,
    ):
        raise ApplicationError(
            "SCOPE_SOURCE_INVALID",
            "原文未明确表达机构集合，不能将具体机构或未知名称扩大为全部可见农商行",
            status_code=422,
        )
    with uow:
        organizations = uow.organization_catalog.list_enabled()
    try:
        if payload.kind == "authorized_cohort":
            scope = AuthorizedCohortScope(kind=payload.kind, cohort=payload.cohort)
        else:
            snapshot = hierarchy.strict_snapshot()
            allowed = permissions.authorized_org_codes(
                actor=actor, available_org_codes={node.code for node in snapshot.nodes},
                hierarchy_snapshot=snapshot,
            )
            parent = resolve_catalog_field(
                "organization", [payload.parent_name],
                [item for item in organizations if item.code in allowed],
            )
            if parent["status"] != "resolved":
                return parent
            scope = ChildrenOfScope(kind=payload.kind, parent_code=parent["value"]["codes"][0])
        return {"status": "resolved", "value": resolve_query_scope(
            scope=scope, actor=actor, organizations=organizations,
            permissions=permissions, hierarchy=hierarchy,
        )}
    except PermissionDeniedError as error:
        raise OrganizationScopeError("PERMISSION_DENIED", "无法确认当前账号的机构权限") from error


@router.post("/metric-mentions")
def metric_mentions(
    payload: MetricMentionsRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
) -> dict:
    """对完整原文匹配启用目录，不调用模型、不执行指标 SQL。取数权限仍在执行层校验。"""
    with uow:
        items = uow.metric_catalog.list_enabled()
    return {"mentions": metric_candidate_index(items).mentions(payload.question)}


def _authorized_organization_items(
    items: list,
    *,
    actor: ActorContext,
    permissions: ScopedOrganizationPermissionService,
) -> list:
    """机构目录按当前账号权限过滤；resolve-field 与 org-catalog 共用同一规则。"""
    if not items:
        return items
    try:
        authorized = permissions.authorize_logical_dsl(actor=actor, logical_dsl={
            "orgs": [item.code for item in items],
            "options": {"organization_scope": "synchronized_catalog"},
        })
    except PermissionDeniedError as error:
        raise HTTPException(status_code=403, detail="无权解析机构范围") from error
    allowed = set(authorized.get("orgs", []))
    return [item for item in items if item.code in allowed]


@router.get("/org-catalog")
def org_catalog(
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
) -> dict:
    """供 agent-service 注入模型上下文的机构目录；别名已合并派生短称。"""
    with uow:
        items = _authorized_organization_items(
            uow.organization_catalog.list_enabled(), actor=actor, permissions=permissions,
        )
    return {"items": [
        {"code": item.code, "name": item.name, "aliases": list(item.aliases)}
        for item in items
    ]}


@router.post("/resolve-field")
def resolve_field(
    payload: ResolveFieldRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
) -> dict:
    if payload.entity == "date":
        if len(payload.raw_values) != 1:
            return {"status": "invalid"}
        today = payload.business_date or datetime.now(ZoneInfo("Asia/Shanghai")).date()
        result = resolve_date_field(
            payload.raw_values[0], today, reference_year=payload.reference_year,
            model_value=(
                payload.model_value.model_dump(exclude_none=True)
                if payload.model_value is not None else None
            ),
        )
        if payload.source_question:
            result["metadata"] = {**result.get("metadata", {}),
                                  "source_calendar": source_calendar_constraints(payload.source_question, today, reference_year=payload.reference_year)}
        return result
    with uow:
        if payload.entity == "metric":
            items = uow.metric_catalog.list_enabled()
        else:
            items = _authorized_organization_items(
                uow.organization_catalog.list_enabled(), actor=actor, permissions=permissions,
            )
        # suggested 仅机构字段消费：metric/date 没有模型推断通道，按现有逻辑忽略。
        suggested = (
            [entry.model_dump(exclude_none=True) for entry in payload.suggested]
            if payload.entity == "organization" and payload.suggested else None
        )
        result = resolve_catalog_field(payload.entity, payload.raw_values, items,
                                       suggested=suggested)
        if payload.entity == "organization" and payload.source_question:
            # 错字感知与准入对账同尺：追问错字（如“沐阳”）登记为目录事实后，
            # 与之相符的模型建议不再降级为待确认；不相符的照旧确认。
            source_codes = source_organization_codes(payload.source_question, items, allow_typo=True)
            result["metadata"] = {**result.get("metadata", {}), "source_codes": source_codes}
            # 有权目录成员资格不能证明用户指代；未由原话目录事实绑定的模型建议保持待确认。
            if suggested and result["status"] == "resolved" and not set(result["value"]["codes"]) <= set(source_codes):
                by_code = {item.code: item for item in items}
                candidates = [{"code": code, "value": by_code[code].name, "preferred": True}
                              for code in result["value"]["codes"]]
                result = {"status": "needs_confirmation", "candidates": candidates,
                          "metadata": {**result["metadata"], "reason": "model_suggestion_requires_confirmation"}}
        return result
