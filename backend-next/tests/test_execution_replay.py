"""执行重放回归：自然语言查询的幂等重放必须返回完整事实。

缺陷背景：``_result_summary`` 明确排除 ``rows``/``comparisons``，旧
``_execution_replay`` 只用摘要重建结果，重放时明细行与比较结果丢失；
修复要求统一从 state 中的 ResultArtifact 回读完整结果，
快照缺失时显式报错而不是用摘要伪造空表。
"""

from datetime import UTC, datetime

import pytest

from ask_metric.application.query_execution_service import (
    _execution_replay,
    _result_summary,
)
from ask_metric.domain.query_execution import QueryExecutionResult
from ask_metric.domain.result_context import ResultArtifact
from ask_metric.domain.task import QueryTaskState

_REQUEST_ID = "req-replay-1"


def _succeeded_result() -> QueryExecutionResult:
    return QueryExecutionResult(
        run_id=7,
        task_id="task-1",
        status="succeeded",
        query_shape="metric_value",
        columns=["org_name", "metric_value"],
        rows=[{"org_name": "无锡分行", "metric_value": "15147420074.00"}],
        comparisons=[{"left": "无锡分行", "right": "全省均值", "difference": "1024.50"}],
        row_count=1,
        message="查询完成，共返回 1 行。",
        task_version=3,
        task_status="SUCCEEDED",
    )


def _state_with_artifact() -> QueryTaskState:
    result = _succeeded_result()
    artifact = ResultArtifact(
        result_id="result:task-1",
        task_id="task-1",
        conversation_id="conv-1",
        owner_user_id="user-1",
        source_run_id=result.run_id,
        created_at=datetime.now(UTC),
        logical_dsl={},
        result=result.model_dump(mode="json", exclude={"debug"}),
    )
    state = QueryTaskState()
    state.execution = {
        "request_id": _REQUEST_ID,
        "run_id": result.run_id,
        "status": "succeeded",
        "summary": _result_summary(result),
    }
    state.result_artifact = artifact.model_dump(mode="json")
    return state


def test_replay_returns_full_rows_and_comparisons_from_artifact() -> None:
    """已成功执行的重放必须从不可变快照还原完整明细与比较结果。"""
    replay = _execution_replay(_state_with_artifact(), _REQUEST_ID)

    assert replay is not None
    assert replay.idempotent_replay is True
    assert replay.rows == [{"org_name": "无锡分行", "metric_value": "15147420074.00"}]
    assert replay.comparisons == [
        {"left": "无锡分行", "right": "全省均值", "difference": "1024.50"}
    ]
    assert replay.row_count == 1
    assert replay.message == "查询完成，共返回 1 行。"


def test_replay_without_matching_request_id_returns_none() -> None:
    """request_id 不匹配的调用不是重放，继续正常执行流程。"""
    assert _execution_replay(_state_with_artifact(), "other-request") is None


def test_replay_succeeded_without_snapshot_fails_explicitly() -> None:
    """已成功但快照缺失时明确报错，不允许用摘要伪造没有明细的“成功”。"""
    state = _state_with_artifact()
    state.result_artifact = None

    with pytest.raises(Exception) as excinfo:
        _execution_replay(state, _REQUEST_ID)
    assert getattr(excinfo.value, "code", None) == "RESULT_SNAPSHOT_MISSING"
