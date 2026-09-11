from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any


class InvalidContinuationToken(ValueError):
    pass


@dataclass(frozen=True)
class ContinuationTarget:
    task_id: str
    expected_version: int
    clarification_id: str
    channel: str
    channel_context: dict[str, Any]


class ContinuationTokenCodec:
    def __init__(self, secret: str, *, ttl_seconds: int = 86_400) -> None:
        if not isinstance(secret, str) or not secret.strip():
            raise ValueError("A continuation token secret is required")
        self._secret = secret.encode("utf-8")
        self._ttl_seconds = ttl_seconds

    def encode(self, target: ContinuationTarget, *, now: int | None = None) -> str:
        issued_at = int(time.time() if now is None else now)
        payload = {
            "v": 1,
            "iat": issued_at,
            "exp": issued_at + self._ttl_seconds,
            "task_id": target.task_id,
            "expected_version": target.expected_version,
            "clarification_id": target.clarification_id,
            "channel": target.channel,
            "channel_context": target.channel_context,
        }
        encoded = _b64encode(_canonical_json(payload))
        signature = _b64encode(hmac.new(self._secret, encoded, hashlib.sha256).digest())
        return f"{encoded.decode('ascii')}.{signature.decode('ascii')}"

    def decode(self, token: str, *, now: int | None = None) -> ContinuationTarget:
        try:
            payload_segment, signature_segment = token.split(".", 1)
            encoded = payload_segment.encode("ascii")
            supplied_signature = _b64decode(signature_segment)
        except (binascii.Error, ValueError, UnicodeError) as exc:
            raise InvalidContinuationToken("Malformed continuation token") from exc
        expected_signature = hmac.new(self._secret, encoded, hashlib.sha256).digest()
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise InvalidContinuationToken("Invalid continuation token signature")
        try:
            payload = json.loads(_b64decode(payload_segment))
            current_time = int(time.time() if now is None else now)
            if payload["v"] != 1 or current_time >= int(payload["exp"]):
                raise InvalidContinuationToken("Continuation token is expired or unsupported")
            return ContinuationTarget(
                task_id=str(payload["task_id"]),
                expected_version=int(payload["expected_version"]),
                clarification_id=str(payload["clarification_id"]),
                channel=str(payload["channel"]),
                channel_context=dict(payload.get("channel_context") or {}),
            )
        except (binascii.Error, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            if isinstance(exc, InvalidContinuationToken):
                raise
            raise InvalidContinuationToken("Invalid continuation token payload") from exc


def _canonical_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def _b64encode(value: bytes) -> bytes:
    return base64.urlsafe_b64encode(value).rstrip(b"=")


def _b64decode(value: str) -> bytes:
    encoded = value.encode("ascii")
    return base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))
