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
    model_validator,
)

from ask_metric.api.dependencies import require_actor
from ask_metric.api.routes.catalogs import get_overview_permissions, get_overview_settings, get_uow
from ask_metric.application.field_resolution import (
    resolve_catalog_field,
    resolve_date_field,
    source_calendar_constraints,
    source_organization_codes,
    typo_organization_matches,
)
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.application.organization_query_scope import resolve_query_scope
from ask_metric.application.ports import PermissionDeniedError, ScopedOrganizationPermissionService
from ask_metric.application.requests import ActorContext
from ask_metric.core.config import Settings
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.metric_matching import normalize_semantic_text
from ask_metric.domain.organization_scope import (
    AuthorizedCohortScope,
    ChildrenOfScope,
    OrganizationScopeError,
)
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


class HistoricalGoalContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=128)
    sources: list[HistoricalGoalSource] = Field(min_length=1, max_length=100)


class InspectGoalRequest(MetricMentionsRequest):
    business_date: date
    reference_year: int | None = Field(default=None, ge=1, le=9999)
    history: HistoricalGoalContext | None = None


@router.post("/inspect-goal")
def inspect_business_goal(
    payload: InspectGoalRequest,
    actor: Annotated[ActorContext, Depends(require_actor)],
    uow: Annotated[SqlAlchemyUnitOfWork, Depends(get_uow)],
    permissions: Annotated[ScopedOrganizationPermissionService, Depends(get_overview_permissions)],
) -> dict:
    with uow:
        metrics = uow.metric_catalog.list_enabled()
        organizations = uow.organization_catalog.list_enabled()
        allowed = permissions.authorized_org_codes(actor=actor, available_org_codes={item.code for item in organizations})
        if payload.history:
            if uow.conversations.get_owned(payload.history.conversation_id, actor.user_id) is None:
                raise HTTPException(status_code=404, detail="历史任务会话不可读取")
            # 历史 spec 的机构只作定位消歧，不构成任何执行许可，也不触发重跑；
            # 数据访问由执行路径单独鉴权。
            for source in payload.history.sources:
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
    """模型声明范围类型；Agent 绑定原文，后端按正式层级和当前权限解析成员。"""
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


