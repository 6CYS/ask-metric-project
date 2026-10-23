"""通用指标发现：正式目录描述、版本绑定及服务端签发的探索引用。"""

import base64
import hashlib
import hmac
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from ask_metric.application.business_overview import bind_metrics
from ask_metric.application.catalog_search import search_metrics
from ask_metric.core.errors import ApplicationError
from ask_metric.domain.metric_matching import normalize_semantic_text

CONFIG_DIR = Path(__file__).resolve().parents[3] / "config"
METHOD_VERSION = "general-analysis-v1"


class MetricExtension(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["draft", "approved", "retired"] = "draft"
    source: str = ""
    value_encoding: Literal["ratio", "percent"] | None = None
    frequency: Literal["daily", "monthly", "quarterly", "yearly"] | None = None
    quantity_kind: Literal["stock", "flow", "cumulative_flow", "ratio", "ranking"] | None = None
    business_direction: Literal["higher", "lower", "neutral"] | None = None

    @model_validator(mode="after")
    def require_approved_source(self):
        if self.status == "approved" and not self.source.strip():
            raise ValueError("审核后的语义配置必须注明依据")
        return self


class MetricRelation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    status: Literal["draft", "approved", "retired"] = "draft"
    parent: str = Field(min_length=1)
    children: list[str] = Field(min_length=1, max_length=15)
    source: str = Field(min_length=1)

    @model_validator(mode="after")
    def unique_members(self):
        if self.parent in self.children or len(set(self.children)) != len(self.children):
            raise ValueError("指标关系不能自包含或重复")
        return self


class SemanticExtensions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    version: str = "general-analysis-v1"
    metrics: dict[str, MetricExtension] = Field(default_factory=dict)
    relations: list[MetricRelation] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_relations(self):
        if len({item.id for item in self.relations}) != len(self.relations):
            raise ValueError("关系ID不能重复")
        return self


def digest(value) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
        ).encode()
    ).hexdigest()


