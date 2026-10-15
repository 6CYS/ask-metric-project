import { describe, expect, it } from "vitest"
import type { ChatResponse } from "@/types/api"
import { friendlyQueryError, withFailureNotice } from "../../src/lib/queryErrors"

const notice = "本轮模型响应未完成；已取得的步骤结果仍可查看，请重试未完成部分。"

it.each([
  ["MODEL_FIRST_RESPONSE_TIMEOUT", "模型服务响应超时，请稍后重试。已确认的查询条件仍保留，无需重复输入。"],
  ["MODEL_STREAM_IDLE_EXCEEDED", "模型输出长时间没有进展，本轮未完成。已确认的查询条件仍保留，无需重复输入。"],
])("仅收到终态码 %s 时仍能显示对应提示并隐藏内部错误", (code, expected) => {
  expect(friendlyQueryError("private gateway response", code)).toBe(expected)
})

describe("同一轮失败提示", () => {
  it.each([notice, `结果正文\n${notice}`, `结果正文\n\n${notice}\n`])("正文已有失败说明时不重复追加：%s", (content) => {
    expect(withFailureNotice({ content }, notice).content).toBe(content.trimEnd())
  })

  it("空答案只显示一次失败，后续终态和异常不叠加通用提示", () => {
    const projected = withFailureNotice({ content: "" }, notice)
    const terminal = withFailureNotice(projected, "本次查询暂未完成。请稍后重新查询。")
    expect(withFailureNotice(terminal, "暂时无法连接问数服务。")).toEqual(projected)
    expect(projected.content).toBe(notice)
  })

  it("保留正常正文中的重复内容与结果表，结构化答案同步提示", () => {
    const content = "合法重复\n合法重复"
    const response = { answer: content, answer_blocks: [{ type: "paragraph", text: content }], result: { table: { columns: ["value"], rows: [{ value: 12 }] } } } as unknown as ChatResponse
    const failed = withFailureNotice({ content, response }, notice)
    expect(failed.content).toBe(`${content}\n${notice}`)
    expect(failed.response?.answer).toBe(failed.content)
    expect(failed.response?.answer_blocks).toBeUndefined()
    expect(failed.response?.result).toBe(response.result)
    expect(withFailureNotice(failed, notice)).toEqual(failed)
  })
})
