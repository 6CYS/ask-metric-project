"""维护现有分析语义配置；预置主题关系只投影，不复制为另一套配置。"""

import hashlib
import json
import os
import tempfile
from collections import defaultdict
from collections.abc import Sequence
from contextlib import suppress
from pathlib import Path
from threading import RLock
from typing import Annotated, Literal, TypedDict
from uuid import uuid4

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from ask_metric.application.business_overview import bind_metrics
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.metric_relationships import MetricRelation, MetricRelationFields
from ask_metric.domain.semantics import MetricCatalogItem

CONFIG_DIR = Path(__file__).resolve().parents[3] / "config"
_LOCK = RLock()
_RELATIONS = TypeAdapter(list[MetricRelation])


class _TopicMetric(BaseModel):
    id: str
    label: str
    code: str | None = None
    names: list[str]
    units: list[str]
    value_basis: str
    disabled_reason: str | None = None


class _TopicRelation(BaseModel):
    id: str
    type: str
    parent: str
    children: list[str]
    note: str = ""


class _Topic(BaseModel):
    name: str
    metrics: list[_TopicMetric]
    relationships: list[_TopicRelation]


class _Topics(BaseModel):
    topics: dict[str, _Topic]


class _RelationshipIssue(TypedDict):
    id: str
    title: str
    message: str
    metric_codes: list[str]


def topic_relationships(
    path: Path, catalog: Sequence[MetricCatalogItem],
) -> tuple[list[dict], list[_RelationshipIssue]]:
    """主题内 ID 只有通过正式目录唯一绑定，才投影为可展示的指标编码。"""
    try:
        topics = _Topics.model_validate_json(path.read_bytes())
    except (OSError, ValueError, ValidationError) as error:
        raise ApplicationError(
            "METRIC_RELATION_UNAVAILABLE", "预置指标关系配置不可用，请联系管理员核对。",
            status_code=503,
        ) from error
    items: list[dict] = []
    issues: list[_RelationshipIssue] = []
    for topic_id, topic in topics.topics.items():
        definition = topic.model_dump()
        bound, gaps = bind_metrics(definition, catalog)
        projected, unavailable = project_topic_relationships(topic_id, definition, bound, gaps)
        items.extend(projected)
        issues.extend(unavailable)
    return items, issues


def project_topic_relationships(
    topic_id: str,
    topic: dict,
    bound: dict[str, MetricCatalogItem],
    gaps: list[dict],
) -> tuple[list[dict], list[_RelationshipIssue]]:
    """复用已完成的正式目录绑定，供管理展示和一跳导航使用，不授予计算权限。"""
    items: list[dict] = []
    issues: list[_RelationshipIssue] = []
    definitions = {metric["id"]: metric for metric in topic["metrics"]}
    gaps_by_metric = {gap["metric"]: gap for gap in gaps}
    for relation in topic["relationships"]:
        members = [relation["parent"], *relation["children"]]
        missing = [member for member in members if member not in bound]
        message = ""
        if relation["type"] not in {"classification", "reconciliation"}:
            message = "该关系的类型暂不支持展示，请核对预置关系配置。"
        elif missing:
            details = []
            for member in missing:
                gap = gaps_by_metric.get(member)
                details.append(
                    f"{gap['label']}（{gap['reason']}）" if gap else "未定义指标（请核对关系配置）"
                )
            message = "以下指标尚未完成目录关联：" + "；".join(details) + "。"
        if message:
            parent = definitions.get(relation["parent"])
            parent_label = parent["label"] if parent else "未定义指标"
            metric_codes = []
            for member in members:
                definition = definitions.get(member)
                code = (
                    bound[member].code
                    if member in bound
                    else (definition.get("code") if definition else None)
                )
                if code and code not in metric_codes:
                    metric_codes.append(code)
            issues.append(
                {
                    "id": f"topic:{topic_id}:{relation['id']}",
                    "title": f"{topic['name']} · {parent_label}的指标关系",
                    "message": message,
                    "metric_codes": metric_codes,
                }
            )
            continue
        items.append(
            {
                "id": f"topic:{topic_id}:{relation['id']}",
                "kind": "composition" if relation["type"] == "reconciliation" else "classification",
                "status": "draft",
                "parent": bound[relation["parent"]].code,
                "children": [bound[child].code for child in relation["children"]],
                "source": relation.get("note", ""),
                "origin": "topic",
                "editable": False,
                "topic": topic_id,
            }
        )
    return items, issues


