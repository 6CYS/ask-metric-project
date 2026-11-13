"""源码目录或已安装应用包均可使用的配置迁移脚本入口。"""

import runpy
import sys
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "src"
if source.is_dir():
    sys.path.insert(0, str(source))
runpy.run_module("ask_metric.configuration_migration", run_name="__main__")
