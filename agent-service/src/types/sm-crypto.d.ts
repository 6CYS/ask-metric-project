/**
 * sm-crypto 未提供 TypeScript 类型，这里声明本服务用到的最小接口。
 * sm4：CBC 模式 + pkcs#7 填充；sm3：支持普通摘要与 hmac 模式。
 */
declare module "sm-crypto" {
  export function sm3(input: string | number[] | Uint8Array, options?: { mode?: "hmac"; key?: string | number[] | Uint8Array }): string;
  export const sm4: {
    encrypt(input: string | number[] | Uint8Array, key: string | number[], options?: { padding?: "pkcs#5" | "pkcs#7" | "none"; mode?: "cbc"; iv?: string | number[]; output?: "string" | "array" }): string;
    decrypt(input: string | number[] | Uint8Array, key: string | number[], options?: { padding?: "pkcs#5" | "pkcs#7" | "none"; mode?: "cbc"; iv?: string | number[]; output?: "string" | "array" }): string;
  };
}