class MetricRelationshipStore:
    def __init__(self, path: Path, topics_path: Path):
        self.path = path
        self.topics_path = topics_path

    def _load(self) -> tuple[dict, list[MetricRelation], str]:
        try:
            data = self.path.read_bytes()
            document = json.loads(data)
            if not isinstance(document, dict):
                raise ValueError("配置须为对象")
            relations = _RELATIONS.validate_python(document.get("relations", []))
            if len({item.id for item in relations}) != len(relations):
                raise ValueError("指标关系 ID 重复")
        except (OSError, ValueError, ValidationError) as error:
            raise ApplicationError(
                "METRIC_RELATION_UNAVAILABLE", "指标关系配置不可用，请联系管理员核对。",
                status_code=503,
            ) from error
        return document, relations, hashlib.sha256(data).hexdigest()

    @staticmethod
    def _item(relation: MetricRelation) -> dict:
        return {**relation.model_dump(), "origin": "managed", "editable": True}

    def read(self, catalog: Sequence[MetricCatalogItem]) -> dict:
        with _LOCK:
            _, relations, revision = self._load()
            presets, issues = topic_relationships(self.topics_path, catalog)
            metrics = {item.code: item for item in catalog}
            for relation in relations:
                members = [relation.parent, *relation.children]
                missing = [code for code in members if code not in metrics]
                if missing:
                    parent = metrics.get(relation.parent)
                    issues.append({
                        "id": f"managed:{relation.id}",
                        "title": f"{parent.name}的指标关系" if parent else "指标关系待核对",
                        "message": "以下指标已停用或不在当前目录：" + "、".join(missing) + "。",
                        "metric_codes": members,
                    })
            return {"items": [*(self._item(item) for item in relations), *presets],
                    "revision": revision, "issues": issues,
                    "warnings": [f"{issue['title']}：{issue['message']}" for issue in issues]}

    def _validate(
        self, candidate: MetricRelation, relations: list[MetricRelation],
        catalog: Sequence[MetricCatalogItem], *, previous: MetricRelation | None,
    ) -> None:
        # 停用保留既有定义退出运行；不要求已失效的目录条件重新满足启用要求。
        if (previous is not None and candidate.status == "retired"
                and (candidate.kind, candidate.parent, candidate.children)
                == (previous.kind, previous.parent, previous.children)):
            return
        metrics = {item.code: item for item in catalog}
        members = [candidate.parent, *candidate.children]
        if any(code not in metrics for code in members):
            raise ApplicationError(
                "METRIC_RELATION_METRIC_NOT_FOUND", "请选择正式目录中已启用的指标。",
                status_code=422,
            )
        if candidate.kind == "composition":
            units = {metrics[code].unit for code in members}
            if len(units) != 1 or None in units or "" in units:
                raise ApplicationError(
                    "METRIC_RELATION_UNIT_MISMATCH", "组成关系的总量与分项须使用相同且明确的单位。",
                    status_code=422,
                )
        if candidate.kind == "ratio":
            numerator, denominator = (metrics[code] for code in candidate.children)
            if (metrics[candidate.parent].unit != "%" or not numerator.unit
                    or numerator.unit != denominator.unit):
                raise ApplicationError(
                    "METRIC_RELATION_UNIT_MISMATCH",
                    "比例指标单位须为 %，分子与分母须使用相同且明确的单位。", status_code=422,
                )
        if candidate.status == "retired":
            return
        presets, _ = topic_relationships(self.topics_path, catalog)
        # 分类属于管理层级，不是公式依赖；组成同时参与两者，须分别检查。
        for kinds in ({"classification", "composition"}, {"composition", "ratio"}):
            if candidate.kind not in kinds:
                continue
            edges: dict[str, set[str]] = defaultdict(set)
            for relation in [*(item.model_dump() for item in relations), *presets]:
                if relation["status"] != "retired" and relation["kind"] in kinds:
                    edges[relation["parent"]].update(relation["children"])
            pending, visited = list(candidate.children), set()
            while pending:
                child = pending.pop()
                if child == candidate.parent:
                    raise ApplicationError(
                        "METRIC_RELATION_CYCLE", "该关系会形成循环，请调整关联指标。",
                        status_code=422,
                    )
                if child not in visited:
                    visited.add(child)
                    pending.extend(edges.get(child, set()))

    def _persist(self, document: dict) -> str:
        data = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
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
                "METRIC_RELATION_WRITE_FAILED", "指标关系保存失败，原内容未更改，请稍后重试。",
                status_code=503,
            ) from error
        finally:
            if temporary is not None:
                with suppress(OSError):
                    temporary.unlink(missing_ok=True)
        return hashlib.sha256(data).hexdigest()

    def _write(
        self, operation: Literal["create", "update", "delete"], relation_id: str,
        fields: MetricRelationFields | None, revision: str, catalog: Sequence[MetricCatalogItem],
    ) -> dict:
        with _LOCK:
            document, relations, current_revision = self._load()
            if revision != current_revision:
                raise ApplicationError(
                    "METRIC_RELATION_CONFLICT", "指标关系已被更新，请刷新后重新编辑。",
                    status_code=409,
                )
            if relation_id.startswith("topic:"):
                raise ApplicationError(
                    "METRIC_RELATION_READ_ONLY", "预置关系关联现有计算口径，本页暂不支持修改。",
                    status_code=409,
                )
            index = next((i for i, item in enumerate(relations) if item.id == relation_id), None)
            if operation != "create" and index is None:
                raise ApplicationError(
                    "METRIC_RELATION_NOT_FOUND", "指标关系不存在，请刷新列表。", status_code=404,
                )
            candidate = MetricRelation(id=relation_id, **fields.model_dump()) if fields else None
            remaining = [item for item in relations if item.id != relation_id]
            if candidate is not None:
                self._validate(candidate, [*remaining, candidate], catalog,
                               previous=relations[index] if index is not None else None)
            # 不重新序列化无关条目，保留现有语义扩展、版本和旧字段的表示。
            raw_relations = list(document.get("relations", []))
            if index is None and candidate is not None:
                raw_relations.append(candidate.model_dump())
            elif index is not None:
                if candidate is None:
                    raw_relations.pop(index)
                else:
                    raw_relations[index] = candidate.model_dump()
            document["relations"] = raw_relations
            result: dict[str, object] = {"revision": self._persist(document)}
            if candidate is not None:
                result["item"] = self._item(candidate)
            return result

    def create(
        self, fields: MetricRelationFields, revision: str, catalog: Sequence[MetricCatalogItem],
    ) -> dict:
        return self._write("create", str(uuid4()), fields, revision, catalog)

    def update(
        self, relation_id: str, fields: MetricRelationFields, revision: str,
        catalog: Sequence[MetricCatalogItem],
    ) -> dict:
        return self._write("update", relation_id, fields, revision, catalog)

    def delete(
        self, relation_id: str, revision: str, catalog: Sequence[MetricCatalogItem],
    ) -> dict:
        return self._write("delete", relation_id, None, revision, catalog)


Revision = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
