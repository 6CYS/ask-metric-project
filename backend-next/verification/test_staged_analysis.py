"""分阶段取证协议；隔离协议测试不连接业务数据。"""

from copy import deepcopy

import pytest
from pydantic import ValidationError

from ask_metric.domain.analysis_methods import AnalysisPlan


def staged_plan():
    return {"objective": "哪家收益最低，为什么", "scope_notice": "授权机构范围",
            "requirements": [{"id": "q1", "question": "哪家收益最低"},
                             {"id": "q2", "question": "该机构收益低的原因",
                              "deferred_reason": "先查排名，再对选中机构取证"}],
            "steps": [{"id": "s1", "method": "ranking", "metric_refs": ["k1"],
                       "answers": ["q1"], "rationale": "定位机构",
                       "position": "bottom", "top_n": 1}]}


def test_deferred_question_survives_without_becoming_a_data_gap():
    result = AnalysisPlan.model_validate(staged_plan())
    assert result.requirements[1].deferred_reason == "先查排名，再对选中机构取证"
    assert result.requirements[1].gap_reason is None


@pytest.mark.parametrize("change", ["gap", "empty", "blank", "answered"])
def test_deferred_question_requires_real_work_and_an_unambiguous_state(change):
    value = deepcopy(staged_plan())
    if change == "gap":
        value["requirements"][1]["gap_reason"] = "没有数据"
    elif change == "empty":
        value["steps"] = []
    elif change == "blank":
        value["requirements"][1]["deferred_reason"] = "  "
    else:
        value["steps"][0]["answers"].append("q2")
    with pytest.raises(ValidationError):
        AnalysisPlan.model_validate(value)
