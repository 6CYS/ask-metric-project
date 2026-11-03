import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import EvaluationComparison from "../src/components/evaluation/EvaluationComparison.vue"
import EvaluationEvidenceComparison from "../src/components/evaluation/EvaluationEvidenceComparison.vue"
import { compareEvaluationRuns } from "../src/lib/evaluation"
import type { EvaluationTurnDetail } from "../src/types/evaluation"
import { runFixture } from "./evaluationFixtures"

describe("测评依据对比", () => {
  it("每题提供成对查看入口，并保留两侧的单次详情入口", async () => {
    const html = await renderToString(
      createSSRApp(EvaluationComparison as Component, {
        runs: [runFixture({ id: "run-new" }), runFixture({ id: "run-old" })],
      }),
    )
    expect(html).toContain('aria-label="对比依据：首问"')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/查看依据/g)).toHaveLength(2)
  })

  const before = runFixture({ id: "run-old", name: "基准批次" })
  const after = runFixture({ id: "run-new", name: "对比批次" })
  const beforeDetail: EvaluationTurnDetail = {
    turn: before.turns[0]!,
    messages: [{ role: "assistant", text: "基准回答：余额100万元。", timestamp: null }],
  }
  const afterDetail: EvaluationTurnDetail = {
    turn: after.turns[0]!,
    messages: [{ role: "assistant", text: "对比回答：余额120万元。", timestamp: null }],
  }

  it("两侧正文属于各自批次，执行完成不会代替人工复核", async () => {
    const html = await renderToString(
      createSSRApp(EvaluationEvidenceComparison as Component, {
        before,
        after,
        row: compareEvaluationRuns(before, after).rows[0],
        beforeDetail: { detail: beforeDetail, loading: false, error: "" },
        afterDetail: { detail: afterDetail, loading: false, error: "" },
      }),
    )
    const left = html.split('aria-label="基准结果"')[1]?.split("</article>")[0]
    const right = html.split('aria-label="对比结果"')[1]?.split("</article>")[0]
    expect(left).toContain("基准回答：余额100万元。")
    expect(left).not.toContain("对比回答")
    expect(right).toContain("对比回答：余额120万元。")
    expect(right).not.toContain("基准回答")
    expect(left).toContain("待复核")
    expect(right).toContain("待复核")
  })

  it("单侧无权读取时保留另一侧正文，提供对应侧重试入口", async () => {
    const html = await renderToString(
      createSSRApp(EvaluationEvidenceComparison as Component, {
        before,
        after,
        row: compareEvaluationRuns(before, after).rows[0],
        beforeDetail: { detail: null, loading: false, error: "没有权限读取该会话。" },
        afterDetail: { detail: afterDetail, loading: false, error: "" },
      }),
    )
    expect(html).toContain("没有权限读取该会话。")
    expect(html).toContain('aria-label="重新读取基准结果依据"')
    expect(html).toContain("对比回答：余额120万元。")
    expect(html).not.toContain("基准回答：余额100万元。")
  })

  it("缺少对应题目时显示缺项，不把单侧结果当成可比", async () => {
    const missing = runFixture({ id: "run-missing", turns: [] })
    const html = await renderToString(
      createSSRApp(EvaluationEvidenceComparison as Component, {
        before: missing,
        after,
        row: compareEvaluationRuns(missing, after).rows[0],
        beforeDetail: { detail: null, loading: false, error: "" },
        afterDetail: { detail: afterDetail, loading: false, error: "" },
      }),
    )
    expect(html).toContain("该批次没有此题")
    expect(html).toContain("比较条件存在差异")
    expect(html).toContain("仅对比批次")
    expect(html).toContain("对比回答：余额120万元。")
  })
})
