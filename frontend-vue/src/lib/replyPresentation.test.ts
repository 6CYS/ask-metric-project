import { expect, it } from "vitest"
import { governedReply } from "./replyPresentation"

it("失败回执保留具体业务原因，历史和实时展示使用相同文案", () => {
  const public_answer = "以下指标当前未启用：金融机构数量较同期。本次未执行部分取数，请移除这些指标或联系管理员确认。"
  for (const status of ["error", "failed", "FAILED"]) {
    expect(governedReply({ kind: "metric_ask", status, error_code: "METRIC_DISABLED", public_answer })).toBe(public_answer)
  }
})

it("没有公开原因时保留安全兜底，不展示附加的内部异常", () => {
  const receipt = { kind: "metric_read" as const, status: "FAILED", error_code: "INTERNAL_ERROR", error_message: "private stack trace" }
  expect(governedReply(receipt)).toBe("本次查询未成功，请检查查询条件或稍后重试。")
})
