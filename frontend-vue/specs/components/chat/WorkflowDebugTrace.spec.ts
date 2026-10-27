import { describe, expect, it } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import BackendNextDebugPanel from "../../../src/components/chat/BackendNextDebugPanel.vue"
import { workflowTrace } from "../../fixtures/workflowTrace"

const render = (trace = workflowTrace) => renderToString(createSSRApp(BackendNextDebugPanel,
  {question: "合成问题", workflowTraces: [trace]}))

describe("路线调试面板", () => {
  it("无 QueryTask 仍展示召回依据、口径、计划和真实步骤结果", async () => {
    const html = await render()
    for (const text of ["召回依据", "BAAI/bge-m3", "BAAI/bge-reranker-v2-m3", "0.930", "0.830",
      "从低到高取 1 家", "合成净利润金额", "定向核对收入成本", "部分取得数据", "合成成本缺失，不补零",
      "目标 20 家，同日有效 18 家", "保留指定日期", "判断依据与边界"]) expect(html).toContain(text)
    expect(html).not.toContain("尚未创建 QueryTask")
    expect(html).not.toContain("undefined")
  })
  it("正常缺数明确展示保留日期及未补查，不标执行失败", async () => {
    const html = await render({...workflowTrace, outcome: "no_data",
      date_policy: {...workflowTrace.date_policy, requested_start: "2026-08-31", requested_end: "2026-08-31", actual_dates: []},
      steps: [{...workflowTrace.steps[0]!, status: "no_data", fact_count: 0, org_count: 0, actual_dates: []},
        {...workflowTrace.steps[1]!, status: "skipped_no_data", fact_count: 0, org_count: 0}]})
    expect(html).toContain("正常缺数")
    expect(html).toContain("2026-08-31")
    expect(html).toContain("因排名无数据未补查")
    expect(html).not.toContain("执行失败")
  })
  it("待执行和失败分别展示，不把计划当成成功结果", async () => {
    const planned = await render({...workflowTrace, phase: "awaiting_input", outcome: undefined,
      steps: [{id: "rank", method: "ranking", status: "not_started", position: "top", top_n: 3}]})
    expect(planned).toContain("待确认条件")
    expect(planned).toContain("尚未执行")
    expect(planned).not.toContain("已完成")
    const failed = await render({...workflowTrace, outcome: "unavailable",
      steps: [{id: "rank", method: "ranking", status: "failed", error_code: "QUERY_TIMEOUT"}]})
    expect(failed).toContain("执行失败")
    expect(failed).toContain("QUERY_TIMEOUT")
    expect(failed).not.toContain("正常缺数")
  })
})
