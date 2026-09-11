"""国密（SM2/SM3/SM4）支持：登录密码的传输加密与存储哈希。

链路约定（与前端 sm-crypto 实现对齐）：

- SM2 公私钥为 64/128 位十六进制字符串，对外公钥带 ``04`` 前缀（130 字符）；
- SM2 密文使用 C1C3C2 分段顺序（sm-crypto cipherMode=1）；
- 前端加密的是 SM4 密钥的十六进制文本本身，解密后需再按 hex 还原密钥字节；
- SM4 使用 CBC 模式、PKCS7 填充，密钥、IV、密文均为十六进制字符串；
- 密码存储为 ``sm3$<salt_hex>$<digest_hex>``，digest = SM3(salt + password UTF-8)。
"""

import hmac
import logging
import re
import secrets
from dataclasses import dataclass, field

from gmssl import func, sm2, sm3, sm4

logger = logging.getLogger(__name__)

PASSWORD_SCHEME_SM3 = "sm3"
SM2_PRIVATE_KEY_HEX_LEN = 64
SM4_BLOCK_HEX_LEN = 32  # 16 字节密钥/IV 的 hex 长度

_ephemeral_keypairs: list["Sm2KeyPair"] = []
_configured_keypairs: dict[str, "Sm2KeyPair"] = {}


class GmCryptoError(ValueError):
    """国密解密或格式校验失败。"""


@dataclass(frozen=True)
class Sm2KeyPair:
    private_key: str = field(repr=False)  # 64 位 hex，禁止对象表示泄露私钥
    public_key: str  # 128 位 hex，不带 04 前缀

    @property
    def public_key_with_prefix(self) -> str:
        return f"04{self.public_key}"


def generate_sm2_keypair() -> Sm2KeyPair:
    order = int(sm2.default_ecc_table["n"], 16)
    private_key = f"{secrets.randbelow(order - 2) + 1:064x}"
    return Sm2KeyPair(private_key=private_key, public_key=_derive_public_key(private_key))


def _derive_public_key(private_key_hex: str) -> str:
    _validate_private_key(private_key_hex)
    # G is a public curve parameter, not a secret. Public-key derivation computes d*G.
    crypt = sm2.CryptSM2(
        private_key=private_key_hex,
        public_key=sm2.default_ecc_table["g"],
        mode=1,
    )
    return crypt._kg(int(private_key_hex, 16), sm2.default_ecc_table["g"])


