from __future__ import annotations

import argparse
import getpass
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m ask_metric")
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ("sync-metric-catalog", "sync-org-catalog"):
        command = subcommands.add_parser(name)
        command.add_argument("--dry-run", action="store_true")
        command.add_argument(
            "--full",
            action="store_true",
            help="Disable catalog rows missing from the source snapshot",
        )
    subcommands.add_parser("check-data-lake")
    encrypt_config = subcommands.add_parser(
        "encrypt-config", help="Encrypt one runtime configuration value with SM4"
    )
    encrypt_config.add_argument(
        "--key-file",
        type=Path,
        help="Read the 32-hex-character SM4 master key from this protected file",
    )
    args = parser.parse_args()

    if args.command == "encrypt-config":
        from ask_metric.core.config_crypto import encrypt_config_value, load_config_sm4_key

        key = load_config_sm4_key(key_file=args.key_file)
        assert key is not None
        plaintext = getpass.getpass("Plaintext configuration value: ")
        if not plaintext:
            raise SystemExit("Configuration value must not be empty")
        print(encrypt_config_value(plaintext, key))
        return

    from ask_metric.application.catalog_sync import SitCatalogSyncService, verify_data_lake_readonly
    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import (
        get_app_session_factory,
        get_metric_catalog_engine,
        get_org_catalog_engine,
        get_query_engine,
    )

    settings = get_settings()
    service = SitCatalogSyncService(get_app_session_factory())
    if args.command == "sync-metric-catalog":
        result = service.sync_metrics(
            source_engine=get_metric_catalog_engine(),
            config_table=settings.sit_metric_config_table,
            fact_table=settings.sit_fact_table,
            dry_run=args.dry_run,
            full=args.full,
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
        ).to_dict()
    elif args.command == "sync-org-catalog":
        result = service.sync_organizations(
            source_engine=get_org_catalog_engine(),
            source_table=settings.sit_org_table,
            dry_run=args.dry_run,
            full=args.full,
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
        ).to_dict()
    else:
        result = verify_data_lake_readonly(get_query_engine())
    print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
