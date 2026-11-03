import { describe, expect, it, vi } from "vitest"
import {
  compareEvaluationRuns,
  createEvaluationId,
  evaluationSummary,
  parseDatasetInput,
  evaluationEvidenceResponse,
} from "../src/lib/evaluation"
import { runFixture, reportEvidenceFixture } from "./evaluationFixtures"

describe("测评业务统计", () => {
  it("执行完成但未人工复核，不能计为业务通过", () => {
    expect(evaluationSummary(runFixture())).toEqual({
      total: 1,
      completed: 1,
      passed: 0,
      failed: 0,
      pendingReview: 1,
      executionFailed: 0,
    })
  })
  it("执行失败时历史通过标记不能抵消执行失败", () => {
    const run = runFixture()
    run.turns[0]!.status = "failed"
    run.turns[0]!.review = { verdict: "passed", note: "", updated_at: "", reviewer: "" }
    expect(evaluationSummary(run).passed).toBe(0)
    expect(evaluationSummary(run).executionFailed).toBe(1)
  })
})

describe("版本逐题对比", () => {
  it("按稳定题目身份对齐，问题变化不能算作改进", () => {
    const before = runFixture()
    const after = runFixture({ id: "run-b", model: "another-model", config_hash: "config-b" })
    after.turns[0]!.question = "已修改问题"
    const comparison = compareEvaluationRuns(before, after)
    expect(comparison.rows[0]?.comparable).toBe(false)
    expect(comparison.rows[0]?.changes).toContain("问题变化")
    expect(comparison.contextDifferences).toContain("模型不同")
    expect(comparison.contextDifferences).toContain("运行配置不同")
  })
  it("追问文字没变但前序问题变化时，也不能直接判断改进", () => {
    const before = runFixture()
    const after = runFixture({ id: "run-b" })
    const followUp = { id: "follow-up", question: "继续比较", expected: "核对同一对象" }
    for (const run of [before, after]) {
      run.dataset.groups[0]!.turns.push({ ...followUp })
      run.turns.push({ ...run.turns[0]!, ...followUp })
    }
    after.dataset.groups[0]!.turns[0]!.question = "换了业务目标的首问"
    const followUpComparison = compareEvaluationRuns(before, after).rows.find(
      (row) => row.id === "follow-up",
    )
    expect(followUpComparison?.comparable).toBe(false)
    expect(followUpComparison?.changes).toEqual(["前序会话变化"])
  })
  it("新题和删题保留，不按数组位置配对", () => {
    const before = runFixture()
    const after = runFixture({ id: "run-b" })
    after.turns[0]!.id = "new-turn"
    expect(compareEvaluationRuns(before, after).rows.map((row) => [row.id, row.changes])).toEqual([
      ["turn-a", ["仅基准批次"]],
      ["new-turn", ["仅对比批次"]],
    ])
  })
})

describe("问题集导入", () => {
  it("保留分组顺序、稳定ID与人工期望，不把期望补成标准答案", () => {
    const input = {
      name: "真实数据由用户导入",
      description: "",
      groups: [
        {
          id: "g1",
          name: "会话一",
          turns: [
            { id: "q1", question: "第一问", expected: "" },
            { id: "q2", question: "继续追问", expected: "待业务复核" },
          ],
        },
      ],
    }
    expect(parseDatasetInput(JSON.stringify(input))).toEqual(input)
  })
  it("拒绝重复轮次ID与超过100轮的题集", () => {
    const groups = [
      {
        id: "g",
        name: "组",
        turns: [
          { id: "q", question: "问", expected: "" },
          { id: "q", question: "追问", expected: "" },
        ],
      },
    ]
    expect(() =>
      parseDatasetInput(JSON.stringify({ name: "题集", description: "", groups })),
    ).toThrow("重复")
    groups[0]!.turns = Array.from({ length: 101 }, (_, index) => ({
      id: `q${index}`,
      question: "问",
      expected: "",
    }))
    expect(() =>
      parseDatasetInput(JSON.stringify({ name: "题集", description: "", groups })),
    ).toThrow("100")
  })
})

describe("测评正式报告转换", () => {
  it("没有表格行的报告仍保留来源范围与真实图表", () => {
    const response = evaluationEvidenceResponse(reportEvidenceFixture, "message-a")
    expect(response?.analysis_report?.charts).toEqual(reportEvidenceFixture.report.charts)
    expect(response?.analysis_report?.scope).toBe("隔离样本范围")
    expect(response?.analysis_report?.source_notices).toEqual(["隔离来源"])
    expect(response?.result).toBeNull()
  })
  it("缺少有效来源的图表仍由公共展示契约拒绝，保留合法正文", () => {
    const invalid = {
      ...reportEvidenceFixture,
      report: {
        ...reportEvidenceFixture.report,
        charts: reportEvidenceFixture.report.charts.map((chart) => ({ ...chart, source_refs: [] })),
      },
    }
    expect(
      evaluationEvidenceResponse(invalid, "message-a")?.analysis_report?.charts,
    ).toBeUndefined()
    expect(evaluationEvidenceResponse(invalid, "message-a")?.analysis_report?.summary).toBe(
      "隔离报告正文。",
    )
  })
})

describe("问题集身份兼容", () => {
  it("缺少 randomUUID 时仍可生成互不重复且可保存的题目身份", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal("crypto", { getRandomValues })
    try {
      const groupId = createEvaluationId()
      const questionIds = [createEvaluationId(), createEvaluationId()]
      const input = parseDatasetInput({
        name: "兼容性检查",
        description: "",
        groups: [
          {
            id: groupId,
            name: "连续问题",
            turns: questionIds.map((id) => ({ id, question: "待核对问题", expected: "" })),
          },
        ],
      })
      expect(new Set([groupId, ...questionIds]).size).toBe(3)
      expect(input.groups[0]?.turns.map((turn) => turn.id)).toEqual(questionIds)
      expect(
        [groupId, ...questionIds].every((id) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)),
      ).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
