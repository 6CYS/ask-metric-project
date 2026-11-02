"""指标同义词一致性检查（只读）。

识别索引会从“指标术语”维护的组合同义词推导基础指标别名与口径别名。本脚本输出推导结果，
并列出不会被采用的写法，供目录负责人修正同义词：
- 同一基础别名落到多个基础指标，或与另一基础指标的正式名称相同；
- 拆不出基础指标与口径的同义词（仍按完整写法匹配）。

依赖迁移 0005 与目录同步回填源字段；不修改任何数据。
Run ``python scripts/check_metric_synonyms.py --help`` for details.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="检查指标同义词可推导的基础别名与口径别名（只读）")
    parser.add_argument("--config", type=Path, required=True, help="后端 backend.env/.env")
    parser.add_argument(
        "--backend-dir", type=Path, default=Path(__file__).resolve().parents[1],
        help="backend-next 目录；默认脚本所在项目",
    )
    parser.add_argument("--output", type=Path, help="完整报告 JSON 输出路径；省略时只打印摘要")
    return parser.parse_args()


def configure_backend(args: argparse.Namespace) -> None:
    source_dir = args.backend_dir.expanduser().resolve() / "src"
    if not (source_dir / "ask_metric").is_dir():
        raise SystemExit("--backend-dir 不正确，未找到 src/ask_metric")
    sys.path.insert(0, str(source_dir))
    from dotenv import dotenv_values

    config_file = args.config.expanduser().resolve()
    if not config_file.is_file():
        raise SystemExit("配置文件不存在，请核对 --config")
    for name, value in dotenv_values(config_file).items():
        if value is not None:
            os.environ[name] = value
    from ask_metric.core.config import get_settings
    from ask_metric.infrastructure.db.session import reset_database_runtime

    get_settings.cache_clear()
    reset_database_runtime()


def report(args: argparse.Namespace) -> int:
    from ask_metric.application.metric_alias_structure import (
        StructuredMetric,
        propose_alias_structure,
    )
    from ask_metric.infrastructure.db.session import get_app_session_factory
    from ask_metric.infrastructure.semantic.catalogs import SqlAlchemyMetricCatalogRepository

    session = get_app_session_factory()()
    try:
        items = SqlAlchemyMetricCatalogRepository(session).list_enabled()
    finally:
        session.rollback()
        session.close()
    metrics = [
        StructuredMetric(item.code, item.source_metric_code, item.base_name, item.value_basis)
        for item in items if item.source_metric_code and item.base_name and item.value_basis
    ]
    if not metrics:
        raise SystemExit("没有带源字段的启用指标：请先执行迁移 0005 并用目录同步回填源字段")
    result = propose_alias_structure(metrics, {item.code: list(item.aliases) for item in items})
    conflicts = [item for item in result["base_aliases"] if not item["approved"]]
    print(json.dumps({
        **result["stats"],
        "value_basis_aliases": [
            f"{item['alias']} → {item['value_basis']}" for item in result["value_basis_aliases"]
        ],
        "conflicting_base_aliases": sorted({item["alias"] for item in conflicts}),
    }, ensure_ascii=False, indent=2))
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"完整报告：{args.output}")
    return 0


def main() -> None:
    args = parse_args()
    configure_backend(args)
    try:
        result = report(args)
    except SystemExit:
        raise
    except Exception:
        raise SystemExit("检查失败：请核对配置、迁移 0005 与数据库可用性。") from None
    raise SystemExit(result)


if __name__ == "__main__":
    main()
