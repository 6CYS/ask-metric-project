"""Synchronous SQLAlchemy LangGraph saver for the existing MySQL/GoldenDB route.

No DDL at runtime. Task ownership is checked by the service before constructing
this thread-bound saver. Full checkpoints, parent references and pending writes
are retained; no DeltaChannel/pruning/copy APIs are used by the MVP graph.
"""

import base64
import hashlib
from threading import RLock
from time import time

from langgraph.checkpoint.base import WRITES_IDX_MAP, BaseCheckpointSaver, CheckpointTuple
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from ask_metric.infrastructure.db.models import AnalysisCheckpoint, AnalysisThread


class CheckpointConflict(RuntimeError):
    pass


class SqlAlchemyAnalysisSaver(BaseCheckpointSaver):
    def __init__(self, session_factory, thread_id, lease_token=None):
        super().__init__()
        self.factory = session_factory
        self.thread_id = thread_id
        self.lease_token = lease_token
        self.lock = RLock()

    def _fence(self, session):
        if self.lease_token is None:
            return
        row = session.scalar(select(AnalysisThread).where(
            AnalysisThread.id == self.thread_id).with_for_update())
        if row is None or row.lease_token != self.lease_token or row.lease_until <= time():
            raise CheckpointConflict("执行租约失效，禁止写入检查点")

    def _scope(self, config):
        value = config["configurable"]
        if value["thread_id"] != self.thread_id:
            raise PermissionError("检查点线程归属不匹配")
        return value.get("checkpoint_ns", ""), value.get("checkpoint_id")

    def _pack(self, value):
        kind, data = self.serde.dumps_typed(value)
        return [kind, base64.b64encode(data).decode("ascii")]

    def _unpack(self, value):
        return self.serde.loads_typed((value[0], base64.b64decode(value[1])))

    def _config(self, ns, checkpoint_id):
        return {
            "configurable": {
                "thread_id": self.thread_id,
                "checkpoint_ns": ns,
                "checkpoint_id": checkpoint_id,
            }
        }

    def _key(self, ns, checkpoint_id):
        return hashlib.sha256(f"{self.thread_id}\0{ns}\0{checkpoint_id}".encode()).hexdigest()

    def _tuple(self, row):
        data = row.payload
        return CheckpointTuple(
            self._config(row.namespace, row.checkpoint_id),
            self._unpack(data["checkpoint"]),
            self._unpack(data["metadata"]),
            self._config(row.namespace, data["parent"]) if data["parent"] else None,
            [
                (w["task_id"], w["channel"], self._unpack(w["value"]))
                for _, w in sorted((row.writes or {}).items())
            ],
        )

    def get_tuple(self, config):
        ns, checkpoint_id = self._scope(config)
        with self.factory() as session:
            query = select(AnalysisCheckpoint).where(
                AnalysisCheckpoint.thread_id == self.thread_id,
                AnalysisCheckpoint.namespace == ns,
            )
            if checkpoint_id:
                query = query.where(AnalysisCheckpoint.checkpoint_id == checkpoint_id)
            for row in session.scalars(query.order_by(AnalysisCheckpoint.checkpoint_id.desc())):
                if row.payload:
                    return self._tuple(row)
            return None

    def list(self, config, *, filter=None, before=None, limit=None):
        ns, _ = self._scope(config or self._config("", None))
        with self.factory() as session:
            query = (
                select(AnalysisCheckpoint)
                .where(
                    AnalysisCheckpoint.thread_id == self.thread_id,
                    AnalysisCheckpoint.namespace == ns,
                )
                .order_by(AnalysisCheckpoint.checkpoint_id.desc())
            )
            if before:
                _, checkpoint_id = self._scope(before)
                query = query.where(AnalysisCheckpoint.checkpoint_id < checkpoint_id)
            count = 0
            for row in session.scalars(query):
                if not row.payload:
                    continue
                item = self._tuple(row)
                if filter and any(item.metadata.get(k) != v for k, v in filter.items()):
                    continue
                if limit is not None and count >= limit:
                    break
                count += 1
                yield item

    def put(self, config, checkpoint, metadata, new_versions):
        ns, parent = self._scope(config)
        key = self._key(ns, checkpoint["id"])
        payload = {
            "checkpoint": self._pack(checkpoint),
            "metadata": self._pack(metadata),
            "parent": parent,
        }
        with self.lock, self.factory() as session:
            self._fence(session)
            existing = session.get(AnalysisCheckpoint, key)
            if existing:
                if existing.payload and existing.payload != payload:
                    raise CheckpointConflict("同一检查点身份不能覆盖不同内容")
                existing.payload = payload
            else:
                session.add(
                    AnalysisCheckpoint(
                        id=key,
                        thread_id=self.thread_id,
                        namespace=ns,
                        checkpoint_id=checkpoint["id"],
                        payload=payload,
                        writes={},
                        revision=0,
                    )
                )
            try:
                session.commit()
            except IntegrityError as exc:
                raise CheckpointConflict("检查点并发写冲突") from exc
        return self._config(ns, checkpoint["id"])

    def put_writes(self, config, writes, task_id, task_path=""):
        ns, checkpoint_id = self._scope(config)
        with self.lock, self.factory() as session:
            self._fence(session)
            row = session.get(AnalysisCheckpoint, self._key(ns, checkpoint_id))
            if row is None:
                # LangGraph may submit pending writes before the checkpoint put future.
                row = AnalysisCheckpoint(
                    id=self._key(ns, checkpoint_id),
                    thread_id=self.thread_id,
                    namespace=ns,
                    checkpoint_id=checkpoint_id,
                    payload={},
                    writes={},
                    revision=0,
                )
                session.add(row)
                session.flush()
            values = dict(row.writes or {})
            for index, (channel, value) in enumerate(writes):
                idx = WRITES_IDX_MAP.get(channel, index)
                key = f"{task_id}:{idx}"
                if key in values and idx >= 0:
                    continue
                values[key] = {
                    "task_id": task_id,
                    "channel": channel,
                    "value": self._pack(value),
                    "task_path": task_path,
                }
            result = session.execute(
                update(AnalysisCheckpoint)
                .where(
                    AnalysisCheckpoint.id == row.id,
                    AnalysisCheckpoint.revision == row.revision,
                )
                .values(writes=values, revision=row.revision + 1)
            )
            if result.rowcount != 1:
                raise CheckpointConflict("pending writes并发冲突")
            session.commit()

    def delete_thread(self, thread_id):
        if thread_id != self.thread_id:
            raise PermissionError("检查点线程归属不匹配")
        with self.factory() as session:
            session.execute(
                delete(AnalysisCheckpoint).where(AnalysisCheckpoint.thread_id == thread_id)
            )
            session.execute(delete(AnalysisThread).where(AnalysisThread.id == thread_id))
            session.commit()
