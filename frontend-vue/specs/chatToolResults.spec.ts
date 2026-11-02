import { describe, expect, it } from "vitest"
import { applyChatToolResult, type ChatToolResultState } from "../src/lib/chatToolResults"

// 仅验证服务端回执的展示转换，隔离样本不用于实际问数。
describe("实时与历史共用的工具结果转换", () => {
  const initial: ChatToolResultState = { content: "" }
  const report = {
    kind: "business_report",
    status: "succeeded",
    public_answer: "两家情况如下。",
    rows: [{ org_name: "甲行", metric_value: "-0.001", unit: "元" }],
    report: {
      summary: "两家情况如下。",
      sections: [],
      plans: [],
      charts: [
        {
          type: "bar",
          source_refs: ["a", "b"],
          points: [
            { name: "甲行", value: "-0.001" },
            { name: "乙行", value: "1" },
          ],
        },
      ],
    },
  }
  it("正文、明细和图表原样保持，不因 JSON 历史重放改数或重新生成答案", () => {
    const live = applyChatToolResult(initial, report)
    const restored = applyChatToolResult(initial, JSON.parse(JSON.stringify(report)) as unknown)
    expect(live).toEqual(restored)
    expect(live.content).toBe(report.public_answer)
    expect(live.metricAskDetails).toEqual(report)
    expect(initial).toEqual({ content: "" })
  })
  it("未选中的失败尝试与内部查询证据不能覆盖已交付正文", () => {
    const delivered = applyChatToolResult(initial, report)
    for (const receipt of [
      { ...report, answer_selected: false, public_answer: "不应显示" },
      { kind: "analysis_evidence", status: "succeeded", content: "{内部资料}" },
      { kind: "metric_read", status: "SUCCEEDED", task_id: "t" },
    ])
      expect(applyChatToolResult(delivered, receipt)).toEqual(delivered)
  })
  it("计算恢复成功后移除失败提示，同时保留真实任务和计算引用", () => {
    let state = applyChatToolResult(initial, {
      kind: "metric_calculate",
      status: "error",
      retryable: true,
    })
    const calculation = {
      kind: "metric_calculate",
      status: "succeeded",
      task_id: "task-1",
      calculation_id: "calculation-1",
      results: [],
    }
    state = applyChatToolResult(state, calculation)
    expect(state.calculations).toEqual([calculation])
    expect(state.taskIds).toEqual(["task-1"])
    expect(state.content).toBe("")
  })
  it("覆盖失败与没有数据不同，成功回执清除旧错误", () => {
    const failed = applyChatToolResult(initial, { kind: "data_availability", status: "error" })
    expect(failed.availabilityError).toContain("不代表没有数据")
    const succeeded = applyChatToolResult(failed, {
      kind: "data_availability",
      status: "succeeded",
      groups: [],
      notice: "没有记录",
    })
    expect(succeeded.availabilityError).toBeUndefined()
    expect(succeeded.availability).toHaveLength(1)
    expect(succeeded.content).toBe("")
  })
  it("澄清目标只沿用服务端发布的版本，成功后退出待澄清状态", () => {
    const receipt = {
      kind: "metric_ask",
      status: "clarification_required",
      task_id: "task-1",
      clarification: { id: "choice-1", prompt: "选择口径" },
      clarification_prompt: "选择口径",
    }
    const unknownVersion = applyChatToolResult(initial, receipt)
    expect(unknownVersion.clarificationTarget).toBeUndefined()
    const confirmed = applyChatToolResult(initial, { ...receipt, version: 3 })
    expect(confirmed.clarificationTarget).toEqual({
      task_id: "task-1",
      version: 3,
      clarification_id: "choice-1",
    })
    const result = applyChatToolResult(confirmed, report)
    expect(result.metricAskClarification).toBeUndefined()
    expect(result.clarificationTarget).toBeUndefined()
  })
  it("正式交付结束旧澄清，刷新恢复不再用旧问题覆盖答案", () => {
    const clarification = applyChatToolResult(initial, {
      kind: "metric_ask",
      status: "clarification_required",
      task_id: "t",
      version: 2,
      clarification: { id: "choice", prompt: "选择口径" },
      clarification_prompt: "选择口径",
    })
    const delivered = applyChatToolResult(clarification, {
      kind: "answer_present",
      delivery: "business_answer_v1",
      status: "delivered",
      public_answer: "正式回答",
    })
    expect(delivered.content).toBe("正式回答")
    expect(delivered.metricAskClarification).toBeUndefined()
    expect(delivered.metricAskClarificationPrompt).toBeUndefined()
    expect(delivered.clarificationTarget).toBeUndefined()
  })
  it("旧原生正文继续保留，确定交付可明确替换正文", () => {
    const state = { ...initial, nativeAnswer: true, content: "历史自然回答" }
    expect(applyChatToolResult(state, report).content).toBe("历史自然回答")
    expect(
      applyChatToolResult(state, {
        kind: "answer_present",
        delivery: "business_answer_v1",
        status: "delivered",
        public_answer: "可靠部分结果",
      }),
    ).toMatchObject({
      content: "可靠部分结果",
      answerDelivered: true,
    })
  })

  it("未完成回执统一结束正文与澄清，但不构造成功查询或图表", () => {
    const state: ChatToolResultState = {
      content: "尚未核验的临时正文",
      nativeAnswer: true,
      metricAskClarification: { id: "choice", prompt: "选择口径", type: "metric", options: [] },
      metricAskClarificationPrompt: "选择口径",
      clarificationTarget: { task_id: "task-1", version: 1, clarification_id: "choice" },
      queryResults: [],
      calculations: [],
    }
    const receipt = {
      kind: "runtime_delivery",
      version: 1,
      operation_id: "op-1",
      status: "delivered",
      outcome: "incomplete",
      public_answer: "本次回答整理未完成，请稍后重试。",
      error_code: "ANALYSIS_REPORT_FORMAT",
    }
    const live = applyChatToolResult(state, receipt)
    const restored = applyChatToolResult(state, JSON.parse(JSON.stringify(receipt)) as unknown)
    expect(live).toEqual(restored)
    expect(live.content).toBe(receipt.public_answer)
    expect(live.answerDelivered).toBe(true)
    expect(live.metricAskClarification).toBeUndefined()
    expect(live.metricAskClarificationPrompt).toBeUndefined()
    expect(live.clarificationTarget).toBeUndefined()
    expect(live.metricAskDetails).toBeUndefined()
    expect(live.queryResults).toBe(state.queryResults)
    expect(live.calculations).toBe(state.calculations)
    expect(applyChatToolResult(state, { ...receipt, version: 2 })).toBe(state)
    expect(applyChatToolResult(state, { ...receipt, status: "pending" })).toBe(state)
  })
})
