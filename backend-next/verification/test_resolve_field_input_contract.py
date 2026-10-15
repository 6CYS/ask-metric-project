"""机构建议通道合并后，保留指标/日期原值的准入合同；不连接数据库。"""

import pytest
from pydantic import ValidationError

from ask_metric.api.routes.business_context import ResolveFieldRequest


@pytest.mark.parametrize("entity", ["metric", "date"])
def test_suggestions_cannot_replace_metric_or_date_raw_values(entity):
    with pytest.raises(ValidationError, match="raw_values"):
        ResolveFieldRequest.model_validate({
            "entity": entity, "suggested": [{"code": "SYNTH_ORG"}],
        })


@pytest.mark.parametrize("entity,raw", [("metric", "合成指标"), ("date", "2026-05-31")])
def test_existing_nonempty_raw_values_remain_admissible(entity, raw):
    request = ResolveFieldRequest.model_validate({"entity": entity, "raw_values": [raw]})
    assert request.raw_values == [raw]


def test_organization_can_still_use_the_suggestion_channel():
    request = ResolveFieldRequest.model_validate({
        "entity": "organization", "suggested": [{"code": "SYNTH_ORG"}],
    })
    assert request.suggested[0].code == "SYNTH_ORG"


def test_organization_without_raw_values_or_suggestions_is_invalid():
    with pytest.raises(ValidationError):
        ResolveFieldRequest.model_validate({"entity": "organization"})
