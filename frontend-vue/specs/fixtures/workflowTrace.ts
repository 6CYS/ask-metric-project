import type { WorkflowTrace } from "../../src/lib/workflowTrace"

export const workflowTrace: WorkflowTrace = {
  schema_version: 1, workflow_id: "profitability_ranking_v1", name: "机构盈利排名及原因分析",
  version: "synthetic-v1", phase: "executed", outcome: "answered", run_ref: "synthetic-run",
  basis: "按净利润金额比较高低，不等同于综合经营好坏",
  retrieval: {strategy: "embedding_milvus_rerank", embedding_model: "BAAI/bge-m3", reranker_model: "BAAI/bge-reranker-v2-m3",
    matched_document: {id: "synthetic-description", text: "先按净利润金额排名，再核对入选机构收入成本。"},
    rerank_score: 0.93, other_class_score: 0.1, min_score: 0.5, min_margin: 0.04},
  date_policy: {mode: "exact", requested_start: "2026-07-31", requested_end: "2026-07-31", actual_dates: ["2026-07-31"]},
  coverage: {requested_org_count: 20, valid_org_count: 18},
  interpretation: ["收入成本观测不能单独证明业务原因。"],
  steps: [{id: "rank", method: "ranking", rationale: "同日有效净利润排序，不补零", status: "completed",
    position: "bottom", top_n: 1, metrics: [{name: "合成净利润金额"}], fact_count: 18, org_count: 18, task_count: 2,
    actual_dates: ["2026-07-31"]},
  {id: "drivers", method: "observe", rationale: "定向核对收入成本", status: "partial", depends_on: ["rank"],
    organization_from_step: "rank", metrics: [{name: "合成营业收入"}], fact_count: 1, org_count: 1, task_count: 1,
    gaps: ["合成成本缺失，不补零"]}],
}
