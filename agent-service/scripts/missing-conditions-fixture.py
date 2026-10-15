"""缺项循环回归：目录名可复现原问法，编码和数值全部为隔离合成数据。"""
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("semantic_fixture", Path(__file__).with_name("semantic-task-fixture.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.fixture.METRICS.append(bridge.fixture.MetricCatalogItem(
    code="SYNTH_DEPOSIT:D", name="对公协定存款余额当日数", base_name="对公协定存款余额",
    source_metric_code="SYNTH_DEPOSIT", value_basis="当日数", unit="元",
))

if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "value": bridge.main(json.load(sys.stdin))}, ensure_ascii=False, default=str))
    except Exception as error:
        print(json.dumps({"ok": False, "error": getattr(error, "code", type(error).__name__), "message": str(error)}, ensure_ascii=False))
