import { describe, expect, it } from "vitest";
import {
  decryptConfigValue,
  encryptConfigValue,
  isEncryptedConfigValue,
  ConfigCryptoError,
} from "./sm4ConfigCrypto.js";

const MASTER_KEY = Buffer.from("0123456789abcdeffedcba9876543210", "hex");

// 由后端 Python 实现（config_crypto.encrypt_config_value）用同一主密钥生成，验证跨语言兼容
const PYTHON_ENCRYPTED =
  "ENC[SM4:v1:3636e48404d0f01a50d1ed33aec7b926:417ff398292c02fb952fed9448b9394bc03dbfbb1e10f4a6a93ab161f3d96666:dc0a753f73b9b76c0934f9be18314fff6764886bf2ba745a4fc9bd5b37a4bba6]";

describe("sm4ConfigCrypto", () => {
  it("解密后端 Python 生成的密文", () => {
    expect(decryptConfigValue(PYTHON_ENCRYPTED, MASTER_KEY)).toBe("sk-test-密钥-123");
  });

  it("非密文原样返回", () => {
    expect(isEncryptedConfigValue("plain-value")).toBe(false);
    expect(decryptConfigValue("plain-value", MASTER_KEY)).toBe("plain-value");
  });

  it("加解密往返一致", () => {
    const encrypted = encryptConfigValue("p@ss:word/测试#1", MASTER_KEY);
    expect(isEncryptedConfigValue(encrypted)).toBe(true);
    expect(decryptConfigValue(encrypted, MASTER_KEY)).toBe("p@ss:word/测试#1");
  });

  it("密文被篡改时拒绝解密", () => {
    const tampered = PYTHON_ENCRYPTED.replace("417ff398", "417ff399");
    expect(() => decryptConfigValue(tampered, MASTER_KEY)).toThrow(ConfigCryptoError);
  });

  it("主密钥错误时拒绝解密", () => {
    const wrongKey = Buffer.from("fedcba98765432100123456789abcdef", "hex");
    expect(() => decryptConfigValue(PYTHON_ENCRYPTED, wrongKey)).toThrow(ConfigCryptoError);
  });
});
