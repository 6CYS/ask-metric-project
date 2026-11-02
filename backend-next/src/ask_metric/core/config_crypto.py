from __future__ import annotations

import hmac
import os
import secrets
from collections.abc import Mapping
from pathlib import Path

from gmssl import sm4

from ask_metric.core.gm_crypto import sm3_hexdigest

ENCRYPTED_CONFIG_PREFIX = "ENC[SM4:v1:"
CONFIG_SM4_KEY_ENV = "ASK_METRIC_CONFIG_SM4_KEY"
CONFIG_SM4_KEY_FILE_ENV = "ASK_METRIC_CONFIG_SM4_KEY_FILE"


class ConfigCryptoError(ValueError):
    """An encrypted runtime configuration value cannot be safely processed."""


def is_encrypted_config_value(value: object) -> bool:
    return isinstance(value, str) and value.startswith(ENCRYPTED_CONFIG_PREFIX)


def load_config_sm4_key(
    *,
    environ: Mapping[str, str] | None = None,
    key_file: Path | None = None,
    required: bool = True,
) -> bytes | None:
    source = environ if environ is not None else os.environ
    inline = source.get(CONFIG_SM4_KEY_ENV, "").strip()
    configured_file = source.get(CONFIG_SM4_KEY_FILE_ENV, "").strip()
    if key_file is not None and configured_file:
        raise ConfigCryptoError(
            f"configure only one of --key-file and {CONFIG_SM4_KEY_FILE_ENV}"
        )
    if inline and (key_file is not None or configured_file):
        raise ConfigCryptoError(
            f"configure only one of {CONFIG_SM4_KEY_ENV} and {CONFIG_SM4_KEY_FILE_ENV}"
        )
    if key_file is not None or configured_file:
        path = key_file or Path(configured_file)
        try:
            encoded = path.read_text(encoding="ascii").strip()
        except (OSError, UnicodeError) as exc:
            raise ConfigCryptoError("failed to read the SM4 configuration key file") from exc
    else:
        encoded = inline
    if not encoded:
        if required:
            raise ConfigCryptoError(
                f"encrypted configuration requires {CONFIG_SM4_KEY_ENV} or "
                f"{CONFIG_SM4_KEY_FILE_ENV}"
            )
        return None
    try:
        key = bytes.fromhex(encoded)
    except ValueError as exc:
        raise ConfigCryptoError("the SM4 configuration key must be hexadecimal") from exc
    if len(key) != 16:
        raise ConfigCryptoError("the SM4 configuration key must contain exactly 16 bytes")
    return key


def encrypt_config_value(plaintext: str, key: bytes) -> str:
    _require_key(key)
    if not isinstance(plaintext, str):
        raise ConfigCryptoError("configuration plaintext must be a string")
    iv = secrets.token_bytes(16)
    encryption_key, authentication_key = _derive_keys(key)
    crypt = sm4.CryptSM4()
    crypt.set_key(encryption_key, sm4.SM4_ENCRYPT)
    ciphertext = bytes(crypt.crypt_cbc(iv, plaintext.encode("utf-8")))
    authenticated = b"SM4:v1:" + iv + ciphertext
    tag = _hmac_sm3(authentication_key, authenticated)
    return f"{ENCRYPTED_CONFIG_PREFIX}{iv.hex()}:{ciphertext.hex()}:{tag.hex()}]"


def decrypt_config_value(value: str, key: bytes | None = None) -> str:
    if not isinstance(value, str):
        raise ConfigCryptoError("configuration value must be a string")
    if not is_encrypted_config_value(value):
        return value
    resolved_key = key if key is not None else load_config_sm4_key()
    _require_key(resolved_key)
    payload = value[len(ENCRYPTED_CONFIG_PREFIX) :]
    if not payload.endswith("]"):
        raise ConfigCryptoError("encrypted configuration has an invalid envelope")
    parts = payload[:-1].split(":")
    if len(parts) != 3:
        raise ConfigCryptoError("encrypted configuration has an invalid envelope")
    try:
        iv, ciphertext, supplied_tag = (bytes.fromhex(part) for part in parts)
    except ValueError as exc:
        raise ConfigCryptoError("encrypted configuration must use hexadecimal fields") from exc
    if len(iv) != 16 or not ciphertext or len(ciphertext) % 16 != 0:
        raise ConfigCryptoError("encrypted configuration has invalid SM4-CBC parameters")
    if len(supplied_tag) != 32:
        raise ConfigCryptoError("encrypted configuration has an invalid authentication tag")
    encryption_key, authentication_key = _derive_keys(resolved_key)
    authenticated = b"SM4:v1:" + iv + ciphertext
    expected_tag = _hmac_sm3(authentication_key, authenticated)
    if not hmac.compare_digest(supplied_tag, expected_tag):
        raise ConfigCryptoError("encrypted configuration authentication failed")
    crypt = sm4.CryptSM4()
    crypt.set_key(encryption_key, sm4.SM4_DECRYPT)
    try:
        plaintext = bytes(crypt.crypt_cbc(iv, ciphertext))
        return plaintext.decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise ConfigCryptoError("failed to decrypt the SM4 configuration value") from exc


def _derive_keys(master_key: bytes) -> tuple[bytes, bytes]:
    encryption_key = bytes.fromhex(sm3_hexdigest(b"ask-metric:config:enc:" + master_key))[:16]
    authentication_key = bytes.fromhex(
        sm3_hexdigest(b"ask-metric:config:mac:" + master_key)
    )
    return encryption_key, authentication_key


def _hmac_sm3(key: bytes, message: bytes) -> bytes:
    block_size = 64
    if len(key) > block_size:
        key = bytes.fromhex(sm3_hexdigest(key))
    padded = key.ljust(block_size, b"\0")
    inner = bytes(value ^ 0x36 for value in padded)
    outer = bytes(value ^ 0x5C for value in padded)
    inner_digest = bytes.fromhex(sm3_hexdigest(inner + message))
    return bytes.fromhex(sm3_hexdigest(outer + inner_digest))


def _require_key(key: bytes | None) -> None:
    if not isinstance(key, bytes) or len(key) != 16:
        raise ConfigCryptoError("the SM4 configuration key must contain exactly 16 bytes")
