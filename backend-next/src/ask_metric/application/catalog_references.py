"""原文明示且无歧义的目录实体识别；供历史结果回读等场景核对原文引用。"""

from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.domain.metric_matching import normalize_semantic_text
from ask_metric.domain.semantics import (
    MetricCatalogItem,
    MetricMatch,
    OrganizationCatalogItem,
)


def explicit_catalog_references(
    question: str,
    *,
    metrics: list[MetricCatalogItem],
    organizations: list[OrganizationCatalogItem],
    organization_aliases: dict[str, list[str]],
) -> dict[str, set[str]]:
    """只返回原文明示且无歧义的目录实体；与指标识别共用同一识别器，同音采用不算明示。"""
    index = metric_candidate_index(metrics)
    matches = []
    for mention in index.mentions(question):
        resolution = mention["resolution"]
        codes = resolution.get("value", {}).get("codes", [])
        if (resolution["status"] != "resolved" or len(codes) != 1
                or resolution.get("metadata", {}).get("match") == "homophone"):
            continue
        item = index.items[codes[0]]
        exact = normalize_semantic_text(mention["text"]) == normalize_semantic_text(item.name)
        matches.append(MetricMatch(
            code=item.code, name=item.name, matched_text=mention["text"],
            start=mention["start"], end=mention["end"],
            source="standard_name" if exact else "alias", exact=exact,
        ))
    org_codes: list[str] = []
    _protect_resolved_entities(
        question,
        metric_matches=matches,
        organizations=organizations,
        organization_aliases=organization_aliases,
        resolved_org_codes=org_codes,
    )
    return {"orgs": set(org_codes), "metrics": {match.code for match in matches}}


def _protect_resolved_entities(
    question: str,
    *,
    metric_matches: list[MetricMatch],
    organizations: list[OrganizationCatalogItem],
    organization_aliases: dict[str, list[str]],
    ambiguous_metric_spans: list[tuple[int, int]] | None = None,
    resolved_org_codes: list[str] | None = None,
) -> str:
    """Replace confirmed entity spans with opaque, self-closing placeholders."""

    spans: list[tuple[int, int, str]] = [
        (match.start, match.end, f'<METRIC code="{match.code}"/>')
        for match in metric_matches
    ]
    # 完整歧义别名内的“同比/排名”等同样属于实体文字。保留候选供澄清，
    # 不向模型暴露名称内部的操作词，也不伪造一个已选中的指标编码。
    for start, end in sorted(
        ambiguous_metric_spans or [], key=lambda span: -(span[1] - span[0])
    ):
        if not any(start < right and end > left for left, right, _ in spans):
            spans.append((start, end, '<METRIC unresolved="true"/>'))
    occupied = [(start, end) for start, end, _ in spans]

    term_owners: dict[str, list[OrganizationCatalogItem]] = {}
    for organization in organizations:
        for term in dict.fromkeys(
            [
                organization.name,
                *organization.aliases,
                *organization_aliases.get(organization.name, []),
            ]
        ):
            normalized = term.strip()
            if normalized:
                term_owners.setdefault(normalized, []).append(organization)

    candidates: list[tuple[int, int, str]] = []
    for term, owners in term_owners.items():
        unique_owners = {item.code: item for item in owners}
        if len(unique_owners) != 1:
            # Leave ambiguous aliases visible so the normal clarification path
            # can resolve them instead of silently selecting a catalog row.
            continue
        organization = next(iter(unique_owners.values()))
        search_start = 0
        while True:
            position = question.find(term, search_start)
            if position < 0:
                break
            end = position + len(term)
            if term.endswith("农商") and question[end : end + 1] == "行":
                end += 1
            candidates.append((position, end, organization.code))
            search_start = end

    for start, end, code in sorted(
        candidates,
        key=lambda item: (-(item[1] - item[0]), item[0]),
    ):
        if any(start < right and end > left for left, right in occupied):
            continue
        spans.append((start, end, f'<ORG code="{code}"/>'))
        occupied.append((start, end))
        if resolved_org_codes is not None:
            resolved_org_codes.append(code)

    output: list[str] = []
    cursor = 0
    for start, end, placeholder in sorted(spans, key=lambda item: item[0]):
        if start < cursor:
            continue
        output.append(question[cursor:start])
        output.append(placeholder)
        cursor = end
    output.append(question[cursor:])
    return "".join(output)
