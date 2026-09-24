from __future__ import annotations

import argparse
import json
import os
import platform
import re
import secrets
import shutil
import stat
import sys
import urllib.request
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parents[1]
PLACEHOLDER = re.compile(r"<[^>]+>|@[A-Z_]+@|development-only-change-me")
ENCRYPTED_VALUE_PREFIX = "ENC[SM4:v1:"
SENSITIVE_CONFIG_KEYS = {
    "APP_DATABASE_URL",
    "QUERY_DATABASE_URL",
    "METRIC_CATALOG_DATABASE_URL",
    "ORG_CATALOG_DATABASE_URL",
    "NACOS_PASSWORD",
    "JWT_SECRET",
    "MODEL_CHAT_API_KEY",
    "MODEL_EMBEDDING_API_KEY",
    "MODEL_RERANK_API_KEY",
    "MODEL_ADMIN_TOKEN",
    "TRUSTED_PROXY_TOKEN",
    "SM2_PRIVATE_KEY",
}


def _copy_once(source: Path, target: Path) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return "kept"
    shutil.copy2(source, target)
    return "created"


def _load_runtime_environment(config_file: Path) -> None:
    from dotenv import dotenv_values

    for name, value in dotenv_values(config_file).items():
        if value is not None:
            os.environ[name] = value


def init_config(args: argparse.Namespace) -> None:
    config_file = args.config_root.resolve() / "backend.env"
    state_root = args.state_root.resolve()
    runtime_config = state_root / "runtime-config"
    for directory in (
        runtime_config,
        state_root / "config-history",
    ):
        directory.mkdir(parents=True, exist_ok=True)

    mappings = {
        BUNDLE_ROOT / "backend/runtime/config/model-config.json": runtime_config
        / "model-config.json",
        BUNDLE_ROOT / "backend/runtime/config/prompts.json": runtime_config / "prompts.json",
    }
    for source, target in mappings.items():
        print(f"{_copy_once(source, target)}: {target}")
    if config_file.exists():
        print(f"kept: {config_file}")
    else:
        template = (BUNDLE_ROOT / "ops/backend.env.example").read_text(encoding="utf-8")
        replacements = {
            "@INSTALL_ROOT@/current": str(BUNDLE_ROOT),
            "@STATE_ROOT@": str(state_root),
            "@CONFIG_FILE@": str(config_file),
            "@BACKEND_PORT@": str(args.backend_port),
            "<generate-a-long-random-secret>": secrets.token_urlsafe(48),
            "<generate-a-different-long-random-secret>": secrets.token_urlsafe(48),
            "<generate-a-model-admin-token>": secrets.token_urlsafe(48),
        }
        for old, new in replacements.items():
            template = template.replace(old, new)
        config_file.parent.mkdir(parents=True, exist_ok=True)
        config_file.write_text(template, encoding="utf-8", newline="\n")
        os.chmod(config_file, stat.S_IRUSR | stat.S_IWUSR)
        print(f"created: {config_file}")
    print("Edit backend.env and replace all <...> values before validation or startup.")


def validate_config(args: argparse.Namespace) -> None:
    from dotenv import dotenv_values

    config_file = args.config.resolve()
    text = config_file.read_text(encoding="utf-8")
    matches = sorted(set(PLACEHOLDER.findall(text)))
    if matches:
        raise SystemExit("Unresolved configuration placeholders: " + ", ".join(matches))
    required = {
        line.split("=", 1)[0]
        for line in text.splitlines()
        if line and not line.startswith("#") and "=" in line
    }
    missing = sorted(
        {
            "APP_DATABASE_URL",
            "QUERY_DATABASE_URL",
            "JWT_SECRET",
        }
        - required
    )
    if missing:
        raise SystemExit("Missing required configuration keys: " + ", ".join(missing))
    values = dotenv_values(config_file)
    plaintext = sorted(
        name
        for name in SENSITIVE_CONFIG_KEYS
        if values.get(name) and not str(values[name]).startswith(ENCRYPTED_VALUE_PREFIX)
    )
    if plaintext:
        raise SystemExit(
            "Sensitive configuration values must use SM4 encryption: "
            + ", ".join(plaintext)
        )
    key_file_value = str(values.get("ASK_METRIC_CONFIG_SM4_KEY_FILE") or "").strip()
    if not key_file_value:
        raise SystemExit("ASK_METRIC_CONFIG_SM4_KEY_FILE must reference the external key file")
    key_file = Path(key_file_value).resolve()
    if not key_file.is_file():
        raise SystemExit(f"SM4 configuration key file not found: {key_file}")
    key_text = key_file.read_text(encoding="ascii").strip()
    try:
        key_bytes = bytes.fromhex(key_text)
    except ValueError as exc:
        raise SystemExit("SM4 configuration key file must contain hexadecimal text") from exc
    if len(key_bytes) != 16:
        raise SystemExit("SM4 configuration key file must contain exactly 16 bytes")
    key_mode = stat.S_IMODE(key_file.stat().st_mode)
    if key_mode & (stat.S_IWGRP | stat.S_IXGRP | stat.S_IRWXO):
        raise SystemExit(f"Unsafe SM4 key permissions {key_mode:o}; expected 600 or 640")
    mode = stat.S_IMODE(config_file.stat().st_mode)
    if mode & (stat.S_IWGRP | stat.S_IXGRP | stat.S_IRWXO):
        raise SystemExit(f"Unsafe configuration permissions {mode:o}; expected 600 or 640")
    print(f"Configuration validation passed: {config_file}")


