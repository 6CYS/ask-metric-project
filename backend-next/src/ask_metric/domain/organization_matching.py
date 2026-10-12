"""机构名称按最长原文范围匹配；重复别名只能消歧，不能展开为多个机构。"""

from dataclasses import dataclass, field

from ask_metric.domain.metric_matching import _normalize_with_index, normalize_semantic_text
from ask_metric.domain.semantics import OrganizationCatalogItem


@dataclass(frozen=True)
class OrganizationMatch:
    item: OrganizationCatalogItem
    start: int
    end: int


@dataclass
class OrganizationResolution:
    matches: list[OrganizationMatch] = field(default_factory=list)
    ambiguous: list[dict] = field(default_factory=list)


def resolve_organizations(
    text: str,
    organizations: list[OrganizationCatalogItem],
    aliases: dict[str, list[str]] | None = None,
) -> OrganizationResolution:
    normalized, positions = _normalize_with_index(text)
    groups: dict[tuple[int, int], list[tuple[int, OrganizationCatalogItem]]] = {}
    for item in organizations:
        terms = [
            (item.name, 0),
            *(
                (term, 1)
                for term in [
                    *item.aliases,
                    *(aliases or {}).get(item.name, []),
                ]
            ),
        ]
        for term, priority in terms:
            key = normalize_semantic_text(term)
            if not key:
                continue
            offset = 0
            while (start := normalized.find(key, offset)) >= 0:
                end = start + len(key)
                groups.setdefault((positions[start], positions[end - 1] + 1), []).append(
                    (priority, item)
                )
                offset = start + 1
    result = OrganizationResolution()
    occupied: list[tuple[int, int]] = []
    for (start, end), owners in sorted(
        groups.items(), key=lambda pair: (-(pair[0][1] - pair[0][0]), pair[0][0])
    ):
        if any(start < right and end > left for left, right in occupied):
            continue
        occupied.append((start, end))
        priority = min(value[0] for value in owners)
        preferred = {item.code: item for rank, item in owners if rank == priority}
        if len(preferred) == 1:
            result.matches.append(OrganizationMatch(next(iter(preferred.values())), start, end))
        else:
            result.ambiguous.append(
                {
                    "raw_text": text[start:end],
                    "start": start,
                    "end": end,
                    "options": [
                        {"code": item.code, "name": item.name, "kind": "organization"}
                        for item in preferred.values()
                    ],
                }
            )
    result.matches.sort(key=lambda match: match.start)
    return result


def exact_organization(
    value: str,
    organizations: list[OrganizationCatalogItem],
) -> OrganizationCatalogItem | None:
    key = normalize_semantic_text(value)
    standard = [item for item in organizations if normalize_semantic_text(item.name) == key]
    candidates = standard or [
        item
        for item in organizations
        if any(normalize_semantic_text(term) == key for term in item.aliases)
    ]
    unique = {item.code: item for item in candidates}
    return next(iter(unique.values())) if len(unique) == 1 else None
