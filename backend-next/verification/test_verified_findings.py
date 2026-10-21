"""隔离样本验证判断编译，不把样本值当作真实机构数据。"""

from copy import deepcopy

import pytest

from ask_metric.application.verified_findings import (
    attach_analysis_findings,
    attach_overview_findings,
)


def overview():
    atoms = []
    for metric, values in {"personal": ("-2", "0.0893"), "company": ("3", "0.1733")}.items():
        for period, role, value, unit, encoding in [
            ("mom", "difference", values[0], "元", None),
            ("yoy", "rate", values[1], "%", "ratio"),
        ]:
            atoms.append(
                {
                    "ref": f"{metric}.{period}.{role}",
                    "value": value,
                    "unit": unit,
                    "value_encoding": encoding,
                    "date": "2026-08-27",
                }
            )
    return {"org_codes": ["sample-bank"], "analysis_date": "2026-08-27", "evidence_items": atoms}


def topic():
    return {
        "metrics": [
            {"id": "personal", "label": "个人存款"},
            {"id": "company", "label": "对公存款"},
        ],
        "relationships": [{"type": "classification", "children": ["personal", "company"]}],
    }


def test_compute_gap_before_prose_and_preserve_raw_inputs():
    value = overview()
    original = deepcopy(value["evidence_items"])
    result = attach_overview_findings(value, topic())
    gap = next(item for item in result["evidence_items"] if item.get("name") == "rate_gap")
    assert gap["value"] == "8.4000"
    assert gap["display"] == "8.40个百分点"
    assert gap["calculation"]["inputs"] == ["company.yoy.rate", "personal.yoy.rate"]
    assert gap["calculation"]["percent_scales"] == ["100", "100"]
    assert value["evidence_items"][: len(original)] == original
    finding = next(
        item for item in result["verified_findings"]["items"] if item["kind"] == "peer_rate_gap"
    )
    assert "对公存款高于个人存款" in finding["text"]
    assert "不代表增量贡献" in finding["text"]
    divergence = next(
        item
        for item in result["verified_findings"]["items"]
        if item["kind"] == "baseline_divergence"
    )
    assert "较上月减少、较同期增加" in divergence["text"]
    assert "不能据此认定增长加速" in divergence["text"]


@pytest.mark.parametrize(
    "change", ["date", "encoding", "unit", "relation", "organization", "source"]
)
def test_never_compute_peer_gap_without_compatible_scope_or_semantics(change):
    value, config = overview(), topic()
    right = next(atom for atom in value["evidence_items"] if atom["ref"] == "company.yoy.rate")
    if change == "date":
        right["date"] = "2026-07-31"
    elif change == "encoding":
        right["value_encoding"] = None
    elif change == "unit":
        right["unit"] = "元"
    elif change == "relation":
        config["relationships"] = []
    elif change == "organization":
        value["org_codes"].append("other-bank")
    else:
        config["metrics"][1]["source"] = "different-source"
    result = attach_overview_findings(value, config)
    assert not any(atom.get("name") == "rate_gap" for atom in result["evidence_items"])


def test_gap_uses_original_decimal_and_does_not_invent_gap_from_rounded_inputs():
    value = overview()
    value["evidence_items"][1]["value"] = "0.100049"
    value["evidence_items"][3]["value"] = "0.100051"
    result = attach_overview_findings(value, topic())
    gap = next(atom for atom in result["evidence_items"] if atom.get("name") == "rate_gap")
    assert gap["value"] == "0.000200"
    assert gap["display"] == "0.00个百分点"
    # 显示精度不足时不渲染“高于...相差0.00”的误导判断。
    assert not any("高于" in item["text"] for item in result["verified_findings"]["items"])


def test_general_without_domain_skill_supports_published_comparison_and_zero():
    result = attach_analysis_findings(
        {
            "metric_descriptors": [
                {"code": "fee_mom", "name": "业务及管理费用较上月", "value_basis": "较上月"},
                {"code": "fee_yoy", "name": "业务及管理费用较同期", "value_basis": "较同期"},
                {"code": "capital", "name": "资本充足率", "unit": "%"},
            ],
            "evidence_items": [
                {
                    "ref": "r1",
                    "metric_code": "fee_mom",
                    "value": "0",
                    "date": "2026-07-31",
                    "org_code": "bank",
                },
                {
                    "ref": "r2",
                    "metric_code": "fee_yoy",
                    "value": "-2",
                    "date": "2026-07-31",
                    "org_code": "bank",
                },
                {
                    "ref": "r3",
                    "metric_code": "capital",
                    "value": "0.17",
                    "date": "2026-07-31",
                    "org_code": "bank",
                },
            ],
        }
    )
    items = result["verified_findings"]["items"]
    assert any("较上月持平、较同期减少" in item["text"] for item in items)
    assert not any("资本" in item["text"] for item in items)
    assert not any(atom.get("name") == "rate_gap" for atom in result["evidence_items"])


def test_finding_identity_includes_org_date_and_output_is_bounded():
    first = attach_overview_findings(overview(), topic())["verified_findings"]
    assert first == attach_overview_findings(overview(), topic())["verified_findings"]
    other = overview()
    other["org_codes"] = ["other-bank"]
    assert not {item["ref"] for item in first["items"]} & {
        item["ref"]
        for item in attach_overview_findings(other, topic())["verified_findings"]["items"]
    }
    assert len(first["items"]) <= 8


def test_general_topics_with_same_metric_ids_never_merge_judgments():
    descriptors, atoms = [], []
    for topic_id, label, direction in [("loan", "贷款余额", "-1"), ("deposit", "存款余额", "1")]:
        for period in ["mom", "yoy"]:
            code = f"{topic_id}_{period}"
            descriptors.append(
                {
                    "code": code,
                    "name": label,
                    "analysis_hint": {
                        "topic": topic_id,
                        "metric_id": "total",
                        "comparison": period,
                        "comparison_role": "difference",
                    },
                }
            )
            atoms.append(
                {
                    "ref": code,
                    "metric_code": code,
                    "value": direction,
                    "org_code": "bank",
                    "date": "2026-08-27",
                }
            )
    result = attach_analysis_findings({"metric_descriptors": descriptors, "evidence_items": atoms})
    items = result["verified_findings"]["items"]
    assert len(items) == 2
    assert any(
        "贷款余额" in item["text"] and "较上月减少；较同期减少" in item["text"] for item in items
    )
    assert any(
        "存款余额" in item["text"] and "较上月增加；较同期增加" in item["text"] for item in items
    )
    assert all(len({ref.split("_")[0] for ref in item["evidence_refs"]}) == 1 for item in items)
