import { describe, expect, it } from "vitest"
import { friendlyQueryError } from "../src/lib/queryErrors"

describe("结构化模型服务故障", () => {
  it.each([
    ["MODEL_RATE_LIMITED", "请求较多"],
    ["MODEL_QUOTA_EXCEEDED", "额度"],
    ["MODEL_AUTHENTICATION_FAILED", "管理员"],
  ])("%s 解释具体原因，不泄漏上游细节", (code, expected) => {
    const message = friendlyQueryError("upstream internal exception /secret", code)
    expect(message).toContain(expected)
    expect(message).not.toContain("secret")
  })
})
