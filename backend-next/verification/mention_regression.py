"""真实目录的 mention 抽取回归基线：只读业务库，不调用模型，不做任何写入。

语料来自 ../docs/acceptance/**/*.json 中的真实问句（steps[].message 及同类的
message/question 字符串字段），解析失败的文件跳过。用法：

    .venv/bin/python verification/mention_regression.py --out <报告路径> [--baseline <旧报告>]
"""

import argparse
import glob
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from sqlalchemy.orm import Session  # noqa: E402

from ask_metric.application.metric_candidates import metric_candidate_index  # noqa: E402
from ask_metric.infrastructure.db.session import get_metric_catalog_engine  # noqa: E402
from ask_metric.infrastructure.semantic.catalogs import (  # noqa: E402
    SqlAlchemyMetricCatalogRepository,
)

ACCEPTANCE_GLOB = str(
    Path(__file__).resolve().parent.parent.parent / "docs" / "acceptance" / "**" / "*.json"
)
# 真实问句出现的字段名：steps[].message、turns[].question、browser-prompts 的 message 等。
QUESTION_KEYS = ("message", "question")


def collect_questions() -> tuple[list[str], list[str]]:
    """递归收集验收文档中的真实问句，按首次出现顺序去重；返回 (问句, 解析失败文件)。"""
    questions: dict[str, None] = {}
    skipped: list[str] = []
    for path in sorted(glob.glob(ACCEPTANCE_GLOB, recursive=True)):
        try:
            with open(path, encoding="utf-8") as handle:
                document = json.load(handle)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
            skipped.append(f"{path}: {error}")
            continue

        def walk(node: object) -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    if key in QUESTION_KEYS and isinstance(value, str) and value.strip():
                        questions.setdefault(value.strip())
                    else:
                        walk(value)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(document)
    return list(questions), skipped


def load_index():
    engine = get_metric_catalog_engine()
    with Session(engine) as session:
        items = SqlAlchemyMetricCatalogRepository(session).list_enabled()
    return metric_candidate_index(items), len(items)


def build_report() -> dict:
    questions, skipped = collect_questions()
    index, catalog_size = load_index()
    records = []
    for question in questions:
        mentions = [
            {
                "text": mention["text"],
                "start": mention["start"],
                "end": mention["end"],
                "status": mention["resolution"]["status"],
                "codes": mention["resolution"].get("value", {}).get("codes", [])
                or [candidate["code"] for candidate in mention["resolution"].get("candidates", [])],
            }
            for mention in index.mentions(question)
        ]
        records.append({"question": question, "mentions": mentions})
    return {
        "corpus": {
            "source": ACCEPTANCE_GLOB,
            "question_keys": list(QUESTION_KEYS),
            "question_count": len(records),
            "skipped_files": skipped,
            "catalog_enabled_size": catalog_size,
        },
        "records": records,
    }


def _mention_keys(record: dict) -> dict[tuple, dict]:
    """以 (start, end, text) 定位 mention，用于跨报告对齐。"""
    return {(m["start"], m["end"], m["text"]): m for m in record["mentions"]}


def diff_reports(before: dict, after: dict) -> dict:
    before_by_q = {record["question"]: record for record in before["records"]}
    after_by_q = {record["question"]: record for record in after["records"]}
    added, removed, status_changed = [], [], []
    for question, record in after_by_q.items():
        old = _mention_keys(before_by_q.get(question, {"mentions": []}))
        new = _mention_keys(record)
        for key, mention in new.items():
            if key not in old:
                added.append({"question": question, "mention": mention})
            elif old[key]["status"] != mention["status"] or old[key]["codes"] != mention["codes"]:
                status_changed.append(
                    {"question": question, "before": old[key], "after": mention}
                )
        for key, mention in old.items():
            if key not in new:
                removed.append({"question": question, "mention": mention})
    return {
        "summary": {
            "questions_before": len(before_by_q),
            "questions_after": len(after_by_q),
            "added_mentions": len(added),
            "removed_mentions": len(removed),
            "status_changed_mentions": len(status_changed),
            "questions_with_added_mentions": len({item["question"] for item in added}),
        },
        "added": added,
        "removed": removed,
        "status_changed": status_changed,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="报告输出路径（JSON）")
    parser.add_argument("--baseline", help="旧报告路径；提供时输出 diff 到 stdout 并随报告存档")
    args = parser.parse_args()

    report = build_report()
    if args.baseline:
        with open(args.baseline, encoding="utf-8") as handle:
            baseline = json.load(handle)
        report["diff"] = diff_reports(baseline, report)
        print(json.dumps(report["diff"]["summary"], ensure_ascii=False, indent=2))
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"questions={report['corpus']['question_count']} "
          f"catalog={report['corpus']['catalog_enabled_size']} -> {output}")


if __name__ == "__main__":
    main()
