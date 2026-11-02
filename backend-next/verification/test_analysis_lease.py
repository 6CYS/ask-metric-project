"""真实 ORM 状态转换回归；并发项只在显式配置的可丢弃 MySQL 测试库执行。"""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import pytest
from ask_metric.application.analysis_execution import GeneralAnalysisService
from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.base import Base
from ask_metric.infrastructure.db.models import ChatConversation, ChatMessage
from ask_metric.infrastructure.db.schema_governance import assert_disposable_test_database
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from test_inquiry_analysis import request, setup_service


@pytest.fixture
def lease_run(tmp_path):
    configured = os.environ.get("ASK_METRIC_LEASE_TEST_URL")
    url = make_url(configured or f"sqlite:///{tmp_path / 'leases.sqlite'}")
    if url.get_backend_name() != "sqlite":
        assert_disposable_test_database(url.render_as_string(hide_password=False))
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine)
    conversation_id = "lease-test-" + uuid4().hex
    actor = SimpleNamespace(subject=conversation_id, user_id=None)
    with sessions.begin() as session:
        session.add(
            ChatConversation(
                id=conversation_id,
                title="隔离租约回归",
                preview="",
                owner_user_id=None,
            )
        )
    _, semantics, _ = setup_service()
    payload = request(semantics, conversation_id=conversation_id)
    service = GeneralAnalysisService(
        SimpleNamespace(uow_factory=lambda: SqlAlchemyUnitOfWork(sessions)),
        None,
        None,
        secret="isolated",
    )
    run_id, original_lease, state = service._claim(payload, actor, "same-key", ["A"])
    # 只在本测试新建的记录中模拟进程失联；后续领取和保存使用实际事务实现。
    expired = (datetime.now(UTC) - timedelta(seconds=151)).isoformat()
    with sessions.begin() as session:
        record = session.get(ChatMessage, run_id)
        record.payload = {**record.payload, "updated_at": expired}
    try:
        yield service, payload, actor, run_id, original_lease, state, sessions, url
    finally:
        engine.dispose()


def test_recovered_lease_is_live_before_first_progress_save(lease_run):
    service, payload, actor, _, _, _, _, _ = lease_run
    _, _, resumed = service._claim(payload, actor, "same-key", ["A"])
    assert (datetime.now(UTC) - datetime.fromisoformat(resumed["updated_at"])).total_seconds() < 5
    with pytest.raises(ApplicationError) as caught:
        service._claim(payload, actor, "same-key", ["A"])
    assert caught.value.code == "ANALYSIS_RUNNING"


def test_only_current_lease_can_save_and_completed_run_cannot_be_reclaimed(lease_run):
    service, payload, actor, run_id, old_lease, old_state, sessions, _ = lease_run
    _, new_lease, state = service._claim(payload, actor, "same-key", ["A"])
    with pytest.raises(ApplicationError) as caught:
        service._save(run_id, old_lease, old_state)
    assert caught.value.code == "ANALYSIS_LEASE_CHANGED"
    state.update(status="completed", result={"run_ref": run_id})
    service._save(run_id, new_lease, state)
    _, lease, completed = service._claim(payload, actor, "same-key", ["A"])
    assert lease is None and completed["result"] == {"run_ref": run_id}
    with sessions() as session:
        assert session.get(ChatMessage, run_id).payload["lease"] == new_lease


@pytest.mark.database
def test_mysql_concurrent_recovery_has_one_owner(lease_run):
    service, payload, actor, _, _, _, _, url = lease_run
    if url.get_backend_name() != "mysql":
        pytest.skip("SQLite 不支持所需行锁；并发验收须使用可丢弃 MySQL 库")
    barrier = Barrier(2)

    def recover():
        barrier.wait(timeout=5)
        try:
            return service._claim(payload, actor, "same-key", ["A"])[1]
        except ApplicationError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: recover(), range(2)))
    assert results.count("ANALYSIS_RUNNING") == 1
    assert len(set(results)) == 2
