"""执行接口本身的真实准备/重放边界：旧排名实际机构同样复核。"""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from ask_metric.application.commands import ExecuteQueryCommand
from ask_metric.application.ports import ScopedOrganizationPermissionService
from ask_metric.application.query_execution_service import QueryExecutionApplicationService
from ask_metric.application.requests import ActorContext
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.domain.semantics import MetricCatalogItem, OrganizationCatalogItem
from ask_metric.domain.task import QueryTaskState


def replay_fixture(*, requested=("A",), actual="A", role="USER"):
    actor = ActorContext(
        subject="synthetic", user_id="u", org_id="A", role_code=role,
        authentication_method="test", trust_level="authenticated",
    )
    dsl = {"task": "metric_query", "metrics": ["M"], "orgs": list(requested),
           "time": {"start": "2026-04-30", "end": "2026-04-30"}}
    saved = {"task_id": "t", "status": "succeeded", "query_shape": "metric_ranking",
             "rows": [{"org_code": actual, "metric_value": 10}], "row_count": 1}
    state = QueryTaskState(logical_dsl=dsl)
    state.result_artifact = {"source_run_id": 1, "logical_dsl": dsl, "result": saved}
    state.execution = {"request_id": "r", "run_id": 1, "status": "succeeded", "summary": saved}
    task = SimpleNamespace(state_json=state.model_dump(mode="json"))

    class Uow:
        tasks = SimpleNamespace(get_owned_for_update=lambda *args: task)
        metric_catalog = SimpleNamespace(list_enabled=lambda: [
            MetricCatalogItem(code="M", name="合成指标"),
        ])
        organization_catalog = SimpleNamespace(list_enabled=lambda: [
            OrganizationCatalogItem(code="A", name="合成上级"),
            OrganizationCatalogItem(code="B", name="合成旧下级"),
        ])

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    datasource = Mock()
    service = QueryExecutionApplicationService(
        planner=QueryPlanner(dialect="mysql"), data_source=datasource,
        permission_service=ScopedOrganizationPermissionService(), uow_factory=Uow,
    )
    return service, ExecuteQueryCommand(
        task_id="t", expected_version=1, request_id="r", actor=actor,
    )


def test_execution_replay_of_authorized_snapshot_keeps_facts_without_sql():
    service, command = replay_fixture()
    result = service.execute(command)
    assert result.idempotent_replay is True
    assert result.rows == [{"org_code": "A", "metric_value": 10}]
    service.data_source.execute_readonly.assert_not_called()


@pytest.mark.parametrize("requested,actual", [(("B",), "B"), (("A",), "B")])
def test_execution_replay_rejects_revoked_condition_or_legacy_actual_child(requested, actual):
    service, command = replay_fixture(requested=requested, actual=actual)
    with pytest.raises(ApplicationError) as error:
        service.execute(command)
    assert error.value.code == "ORG_SCOPE_FORBIDDEN"
    service.data_source.execute_readonly.assert_not_called()


def test_execution_replay_unknown_historical_scope_is_not_unrestricted_admin_query():
    service, command = replay_fixture(requested=(), role="SYSTEM_ADMIN")
    with pytest.raises(ApplicationError) as error:
        service.execute(command)
    assert error.value.code == "RESULT_SCOPE_UNAVAILABLE"
    service.data_source.execute_readonly.assert_not_called()
