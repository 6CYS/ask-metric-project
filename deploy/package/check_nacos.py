"""只读诊断 Nacos 配置加载；不创建业务资源，不输出配置内容或凭据。"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from ask_metric.core.config import get_settings
from ask_metric.infrastructure.config_center.nacos import ConfigCenterError
from dotenv import dotenv_values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    try:
        config = args.config.resolve(strict=True)
        values = {
            key: value for key, value in dotenv_values(config, interpolate=False).items()
            if value is not None
        }
        conflicts = sorted(
            key for key, value in values.items()
            if key in os.environ and os.environ[key] != value
        )
        if conflicts:
            print("FAIL: 继承环境与配置冲突：" + ", ".join(conflicts))
            return 2
        if values.get("NACOS_CONFIG_ENABLED", "").lower() not in {"true", "1", "yes"}:
            print("FAIL: backend.env 未启用 NACOS_CONFIG_ENABLED")
            return 2
        os.environ.update(values)
        get_settings.cache_clear()
        get_settings()
    except ConfigCenterError as exc:
        # 配置适配器的异常已脱敏，只包含阶段、字段或 Data ID。
        print(f"FAIL: {exc}")
        return 2
    except Exception as exc:  # noqa: BLE001 — CLI 最外层只输出异常类型，避免第三方异常泄露配置。
        print("FAIL: " + type(exc).__name__ + "（未输出异常原文或配置内容）")
        return 2
    print("PASS: Nacos 配置读取与应用校验通过；未连接数据库或调用模型。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