def _resolve_organization_field(
    raw_values: list[str],
    *,
    suggested: list[dict] | None,
    source_question: str | None,
    all_items: list,
    items: list,
) -> dict:
    """resolve-field 的机构解析、来源摘录和权限投影。"""
    submitted_raw_values = list(raw_values)
    raw_values = list(raw_values)
    hint_source_bound = False
    if suggested and source_question:
        for hint in suggested:
            excerpt = hint.get("excerpt")
            if not isinstance(excerpt, str) or not excerpt or excerpt not in source_question:
                continue
            identity = resolve_catalog_field("organization", [], all_items, suggested=[hint])
            if identity["status"] != "resolved":
                continue
            hinted = set(identity["value"]["codes"])
            # excerpt 是模型绑定的机构槽位连续原文（已核对 ∈ source_question），
            # 槽位片段允许错字依据；整句不做此扫描。
            excerpt_identities = set(source_organization_codes(excerpt, all_items, allow_typo=True))
            if hinted <= excerpt_identities:
                continue
            for index, raw in enumerate(raw_values):
                if raw in source_question:
                    continue
                literal = resolve_catalog_field("organization", [raw], all_items)
                if raw == excerpt and literal["status"] != "resolved":
                    hint_source_bound = True
                if literal["status"] == "resolved" and set(literal["value"]["codes"]) == hinted and not hinted <= excerpt_identities:
                    # 仅回到该建议绑定的用户原片段；全句其他目标不能替这个槽位选机构。
                    raw_values[index] = excerpt
                    hint_source_bound = True
    # 先在完整目录识别身份，再裁定权限；失权精确实体不能在可见子目录中纠错成另一家。
    result = resolve_catalog_field("organization", raw_values, all_items, suggested=suggested)
    if hint_source_bound:
        result.setdefault("metadata", {}).update({"hint_source_bound": True, "extractedRawValues": raw_values})
    allowed = {item.code for item in items}
    value = result.get("value") or result.get("metadata", {}).get("partialMembers") or {}
    pairs = list(zip(value.get("codes", []), value.get("names", []), strict=True))
    visible = [(code, name) for code, name in pairs if code in allowed]
    metadata = result.setdefault("metadata", {})
    if "corrections" in metadata:
        metadata["corrections"] = [entry for entry in metadata["corrections"] if entry["corrected_code"] in allowed]
    pending = metadata.get("pendingRawValues")
    if isinstance(pending, list):
        hidden = {item.code for item in all_items} - allowed
        for index, entry in enumerate(pending):
            codes = entry if isinstance(entry, list) else [entry]
            if not any(code in hidden for code in codes):
                continue
            # 目录识别出的失权编码不能外投影；保留用户该槽原文，等待明确处理权限/条件。
            raw = submitted_raw_values[index] if index < len(submitted_raw_values) else ""
            pending[index] = raw
            issues = metadata.setdefault("issues", [])
            if not any(issue.get("rawValueIndex") == index for issue in issues):
                issues.append({"rawValue": raw, "rawValueIndex": index, "reason": "not_found"})
            result["status"] = "not_found"
    if "candidates" in result:
        result["candidates"] = [entry for entry in result["candidates"] if entry.get("code") in allowed]
        metadata["candidate_count"] = max(
            len(result["candidates"]), int(metadata.get("candidate_count", 0))
        )
    if len(visible) != len(pairs):
        if visible:
            metadata["partialMembers"] = {"codes": [code for code, _ in visible], "names": [name for _, name in visible]}
        else:
            metadata.pop("partialMembers", None)
        if result["status"] == "resolved":
            result.pop("value", None)
            result["status"] = "not_found"
            result["candidates"] = []
            metadata["pendingRawValues"] = submitted_raw_values
            metadata["issues"] = [{"rawValue": raw, "rawValueIndex": index, "reason": "not_found"}
                                  for index, raw in enumerate(submitted_raw_values)
                                  if not set(source_organization_codes(raw, all_items)) <= allowed]
    if source_question:
        # 完整原问只做精确机构覆盖，不对整句错字滑窗；错字纠错限定在机构槽位
        # 提交的连续原文（raw_values 阶梯与下方 suggestion.excerpt 对账）内。
        # 槽位原值确为本轮连续原文时补记错字依据（“启动→启东”不因关闭整句
        # 模糊扫描而失去来源）。
        source_codes = [code for code in source_organization_codes(source_question, all_items)
                        if code in allowed]
        slot_codes = [code for raw in submitted_raw_values
                      if isinstance(raw, str) and raw and raw in source_question
                      for code in source_organization_codes(raw, all_items, allow_typo=True)
                      if code in allowed]
        source_codes = list(dict.fromkeys([*source_codes, *slot_codes]))
        # 模型把原文错字预纠成规范写法（提交“启东”而原文是“启动”）时，槽位原值不在
        # 本轮原文内；此时只用整句错字扫描核对“已提交的这个槽位”：扫描出的目录身份必须
        # 与槽位解析集合完全一致才回记原文片段，供宿主按原文重新解析并明示纠正。
        # 该扫描不产生额外机构义务，片段义务仍只做精确覆盖。
        if (result.get("status") == "resolved" and isinstance(result.get("value"), dict)
                and set(result["value"].get("codes", [])) - set(source_codes)
                and not any(isinstance(raw, str) and raw and raw in source_question
                            for raw in submitted_raw_values)):
            resolved_codes = set(result["value"].get("codes", []))
            matches = [(span, code)
                       for span, code in typo_organization_matches(source_question, all_items)
                       if code in resolved_codes]
            if matches and {code for _, code in matches} == resolved_codes:
                text = normalize_semantic_text(source_question)
                spans = [text[start:end] for (start, end), _ in matches]
                source_codes = list(dict.fromkeys([*source_codes, *sorted(resolved_codes)]))
                by_code = {item.code: item for item in all_items}
                metadata = result.setdefault("metadata", {})
                metadata["extractedRawValues"] = list(dict.fromkeys(spans))
                metadata["rawExcerpt"] = spans[0]
                metadata["hint_source_bound"] = True
                metadata["resolution_source"] = "corrected"
                corrections = metadata.setdefault("corrections", [])
                for span, (_, code) in zip(spans, matches, strict=True):
                    if any(entry.get("corrected_code") == code for entry in corrections):
                        continue
                    corrections.append({"raw": span, "corrected_name": by_code[code].name,
                                        "corrected_code": code})
        result["metadata"] = {**result.get("metadata", {}), "source_codes": source_codes}
        # 有权目录成员资格不能证明用户指代；未由原话目录事实绑定的模型建议保持待确认。
        if suggested and not submitted_raw_values and result["status"] == "resolved":
            by_code = {item.code: item for item in items}
            excerpts = [entry["excerpt"] for entry in suggested
                        if isinstance(entry.get("excerpt"), str) and entry.get("excerpt")
                        and entry["excerpt"] in source_question]
            grounded = list(dict.fromkeys(code for excerpt in excerpts
                                          for code in source_organization_codes(excerpt, all_items, allow_typo=True)
                                          if code in allowed))
            if set(result["value"]["codes"]) <= set(grounded):
                return result
            excerpt = excerpts[0] if len(excerpts) == 1 else None
            if len(suggested) == 1 and len(grounded) == 1:
                # 原文目录事实唯一且与模型建议冲突时以原文为准（模型可能换错机构）：
                # 直接按错字纠正落地并明示，不走候选确认，也不采用模型的换名。
                item = by_code[grounded[0]]
                result = {"status": "resolved",
                          "value": {"codes": [item.code], "names": [item.name]},
                          "metadata": {"resolution_source": "corrected",
                                       "corrections": [{"raw": excerpt or source_question,
                                                        "corrected_name": item.name,
                                                        "corrected_code": item.code}],
                                       "source_codes": source_codes}}
            else:
                # 原文依据为多机构或无依据：候选确认，原文依据的机构优先于模型建议。
                seen: set[str] = set()
                candidates = []
                for code in [*grounded, *result["value"]["codes"]]:
                    if code in by_code and code not in seen:
                        seen.add(code)
                        candidates.append({"code": code, "value": by_code[code].name,
                                           "preferred": code in set(grounded)})
                result = {"status": "needs_confirmation", "candidates": candidates,
                          "metadata": {**result["metadata"], "reason": "model_suggestion_requires_confirmation"}}
    return result


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
            # 模型换算被采纳的表达不再用旧词法重扫裁定：source_calendar 直接复用
            # 已采纳结果；确定性命中的表达维持原文词法对账。
            adopted = result.get("value") if result.get("metadata", {}).get(
                "resolution_source") == "model" else None
            result["metadata"] = {**result.get("metadata", {}),
                                  "source_calendar": source_calendar_constraints(
                                      payload.source_question, today,
                                      reference_year=payload.reference_year, adopted=adopted)}
        return result
    if payload.entity == "metric":
        with uow:
            items = uow.metric_catalog.list_enabled()
        return resolve_catalog_field("metric", list(payload.raw_values), items)
    with uow:
        all_items = uow.organization_catalog.list_enabled()
        items = _authorized_organization_items(all_items, actor=actor, permissions=permissions)
    # “我行”是认证账号的机构指代，不进入字符/拼音模糊推荐；别名仅在本次请求生效。
    self_references = {"我行", "本行", "我们行", "我们银行"}
    if any(raw in self_references for raw in payload.raw_values):
        member = next((item for item in items if item.code == actor.org_id), None)
        if member is None:
            return {"status": "not_found", "candidates": [], "metadata": {
                "reason": "account_organization_unavailable",
                "pendingRawValues": list(payload.raw_values), "candidate_count": 0,
            }}
        all_items = [item.model_copy(update={"aliases": [*item.aliases, *sorted(self_references)]})
                     if item.code == member.code else item for item in all_items]
    suggested = (
        [entry.model_dump(exclude_none=True) for entry in payload.suggested]
        if payload.suggested else None
    )
    return _resolve_organization_field(
        list(payload.raw_values), suggested=suggested, source_question=payload.source_question,
        all_items=all_items, items=items,
    )