class MetricSemantics:
    def __init__(self, catalog, *, secret: str, actor_id: str):
        if not secret:
            raise ApplicationError(
                "ANALYSIS_CONFIGURATION_ERROR", "指标绑定配置缺失。", status_code=503
            )
        self.items = {item.code: item for item in catalog}
        self.secret = secret.encode()
        self.actor_id = actor_id
        path = CONFIG_DIR / "analysis-semantics.json"
        try:
            self.extensions = SemanticExtensions.model_validate_json(
                path.read_text(encoding="utf-8") if path.exists() else "{}"
            ).model_dump(mode="json")
        except (OSError, ValidationError) as exc:
            raise ApplicationError(
                "ANALYSIS_CONFIGURATION_ERROR",
                "分析语义配置无效，请检查版本与审核依据。",
                status_code=503,
            ) from exc
        self.topic_attributes = {}
        self.topic_groups = {}
        # 复用既有专业增强中的显式编码与数值编码；不按名称或后缀推导未知口径。
        topics_path = CONFIG_DIR / "business-topics.json"
        if topics_path.exists():
            for topic_id, topic in json.loads(topics_path.read_text(encoding="utf-8"))[
                "topics"
            ].items():
                bound, _ = bind_metrics(topic, list(self.items.values()))
                self.topic_groups[topic_id] = {
                    "name": topic["name"],
                    "default_sections": topic["default_sections"],
                    "codes": [],
                }
                for definition in topic["metrics"]:
                    matched = bound.get(definition["id"])
                    code = matched.code if matched else None
                    item = self.items.get(code)
                    if (
                        item
                        and item.unit in definition.get("units", [])
                        and not definition.get("disabled_reason")
                    ):
                        self.topic_attributes[code] = {
                            "value_encoding": definition.get("value_encoding"),
                            "source": "既有领域指标映射；专业口径仍需业务审核",
                            "analysis_hint": {
                                "topic": topic_id,
                                "topic_name": topic["name"],
                                "metric_id": definition["id"],
                                "section": definition["section"],
                                "default_sections": topic["default_sections"],
                            },
                        }
                        self.topic_groups[topic_id]["codes"].append(code)
                        # 只接受既有映射声明、且正式目录同时存在的比较指标，不制造编码。
                        comparisons = definition.get("comparison_codes", {})
                        for period, fields in topic.get("comparison_suffixes", {}).items():
                            for role, rule in fields.items():
                                candidate = (
                                    comparisons.get(period, {}).get(role) or code + rule["suffix"]
                                )
                                comparison = self.items.get(candidate)
                                if (
                                    comparison
                                    and comparison.unit == ("%" if role == "rate" else item.unit)
                                    and (
                                        comparison.value_basis == rule["value_basis"]
                                        or not comparison.value_basis
                                        and comparison.name
                                        == item.name.removesuffix(definition["value_basis"])
                                        + rule["value_basis"]
                                    )
                                ):
                                    self.topic_attributes.setdefault(
                                        candidate,
                                        {
                                            "source": "既有领域比较映射；专业口径仍需业务审核",
                                            "value_encoding": definition.get("value_encoding"),
                                            "analysis_hint": {
                                                "topic": topic_id,
                                                "topic_name": topic["name"],
                                                "metric_id": definition["id"],
                                                "section": "growth",
                                                "comparison": period,
                                                "comparison_role": role,
                                                "default_sections": topic["default_sections"],
                                            },
                                        },
                                    )
                # 首屏同时给出总量、同口径比较、一级分类和质量，避免全被相似名称占满。
                root_id = topic.get("followup_policy", {}).get("root_metric", "total")
                root = bound.get(root_id)
                core_comparisons = [
                    code
                    for code, attributes in self.topic_attributes.items()
                    if attributes.get("analysis_hint", {}).get("topic") == topic_id
                    and attributes["analysis_hint"].get("metric_id") == root_id
                    and attributes["analysis_hint"].get("comparison_role") == "difference"
                ]
                children = [
                    bound[child].code
                    for relation in topic["relationships"]
                    if relation["parent"] == root_id
                    for child in relation["children"]
                    if child in bound
                ]
                quality = [
                    bound[definition["id"]].code
                    for definition in topic["metrics"]
                    if definition["section"] == "quality" and definition["id"] in bound
                ]
                group = self.topic_groups[topic_id]
                group["codes"] = list(
                    dict.fromkeys(
                        [
                            *([root.code] if root else []),
                            *core_comparisons,
                            *children,
                            *quality,
                            *group["codes"],
                        ]
                    )
                )

    def descriptor(self, code: str) -> dict:
        item = self.items[code]
        extension = self.extensions.get("metrics", {}).get(code, {})
        approved = extension if extension.get("status") == "approved" else {}
        attributes = self.topic_attributes.get(code, {})
        encoding = approved.get("value_encoding") or attributes.get("value_encoding")
        value = {
            **item.model_dump(),
            "value_encoding": encoding,
            "frequency": approved.get("frequency"),
            "quantity_kind": approved.get("quantity_kind"),
            "business_direction": approved.get("business_direction"),
            "semantic_source": approved.get("source") or attributes.get("source") or "正式指标目录",
            "semantic_status": "approved" if approved else "catalog_only",
            "analysis_hint": attributes.get("analysis_hint"),
            "methods": ["observe", "compare", "trend", "ranking"],
            "limitations": [],
        }
        if not item.description and not item.explanation:
            value["limitations"].append(
                "目录未提供完整业务定义，不能据名称推断公式、层级或业务原因。"
            )
        if item.unit == "%" and encoding not in {"ratio", "percent"}:
            value["limitations"].append(
                "百分比数值编码未审核，保留原始值，不自动乘100或计算百分点。"
            )
        if not approved.get("frequency"):
            value["limitations"].append(
                "统计频率未审核，历史取值比较不等于单月发生额或完整月度增速。"
            )
        value["metadata_version"] = digest(
            {
                "metric": value,
                "method": METHOD_VERSION,
                "relations": [
                    relation
                    for relation in self.extensions["relations"]
                    if relation["status"] == "approved"
                    and (code == relation["parent"] or code in relation["children"])
                ],
            }
        )[:24]
        return value

    def _signature(self, body: str) -> str:
        return hmac.new(
            self.secret, f"analysis-binding-v1:{self.actor_id}:{body}".encode(), hashlib.sha256
        ).hexdigest()

    def binding(self, descriptor: dict, keyword: str) -> str:
        # 短引用降低模型抄写长JSON签名时的差错；128位MAC仍绑定用户、指标和版本。
        code = base64.urlsafe_b64encode(descriptor["code"].encode()).decode().rstrip("=")
        body = f"m1.{code}.{descriptor['metadata_version']}"
        return f"{body}.{self._signature(body)[:32]}"

    def resolve(self, reference: str) -> dict:
        try:
            body, signature = reference.rsplit(".", 1)
            if body.startswith("m1."):
                if not hmac.compare_digest(signature, self._signature(body)[:32]):
                    raise ValueError("signature")
                _, code, version = body.split(".")
                payload = {
                    "c": base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)).decode(),
                    "v": version,
                }
            else:
                # 本次升级前已持久化的回执引用仍可按相同权限与版本复核。
                if not hmac.compare_digest(signature, self._signature(body)):
                    raise ValueError("signature")
                payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
            descriptor = self.descriptor(payload["c"])
        except (ValueError, KeyError, TypeError, UnicodeDecodeError) as exc:
            raise ApplicationError(
                "ANALYSIS_BINDING_INVALID",
                "指标引用无效、已停用或不属于当前用户，请重新检索正式目录。",
                status_code=422,
            ) from exc
        if descriptor["metadata_version"] != payload.get("v"):
            raise ApplicationError(
                "ANALYSIS_METADATA_CHANGED",
                "指标定义或规则已更新，请重新读取目录后规划。",
                status_code=409,
            )
        return {**descriptor, "binding_ref": reference, "discovery_keyword": payload.get("q", "")}

    def search(self, keyword: str, *, page=1, page_size=12) -> dict:
        result = search_metrics(keyword, list(self.items.values()), limit=len(self.items))
        # 单主题和跨主题检索复用同一已绑定目录；词法相似的陌生指标不能遮住领域总量。
        matched_codes = {hit.code for hit in result.items}
        groups = {
            key: group
            for key, group in self.topic_groups.items()
            if matched_codes.intersection(group["codes"])
        }
        # 精确身份先于主题推荐；否则完整指标名/编码也会被主题第一页长期遮住。
        term = normalize_semantic_text(keyword)
        exact = [
            hit.code
            for hit in result.items
            if term
            and any(
                normalize_semantic_text(value) == term
                for value in (
                    self.items[hit.code].code,
                    self.items[hit.code].name,
                    *self.items[hit.code].aliases,
                )
            )
        ]
        priority = [code for group in groups.values() for code in group["codes"]]
        ordered = list(dict.fromkeys([*exact, *priority, *(hit.code for hit in result.items)]))
        selected = ordered[(page - 1) * page_size : page * page_size]
        matches = {hit.code: hit.match_type for hit in result.items}
        items = []
        for code in selected:
            descriptor = self.descriptor(code)
            items.append(
                {
                    **descriptor,
                    "match_type": matches.get(code, "domain_mapping"),
                    "binding_ref": self.binding(descriptor, keyword),
                }
            )
        return {
            "keyword": keyword,
            "total": len(ordered),
            "page": page,
            "page_size": page_size,
            "has_more": page * page_size < len(ordered),
            "topic_hints": [
                {
                    "topic": key,
                    "name": group["name"],
                    "default_sections": group["default_sections"],
                    "notice": "这是指标分组和分析方向，不证明分项可加总，也不证明当前有数据。",
                }
                for key, group in groups.items()
            ],
            "items": items,
            "notice": (
                "检索命中不证明语义适合或指定条件有数据。"
                "按完整名称、定义和限定词选择；绑定引用仅证明正式目录来源。"
            ),
        }

    def comparison_candidates(self, descriptors: list[dict]) -> list[dict]:
        """提供已绑定指标的正式比较入口，不猜编码，不证明指定机构当前有数。"""
        selected = {item["code"] for item in descriptors}
        families = {
            (hint["topic"], hint["metric_id"])
            for item in descriptors
            if (hint := item.get("analysis_hint")) and not hint.get("comparison")
        }
        result = []
        for period in ("mom", "yoy"):
            for code, attributes in self.topic_attributes.items():
                hint = attributes.get("analysis_hint", {})
                if (
                    code not in selected
                    and (hint.get("topic"), hint.get("metric_id")) in families
                    and hint.get("comparison") == period
                    and hint.get("comparison_role") == "difference"
                ):
                    descriptor = self.descriptor(code)
                    result.append(
                        {**descriptor, "binding_ref": self.binding(descriptor, "比较补查")}
                    )
        return result[:24]

    def relations(self, descriptors: list[dict]) -> list[dict]:
        codes = {item["code"] for item in descriptors}
        return [
            relation
            for relation in self.extensions.get("relations", [])
            if relation.get("status") == "approved" and relation.get("parent") in codes
        ]
