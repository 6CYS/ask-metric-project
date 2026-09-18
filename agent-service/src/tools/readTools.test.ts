/**
 * 只读工具测试：metric_read 任务/结果分页、session_history_read 列表与精确回读。
 * 后端与原生历史均以桩替代；不触发 SQL 或重算。
 */
import { describe, expect, it } from "vitest";
import { BackendApiError, type BackendClient } from "../backendClient.js";
import type { HistoryBridge } from "../requestContext.js";
import { createMetricReadTool, createSessionHistoryReadTool } from "./readTools.js";
import { MemoryCommandBridge, receiptJson, runTool, testRequestContext } from "./testUtils.js";

function backendWithResult(): BackendClient {
  const backend = {
    async getTask() {
      return {
        task_id: "task-1",
        conversation_id: "conv-1",
        version: 4,
        status: "WAITING_USER",
        clarification: { id: "cl-1", prompt: "请补充日期" },
      };
    },
    async getTaskResult(_taskId: string, offset = 0, limit = 20) {
      return {
        task_id: "task-1",
        result_id: "result:task-1",
        status: "succeeded",
        query_shape: "metric_value",
        columns: ["org_name", "metric_value"],
        rows: [{ org_name: "无锡分行", metric_value: "15147420074.00" }],
        comparisons: [],
        row_count: 1,
        truncated: false,
        offset,
        limit,
        next_offset: null,
        has_more: false,
        message: null,
        evidence: {},
      };
    },
  };
  return backend as unknown as BackendClient;
}

describe("metric_read", () => {
  it("task 模式返回状态、版本与澄清目标", async () => {
    const bridge = new MemoryCommandBridge();
    const request = testRequestContext(backendWithResult(), bridge);
    const result = await runTool(createMetricReadTool(), { kind: "task", task_id: "task-1" }, request);
    const payload = receiptJson(result);
    expect(payload.status).toBe("WAITING_USER");
    expect(payload.version).toBe(4);
    expect((payload.clarification as { id: string }).id).toBe("cl-1");
    // 只读调用不消耗写意图名额
    expect(bridge.record).toBeUndefined();
  });

  it("result 模式返回分页事实；result_id 不一致时明确报错", async () => {
    const request = testRequestContext(backendWithResult(), new MemoryCommandBridge());
    const tool = createMetricReadTool();
    const page = await runTool(
      tool,
      { kind: "result", task_id: "task-1", result_id: "result:task-1", offset: 0, limit: 20 },
      request,
    );
    const payload = receiptJson(page);
    expect(payload.status).toBe("succeeded");
    expect(payload.row_count).toBe(1);
    expect(payload.has_more).toBe(false);

    const mismatch = await runTool(
      tool,
      { kind: "result", task_id: "task-1", result_id: "result:other" },
      request,
    );
    expect((receiptJson(mismatch).error as { code: string }).code).toBe("RESULT_MISMATCH");
  });
});

describe("session_history_read", () => {
  const history: HistoryBridge = {
    async list(beforeSeq, limit = 10) {
      void beforeSeq;
      return {
        entries: [
          { entry_id: "e2", seq: 2, type: "message", preview: "[user] 那江阴呢？" },
          { entry_id: "e1", seq: 1, type: "message", preview: "[user] 查询存款余额" },
        ].slice(0, limit),
        next_before_seq: 1,
        has_more: false,
      };
    },
    async read(entryId, offset = 0, length = 4000) {
      if (entryId !== "e2") return null;
      const text = "那江阴呢？";
      return { entry_id: "e2", seq: 2, type: "message", text: [...text].slice(offset, offset + length).join(""), next_offset: null };
    },
  };

  it("list 返回条目摘要与游标", async () => {
    const request = testRequestContext(
      backendWithResult(),
      new MemoryCommandBridge(),
      { history },
    );
    const result = await runTool(createSessionHistoryReadTool(), { kind: "list", limit: 10 }, request);
    const payload = receiptJson(result);
    expect(payload.status).toBe("ok");
    expect((payload.entries as unknown[]).length).toBe(2);
    expect(payload.next_before_seq).toBe(1);
  });

  it("entry 精确回读；不可访问的条目返回明确错误", async () => {
    const request = testRequestContext(
      backendWithResult(),
      new MemoryCommandBridge(),
      { history },
    );
    const tool = createSessionHistoryReadTool();
    const hit = await runTool(tool, { kind: "entry", entry_id: "e2" }, request);
    expect(receiptJson(hit).text).toBe("那江阴呢？");

    const missing = await runTool(tool, { kind: "entry", entry_id: "nope" }, request);
    expect((receiptJson(missing).error as { code: string }).code).toBe("ENTRY_NOT_FOUND");
  });

  it("只读工具异常映射为可读错误", async () => {
    const backend = {
      async getTask() {
        throw new BackendApiError(404, "not found", "TASK_NOT_FOUND");
      },
    } as unknown as BackendClient;
    const request = testRequestContext(backend, new MemoryCommandBridge());
    const result = await runTool(createMetricReadTool(), { kind: "task", task_id: "task-x" }, request);
    expect(receiptJson(result).status).toBe("error");
  });
});
