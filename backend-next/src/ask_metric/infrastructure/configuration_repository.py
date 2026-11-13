"""配置发布采用条件更新；当前版本、历史与业务投影在同一短事务内提交。"""

import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from threading import RLock
from typing import Any
from uuid import uuid4

from sqlalchemy import Connection, Engine, insert, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from ask_metric.core.errors import ApplicationError
from ask_metric.infrastructure.db.configuration import config_resources, config_versions


@dataclass(frozen=True)
class ConfigSnapshot:
    resource_key: str
    id: str
    version_number: int
    format_version: int
    revision: str
    content: str
    created_ms: int
    created_by: str
    action: str
    source_version_id: str | None = None

    def document(self) -> dict[str, Any]:
        document: dict[str, Any] = json.loads(self.content)
        return document


Projection = Callable[[Connection, ConfigSnapshot], None]


def serialize_document(document: dict[str, Any]) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def _missing() -> ApplicationError:
    return ApplicationError(
        "CONFIG_NOT_INITIALIZED",
        "配置尚未导入数据库，请联系管理员。",
        status_code=503,
    )


def _conflict() -> ApplicationError:
    return ApplicationError(
        "CONFIG_VERSION_CONFLICT",
        "配置已被更新，请刷新后重新编辑。",
        status_code=409,
    )


def _unavailable() -> ApplicationError:
    return ApplicationError(
        "CONFIG_STORAGE_UNAVAILABLE",
        "配置存储暂不可用，请稍后重试。",
        status_code=503,
    )