def verify_runtime(_: argparse.Namespace) -> None:
    import pymysql
    import sqlalchemy
    import uvicorn

    import ask_metric.main  # noqa: F401

    manifest = json.loads((BUNDLE_ROOT / "manifest.json").read_text(encoding="utf-8"))
    print(f"Python: {sys.version.split()[0]}")
    print(f"Platform: {platform.machine()} / libc {platform.libc_ver()}")
    print(f"SQLAlchemy: {sqlalchemy.__version__}")
    print(f"PyMySQL: {pymysql.__version__}")
    print(f"Uvicorn: {uvicorn.__version__}")
    print(f"Release: {manifest['release']}")
    print("Bundled runtime imports: OK")


def database_check(args: argparse.Namespace) -> None:
    from sqlalchemy import text

    config_file = args.config.resolve()
    _load_runtime_environment(config_file)

    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import (
        get_app_engine,
        get_query_engine,
        reset_database_runtime,
    )

    get_settings.cache_clear()
    reset_database_runtime()
    try:
        for label, engine_getter in (
            ("APP_DATABASE_URL", get_app_engine),
            ("QUERY_DATABASE_URL", get_query_engine),
        ):
            with engine_getter().connect() as connection:
                value = connection.execute(text("SELECT 1")).scalar_one()
            if value != 1:
                raise RuntimeError(f"Unexpected {label} SELECT result: {value!r}")
            print(f"{label}: connection and read check OK")
    finally:
        reset_database_runtime()


def catalog_mapping_check(args: argparse.Namespace) -> None:
    from sqlalchemy import text

    config_file = args.config.resolve()
    _load_runtime_environment(config_file)
    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import (
        get_metric_catalog_engine,
        get_org_catalog_engine,
        reset_database_runtime,
    )

    get_settings.cache_clear()
    reset_database_runtime()
    settings = get_settings()
    mappings = {
        "metric_fact": {
            "table": settings.sit_fact_table,
            "columns": {
                "metric_terms.metric_code": settings.sit_fact_metric_code_field,
                "join_to_metric_config": settings.sit_fact_source_metric_code_field,
                "metric_name_suffix": settings.sit_fact_value_basis_field,
                "org_terms.org_code": settings.sit_fact_org_code_field,
                "stat_date": settings.sit_fact_data_date_field,
                "metric_value": settings.sit_fact_value_field,
                "metric_increment": settings.sit_fact_increment_field,
                "snapshot": settings.sit_metric_fact_snapshot_field,
                "batch_order": settings.sit_fact_batch_sequence_field,
            },
        },
        "metric_config": {
            "table": settings.sit_metric_config_table,
            "columns": {
                "join_from_metric_fact": settings.sit_metric_config_code_field,
                "metric_terms.metric_name_base": settings.sit_metric_config_name_field,
                "effective_date_for_latest_row": settings.sit_metric_config_effective_date_field,
                "version_for_latest_row": settings.sit_metric_config_version_field,
                "batch_for_latest_row": settings.sit_metric_config_batch_field,
            },
        },
        "organization": {
            "table": settings.sit_org_table,
            "columns": {
                "org_terms.org_code": settings.sit_org_code_field,
                "org_terms.org_name": settings.sit_org_name_field,
                "filter.corporation_code": settings.sit_org_corporation_code_field,
                "filter.hierarchy": settings.sit_org_hierarchy_field,
                "latest_snapshot": settings.sit_org_snapshot_field,
            },
        },
    }
    try:
        for name, engine, mapping in (
            ("metric_fact", get_metric_catalog_engine(), mappings["metric_fact"]),
            ("metric_config", get_metric_catalog_engine(), mappings["metric_config"]),
            ("organization", get_org_catalog_engine(), mappings["organization"]),
        ):
            columns = list(dict.fromkeys(mapping["columns"].values()))
            sql = f"SELECT {', '.join(columns)} FROM {mapping['table']} WHERE 1 = 0"
            with engine.connect() as connection:
                connection.execute(text(sql))
            print(f"{name}: configured table and columns are readable")
        print(json.dumps(mappings, ensure_ascii=False, indent=2))
    finally:
        reset_database_runtime()


