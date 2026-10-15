"""专项诊断反例：只调用当前纯函数，合成目录，不连接模型或数据库。

断言用于确认当前缺陷仍可复现，退出成功不代表业务实现已修复。
"""

import json
from datetime import date

from ask_metric.api.routes.tasks import SourceMetricBinding, SourceMetricSpan, _verify_metric_coverage
from ask_metric.application.field_resolution import resolve_date_field
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem

today = date(2026, 10, 14)
results = []

month_end = resolve_date_field("2026年1月末至2026年2月末", today)
explicit = resolve_date_field("2026-01-31至2026-02-28", today)
assert month_end["value"]["start"] == "2026-01-01"
assert explicit["value"]["start"] == "2026-01-31"
results.append({"id": "B06", "month_end_expression": month_end, "explicit_range": explicit,
                "bug_reproduced": True})

single = resolve_date_field("2026-1-1", today)
unpadded = resolve_date_field("2026-1-1至2026-2-1", today)
padded = resolve_date_field("2026-01-01至2026-02-01", today)
assert single["status"] == padded["status"] == "resolved"
assert unpadded["status"] == "invalid"
results.append({"id": "B10", "single": single, "unpadded_range": unpadded,
                "padded_range": padded, "bug_reproduced": True})

unsupported = resolve_date_field("近5年", today)
invalid = resolve_date_field("2026年2月30日", today)
assert unsupported == invalid == {"status": "invalid"}
results.append({"id": "B14", "unsupported_expression": unsupported,
                "invalid_calendar": invalid, "bug_reproduced": True})

question = "合成甲换成合成乙"
catalog = [MetricCatalogItem(code="A", name="合成甲"), MetricCatalogItem(code="B", name="合成乙")]
bindings = [SourceMetricBinding(start=5, end=8, text="合成乙", codes=["B"])]
try:
    _verify_metric_coverage(question, ["B"], catalog, bindings)
except ApplicationError as error:
    assert error.code == "METRIC_TARGETS_UNRESOLVED"
    rejected = error.code
else:
    raise AssertionError("缺少旧指标排除的反例未再复现，请重新审查")
_verify_metric_coverage(question, ["B"], catalog, bindings,
                        [SourceMetricSpan(start=0, end=3, text="合成甲")])
results.append({"id": "B08", "without_exclusion": rejected,
                "with_exclusion": "passed", "bug_reproduced": True})

print(json.dumps(results, ensure_ascii=False, indent=2))
