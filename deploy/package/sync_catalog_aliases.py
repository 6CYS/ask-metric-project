"""可选别名补录：只写已有启用目录的别名，不重新同步主数据或访问数据湖。"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from deployment_common import load_environment, require_database_config, write_report


def sync_metrics(session, payload: dict, *, apply: bool) -> dict:
    from ask_metric.infrastructure.db.models import MetricSynonym, MetricTerm
    from sqlalchemy import select

    if not isinstance(payload, dict) or payload.get("format") != 1:
        raise ValueError("指标别名要求 format=1 的准备文件")
    entries = payload.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("指标别名 entries 必须是非空数组")
    query = select(MetricTerm).order_by(MetricTerm.metric_code)
    terms = list(session.scalars(query.with_for_update() if apply else query))
    names = defaultdict(list)
    for term in terms:
        if term.enabled:
            names[term.metric_name].append(term.metric_code)
    existing = defaultdict(list)
    for row in session.scalars(select(MetricSynonym)):
        existing[(row.metric_code, row.synonym)].append(row)
    unmatched, ambiguous, disabled, pending = [], [], [], set()
    unchanged = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("指标别名条目必须为对象")
        name = checked_text(entry.get("metric_name"))
        alias = checked_text(entry.get("synonym"))
        codes = names.get(name, [])
        if not codes:
            unmatched.append(name)
        elif len(codes) > 1:
            ambiguous.append(name)
        else:
            pair = (codes[0], alias)
            if pair not in existing:
                pending.add(pair)
            elif any(row.enabled for row in existing[pair]):
                unchanged.add(pair)
            else:
                disabled.append({"metric_code": codes[0], "synonym": alias})
    report = {
        "unmatched": sorted(set(unmatched)), "ambiguous": sorted(set(ambiguous)),
        "disabled_existing": disabled, "would_create": len(pending),
        "unchanged": len(unchanged),
    }
    blocked = bool(unmatched or ambiguous or disabled)
    # 共享别名允许一对多；不静默重启停用关系，不猜测同名指标的编码。
    if apply and not blocked:
        for code, alias in sorted(pending):
            session.add(MetricSynonym(metric_code=code, synonym=alias, enabled=True, weight=1))
    return {**report, "blocked": blocked}


def checked_text(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 255:
        raise ValueError("名称与别名必须为1至255字符文本")
    if value != value.strip():
        raise ValueError("名称与别名不能包含首尾空白")
    return value


def sync_organizations(session, payload: dict, *, apply: bool) -> dict:
    from ask_metric.infrastructure.db.models import OrgTerm
    from sqlalchemy import select

    if not isinstance(payload, dict) or not payload:
        raise ValueError("机构别名要求非空的机构编码到别名数组映射")
    query = select(OrgTerm).order_by(OrgTerm.org_code)
    terms = list(session.scalars(query.with_for_update() if apply else query))
    enabled = {term.org_code: term for term in terms if term.enabled}
    unknown = sorted(set(payload) - enabled.keys())
    additions = 0
    changed = 0
    for code, aliases in payload.items():
        if not isinstance(aliases, list) or not aliases:
            raise ValueError("机构别名必须为非空数组")
        aliases = [checked_text(alias) for alias in aliases]
        if code not in enabled:
            continue
        term = enabled[code]
        current = list(term.aliases or [])
        merged = list(dict.fromkeys([*current, *aliases]))
        added = set(merged) - set(current)
        additions += len(added)
        changed += bool(added)
        if apply and not unknown and added:
            term.aliases = merged
    return {"blocked": bool(unknown), "unmatched_codes": unknown,
            "would_create": additions, "would_update_organizations": changed}


def synchronize(args: argparse.Namespace) -> dict:
    config = load_environment(args.config)
    require_database_config(config)
    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import (
        get_app_session_factory,
        reset_database_runtime,
    )

    get_settings.cache_clear()
    reset_database_runtime()
    payload = json.loads(args.aliases.read_text(encoding="utf-8-sig"))
    handler = sync_metrics if args.catalog == "metrics" else sync_organizations
    try:
        with get_app_session_factory()() as session:
            report = handler(session, payload, apply=args.apply)
            applied = args.apply and not report["blocked"]
            if applied:
                session.commit()
            else:
                session.rollback()
        return {"status": "BLOCKED" if report["blocked"] else "PASS",
                "catalog": args.catalog, "applied": applied, **report}
    finally:
        reset_database_runtime()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", choices=["metrics", "organizations"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--aliases", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    return write_report(args.report, lambda: synchronize(args))


if __name__ == "__main__":
    raise SystemExit(main())
