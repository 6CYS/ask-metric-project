"""位次角色、权限及双方言窗口边界；使用独立合成目录和事实。"""

import pytest
from pydantic import ValidationError

from ask_metric.application.ports import PermissionDeniedError
from ask_metric.core.errors import ApplicationError

from test_query_intent_v2 import COHORT, fixture, query
from test_query_ranking_contract_v2 import DIALECTS, execute_ranking


def position_query(**changes):
    return query(**{"operation": {"kind": "rank_position"},
                    "comparison_scope": {"org_codes": ["A", "B"]}, **changes})


def test_position_contract_preserves_roles_and_compiles_governed_universe():
    actor, service, uow, _ = fixture()
    spec = position_query()
    assert spec.query_shape == "metric_rank_position"
    dsl, plan, sql = service._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    assert dsl.orgs == ["A", "B"]
    assert plan.parameters["org_codes"] == ["A", "B"]
    assert plan.parameters["rank_subject_codes"] == ["A"]
    assert "rank_subject_codes" in sql
    # 已保存计划再次授权时仍读取两个可信角色来源。
    replay, _, _ = service._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=plan.dsl,
        query_shape=spec.query_shape, strict_codes=True,
    )
    assert replay.options["rank_subject_codes"] == ["A"]


@pytest.mark.parametrize("change", [
    {"comparison_scope": None},
    {"comparison_scope": {"org_codes": []}},
    {"operation": {"kind": "rank_position", "top_n": 1}},
    {"operation": {"kind": "rank_position", "position": "top"}},
    {"selection": "all_in_range"},
    {"operation": {"kind": "value"}},
])
def test_invalid_role_contract_rejected(change):
    with pytest.raises(ValidationError):
        query(**{"operation": {"kind": "rank_position"},
                 "comparison_scope": {"org_codes": ["A", "B"]}, **change})


def test_subject_outside_universe_is_not_silently_added():
    actor, service, uow, _ = fixture()
    spec = position_query(org_codes=["A1"])
    with pytest.raises(ApplicationError) as error:
        service._build_governed_plan(
            uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
            query_shape=spec.query_shape, strict_codes=True,
        )
    assert error.value.code == "SUBJECT_OUTSIDE_COMPARISON_SCOPE"


def test_comparison_permissions_are_rechecked_even_if_subject_is_authorized():
    actor, service, uow, _ = fixture("A")
    spec = position_query()
    with pytest.raises(PermissionDeniedError):
        service._build_governed_plan(
            uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
            query_shape=spec.query_shape, strict_codes=True,
        )


def test_comparison_governed_scope_fingerprint_and_membership():
    actor, service, uow, scope = fixture()
    spec = position_query(comparison_scope={
        "organization_scope": COHORT, "scope_fingerprint": scope["scope_fingerprint"],
    })
    _, plan, _ = service._build_governed_plan(
        uow=uow, actor=actor, logical_dsl=spec.to_logical_dsl().model_dump(mode="json"),
        query_shape=spec.query_shape, strict_codes=True,
    )
    assert plan.parameters["org_codes"] == ["A", "B"]
    service.org_hierarchy_provider.strict_snapshot = lambda: (_ for _ in ()).throw(
        ApplicationError("SCOPE_CHANGED", "合成变更"),
    )
    with pytest.raises(ApplicationError):
        service._authorize_query(uow=uow, actor=actor, logical_dsl=plan.dsl, strict_codes=True)


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("subjects", [("D",), ("B", "D")])
def test_subject_filter_runs_after_whole_population_ranking(dialect, subjects):
    rows = execute_ranking([
        ("M", "A", "2026-04-30", 40), ("M", "B", "2026-04-30", 30),
        ("M", "C", "2026-04-30", 20), ("M", "D", "2026-04-30", 10),
        ("M", "E", "2026-04-30", None), ("M", "X", "2026-04-30", 999),
    ], dialect, subjects=subjects, limit=1)
    actual = [row for row in rows if not row["rank_metadata"]]
    assert [(row["org_code"], row["rank"]) for row in actual] == [
        (code, {"B": 2, "D": 4}[code]) for code in subjects
    ]
    assert {row["rank_population"] for row in rows} == {4}


@pytest.mark.parametrize("dialect", DIALECTS)
def test_subject_missing_keeps_population_and_external_conflicts(dialect):
    facts = [("M", "A", "2026-04-30", 40), ("M", "B", "2026-04-30", 30)]
    rows = execute_ranking(facts, dialect, subjects=("E",))
    assert len(rows) == 1 and rows[0]["rank_metadata"] == 1
    assert rows[0]["rank_population"] == 2
    rows = execute_ranking([*facts, ("M", "B", "2026-04-30", 29)], dialect,
                           subjects=("E",))
    assert rows[0]["rank_data_conflict"] == 1


@pytest.mark.parametrize("dialect", DIALECTS)
def test_position_uses_shared_date_and_preserves_ordinal_sort(dialect):
    rows = execute_ranking([
        ("N", "A", "2026-04-30", 4), ("N", "B", "2026-04-30", 1),
        ("N", "C", "2026-04-29", 0),
    ], dialect, subjects=("A", "C"), mode="in_range", ordinal=("N",))
    actual = [row for row in rows if not row["rank_metadata"]]
    assert [(row["org_code"], row["rank"], row["stat_date"]) for row in actual] == [
        ("A", 2, "2026-04-30"),
    ]
