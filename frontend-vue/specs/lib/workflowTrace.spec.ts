import { describe, expect, it } from "vitest"
import { workflowTracesFromDetails } from "../../src/lib/workflowTrace"
import { workflowTrace } from "../fixtures/workflowTrace"

describe("标准分析路线回执读取", () => {
  it("实时原生回执和历史浏览器投影得到相同路线", () => {
    const raw = {protocol_version: 2, state: {}, workflow_trace: workflowTrace}
    expect(workflowTracesFromDetails(raw)).toEqual([workflowTrace])
    expect(workflowTracesFromDetails({kind: "semantic_results", semantic_task: raw})).toEqual([workflowTrace])
  })
  it("旧回执、普通查询和未知版本不猜测路线", () => {
    for (const value of [null, {}, {plan: {workflow_id: "profitability_ranking_v1"}},
      {workflow_trace: {...workflowTrace, schema_version: 2}}, {content: "模型规划：查利润"}]) {
      expect(workflowTracesFromDetails(value)).toEqual([])
    }
  })
  it("畸形步骤与非有限得分不破坏调试面板", () => {
    expect(workflowTracesFromDetails({workflow_trace: {...workflowTrace, steps: [null]}})).toEqual([])
    expect(workflowTracesFromDetails({workflow_trace: {...workflowTrace,
      retrieval: {...workflowTrace.retrieval, rerank_score: Infinity}}})).toEqual([])
  })
})