def _validate_private_key(value: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise GmCryptoError("SM2_PRIVATE_KEY must be a 64-character hex string")
    if not 1 <= int(value, 16) < int(sm2.default_ecc_table["n"], 16) - 1:
        raise GmCryptoError("SM2_PRIVATE_KEY is outside the valid scalar range")


def _validate_public_point(value: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{128}", value):
        raise GmCryptoError("invalid SM2 public point")
    x, y = int(value[:64], 16), int(value[64:], 16)
    p, a, b = (int(sm2.default_ecc_table[k], 16) for k in ("p", "a", "b"))
    if x >= p or y >= p or (y * y - x * x * x - a * x - b) % p:
        raise GmCryptoError("invalid SM2 public point")


def load_sm2_keypair(private_key_hex: str, *, allow_ephemeral: bool) -> Sm2KeyPair:
    """从配置加载 SM2 密钥对；开发/测试环境未配置时使用进程级临时密钥。"""
    if not isinstance(private_key_hex, str):
        raise GmCryptoError("SM2_PRIVATE_KEY must be configured as hexadecimal text")
    normalized = private_key_hex.strip().lower()
    if normalized:
        _validate_private_key(normalized)
        cached = _configured_keypairs.get(normalized)
        if cached is not None:
            return cached
        try:
            public_key = _derive_public_key(normalized)
        except Exception as exc:  # noqa: BLE001
            raise GmCryptoError("SM2_PRIVATE_KEY is not a valid SM2 private key") from exc
        keypair = Sm2KeyPair(private_key=normalized, public_key=public_key)
        _configured_keypairs[normalized] = keypair
        return keypair
    if not allow_ephemeral:
        raise GmCryptoError("SM2_PRIVATE_KEY must be configured outside development/test")
    if not _ephemeral_keypairs:
        _ephemeral_keypairs.append(generate_sm2_keypair())
        logger.warning(
            "SM2_PRIVATE_KEY not configured; generated an ephemeral SM2 keypair. "
            "Encrypted login payloads will not survive a backend restart."
        )
    return _ephemeral_keypairs[0]


def decrypt_sm4_key_hex(keypair: Sm2KeyPair, encrypted_key_hex: str) -> bytes:
    """SM2 解密前端加密的一次性 SM4 密钥（前端发送的是密钥 hex 文本）。"""
    if not isinstance(keypair, Sm2KeyPair):
        raise GmCryptoError("a valid SM2 keypair is required")
    _validate_private_key(keypair.private_key)
    _validate_public_point(keypair.public_key)
    if not isinstance(encrypted_key_hex, str):
        raise GmCryptoError("encrypted_key must be hexadecimal text")
    try:
        ciphertext = bytes.fromhex(encrypted_key_hex.strip())
    except ValueError as exc:
        raise GmCryptoError("encrypted_key is not valid hex") from exc
    if len(ciphertext) != 64 + 32 + 32:
        raise GmCryptoError("encrypted_key has an invalid length")
    _validate_public_point(ciphertext[:64].hex())
    crypt = sm2.CryptSM2(
        private_key=keypair.private_key, public_key=keypair.public_key, mode=1
    )
    try:
        plaintext = crypt.decrypt(ciphertext)
        # gmssl 3.2.2 computes C3 but does not compare it during decrypt.
        shared = crypt._kg(int(keypair.private_key, 16), ciphertext[:64].hex())
        digest = sm3_hexdigest(bytes.fromhex(shared[:64]) + plaintext
                               + bytes.fromhex(shared[64:]))
        if not hmac.compare_digest(digest, ciphertext[64:96].hex()):
            raise GmCryptoError("SM2 ciphertext authentication failed")
        key_hex = plaintext.decode("ascii")
        key = bytes.fromhex(key_hex)
    except (ValueError, UnicodeDecodeError, AttributeError, TypeError) as exc:
        raise GmCryptoError("failed to decrypt the SM4 key") from exc
    if len(key) != 16:
        raise GmCryptoError("decrypted SM4 key must be 16 bytes")
    return key


def sm4_decrypt_cbc_text(key: bytes, iv_hex: str, cipher_hex: str) -> str:
    """SM4-CBC/PKCS7 解密并还原 UTF-8 文本。"""
    if not isinstance(key, bytes) or len(key) != 16:
        raise GmCryptoError("SM4 key must contain exactly 16 bytes")
    if not isinstance(iv_hex, str) or not isinstance(cipher_hex, str):
        raise GmCryptoError("iv/password ciphertext must be hexadecimal text")
    try:
        iv = bytes.fromhex(iv_hex.strip())
        cipher_bytes = bytes.fromhex(cipher_hex.strip())
    except ValueError as exc:
        raise GmCryptoError("iv/password ciphertext must be valid hex") from exc
    if len(iv) != 16 or not cipher_bytes or len(cipher_bytes) % 16 != 0:
        raise GmCryptoError("invalid SM4-CBC parameters")
    crypt = sm4.CryptSM4()
    crypt.set_key(key, sm4.SM4_DECRYPT)
    try:
        plaintext = crypt.crypt_cbc(iv, cipher_bytes)
        return plaintext.decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise GmCryptoError("failed to decrypt the SM4 ciphertext") from exc


def sm3_hexdigest(data: bytes) -> str:
    return sm3.sm3_hash(func.bytes_to_list(data))


def hash_password_sm3(password: str, *, salt: bytes | None = None) -> str:
    salt = salt if salt is not None else secrets.token_bytes(16)
    digest = sm3_hexdigest(salt + password.encode("utf-8"))
    return f"{PASSWORD_SCHEME_SM3}${salt.hex()}${digest}"


def verify_password_sm3(password: str, encoded: str) -> bool:
    try:
        scheme, salt_hex, digest = encoded.split("$", 2)
    except ValueError:
        return False
    if scheme != PASSWORD_SCHEME_SM3:
        return False
    try:
        salt = bytes.fromhex(salt_hex)
    except ValueError:
        return False
    expected = sm3_hexdigest(salt + password.encode("utf-8"))
    return hmac.compare_digest(expected, digest)
