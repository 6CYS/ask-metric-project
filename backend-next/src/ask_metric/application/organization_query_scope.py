"""基于正式层级和账号权限产生唯一机构集合，不执行指标 SQL。"""

import hashlib
import json
from collections.abc import Sequence

from pydantic import TypeAdapter

from ask_metric.application.ports import (
    OrgHierarchyProvider,
    PermissionDeniedError,
    PermissionService,
)
from ask_metric.application.requests import ActorContext
from ask_metric.domain.organization_scope import (
    OrganizationScopeError,
    OrganizationScopeSpec,
)
from ask_metric.domain.semantics import OrganizationCatalogItem


def resolve_query_scope(
    *, scope: OrganizationScopeSpec | dict, actor: ActorContext,
    organizations: Sequence[OrganizationCatalogItem], permissions: PermissionService,
    hierarchy: OrgHierarchyProvider,
) -> dict:
    scope = TypeAdapter(OrganizationScopeSpec).validate_python(scope)
    if not hasattr(hierarchy, "strict_snapshot"):
        raise OrganizationScopeError("CONFIGURATION_ERROR", "机构层级尚未提供可信快照")
    snapshot = hierarchy.strict_snapshot()
    root = snapshot.validated_root()
    catalog = {item.code: item.name for item in organizations}
    by_code = {node.code: node for node in snapshot.nodes}
    # 同步过程中目录与层级版本不一致时阻断，不能把不同版本拼成新计划。
    if catalog != {node.code: node.name for node in snapshot.nodes}:
        raise OrganizationScopeError("CONFIGURATION_ERROR", "机构目录正在变更，请稍后重新查询")
    try:
        allowed = permissions.authorized_org_codes(
            actor=actor, available_org_codes=set(by_code), hierarchy_snapshot=snapshot,
        )
    except PermissionDeniedError as error:
        raise OrganizationScopeError("PERMISSION_DENIED", "无法确认当前账号的机构权限") from error
    parent_code = root if scope.kind == "authorized_cohort" else scope.parent_code
    if parent_code not in by_code:
        raise OrganizationScopeError("PERMISSION_DENIED", "指定机构范围不可用")
    candidates = {node.code for node in snapshot.nodes if node.parent_code == parent_code}
    codes = sorted(candidates & allowed)
    if not codes:
        raise OrganizationScopeError(
            "EMPTY_AUTHORIZED_SCOPE", "该机构范围内没有当前账号可查看的机构"
        )
    normalized = scope.model_dump()
    fingerprint_data = {
        "definition": "root-direct-legal-entities/v1",
        "root_level": snapshot.root_level, "cohort_level": snapshot.cohort_level,
        "scope": normalized, "codes": codes, "authorized": sorted(allowed),
        "actor": {
            "subject": actor.subject, "tenant_id": actor.tenant_id,
            "org_id": actor.org_id, "role_code": actor.role_code, "trust_level": actor.trust_level,
        },
        "catalog": sorted(
            (node.code, node.name, node.parent_code or "", node.hierarchy_level)
            for node in snapshot.nodes
        ),
    }
    fingerprint = hashlib.sha256(json.dumps(
        fingerprint_data, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    return {
        "codes": codes, "names": [catalog[code] for code in codes],
        "scope": normalized, "scope_fingerprint": fingerprint,
    }
