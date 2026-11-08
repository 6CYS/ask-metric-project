"""独立目录维护入口：使用应用现有配置，不安装、启停服务或修改配置中心。"""
from __future__ import annotations

import sys


def run(command: str, argv: list[str] | None = None) -> None:
    from ask_metric.__main__ import main

    main([command, *(sys.argv[1:] if argv is None else argv)])
