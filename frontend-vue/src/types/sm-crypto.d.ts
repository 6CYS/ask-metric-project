/** sm-crypto 未提供官方类型声明，这里只声明项目用到的最小 API 面。 */
declare module "sm-crypto" {
  export const sm2: {
    generateKeyPairHex(): { privateKey: string; publicKey: string }
    /** cipherMode: 1 = C1C3C2（与后端约定一致），0 = C1C2C3 */
    doEncrypt(data: string, publicKey: string, cipherMode?: 0 | 1): string
  }
  export const sm4: {
    encrypt(
      data: string,
      key: string,
      options?: { mode?: "cbc" | "ecb"; iv?: string; padding?: "pkcs#7" | "none" }
    ): string
  }
}
