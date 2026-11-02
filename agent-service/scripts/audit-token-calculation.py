"""只读核对最终配对的所有正式计算及正文金额，不导出业务数值。"""
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import re

base = Path(__file__).resolve().parents[2] / "docs/verification/token-optimization-20261015"
report = json.loads((base / "paired-final-4.json").read_text())
work = Path("/private/tmp/ask-metric-token-optimization-20261015")
references = json.loads((work / "private-reference-results.json").read_text())
values = {row["target"]["start"]: Decimal(str(row["rows"][0]["metric_value"])) for row in references
          if row["target"]["metric"] == "ORG_CORP_AGRMT_DEPT_BAL" and row["target"]["org"] == "01"
          and row["target"]["start"] in ["2026-05-31", "2026-06-30"]}
difference = values["2026-06-30"] - values["2026-05-31"]
rows = []
for task in report["tasks"]:
    if task["case_id"] != "calculation-retains-model":
        continue
    native = next((work / "native-paired-final-4").rglob(f"*{task['session_id']}.jsonl"))
    records = []
    for line in native.read_text().splitlines():
        record = json.loads(line)
        records.extend(record if isinstance(record, list) else [record])
    entries = [row for row in records if row.get("kind") == "entry"]
    tools = [row for row in entries if row.get("message", {}).get("role") == "toolResult"]
    bodies, calculations = [], {}
    for entry in entries:
        message = entry.get("message", {})
        content = message.get("content", [])
        if message.get("role") == "assistant" and isinstance(content, list) and not any(row.get("type") == "toolCall" for row in content):
            bodies.append("".join(row.get("text", "") for row in content if row.get("type") == "text"))
    for entry in tools:
        evidence = entry["message"].get("details", {}).get("state", {}).get("evidence", {})
        for result in evidence.get("results", []):
            if "calculation_id" in result:
                calculations[result["calculation_id"]] = result
    body, plain = bodies[-1], bodies[-1].replace("**", "")
    money = []
    for match in re.finditer(r"([-+]?\d[\d,]*(?:\.\d+)?)\s*(万元|亿元|元)", plain):
        value = Decimal(match[1].replace(",", ""))
        factor = {"元": Decimal(1), "万元": Decimal(10000), "亿元": Decimal(100000000)}[match[2]]
        quantum = Decimal(1).scaleb(value.as_tuple().exponent)
        expected = [values["2026-05-31"], values["2026-06-30"], difference]
        money.append({"unit": match[2], "exact_scaled_match": any(value == row / factor for row in expected),
                      "display_rounding_match": any(value == (row / factor).quantize(quantum, rounding=ROUND_HALF_UP) for row in expected)})
    items = list(calculations.values())
    single = len(items) == 1 and len(items[0]["results"]) == 1
    result = items[0]["results"][0] if single else {}
    direction = "增加|上升|增长" if difference > 0 else "减少|下降|降低" if difference < 0 else "不变|持平"
    bindings = []
    for label, expected in [("2026年5月31日", values["2026-05-31"]), ("2026年6月30日", values["2026-06-30"]), ("六月末减五月末", difference)]:
        match = re.search(r"([-+]?\d[\d,]*(?:\.\d+)?)\s*(万元|亿元|元)", plain.split(label, 1)[1]) if label in plain else None
        supported = False
        if match:
            number = Decimal(match[1].replace(",", ""))
            factor = {"元": Decimal(1), "万元": Decimal(10000), "亿元": Decimal(100000000)}[match[2]]
            supported = number == (expected / factor).quantize(Decimal(1).scaleb(number.as_tuple().exponent), rounding=ROUND_HALF_UP)
        bindings.append({"label": label, "correct_labeled_value_and_unit": supported})
    row = {"version": task["version"], "session_id": task["session_id"], "native_sha256": hashlib.sha256(native.read_bytes()).hexdigest(),
           "model_calls": task["turns"][0]["model_calls"], "unique_formal_calculations": len(calculations),
           "formal_calculation_count_recorded": task["turns"][0]["calculation_count"], "all_calculation_statuses": [item["status"] for item in items],
           "one_expected_scalar_result": single, "exact_decimal_june_minus_may": single and Decimal(str(result["value"])) == difference,
           "unit_matches_reference": result.get("unit") == "元", "final_prose_money_mentions": money,
           "all_final_amounts_supported_by_formal_values": bool(money) and all(item["display_rounding_match"] for item in money),
           "final_exact_yuan_difference_present": any(Decimal(match[1].replace(",", "")) == difference for match in re.finditer(r"([-+]?\d[\d,]*(?:\.\d+)?)\s*元", plain)),
           "final_direction_correct": bool(re.search(direction, body)), "both_requested_dates_present": all(date in plain for date in ["2026年5月31日", "2026年6月30日"]),
           "final_amount_label_bindings": bindings, "all_final_amount_labels_correct": all(item["correct_labeled_value_and_unit"] for item in bindings),
           "final_body_sha256": hashlib.sha256(body.encode()).hexdigest(), "final_body_redacted": re.sub(r"[-+]?\d[\d,]*(?:\.\d+)?", "[数值]", body),
           "failed_interpretation_receipts": [[issue.get("code") for issue in entry["message"].get("details", {}).get("issues", [])]
                                             for entry in tools if entry["message"].get("details", {}).get("status") == "needs_interpretation"]}
    checks = ["one_expected_scalar_result", "exact_decimal_june_minus_may", "unit_matches_reference", "all_final_amounts_supported_by_formal_values",
              "final_exact_yuan_difference_present", "final_direction_correct", "both_requested_dates_present", "all_final_amount_labels_correct"]
    row["passed"] = all(row[key] for key in checks)
    rows.append(row)
output = {"scope": "Read-only all final-4 calculation receipts and final prose. No additional model/database calls; all money mentions checked, amounts excluded.",
          "rows": rows, "passed": all(row["passed"] for row in rows)}
(base / "final-4-calculation-review.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"passed": output["passed"], "versions": [{key: row[key] for key in ["version", "unique_formal_calculations", *checks, "passed"]} for row in rows]}, ensure_ascii=False))
