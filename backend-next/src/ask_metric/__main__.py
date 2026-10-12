from __future__ import annotations

import argparse
import getpass
import json
from datetime import date
from pathlib import Path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m ask_metric")
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ("sync-metric-catalog", "sync-org-catalog"):
        command = subcommands.add_parser(name)
        command.add_argument("--dry-run", action="store_true")
        if name == "sync-org-catalog":
            command.add_argument("--snapshot-date", type=date.fromisoformat)
            command.add_argument("--org-aliases", type=Path)
            command.add_argument("--strict-scope", action="store_true")
        if name == "sync-metric-catalog":
            command.add_argument("--units", type=Path, help="已确认的完整指标名称—单位 JSON")
            command.add_argument("--infer-units", action="store_true")
            command.add_argument("--all-snapshots", action="store_true",
                                 help="Read distinct metric definitions across all fact snapshots")
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
    export_nacos = subcommands.add_parser(
        "export-nacos-config", help="分类导出 Nacos 配置与节点引导文件"
    )
    export_nacos.add_argument("--output-dir", type=Path, required=True)
    export_nacos.add_argument("--source-root", type=Path, help="原后端资源目录，迁移旧部署时指定")
    export_nacos.add_argument(
        "--env-file", type=Path, help="可选：把已填写的 dotenv 配置拆分为运行/数据源/安全 Data ID"
    )
    encrypt_nacos = subcommands.add_parser(
        "encrypt-nacos-config", help="批量加密 Nacos YAML/JSON 与引导配置中的敏感字段"
    )
    encrypt_nacos.add_argument("--input-dir", type=Path, required=True)
    encrypt_nacos.add_argument("--output-dir", type=Path, required=True)
    encrypt_nacos.add_argument("--key-file", type=Path, required=True)
    args = parser.parse_args(argv)

    if args.command == "encrypt-config":
        from ask_metric.core.config_crypto import encrypt_config_value, load_config_sm4_key

        key = load_config_sm4_key(key_file=args.key_file)
        assert key is not None
        plaintext = getpass.getpass("Plaintext configuration value: ")
        if not plaintext:
            raise SystemExit("Configuration value must not be empty")
        print(encrypt_config_value(plaintext, key))
        return

    if args.command in {"export-nacos-config", "encrypt-nacos-config"}:
        from ask_metric.core.config_crypto import load_config_sm4_key
        from ask_metric.infrastructure.config_center.exporter import (
            encrypt_directory,
            export_builtin_configs,
        )

        try:
            if args.command == "export-nacos-config":
                generated = export_builtin_configs(
                    args.source_root.resolve() if args.source_root else
                    Path(__file__).resolve().parents[2], args.output_dir,
                    env_file=args.env_file.resolve() if args.env_file else None,
                )
                result = {"files": [p.name for p in generated]}
            else:
                key = load_config_sm4_key(environ={}, key_file=args.key_file.resolve())
                result = {"files": encrypt_directory(args.input_dir, args.output_dir, key)}
        except Exception as exc:
            # 不打印 YAML/JSON 原文、解析器异常或包含凭据的输入值。
            from ask_metric.infrastructure.config_center.nacos import ConfigCenterError

            message = str(exc) if isinstance(exc, ConfigCenterError) else type(exc).__name__
            raise SystemExit("配置处理失败：" + message) from None
        result["output_dir"] = str(args.output_dir.resolve())
        print(json.dumps(result, ensure_ascii=False))
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
            all_snapshots=args.all_snapshots,
            units_by_name=(json.loads(args.units.read_text(encoding="utf-8"))
                           if args.units else None),
            infer_units=args.infer_units,
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
            snapshot_date=args.snapshot_date,
            strict_scope=args.strict_scope,
            aliases_by_code=(json.loads(args.org_aliases.read_text(encoding="utf-8"))
                             if args.org_aliases else None),
        ).to_dict()
    else:
        result = verify_data_lake_readonly(get_query_engine())
    print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
