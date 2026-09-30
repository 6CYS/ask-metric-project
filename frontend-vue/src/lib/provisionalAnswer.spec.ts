import {describe, expect, it} from "vitest"
import {applyProvisionalAnswer, clearProvisionalAnswer} from "./provisionalAnswer"

describe("临时回答与正式快照隔离", () => {
  const pending = {status: "pending", content: ""}
  const delta = {type: "answer_delta" as const, call_seq: 1, mode: "text" as const, text: "临时回答"}
  it("累计覆盖且保持 pending，正式 content 不变", () => {
    const first = applyProvisionalAnswer(pending, delta)
    const next = applyProvisionalAnswer(first, {...delta, text: "完整临时回答"})
    expect(next).toEqual({...pending, provisionalContent: "完整临时回答", provisionalCallSeq: 1})
  })
  it("reset 清空，较早调用的延迟事件不能覆盖新回答", () => {
    const current = applyProvisionalAnswer(pending, {...delta, call_seq: 2})
    expect(applyProvisionalAnswer(current, {type: "answer_reset", call_seq: 1, reason: "superseded"})).toEqual(current)
    expect(applyProvisionalAnswer(current, delta)).toEqual(current)
    expect(applyProvisionalAnswer(current, {type: "answer_reset", call_seq: 2, reason: "tool_call"}).provisionalContent).toBe("")
  })
  it("最终快照与失败收尾移除临时字段，后续流式事件不再生效", () => {
    const current = applyProvisionalAnswer(pending, delta)
    for (const status of ["done", "error"]) {
      const finalized = {...clearProvisionalAnswer(current), content: "权威快照", status}
      expect(finalized).not.toHaveProperty("provisionalContent")
      expect(applyProvisionalAnswer(finalized, delta)).toEqual(finalized)
    }
  })
});