def _run_catalog_sync(
    *, settings, service, metric_engine, org_engine, catalog: str, dry_run: bool, full: bool
) -> tuple[object | None, object | None]:
    metric_summary = None
    org_summary = None
    if catalog in {"metrics", "all"}:
        metric_summary = service.sync_metrics(
            source_engine=metric_engine,
            config_table=settings.sit_metric_config_table,
            fact_table=settings.sit_fact_table,
            dry_run=dry_run,
            full=full,
            active_order=settings.sit_metric_active_order,
            fact_snapshot_field=settings.sit_metric_fact_snapshot_field,
            fact_metric_code_field=settings.sit_fact_metric_code_field,
            fact_source_metric_code_field=settings.sit_fact_source_metric_code_field,
            fact_value_basis_field=settings.sit_fact_value_basis_field,
            config_code_field=settings.sit_metric_config_code_field,
            config_name_field=settings.sit_metric_config_name_field,
            config_effective_date_field=settings.sit_metric_config_effective_date_field,
            config_version_field=settings.sit_metric_config_version_field,
            config_batch_field=settings.sit_metric_config_batch_field,
        )
    if catalog in {"organizations", "all"}:
        org_summary = service.sync_organizations(
            source_engine=org_engine,
            source_table=settings.sit_org_table,
            dry_run=dry_run,
            full=full,
            snapshot_field=settings.sit_org_snapshot_field,
            org_code_field=settings.sit_org_code_field,
            org_name_field=settings.sit_org_name_field,
            corporation_code_field=settings.sit_org_corporation_code_field,
            hierarchy_field=settings.sit_org_hierarchy_field,
            corporation_code_max=settings.sit_org_corporation_code_max,
            excluded_corporation_code=settings.sit_org_excluded_corporation_code,
            head_office_corporation_code=settings.sit_org_head_office_corporation_code,
            legal_entity_hier_code=settings.sit_org_legal_entity_hier_code,
            head_office_hier_code=settings.sit_org_head_office_hier_code,
            expected_count=settings.sit_org_expected_count,
        )
    return metric_summary, org_summary


def sync_catalogs(args: argparse.Namespace) -> None:
    config_file = args.config.resolve()
    _load_runtime_environment(config_file)

    from ask_metric.application.catalog_sync import SitCatalogSyncService
    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import (
        get_app_session_factory,
        get_metric_catalog_engine,
        get_org_catalog_engine,
        reset_database_runtime,
    )

    get_settings.cache_clear()
    reset_database_runtime()
    settings = get_settings()
    service = SitCatalogSyncService(get_app_session_factory())
    try:
        if args.catalog == "all":
            metric_summary, org_summary = _run_catalog_sync(
                settings=settings,
                service=service,
                metric_engine=get_metric_catalog_engine(),
                org_engine=get_org_catalog_engine(),
                catalog="all",
                dry_run=args.dry_run,
                full=args.full,
            )
            assert metric_summary is not None and org_summary is not None
            print(
                "metrics: "
                + json.dumps(metric_summary.to_dict(), ensure_ascii=False, default=str)
            )
            print(
                "organizations: "
                + json.dumps(org_summary.to_dict(), ensure_ascii=False, default=str)
            )
        elif args.catalog == "metrics":
            metric_summary, _ = _run_catalog_sync(
                settings=settings,
                service=service,
                metric_engine=get_metric_catalog_engine(),
                org_engine=get_org_catalog_engine(),
                catalog="metrics",
                dry_run=args.dry_run,
                full=args.full,
            )
            assert metric_summary is not None
            print(
                "metrics: "
                + json.dumps(metric_summary.to_dict(), ensure_ascii=False, default=str)
            )
        else:
            _, org_summary = _run_catalog_sync(
                settings=settings,
                service=service,
                metric_engine=get_metric_catalog_engine(),
                org_engine=get_org_catalog_engine(),
                catalog="organizations",
                dry_run=args.dry_run,
                full=args.full,
            )
            assert org_summary is not None
            print(
                "organizations: "
                + json.dumps(org_summary.to_dict(), ensure_ascii=False, default=str)
            )
    finally:
        reset_database_runtime()


