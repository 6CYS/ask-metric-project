import { sm2, sm4 } from "sm-crypto"

export type EncryptedLoginPayload = {
  encryptedKey: string
  iv: string
  passwordCipher: string
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * 登录密码国密传输加密：每次登录生成一次性 SM4 密钥与 IV，
 * 密码走 SM4-CBC/PKCS7（hex），SM4 密钥走 SM2 公钥加密（C1C3C2，hex）。
 * 后端用 SM2 私钥解出 SM4 密钥后再解密密码，链路上不出现明文密码。
 */
export function encryptLoginPassword(
  password: string,
  sm2PublicKey: string
): EncryptedLoginPayload {
  const sm4Key = randomHex(16)
  const iv = randomHex(16)
  const passwordCipher = sm4.encrypt(password, sm4Key, { mode: "cbc", iv })
  const encryptedKey = sm2.doEncrypt(sm4Key, sm2PublicKey, 1)
  return { encryptedKey, iv, passwordCipher }
}
