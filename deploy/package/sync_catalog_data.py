"""只同步正式机构或指标主数据；默认预览，不读取任何别名文件。"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
from datetime import date
from pathlib import Path

from deployment_common import load_environment, require_database_config, write_report


def synchronize(args: argparse.Namespace) -> dict:
    config = load_environment(args.config)
    require_database_config(config)
    from ask_metric.__main__ import main as catalog_command
    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import reset_database_runtime

    get_settings.cache_clear()
    reset_database_runtime()
    settings = get_settings()
    if settings.sit_org_expected_count != 61:
        raise ValueError("本部署入口要求已确认的61家机构范围")
    command = ["sync-metric-catalog" if args.catalog == "metrics" else "sync-org-catalog"]
    if not args.apply:
        command.append("--dry-run")
    if args.catalog == "metrics":
        # 初始化覆盖历史正式编码，单位仅取审核映射，不把未知单位猜成金额。
        command.extend(["--all-snapshots", "--units", str(args.units)])
    else:
        command.extend(["--strict-scope", "--snapshot-date", args.snapshot_date.isoformat()])
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            catalog_command(command)
        summary = json.loads(captured.getvalue())
    finally:
        reset_database_runtime()
    clean = summary["selected_rows"] > 0 and summary["errors"] == 0
    if args.catalog == "organizations":
        clean = clean and summary["selected_rows"] == 61
    return {
        "status": "PASS" if clean else "BLOCKED",
        "catalog": args.catalog, "applied": args.apply, "aliases": "not_requested",
        "summary": summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", choices=["metrics", "organizations"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--units", type=Path,
                        default=Path(__file__).parent / "catalog-data/metric-units.json")
    parser.add_argument("--snapshot-date", type=date.fromisoformat)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.catalog == "organizations" and args.snapshot_date is None:
        parser.error("机构同步必须指定数据负责人确认的 --snapshot-date")
    return write_report(args.report, lambda: synchronize(args))


if __name__ == "__main__":
    raise SystemExit(main())
