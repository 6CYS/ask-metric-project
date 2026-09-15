/**
 * 运行配置密文解密：与 backend-next/src/ask_metric/core/config_crypto.py 同一格式。
 * 密文形如 ENC[SM4:v1:<iv_hex>:<ciphertext_hex>:<tag_hex>]，
 * 由主密钥经 SM3 派生加密钥与认证钥，SM4-CBC 加密、SM3-HMAC 校验完整性。
 * 主密钥与密文分开保存；密钥缺失或密文被篡改时服务拒绝启动。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

const require = createRequire(import.meta.url);
const { sm3, sm4 } = require("sm-crypto") as typeof import("sm-crypto");

export const ENCRYPTED_CONFIG_PREFIX = "ENC[SM4:v1:";
export const CONFIG_SM4_KEY_ENV = "ASK_METRIC_CONFIG_SM4_KEY";
export const CONFIG_SM4_KEY_FILE_ENV = "ASK_METRIC_CONFIG_SM4_KEY_FILE";

export class ConfigCryptoError extends Error {}

export function isEncryptedConfigValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENCRYPTED_CONFIG_PREFIX);
}

/** 主密钥来源与后端一致：inline hex 或独立密钥文件，二者只能配置一个。 */
export function loadConfigSm4Key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const inline = (env[CONFIG_SM4_KEY_ENV] ?? "").trim();
  const keyFile = (env[CONFIG_SM4_KEY_FILE_ENV] ?? "").trim();
  if (inline && keyFile) {
    throw new ConfigCryptoError(
      `只能配置 ${CONFIG_SM4_KEY_ENV} 或 ${CONFIG_SM4_KEY_FILE_ENV} 之一`,
    );
  }
  let encoded = inline;
  if (keyFile) {
    try {
      encoded = readFileSync(keyFile, "ascii").trim();
    } catch {
      throw new ConfigCryptoError("无法读取 SM4 配置主密钥文件");
    }
  }
  if (!encoded) {
    throw new ConfigCryptoError(
      `加密配置需要 ${CONFIG_SM4_KEY_ENV} 或 ${CONFIG_SM4_KEY_FILE_ENV}`,
    );
  }
  const key = Buffer.from(encoded, "hex");
  if (key.length !== 16) {
    throw new ConfigCryptoError("SM4 配置主密钥必须为 16 字节（32 位十六进制）");
  }
  return key;
}

function sm3Hex(data: Buffer): string {
  return sm3(new Uint8Array(data));
}

function deriveKeys(masterKey: Buffer): { encryptionKey: string; authenticationKey: string } {
  // 与 Python 端相同的派生口令：用途前缀 + 主密钥，经 SM3 取摘要
  const encryptionKey = sm3Hex(
    Buffer.concat([Buffer.from("ask-metric:config:enc:", "utf8"), masterKey]),
  ).slice(0, 32);
  const authenticationKey = sm3Hex(
    Buffer.concat([Buffer.from("ask-metric:config:mac:", "utf8"), masterKey]),
  );
  return { encryptionKey, authenticationKey };
}

function hmacSm3Hex(keyHex: string, message: Buffer): string {
  return sm3(new Uint8Array(message), { mode: "hmac", key: keyHex });
}

export function decryptConfigValue(value: string, key?: Buffer): string {
  if (!isEncryptedConfigValue(value)) {
    return value;
  }
  const masterKey = key ?? loadConfigSm4Key();
  const payload = value.slice(ENCRYPTED_CONFIG_PREFIX.length);
  if (!payload.endsWith("]")) {
    throw new ConfigCryptoError("加密配置封装格式非法");
  }
  const parts = payload.slice(0, -1).split(":");
  if (parts.length !== 3) {
    throw new ConfigCryptoError("加密配置封装格式非法");
  }
  const [ivHex, ciphertextHex, tagHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const suppliedTag = Buffer.from(tagHex, "hex");
  if (iv.length !== 16 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new ConfigCryptoError("加密配置的 SM4-CBC 参数非法");
  }
  if (suppliedTag.length !== 32) {
    throw new ConfigCryptoError("加密配置的完整性校验标签非法");
  }
  const { encryptionKey, authenticationKey } = deriveKeys(masterKey);
  const authenticated = Buffer.concat([Buffer.from("SM4:v1:", "utf8"), iv, ciphertext]);
  const expectedTag = Buffer.from(hmacSm3Hex(authenticationKey, authenticated), "hex");
  if (!timingSafeEqual(suppliedTag, expectedTag)) {
    throw new ConfigCryptoError("加密配置完整性校验失败");
  }
  try {
    return sm4.decrypt(ciphertextHex, encryptionKey, { mode: "cbc", iv: ivHex });
  } catch {
    throw new ConfigCryptoError("SM4 配置密文解密失败");
  }
}

/** 加密工具，仅用于本地生成配置与测试；与 Python 端 encrypt_config_value 等价。 */
export function encryptConfigValue(plaintext: string, masterKey: Buffer): string {
  if (masterKey.length !== 16) {
    throw new ConfigCryptoError("SM4 配置主密钥必须为 16 字节");
  }
  const ivHex = randomBytes(16).toString("hex");
  const { encryptionKey, authenticationKey } = deriveKeys(masterKey);
  const ciphertextHex = sm4.encrypt(plaintext, encryptionKey, { mode: "cbc", iv: ivHex });
  const authenticated = Buffer.concat([
    Buffer.from("SM4:v1:", "utf8"),
    Buffer.from(ivHex, "hex"),
    Buffer.from(ciphertextHex, "hex"),
  ]);
  const tag = hmacSm3Hex(authenticationKey, authenticated);
  return `${ENCRYPTED_CONFIG_PREFIX}${ivHex}:${ciphertextHex}:${tag}]`;
}
