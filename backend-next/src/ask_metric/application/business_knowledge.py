"""业务知识的同源读取与逐条维护；单进程写入串行化，版本冲突不覆盖管理员修改。"""

import hashlib
import json
import math
import os
import re
import tempfile
import unicodedata
from collections import Counter
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, date, datetime
from pathlib import Path
from threading import RLock
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    TypeAdapter,
    ValidationError,
    field_validator,
)

from ask_metric.core.errors import ApplicationError

_LOCK = RLock()
_HTTP_URL = TypeAdapter(AnyHttpUrl)


class KnowledgeFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    topic: Literal["loan", "deposit"] | None = None
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=8000)
    source: str = Field(default="", max_length=300)
    role: str = Field(default="", max_length=500)
    url: str | None = Field(default=None, max_length=2000)
    date: str | None = None
    enabled: StrictBool = True

    @field_validator("url", "date", mode="before")
    @classmethod
    def optional_text(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("url")
    @classmethod
    def http_url(cls, value):
        if value is not None:
            _HTTP_URL.validate_python(value)
        return value

    @field_validator("date")
    @classmethod
    def calendar_date(cls, value):
        if value is not None:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError("资料日期须为 YYYY-MM-DD")
            date.fromisoformat(value)
        return value

    @field_validator("topic", mode="before")
    @classmethod
    def topic_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class KnowledgeEntry(KnowledgeFields):
    id: str = Field(min_length=1, max_length=128)
    updated_at: datetime | None = None


class KnowledgeDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    entries: list[KnowledgeEntry]

    @field_validator("entries")
    @classmethod
    def unique_ids(cls, entries):
        if len({entry.id for entry in entries}) != len(entries):
            raise ValueError("知识条目 ID 重复")
        return entries


class KnowledgeSearch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query: str = Field(max_length=2000)
    context_terms: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=8,
    )


def _search_terms(text: str) -> set[str]:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    terms = set(re.findall(r"[a-z0-9_]{2,}", normalized))
    for phrase in re.findall(r"[\u3400-\u9fff]+", normalized):
        terms.update(phrase[index:index + 2] for index in range(len(phrase) - 1))
    return terms


class BusinessKnowledgeStore:
    def __init__(self, path: Path):
        self.path = path

    def _load(self) -> tuple[KnowledgeDocument, str]:
        try:
            data = self.path.read_bytes()
            document = KnowledgeDocument.model_validate_json(data)
        except (OSError, ValueError, ValidationError) as error:
            raise ApplicationError(
                "BUSINESS_KNOWLEDGE_UNAVAILABLE", "业务知识文件不可用，请联系管理员核对。",
                status_code=503,
            ) from error
        return document, hashlib.sha256(data).hexdigest()

    def read(self, topic: str | None = None, *, enabled_only: bool = False) -> dict:
        with _LOCK:
            document, revision = self._load()
            return {"items": [entry.model_dump(mode="json") for entry in document.entries
                              if (topic is None or entry.topic == topic)
                              and (not enabled_only or entry.enabled)], "revision": revision}

    def search(self, query: str, context_terms: list[str]) -> dict:
        snapshot = self.read(enabled_only=True)
        question = _search_terms(query)
        context = set().union(*(_search_terms(term) for term in context_terms))
        documents = [(_search_terms(entry["title"]), _search_terms(entry["text"]),
                      _search_terms(entry["role"])) for entry in snapshot["items"]]
        frequency = Counter(term for parts in documents for term in set().union(*parts))

        def score(parts):
            total = 0.0
            for terms, weight in zip(parts, (3, 1, 2), strict=True):
                for term in terms & (question | context):
                    relevance = 1 if term in question else 0.25
                    total += weight * relevance * math.log1p(
                        len(documents) / frequency[term],
                    )
            return total

        ranked = sorted(zip(snapshot["items"], documents, strict=True),
                        key=lambda item: score(item[1]), reverse=True)
        entries, remaining = [], 8000
        for entry, parts in ranked:
            if score(parts) <= 0:
                break
            # 保留完整正文，不能为节省上下文截掉末尾的适用条件或使用边界。
            if len(entry["text"]) > remaining:
                continue
            entries.append({key: entry[key] for key in ("id", "title", "text", "role")})
            remaining -= len(entry["text"])
            if len(entries) == 3:
                break
        return {"entries": entries, "revision": snapshot["revision"]}

    def _persist(self, document: KnowledgeDocument) -> str:
        data = (json.dumps(document.model_dump(mode="json"), ensure_ascii=False, indent=2)
                + "\n").encode("utf-8")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp",
                delete=False,
            ) as output:
                temporary = Path(output.name)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except OSError as error:
            raise ApplicationError(
                "BUSINESS_KNOWLEDGE_WRITE_FAILED", "业务知识保存失败，原内容未更改，请稍后重试。",
                status_code=503,
            ) from error
        finally:
            if temporary is not None:
                with suppress(OSError):
                    temporary.unlink(missing_ok=True)
        return hashlib.sha256(data).hexdigest()

    def _change(self, revision: str, change: Callable[[list[KnowledgeEntry]], KnowledgeEntry]):
        with _LOCK:
            document, current_revision = self._load()
            if revision != current_revision:
                raise ApplicationError(
                    "BUSINESS_KNOWLEDGE_CONFLICT", "业务知识已被更新，请刷新后重新编辑。",
                    status_code=409,
                )
            item = change(document.entries)
            return {"item": item.model_dump(mode="json"), "revision": self._persist(document)}

    def create(self, fields: KnowledgeFields, revision: str) -> dict:
        def add(entries):
            item = KnowledgeEntry(
                **fields.model_dump(), id=str(uuid4()), updated_at=datetime.now(UTC),
            )
            entries.append(item)
            return item
        return self._change(revision, add)

    def update(self, entry_id: str, fields: KnowledgeFields, revision: str) -> dict:
        def replace(entries):
            index = self._index(entries, entry_id)
            # 精简表单不发送旧资料字段，省略值不能覆盖已保存的元数据。
            item = KnowledgeEntry.model_validate({
                **entries[index].model_dump(), **fields.model_dump(exclude_unset=True),
                "updated_at": datetime.now(UTC),
            })
            entries[index] = item
            return item
        return self._change(revision, replace)

    def set_enabled(self, entry_id: str, enabled: bool, revision: str) -> dict:
        def toggle(entries):
            item = entries[self._index(entries, entry_id)]
            item.enabled, item.updated_at = enabled, datetime.now(UTC)
            return item
        return self._change(revision, toggle)

    @staticmethod
    def _index(entries: list[KnowledgeEntry], entry_id: str) -> int:
        for index, item in enumerate(entries):
            if item.id == entry_id:
                return index
        raise ApplicationError(
            "BUSINESS_KNOWLEDGE_NOT_FOUND", "业务知识条目不存在。", status_code=404,
        )
