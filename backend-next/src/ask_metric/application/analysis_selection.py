"""分析指标选择回执：绑定身份、目录版本和完整执行范围，不接受模型自报来源。"""
import base64
import hashlib
import hmac
import json
from collections.abc import Sequence

from ask_metric.core.errors import ApplicationError
from ask_metric.domain.semantics import MetricCatalogItem


def catalog_digest(codes: list[str], catalog: Sequence[MetricCatalogItem]) -> str:
    by_code = {item.code: item for item in catalog}
    if not codes or len(set(codes)) != len(codes) or any(code not in by_code for code in codes):
        raise ApplicationError('ANALYSIS_CATALOG_CHANGED', '分析指标已停用或目录身份不可用，请重新查阅目录。', status_code=409)
    values = [(code, by_code[code].name, by_code[code].unit, by_code[code].value_basis) for code in sorted(codes)]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def _signature(body: bytes, secret: str) -> bytes:
    if not secret:
        raise ApplicationError('ANALYSIS_RECEIPT_UNAVAILABLE', '分析来源回执服务尚未配置。', status_code=503)
    return hmac.new(secret.encode(), b'askmetric.analysis-selection.v1\0' + body, hashlib.sha256).digest()


def issue_selection(*, owner: str, conversation: str, session: str, goal: str, codes: list[str], scope: dict, catalog: Sequence[MetricCatalogItem], secret: str) -> str:
    body = json.dumps({'v': 1, 'owner': owner, 'conversation': conversation, 'session': session,
        'goal_hash': hashlib.sha256(goal.encode()).hexdigest(), 'codes': sorted(codes), 'scope': scope,
        'catalog': catalog_digest(codes, catalog)}, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
    return encode(body) + '.' + encode(_signature(body, secret))


def verify_selection(token: str, *, owner: str, conversation: str | None, codes: list[str], scope: dict, catalog: Sequence[MetricCatalogItem], secret: str, session: str | None = None) -> None:
    try:
        raw, signature = token.split('.')
        decode = lambda value: base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
        body = decode(raw)
        if not hmac.compare_digest(decode(signature), _signature(body, secret)):
            raise ValueError('signature')
        payload = json.loads(body)
        if not isinstance(payload, dict) or payload.get('v') != 1 or payload.get('owner') != owner or payload.get('conversation') != conversation:
            raise ValueError('ownership')
        if session is not None and payload.get('session') != session:
            raise ValueError('session')
        if payload.get('codes') != sorted(codes) or payload.get('scope') != scope:
            raise ValueError('scope')
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise ApplicationError('ANALYSIS_SOURCE_INVALID', '分析来源回执与当前身份或执行范围不符。', status_code=409) from None
    if payload.get('catalog') != catalog_digest(codes, catalog):
        raise ApplicationError('ANALYSIS_CATALOG_CHANGED', '分析来源目录已变化，请重新选择指标。', status_code=409)
