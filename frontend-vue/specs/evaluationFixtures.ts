import type { EvaluationRun } from "../src/types/evaluation"

export function runFixture(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: "run-a",
    name: "隔离测试批次",
    status: "completed",
    dataset: {
      id: "dataset-a",
      name: "隔离题集",
      description: "仅供单元测试",
      version: 1,
      updated_at: "2026-11-02T00:00:00Z",
      groups: [
        {
          id: "group-a",
          name: "连续会话",
          turns: [{ id: "turn-a", question: "首问", expected: "业务确认" }],
        },
      ],
    },
    dataset_hash: "dataset-hash",
    version_label: "版本A",
    data_label: "人工登记条件",
    model: "configured-model",
    config_hash: "config-a",
    actor: { id: "actor-a", name: "测试账号", org_code: "org-a", role_code: "user" },
    created_at: "2026-11-02T00:00:00Z",
    finished_at: "2026-11-02T00:01:00Z",
    turns: [
      {
        id: "turn-a",
        group_id: "group-a",
        question: "首问",
        expected: "业务确认",
        status: "completed",
        session_id: "session-a",
        request_id: "request-a",
        started_at: null,
        finished_at: null,
        result: null,
        review: null,
      },
    ],
    ...overrides,
  }
}

// 仅验证正式报告展示契约，不作为运行数据或业务验收结果。
export const reportEvidenceFixture = {
  kind: "business_report" as const,
  status: "succeeded",
  public_answer: "隔离报告正文。",
  report: {
    summary: "隔离报告正文。",
    sections: [],
    plans: [],
    charts: [
      {
        type: "bar" as const,
        title: "隔离样本变化",
        dates: ["2026-11-01"],
        unit: "元",
        source_refs: ["fixture-a", "fixture-b"],
        points: [
          { name: "样本A", value: "1.20", display: "1.20元" },
          { name: "样本B", value: "-0.50", display: "-0.50元" },
        ],
      },
    ],
    presentation: {
      version: 1,
      body_mode: "narrative" as const,
      scope: "隔离样本范围",
      source_notices: ["隔离来源"],
      limitations: ["仅供契约验证"],
    },
  },
}
