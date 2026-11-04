"""源码运行与离线 wheel 安装共用的外置业务资源位置。"""

import os
from pathlib import Path


def runtime_config_dir() -> Path:
    # wheel 不携带现场配置；部署入口在导入应用前指定角色包中的只读资源目录。
    configured = os.environ.get("ASK_METRIC_RUNTIME_CONFIG_DIR", "").strip()
    if configured:
        path = Path(configured)
        if not path.is_absolute() or not path.is_dir():
            raise ValueError("ASK_METRIC_RUNTIME_CONFIG_DIR 必须是存在的绝对目录")
        return path
    return Path(__file__).resolve().parents[3] / "config"


def default_business_knowledge_path(config_dir: Path | None = None) -> Path:
    configured = os.environ.get("BUSINESS_KNOWLEDGE_PATH", "").strip()
    if configured:
        return Path(configured)
    return (config_dir or runtime_config_dir()) / "business-knowledge.json"
