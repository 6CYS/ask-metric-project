"""本地合成目录选型验证；不调用任何模型、网络或业务数据库。"""

import json
import platform
import random
import statistics
import sys
from pathlib import Path
from time import perf_counter

from ask_metric.application.metric_candidates import metric_candidate_index
from ask_metric.domain.semantic_engine import _lexical_metric_candidates
from ask_metric.domain.semantics import MetricCatalogItem

CASES = [
    ("完整名称", "查询省联社2026年3月31日贷款余额当日数。", "D"),
    ("完整别名", "查询合成机构2026年6月末存款日均", "S"),
    ("错别字", "查询省联社2026年3月31日贷款讯额当日数", "D"),
    ("同音字", "查询贷款余额当日树", "D"),
    ("同音字", "查询合成机构去年存款余鹅月日均", "S"),
    ("错别字", "合成客护风险比率", "R"),
    ("描述", "本月每天的存款平均值是多少", "S"),
    ("描述", "存在风险的客户占全部客户多少比例", "R"),
]


def run(size=10000):
    items = [
        MetricCatalogItem(code="D", name="贷款余额当日数"),
        MetricCatalogItem(code="T", name="各项贷款余额", aliases=["贷款余额"]),
        MetricCatalogItem(
            code="S",
            name="存款余额月日均",
            aliases=["存款日均"],
            description="本月每天存款余额的平均值",
        ),
        MetricCatalogItem(
            code="R",
            name="合成客户风险比率",
            aliases=["合成风险率"],
            description="存在风险的客户占全部客户的比例",
        ),
    ]
    rng = random.Random(20260921)
    # 干扰项刻意共享金融字符，避免随机数字编码导致过于容易的匹配基准。
    chars = "余额存贷款日月年客户风险资产负债收益成本数量比例账户交易结算业务经营统计"
    for i in range(size - len(items)):
        items.append(
            MetricCatalogItem(code=f"SYN{i}", name="合成" + "".join(rng.choices(chars, k=9)))
        )
    started = perf_counter()
    index = metric_candidate_index(items)
    build_ms = (perf_counter() - started) * 1000
    results = []
    engines = {
        "old_whole_question_sequence_matcher": lambda q: [
            candidate.item.code for candidate in _lexical_metric_candidates(q, items, limit=5)
        ],
        "hanlp_trie_exact_only": lambda q: [
            code for match in index.exact(q) for code in match["codes"]
        ],
        "hanlp_trie_pinyin_rapidfuzz_description": lambda q: list(
            dict.fromkeys(
                code
                for mention in index.mentions(q)
                for code in (
                    mention["resolution"].get("value", {}).get("codes", [])
                    + [c["code"] for c in mention["resolution"].get("candidates", [])]
                )
            )
        )[:5],
    }
    for name, function in engines.items():
        timings = []
        cases = []
        for kind, question, expected in CASES:
            codes = []
            for _ in range(5):
                start = perf_counter()
                codes = function(question)
                timings.append((perf_counter() - start) * 1000)
            cases.append(
                {
                    "kind": kind,
                    "question": question,
                    "expected": expected,
                    "top5": codes[:5],
                    "hit": expected in codes[:5],
                }
            )
        results.append(
            {
                "engine": name,
                "hit_at_5": sum(c["hit"] for c in cases),
                "cases": len(cases),
                "p50_ms": round(statistics.median(timings), 3),
                "p95_ms": round(sorted(timings)[int(len(timings) * 0.95) - 1], 3),
                "details": cases,
            }
        )
    return {
        "environment": "synthetic_catalog_no_model_no_database",
        "python": platform.python_version(),
        "machine": platform.machine(),
        "catalog_size": size,
        "index_build_ms": round(build_ms, 3),
        "results": results,
        "limitations": [
            "合成小样本不代表真实目录准确率",
            "未测试完整 HanLP 神经模型",
            "延迟不包含数据库读取、HTTP 和问答模型耗时",
        ],
    }


if __name__ == "__main__":
    report = run()
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/metric-matching-benchmark.json")
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {
                "report": str(output),
                "catalog_size": report["catalog_size"],
                "index_build_ms": report["index_build_ms"],
                "results": [
                    {k: v for k, v in r.items() if k != "details"} for r in report["results"]
                ],
            },
            ensure_ascii=False,
        )
    )