class DatabaseConfigRepository:
    def __init__(self, engine: Engine):
        self.engine = engine

    def read(self, key: str) -> ConfigSnapshot:
        try:
            with self.engine.connect() as connection:
                row = (
                    connection.execute(
                        select(config_versions)
                        .join(
                            config_resources,
                            config_resources.c.current_version_id == config_versions.c.id,
                        )
                        .where(config_resources.c.resource_key == key)
                    )
                    .mappings()
                    .first()
                )
                if row is None:
                    raise _missing()
                return ConfigSnapshot(**row)
        except SQLAlchemyError as error:
            raise _unavailable() from error

    def current_version(self, key: str) -> str:
        try:
            with self.engine.connect() as connection:
                value = connection.scalar(
                    select(config_resources.c.current_version_id).where(
                        config_resources.c.resource_key == key,
                    )
                )
                if value is None:
                    raise _missing()
                if not isinstance(value, str):
                    raise _unavailable()
                return value
        except SQLAlchemyError as error:
            raise _unavailable() from error

    def read_many(self, keys: list[str]) -> dict[str, ConfigSnapshot]:
        """同一 SQL 快照读取多个资源，避免一个请求混用发布前后的提示词。"""
        if not keys:
            return {}
        try:
            with self.engine.connect() as connection:
                result = {
                    row["resource_key"]: ConfigSnapshot(**row)
                    for row in connection.execute(
                        select(config_versions)
                        .join(
                            config_resources,
                            config_resources.c.current_version_id == config_versions.c.id,
                        )
                        .where(config_resources.c.resource_key.in_(keys)),
                    ).mappings()
                }
            if set(result) != set(keys):
                raise _missing()
            return result
        except SQLAlchemyError as error:
            raise _unavailable() from error

    def initialize_history(
        self,
        key: str,
        resource_type: str,
        versions: list[ConfigSnapshot],
    ) -> ConfigSnapshot:
        """受控迁移保留已有历史身份；不用于在线发布，不覆盖已有资源。"""
        if not versions:
            raise ValueError("导入历史不能为空")
        previous = 0
        known: set[str] = set()
        for item in versions:
            checked = self._snapshot(
                key,
                item.content,
                item.created_by,
                item.version_number,
                item.action,
                item.source_version_id,
            )
            if (
                item.resource_key != key
                or item.version_number <= previous
                or not item.id
                or len(item.id) > 36
                or item.id in known
                or item.format_version != 1
                or item.revision != checked.revision
                or item.created_ms < 0
                or item.action not in {"publish", "rollback", "import"}
                or (item.source_version_id is not None and item.source_version_id not in known)
            ):
                raise ValueError("导入历史版本身份、顺序或来源无效")
            known.add(item.id)
            previous = item.version_number
        current = versions[-1]
        try:
            with self.engine.begin() as connection:
                existing = connection.scalar(
                    select(config_resources.c.current_version_id).where(
                        config_resources.c.resource_key == key,
                    )
                )
                if existing is not None:
                    saved = [
                        ConfigSnapshot(**row)
                        for row in connection.execute(
                            select(config_versions)
                            .where(config_versions.c.resource_key == key)
                            .order_by(config_versions.c.version_number),
                        ).mappings()
                    ]
                    if saved != versions or existing != current.id:
                        raise _conflict()
                    return current
                connection.execute(
                    insert(config_resources).values(
                        resource_key=key,
                        resource_type=resource_type,
                        current_version_id=current.id,
                        default_version_id=versions[0].id,
                        version_number=current.version_number,
                        revision=current.revision,
                    )
                )
                connection.execute(insert(config_versions), [item.__dict__ for item in versions])
                return current
        except IntegrityError as error:
            raise _conflict() from error
        except SQLAlchemyError as error:
            raise _unavailable() from error

    def initialize(
        self,
        key: str,
        resource_type: str,
        content: str,
        *,
        actor: str,
        projection: Projection | None = None,
        default_content: str | None = None,
    ) -> ConfigSnapshot:
        default = self._snapshot(
            key,
            default_content if default_content is not None else content,
            actor,
            1,
            "import",
        )
        snapshot = (
            default
            if default.content == content
            else self._snapshot(key, content, actor, 2, "import", default.id)
        )
        try:
            with self.engine.begin() as connection:
                existing = connection.scalar(
                    select(config_resources.c.revision).where(
                        config_resources.c.resource_key == key,
                    )
                )
                if existing is not None:
                    if existing != snapshot.revision:
                        raise _conflict()
                else:
                    connection.execute(
                        insert(config_resources).values(
                            resource_key=key,
                            resource_type=resource_type,
                            current_version_id=snapshot.id,
                            default_version_id=default.id,
                            version_number=snapshot.version_number,
                            revision=snapshot.revision,
                        )
                    )
                    connection.execute(insert(config_versions).values(**default.__dict__))
                    if snapshot.id != default.id:
                        connection.execute(insert(config_versions).values(**snapshot.__dict__))
                    if projection is not None:
                        projection(connection, snapshot)
                    return snapshot
        except IntegrityError:
            # 首次导入可以由不同节点同时发起，但绝不能覆盖已存在的人工版本。
            current = self.read(key)
            if current.revision != snapshot.revision:
                raise _conflict() from None
            return current
        except SQLAlchemyError as error:
            raise _unavailable() from error
        return self.read(key)

    def publish(
        self,
        key: str,
        content: str,
        *,
        expected_revision: str,
        actor: str,
        action: str = "publish",
        source_version_id: str | None = None,
        projection: Projection | None = None,
    ) -> ConfigSnapshot:
        try:
            with self.engine.begin() as connection:
                head = (
                    connection.execute(
                        select(config_resources).where(
                            config_resources.c.resource_key == key,
                        )
                    )
                    .mappings()
                    .first()
                )
                if head is None:
                    raise _missing()
                if head["revision"] != expected_revision:
                    raise _conflict()
                snapshot = self._snapshot(
                    key,
                    content,
                    actor,
                    head["version_number"] + 1,
                    action,
                    source_version_id,
                )
                changed = connection.execute(
                    update(config_resources)
                    .where(
                        config_resources.c.resource_key == key,
                        config_resources.c.version_number == head["version_number"],
                    )
                    .values(
                        current_version_id=snapshot.id,
                        revision=snapshot.revision,
                        version_number=snapshot.version_number,
                    )
                )
                if changed.rowcount != 1:
                    raise _conflict()
                connection.execute(insert(config_versions).values(**snapshot.__dict__))
                if projection is not None:
                    projection(connection, snapshot)
                return snapshot
        except SQLAlchemyError as error:
            raise _unavailable() from error

    def versions(self, key: str) -> list[ConfigSnapshot]:
        try:
            with self.engine.connect() as connection:
                return [
                    ConfigSnapshot(**row)
                    for row in connection.execute(
                        select(config_versions)
                        .where(config_versions.c.resource_key == key)
                        .order_by(config_versions.c.version_number.desc()),
                    ).mappings()
                ]
        except SQLAlchemyError as error:
            raise _unavailable() from error

    def restore(
        self,
        key: str,
        version_id: str,
        *,
        expected_revision: str,
        actor: str,
        projection: Projection | None = None,
    ) -> ConfigSnapshot:
        version = self.version(key, version_id)
        return self.publish(
            key,
            version.content,
            expected_revision=expected_revision,
            actor=actor,
            action="rollback",
            source_version_id=version.id,
            projection=projection,
        )

    def version(self, key: str, version_id: str) -> ConfigSnapshot:
        try:
            with self.engine.connect() as connection:
                row = (
                    connection.execute(
                        select(config_versions).where(
                            config_versions.c.resource_key == key,
                            config_versions.c.id == version_id,
                        )
                    )
                    .mappings()
                    .first()
                )
                if row is None:
                    raise ApplicationError(
                        "CONFIG_VERSION_NOT_FOUND",
                        "配置版本不存在。",
                        status_code=404,
                    )
                return ConfigSnapshot(**row)
        except SQLAlchemyError as error:
            raise _unavailable() from error

    def default(self, key: str) -> ConfigSnapshot:
        try:
            with self.engine.connect() as connection:
                version_id = connection.scalar(
                    select(config_resources.c.default_version_id).where(
                        config_resources.c.resource_key == key,
                    )
                )
                if version_id is None:
                    raise _missing()
            return self.version(key, version_id)
        except SQLAlchemyError as error:
            raise _unavailable() from error

    @staticmethod
    def _snapshot(
        key: str,
        content: str,
        actor: str,
        number: int,
        action: str,
        source_version_id: str | None = None,
    ) -> ConfigSnapshot:
        document = json.loads(content, parse_constant=lambda value: _invalid_number(value))
        if not isinstance(document, dict):
            raise ValueError("配置文档须为对象")
        if not key or len(key) > 190 or not actor or len(actor) > 128:
            raise ValueError("配置标识或修改人无效")
        return ConfigSnapshot(
            resource_key=key,
            id=str(uuid4()),
            version_number=number,
            format_version=1,
            revision=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            content=content,
            created_ms=time.time_ns() // 1_000_000,
            created_by=actor,
            action=action,
            source_version_id=source_version_id,
        )


def _invalid_number(value: str):
    raise ValueError(f"配置不能包含非有限数值：{value}")


class VersionedConfigCache:
    """缓存正文但核对共享版本；数据库异常不伪装为仍然成功读取旧配置。"""

    def __init__(self, repository: DatabaseConfigRepository, *, max_entries: int = 64):
        if max_entries < 1:
            raise ValueError("配置缓存容量须为正数")
        self.repository = repository
        self.max_entries = max_entries
        self._entries: dict[str, ConfigSnapshot] = {}
        self._lock = RLock()

    def read(self, key: str) -> ConfigSnapshot:
        version_id = self.repository.current_version(key)
        with self._lock:
            cached = self._entries.get(key)
            if cached is not None and cached.id == version_id:
                return cached
        snapshot = self.repository.read(key)
        with self._lock:
            if key not in self._entries and len(self._entries) >= self.max_entries:
                self._entries.pop(next(iter(self._entries)))
            self._entries[key] = snapshot
        return snapshot
