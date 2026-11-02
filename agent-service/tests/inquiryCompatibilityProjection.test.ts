import { describe, expect, it, vi } from "vitest";
import type { Entry, LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { AnswerReceipt, PendingQuestion } from "../src/semantic-task/questions.js";
import { semanticFeedback } from "../src/semantic-task/feedback.js";
import {
  projectEntries,
  projectQuestionStates,
  projectSnapshot,
  projectWatchEvent,
  type ProjectedQuestionState,
} from "../src/sessionProjection.js";
import { LEGACY_OPERATION_INTERRUPTED_MESSAGE } from "../src/inquiry/legacyRecovery.js";

const question: PendingQuestion = {
  question_id: "published-question",
  version: 2,
  kind: "choice",
  scope: { task_ref: "old-task", target_ref: "old-target", field: "metrics", item_ref: "item-1" },
  prompt: "请选择需要查询的指标。",
  selection_mode: "single",
  options: [{ option_id: "metric-one", no: 1, label: "测试余额" }],
  status: "open",
  issued_operation_id: "old-operation",
};

function user(receipts: AnswerReceipt[] = []): Entry {
  const message = {
    role: "user" as const,
    content: "",
    displayText: "已选择测试余额",
    timestamp: 30,
    businessProtocol: "inquiry_v1",
    inquiryAdmission: { targets: [], answerReceipts: receipts },
  };
  return { type: "message", id: "new-user", parentId: "old-card", seq: 3, timestamp: 30, message };
}

function tool(id: string, details: unknown, toolName = "resolve_business_turn"): Entry {
  return {
    type: "message",
    id,
    parentId: null,
    seq: 2,
    timestamp: 20,
    message: {
      role: "toolResult",
      toolCallId: `${id}-call`,
      toolName,
      content: [{ type: "text", text: "" }],
      details,
      timestamp: 20,
      isError: false,
    },
  };
}

function card() {
  return tool("old-card", {
    ...semanticFeedback(undefined, "needs_user"),
    pending_questions: [question],
  });
}

function receipt(outcome: AnswerReceipt["outcome"], version = 2): AnswerReceipt {
  return { question_id: question.question_id, version, outcome, notice: "已处理本次选择。" };
}

function stateStore(states: ProjectedQuestionState[]) {
  return {
    questionStates: vi.fn((ids: readonly string[]) =>
      Promise.resolve(structuredClone(states.filter((state) => ids.includes(state.question_id)))),
    ),
  };
}

describe("inquiry 兼容输入的历史与刷新投影", () => {
  it.each([
    { outcome: "applied", status: "answered" },
    { outcome: "declined", status: "rejected" },
  ] as const)(
    "新用户回执 $outcome 更新旧卡片当前状态且不改历史题目",
    async ({ outcome, status }) => {
      const entries = [card(), user([receipt(outcome)])];
      const original = structuredClone(entries);
      const messages = projectEntries(entries);
      const store = stateStore([{ question_id: question.question_id, version: 2, status: "open" }]);
      expect(messages.at(-1)).toMatchObject({
        role: "user",
        text: "已选择测试余额",
        answer_receipts: [{ question_id: question.question_id, version: 2, outcome }],
      });
      expect(await projectQuestionStates(messages, store)).toEqual([
        { question_id: question.question_id, version: 2, status },
      ]);
      expect(entries).toEqual(original);
      const snapshot = projectSnapshot({ transcript: entries, operation: null } as LaneSnapshot);
      expect(snapshot.messages).toEqual(messages);
      expect(await projectQuestionStates(snapshot.messages, store)).toEqual([
        { question_id: question.question_id, version: 2, status },
      ]);
    },
  );

  it("旧版本或未应用回执不覆盖最新卡片状态", async () => {
    const entries = [card(), user([receipt("applied", 1), receipt("not_applied")])];
    const store = stateStore([{ question_id: question.question_id, version: 2, status: "open" }]);
    expect(await projectQuestionStates(projectEntries(entries), store)).toEqual([
      { question_id: question.question_id, version: 2, status: "open" },
    ]);
  });

  it("没有可见发布记录时不从用户回执补出已隐藏的卡片", async () => {
    const store = stateStore([{ question_id: question.question_id, version: 2, status: "open" }]);
    expect(
      await projectQuestionStates(projectEntries([user([receipt("applied")])]), store),
    ).toEqual([]);
    expect(store.questionStates).not.toHaveBeenCalled();
  });

  it("升级中断通知在GET与重连回放相同，并保留旧结果和新提问", () => {
    const oldResult = {
      kind: "metric_query_structured",
      status: "succeeded",
      task_id: "old-task",
      result_id: "old-result",
      columns: ["指标", "日期", "值"],
      rows: [{ 指标: "测试余额", 日期: "2026-06-30", 值: "10" }],
      row_count: 1,
    };
    const notice: Entry = {
      type: "custom",
      customType: "askmetric.legacy-interrupted",
      id: "notice",
      parentId: "old-result",
      seq: 3,
      timestamp: 25,
      data: { operation_id: "old-operation", message: "此字段不是公开通知" },
    };
    const entries = [tool("old-result", oldResult, "metric_query_structured"), notice, user()];
    const original = structuredClone(entries);
    const projected = projectEntries(entries);
    expect(projected.filter((message) => message.entry_id === "notice")).toEqual([
      {
        role: "assistant",
        text: LEGACY_OPERATION_INTERRUPTED_MESSAGE,
        tools: [],
        timestamp: 25,
        entry_id: "notice",
      },
    ]);
    expect(projected.find((message) => message.entry_id === "old-result")).toMatchObject({
      details: oldResult,
    });
    expect(projected.at(-1)).toMatchObject({ role: "user", text: "已选择测试余额" });
    expect(projectSnapshot({ transcript: entries, operation: null } as LaneSnapshot)).toEqual({
      running: false,
      operation_id: null,
      messages: projected,
    });
    expect(entries).toEqual(original);
    expect(JSON.stringify(projected)).not.toContain("此字段不是公开通知");
  });

  it("可信报告的时间备选在实时事件、历史和刷新中保持同一合同", () => {
    const details = {
      kind: "business_report",
      status: "succeeded",
      public_answer: "已查询所选期间。",
      time_variants: [{ label: "最近三个完整年度", start: "2023-01-01", end: "2025-12-31" }],
      report: { summary: "已查询所选期间。", sections: [], charts: [] },
    };
    const entries = [tool("new-report", details, "analysis_answer")];
    expect(
      projectWatchEvent({
        type: "tool_end",
        toolName: "analysis_answer",
        toolCallId: "new-report-call",
        result: { details },
        isError: false,
      }),
    ).toMatchObject({ type: "tool_end", details });
    const history = projectEntries(entries);
    expect(history.find((message) => message.role === "tool")).toMatchObject({ details });
    expect(
      projectSnapshot({ transcript: entries, operation: null } as LaneSnapshot).messages,
    ).toEqual(history);
  });
});
