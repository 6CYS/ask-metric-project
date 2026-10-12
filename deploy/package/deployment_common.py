"""离线部署工具共用的环境加载及报告边界，不输出连接凭据。"""
from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path


def load_environment(config: Path) -> Path:
    from dotenv import dotenv_values

    config = config.resolve(strict=True)
    values = dotenv_values(config, interpolate=False)
    # Uvicorn 不覆盖继承的环境值；部署检查不能悄悄使用另一组值而给出假通过。
    conflicts = sorted(
        key for key, value in values.items()
        if value is not None and key in os.environ and os.environ[key] != value
    )
    if conflicts:
        raise ValueError("继承环境与配置冲突，请先清除这些变量：" + ", ".join(conflicts))
    for key, value in values.items():
        if value is not None:
            os.environ[key] = value
    return config


def require_database_config(config: Path) -> None:
    from dotenv import dotenv_values

    values = dotenv_values(config, interpolate=False)
    if str(values.get("NACOS_CONFIG_ENABLED") or "").lower() in {"true", "1", "yes"}:
        # 后续 get_settings 会从 Nacos 校验两个独立用途的连接，仍不创建或修改库。
        return
    if not values.get("APP_DATABASE_URL") or not values.get("QUERY_DATABASE_URL"):
        raise ValueError("必须在指定配置中填写 APP_DATABASE_URL 和 QUERY_DATABASE_URL")


def write_report(path: Path, operation: Callable[[], dict]) -> int:
    # 先排他创建报告，避免数据提交后才发现报告不可写；禁止覆盖既有执行记录。
    with path.open("x", encoding="utf-8") as output:
        try:
            report = operation()
        except Exception as exc:
            report = {"status": "FAILED", "error_type": type(exc).__name__}
            # 数据问题仅记录已确认安全的结构字段，不输出数据库异常正文。
            if type(exc).__name__ == "MetricUnitError":
                report["unresolved_units"] = exc.names
            if type(exc).__name__ == "OrganizationScopeError":
                report["outside_scope_codes"] = exc.codes
            report["hint"] = "核对输入、单位映射、目录名称、数据库权限和配置；未输出原始异常"
        json.dump(report, output, ensure_ascii=False, indent=2)
    print(json.dumps({"status": report["status"], "report": str(path)}, ensure_ascii=False))
    return 0 if report["status"] == "PASS" else 2
