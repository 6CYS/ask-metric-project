import { describe, expect, it } from "vitest"
import { createSSRApp, type Component } from "vue"
import { renderToString } from "vue/server-renderer"
import EvaluationDatasetPanel from "../src/components/evaluation/EvaluationDatasetPanel.vue"
import EvaluationTurnDetail from "../src/components/evaluation/EvaluationTurnDetail.vue"
import EvaluationRunPanel from "../src/components/evaluation/EvaluationRunPanel.vue"
import EvaluationRunList from "../src/components/evaluation/EvaluationRunList.vue"
import { runFixture, reportEvidenceFixture } from "./evaluationFixtures"

describe("测评正文与业务复核展示", () => {
  it("删除未完成批次保留继续删除入口，停止展示可复核结果", async () => {
    const run = runFixture({ status: "deleting" })
    const html = await renderToString(
      createSSRApp(EvaluationRunPanel as Component, {
        run,
        selectedTurnId: "",
        busy: false,
      }),
    )
    expect(html).toContain("删除未完成")
    expect(html).toContain("继续删除")
    expect(html).not.toContain("查看并复核")
    expect(html).not.toContain("新建批次重跑")
  })
  it("问题集空态不预置业务题目", async () => {
    const html = await renderToString(
      createSSRApp(EvaluationDatasetPanel as Component, { datasets: [], busy: false }),
    )
    expect(html).toContain("暂无问题集")
    expect(html).toContain("新建问题集")
  })
  it("执行完成仍显示待复核，不伪称业务通过", async () => {
    const html = await renderToString(
      createSSRApp(EvaluationRunPanel as Component, {
        run: runFixture(),
        selectedTurnId: "",
        busy: false,
      }),
    )
    expect(html).toContain("执行结束")
    expect(html).toContain("待复核")
    expect(html).not.toContain("100%")
  })
  it("冻结人工期望与实际正文分别展示，正文不注入原始HTML", async () => {
    const run = runFixture()
    const turn = run.turns[0]!
    const html = await renderToString(
      createSSRApp(EvaluationTurnDetail as Component, {
        detail: {
          turn,
          messages: [
            { role: "assistant", text: "实际正文<script>alert(1)</script>", timestamp: null },
          ],
        },
        loading: false,
        error: "",
        busy: false,
      }),
    )
    expect(html).toContain("人工期望")
    expect(html).toContain("业务确认")
    expect(html).toContain("实际正文")
    expect(html).not.toContain("<script>alert(1)</script>")
  })
  it("正式报告图表作为图形展示，不能只出现在原始JSON里", async () => {
    const html = await renderToString(
      createSSRApp(EvaluationTurnDetail as Component, {
        detail: {
          turn: runFixture().turns[0],
          messages: [
            {
              role: "tool",
              tool: "business_report",
              details: reportEvidenceFixture,
              is_error: false,
              timestamp: null,
            },
          ],
        },
        loading: false,
        error: "",
        busy: false,
      }),
    )
    expect(html).toContain('role="img"')
    expect(html).toContain("隔离样本变化")
    expect(html).toContain("隔离样本范围")
  })
})

it.each([EvaluationRunPanel, EvaluationRunList])(
  "停止未确认时保留可用的重新确认入口",
  async (component) => {
    const run = runFixture({ status: "cancelling", finished_at: null })
    run.turns[0]!.status = "failed"
    run.turns[0]!.result = {
      status: "failed",
      user_entry_id: "entry",
      operation_id: "operation",
      run_status: null,
      answer_status: null,
      error_code: "EVALUATION_CANCEL_UNCONFIRMED",
      error_message: "无法确认原操作已停止",
      timings_ms: {},
    }
    const html = await renderToString(
      createSSRApp(component as Component, {
        run,
        runs: [run],
        selectedId: "",
        selectedTurnId: "",
        busy: false,
      }),
    )
    const retry = html.match(
      /<button\b([^>]*)>(?:<!--.*?-->)*重新确认停止(?:<!--.*?-->)*<\/button>/,
    )
    expect(retry).not.toBeNull()
    expect(retry?.[1]).not.toMatch(/\sdisabled(?:\s|=|$)/)
  },
)