def initialize_synchronized_catalogs(args: argparse.Namespace) -> None:
    if not args.apply:
        raise SystemExit(
            "Preview only. No application data changed. Re-run with --apply and "
            "--confirm INITIALIZE_SYNCHRONIZED_CATALOGS after database backup and DBA approval."
        )
    if args.confirm != "INITIALIZE_SYNCHRONIZED_CATALOGS":
        raise SystemExit("Refusing destructive cleanup: confirmation text is missing")

    config_file = args.config.resolve()
    _load_runtime_environment(config_file)
    from ask_metric.application.catalog_sync import SitCatalogSyncService
    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import (
        get_app_session_factory,
        get_metric_catalog_engine,
        get_org_catalog_engine,
        reset_database_runtime,
    )

    get_settings.cache_clear()
    reset_database_runtime()
    settings = get_settings()
    if settings.query_database_dialect != "inceptor":
        raise SystemExit(
            "QUERY_DATABASE_DIALECT must be inceptor before initializing synchronized catalogs"
        )
    service = SitCatalogSyncService(get_app_session_factory())
    try:
        metric_summary, org_summary = _run_catalog_sync(
            settings=settings,
            service=service,
            metric_engine=get_metric_catalog_engine(),
            org_engine=get_org_catalog_engine(),
            catalog="all",
            dry_run=False,
            full=True,
        )
        assert metric_summary is not None and org_summary is not None
        if (
            metric_summary.selected_rows <= 0
            or org_summary.selected_rows <= 0
            or metric_summary.errors
            or org_summary.errors
        ):
            raise RuntimeError("Data-lake catalog synchronization was incomplete; cleanup refused")
        fallback_org_code = args.user_org_code
        if not fallback_org_code:
            raise RuntimeError(
                "--user-org-code is required and must be an org_no returned by the lake sync"
            )
        cleanup = service.cleanup_simulated_catalogs(
            retained_metric_codes=metric_summary.selected_codes,
            retained_org_codes=org_summary.selected_codes,
            fallback_org_code=fallback_org_code,
        )
        print("metrics: " + json.dumps(metric_summary.to_dict(), ensure_ascii=False, default=str))
        print(
            "organizations: "
            + json.dumps(org_summary.to_dict(), ensure_ascii=False, default=str)
        )
        print("cleanup: " + json.dumps(cleanup.to_dict(), ensure_ascii=False, default=str))
    finally:
        reset_database_runtime()


def health(args: argparse.Namespace) -> None:
    for path in ("/health", "/health/ready"):
        url = f"http://{args.host}:{args.port}{path}"
        with urllib.request.urlopen(url, timeout=args.timeout) as response:
            body = response.read(512).decode("utf-8", errors="replace")
            print(f"{response.status} {url} {body}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Shell-free Ask Metric intranet operations")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init-config")
    init_parser.add_argument("--config-root", type=Path, required=True)
    init_parser.add_argument("--state-root", type=Path, required=True)
    init_parser.add_argument("--backend-port", type=int, default=8010)
    init_parser.set_defaults(handler=init_config)

    validate_parser = subparsers.add_parser("validate-config")
    validate_parser.add_argument("--config", type=Path, required=True)
    validate_parser.set_defaults(handler=validate_config)

    verify_parser = subparsers.add_parser("verify-runtime")
    verify_parser.set_defaults(handler=verify_runtime)

    database_parser = subparsers.add_parser("database-check")
    database_parser.add_argument("--config", type=Path, required=True)
    database_parser.set_defaults(handler=database_check)

    mapping_parser = subparsers.add_parser("catalog-mapping-check")
    mapping_parser.add_argument("--config", type=Path, required=True)
    mapping_parser.set_defaults(handler=catalog_mapping_check)

    sync_parser = subparsers.add_parser("sync-catalogs")
    sync_parser.add_argument("--config", type=Path, required=True)
    sync_parser.add_argument(
        "--catalog", choices=("metrics", "organizations", "all"), default="all"
    )
    sync_parser.add_argument("--dry-run", action="store_true")
    sync_parser.add_argument("--full", action="store_true")
    sync_parser.set_defaults(handler=sync_catalogs)

    replace_parser = subparsers.add_parser("initialize-synchronized-catalogs")
    replace_parser.add_argument("--config", type=Path, required=True)
    replace_parser.add_argument("--user-org-code")
    replace_parser.add_argument("--apply", action="store_true")
    replace_parser.add_argument("--confirm")
    replace_parser.set_defaults(handler=initialize_synchronized_catalogs)

    health_parser = subparsers.add_parser("health")
    health_parser.add_argument("--host", default="127.0.0.1")
    health_parser.add_argument("--port", type=int, default=8010)
    health_parser.add_argument("--timeout", type=float, default=10.0)
    health_parser.set_defaults(handler=health)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
