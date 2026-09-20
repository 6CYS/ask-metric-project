/**
 * metric_ask 三动作与幂等契约测试（后端以桩替代，不连真实服务）：
 * - 澄清补充继续原任务，不新建任务（澄清错建任务回归）；
 * - clarify 版本冲突的受控刷新只放行一次；
 * - 同一 operation 第二个不同写意图返回 TURN_QUERY_LIMIT；
 * - new/followup 走稳定命令键，submit 丢响应时同键找回。
 */
import { describe, expect, it } from "vitest";
import { BackendApiError, type BackendClient } from "../backendClient.js";
import { createMetricAskTool } from "./metricAsk.js";
import { MemoryCommandBridge, receiptJson, runTool, testRequestContext } from "./testUtils.js";

interface StubSpec {
  submitQuestion?: (...args: unknown[]) => unknown;
  analyzeTask?: (...args: unknown[]) => unknown;
  executeTask?: (...args: unknown[]) => unknown;
  submitClarification?: (...args: unknown[]) => unknown;
  getTask?: (...args: unknown[]) => unknown;
  getTaskResult?: (...args: unknown[]) => unknown;
  lookupTask?: (...args: unknown[]) => unknown;
}

/** 记录调用的后端桩：只实现本次用到的接口 */
function stubBackend(spec: StubSpec) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend = {
    calls,
    submitQuestion: async (...args: unknown[]) => {
      calls.push({ method: "submitQuestion", args });
      return spec.submitQuestion
        ? spec.submitQuestion(...args)
        : { task_id: "task-1", conversation_id: "conv-1", version: 0, status: "RUNNING" };
    },
    analyzeTask: async (...args: unknown[]) => {
      calls.push({ method: "analyzeTask", args });
      return spec.analyzeTask
        ? spec.analyzeTask(...args)
        : { task_id: "task-1", conversation_id: "conv-1", version: 1, status: "RUNNING" };
    },
    executeTask: async (...args: unknown[]) => {
      calls.push({ method: "executeTask", args });
      return spec.executeTask
        ? spec.executeTask(...args)
        : {
            task_id: "task-1",
            status: "succeeded",
            query_shape: "metric_value",
            columns: ["org_name", "metric_value"],
            rows: [{ org_name: "无锡分行", metric_value: "15147420074.00", metric_name: "存款余额", stat_date: "2026-08-31", unit: "元" }],
            row_count: 1,
          };
    },
    submitClarification: async (...args: unknown[]) => {
      calls.push({ method: "submitClarification", args });
      return spec.submitClarification
        ? spec.submitClarification(...args)
        : { task_id: "task-1", conversation_id: "conv-1", version: 3, status: "RUNNING" };
    },
    getTask: async (...args: unknown[]) => {
      calls.push({ method: "getTask", args });
      return spec.getTask
        ? spec.getTask(...args)
        : {
            task_id: "task-1",
            conversation_id: "conv-1",
            version: 4,
            status: "WAITING_USER",
            clarification: { id: "cl-1", prompt: "请补充日期" },
          };
    },
    getTaskResult: async (...args: unknown[]) => {
      calls.push({ method: "getTaskResult", args });
      return spec.getTaskResult ? spec.getTaskResult(...args) : {
        task_id: "task-1", result_id: "result:task-1", status: "succeeded",
        columns: ["org_name", "metric_value"], rows: [{ org_name: "无锡分行", metric_value: "15147420074.00", metric_name: "存款余额", stat_date: "2026-08-31", unit: "元" }],
        row_count: 1, truncated: false, offset: 0, limit: 20, next_offset: null, has_more: false,
      };
    },
    lookupTask: async (...args: unknown[]) => {
      calls.push({ method: "lookupTask", args });
      if (spec.lookupTask) return spec.lookupTask(...args);
      throw new BackendApiError(404, "not found", "TASK_NOT_FOUND");
    },
  };
  return backend as unknown as BackendClient & { calls: typeof calls };
}

describe("metric_ask", () => {
  it("new：提交→分析→执行，返回事实回执并登记会话映射", async () => {
    const backend = stubBackend({
      getTask: async () => ({
        task_id: "task-1",
        conversation_id: "conv-1",
        version: 2,
        status: "SUCCEEDED",
        result: { result_id: "result:task-1", status: "succeeded", row_count: 1 },
      }),
    });
    const bridge = new MemoryCommandBridge();
    const request = testRequestContext(backend, bridge);
    const tool = createMetricAskTool();

    const result = await runTool(tool, { action: "new" }, request);
    const payload = receiptJson(result);

    expect(payload.status).toBe("succeeded");
    expect(payload.task_id).toBe("task-1");
    expect(payload.result_id).toBe("result:task-1");
    expect(bridge.conversationId).toBe("conv-1");
    expect(bridge.record?.status).toBe("completed");
    // 提交幂等键是稳定命令键而非随机 UUID：同一请求重试得到同一键
    const submitKey = backend.calls.find((c) => c.method === "submitQuestion")?.args[2];
    expect(typeof submitKey).toBe("string");
    expect((submitKey as string).length).toBe(64);
  });

  it("成功回执透传后端 answer_blocks；后端无该字段时 details 不含此键", async () => {
    const blocks = [
      {type:"paragraph",segments:[{text:"2026年08月31日，无锡分行的存款余额为",bold:false},{text:"15147420074.00元",bold:true},{text:"。",bold:false}]},
    ];
    const succeededTask = {
      task_id: "task-1",
      conversation_id: "conv-1",
      version: 2,
      status: "SUCCEEDED",
      result: { result_id: "result:task-1", status: "succeeded", row_count: 1 },
    };
    const backend = stubBackend({
      getTask: async () => succeededTask,
      executeTask: async () => ({
        task_id: "task-1",
        status: "succeeded",
        query_shape: "metric_value",
        columns: ["org_name", "metric_value"],
        rows: [{ org_name: "无锡分行", metric_value: "15147420074.00", metric_name: "存款余额", stat_date: "2026-08-31", unit: "元" }],
        row_count: 1,
        answer_blocks: blocks,
      }),
    });
    const withBlocks = await runTool(createMetricAskTool(), { action: "new" }, testRequestContext(backend, new MemoryCommandBridge()));
    expect(withBlocks.details.public_answer_blocks).toEqual(blocks);
    expect(withBlocks.details.public_answer).toContain("15147420074.00");

    // 默认桩不含 answer_blocks：details 不出现该键，前端回退纯文本
    const plain = stubBackend({ getTask: async () => succeededTask });
    const withoutBlocks = await runTool(createMetricAskTool(), { action: "new" }, testRequestContext(plain, new MemoryCommandBridge()));
    expect("public_answer_blocks" in withoutBlocks.details).toBe(false);
  });

  it("clarify：补充继续原任务，不重新 POST /questions", async () => {
    const backend = stubBackend({
      submitClarification: async () => ({
        task_id: "task-1",
        conversation_id: "conv-1",
        version: 3,
        status: "WAITING_USER",
        clarification: { id: "cl-1", prompt: "请补充机构" },
      }),
    });
    const bridge = new MemoryCommandBridge();
    bridge.conversationId = "conv-1";
    const request = testRequestContext(backend, bridge);
    const tool = createMetricAskTool();

    const result = await runTool(
      tool,
      { action: "clarify", target: { task_id: "task-1", version: 2, clarification_id: "cl-1" } },
      request,
    );
    const payload = receiptJson(result);

    expect(payload.status).toBe("clarification_required");
    expect(payload.task_id).toBe("task-1");
    expect(backend.calls.filter((c) => c.method === "submitQuestion")).toHaveLength(0);
    const clarify = backend.calls.find((c) => c.method === "submitClarification");
    expect(clarify?.args[0]).toBe("task-1");
    expect((clarify?.args[1] as { clarification_id: string }).clarification_id).toBe("cl-1");
  });

  it("clarify 版本冲突后按受控刷新重试一次；再次冲突则提示用户确认", async () => {
    const versions: number[] = [];
    let attempt = 0;
    const backend = stubBackend({
      submitClarification: async (_taskId: unknown, payload: unknown) => {
        const version = (payload as { expected_version: number }).expected_version;
        versions.push(version);
        attempt += 1;
        if (attempt === 1) {
          throw new BackendApiError(409, "version conflict", "TASK_VERSION_CONFLICT");
        }
        return { task_id: "task-1", conversation_id: "conv-1", version: 4, status: "RUNNING" };
      },
      getTask: async () => ({
        task_id: "task-1",
        conversation_id: "conv-1",
        version: 4,
        status: "WAITING_USER",
        clarification: { id: "cl-1", prompt: "请补充日期" },
      }),
    });
    const bridge = new MemoryCommandBridge();
    bridge.conversationId = "conv-1";
    const request = testRequestContext(backend, bridge);
    const tool = createMetricAskTool();
    const target = { task_id: "task-1", version: 2, clarification_id: "cl-1" };

    const first = await runTool(tool, { action: "clarify", target }, request);
    // 第一次冲突后工具内受控刷新成功：v2 冲突 → 读到 v4 → 同键重试成功并执行
    expect(receiptJson(first).status).toBe("succeeded");
    expect(versions).toEqual([2, 4]);
    expect(bridge.record?.refreshed).toBe(true);
  });

  it("同一 operation 第二个不同写意图返回 TURN_QUERY_LIMIT，不触达后端", async () => {
    const backend = stubBackend({});
    const bridge = new MemoryCommandBridge();
    const request = testRequestContext(backend, bridge);
    const tool = createMetricAskTool();

    const first = await runTool(tool, { action: "new" }, request);
    expect(receiptJson(first).status).toBe("succeeded");

    const second = await runTool(
      tool,
      { action: "clarify", target: { task_id: "task-9", version: 1, clarification_id: "cl-9" } },
      request,
    );
    const payload = receiptJson(second);
    expect(payload.status).toBe("error");
    expect((payload.error as { code: string }).code).toBe("TURN_QUERY_LIMIT");
    expect(backend.calls.filter((c) => c.method === "submitClarification")).toHaveLength(0);
  });

  it("相同写命令重复调用幂等回放，不重复提交", async () => {
    const backend = stubBackend({
      getTask: async () => ({
        task_id: "task-1",
        conversation_id: "conv-1",
        version: 2,
        status: "SUCCEEDED",
        result: { result_id: "result:task-1", status: "succeeded", row_count: 1 },
      }),
    });
    const bridge = new MemoryCommandBridge();
    const request = testRequestContext(backend, bridge);
    const tool = createMetricAskTool();

    await runTool(tool, { action: "new" }, request);
    const replay = await runTool(tool, { action: "new" }, request);
    const payload = receiptJson(replay);
    expect(payload.idempotent_replay).toBe(true);
    expect(replay.details.status).toBe("succeeded");
    expect(replay.details.columns).toEqual(["org_name", "metric_value"]);
    expect(replay.details.public_answer).toContain("15147420074.00");
    expect(payload.task_id).toBe("task-1");
    expect(backend.calls.filter((c) => c.method === "submitQuestion")).toHaveLength(1);
  });

  it("followup：携带 query_reference 提交派生查询", async () => {
    const backend = stubBackend({
      getTask: async () => ({
        task_id: "task-2",
        conversation_id: "conv-1",
        version: 2,
        status: "SUCCEEDED",
        result: { result_id: "result:task-2", status: "succeeded", row_count: 1 },
      }),
    });
    const bridge = new MemoryCommandBridge();
    bridge.conversationId = "conv-1";
    const request = testRequestContext(backend, bridge, { originalMessage: "那江阴呢？" });
    const tool = createMetricAskTool();

    const result = await runTool(
      tool,
      { action: "followup", source: { task_id: "task-1", version: 2 }, change_field: "orgs" },
      request,
    );
    expect(receiptJson(result).status).toBe("succeeded");
    const submit = backend.calls.find((c) => c.method === "submitQuestion");
    expect(submit?.args[3]).toEqual({ task_id: "task-1", version: 2, change_field: "compose" });
  });

  it("模型把嵌套对象写成 JSON 字符串时由 prepareArguments 还原", () => {
    const tool = createMetricAskTool();
    const normalized = tool.prepareArguments?.({
      action: "followup",
      source: "{\"task_id\": \"task-1\", \"version\": 3}",
      change_field: "orgs",
    }) as { source: { task_id: string; version: number } };
    expect(normalized.source).toEqual({ task_id: "task-1", version: 3 });

    const clarify = tool.prepareArguments?.({
      action: "clarify",
      target: "{\"task_id\": \"task-1\", \"version\": 2, \"clarification_id\": \"cl-1\"}",
    }) as { target: { clarification_id: string } };
    expect(clarify.target.clarification_id).toBe("cl-1");
  });

  it("卡片目标与模型目标冲突时报错，不猜优先级", async () => {
    const backend = stubBackend({});
    const bridge = new MemoryCommandBridge();
    const request = testRequestContext(backend, bridge, {
      clarificationTarget: { task_id: "task-1", version: 2, clarification_id: "cl-1" },
    });
    const tool = createMetricAskTool();

    const result = await runTool(
      tool,
      { action: "clarify", target: { task_id: "task-2", version: 1, clarification_id: "cl-2" } },
      request,
    );
    const payload = receiptJson(result);
    expect((payload.error as { code: string }).code).toBe("CLARIFICATION_TARGET_MISMATCH");
    expect(backend.calls).toHaveLength(0);
  });
});

describe("中断恢复与输入绑定回归", () => {
  it("已分析落库后恢复跳过 analyze，成功回执保持统一", async () => {
    const backend = stubBackend({
      submitQuestion: () => ({task_id:"task-1",conversation_id:"conv-1",version:2,status:"RUNNING",current_stage:"LOGICAL_DSL"}),
      getTask: () => ({task_id:"task-1",conversation_id:"conv-1",version:3,status:"SUCCEEDED",result:{result_id:"result:task-1"}}),
    });
    const result = await runTool(createMetricAskTool(), {action:"new"}, testRequestContext(backend,new MemoryCommandBridge()));
    expect(backend.calls.filter(c=>c.method==="analyzeTask")).toHaveLength(0);
    expect(backend.calls.filter(c=>c.method==="executeTask")).toHaveLength(1);
    expect(result.details.status).toBe("succeeded");
  });
  it("明确回复澄清卡片不能 new 或 followup", async () => {
    const backend=stubBackend({});
    const request=testRequestContext(backend,new MemoryCommandBridge(), {clarificationTarget:{task_id:"t",version:1,clarification_id:"c"}});
    for(const params of [{action:"new"},{action:"followup",source:{task_id:"old",version:2},change_field:"orgs"}]) {
      expect(receiptJson(await runTool(createMetricAskTool(),params,request)).status).toBe("error");
    }
    expect(backend.calls).toHaveLength(0);
  });
  it("澄清提交后执行中断，登记仍 pending；恢复继续执行", async () => {
    let executions=0;
    const backend=stubBackend({
      executeTask:()=>{ executions++; if(executions===1) throw new Error("connection lost"); return {task_id:"task-1",status:"succeeded",columns:[],rows:[],row_count:0}; },
      getTask:()=>({task_id:"task-1",conversation_id:"conv-1",version:3,status:executions<2?"RUNNING":"SUCCEEDED",current_stage:"LOGICAL_DSL",result:executions<2?null:{result_id:"r"}}),
    });
    const bridge=new MemoryCommandBridge();
    const request=testRequestContext(backend,bridge);
    const params={action:"clarify",target:{task_id:"task-1",version:2,clarification_id:"c"}};
    await expect(runTool(createMetricAskTool(),params,request)).rejects.toThrow("connection lost");
    expect(bridge.record?.status).toBe("pending");
    const result=await runTool(createMetricAskTool(),params,request);
    expect(result.details.status).toBe("succeeded");
    expect(backend.calls.filter(c=>c.method==="submitClarification")).toHaveLength(1);
  });
});

it("new 的候选来源参与提交与幂等回放，第二次调用不新增任务", async () => {
  const backend=stubBackend({getTask:async()=>({task_id:"task-1",version:2,status:"SUCCEEDED",result:{result_id:"result:task-1"}})});
  const bridge=new MemoryCommandBridge();
  const request=testRequestContext(backend,bridge);
  request.queryCandidate={task_id:"prior",version:3};
  const tool=createMetricAskTool();
  await runTool(tool,{action:"new"},request);
  await runTool(tool,{action:"new"},request);
  const submissions=backend.calls.filter(call=>call.method==="submitQuestion");
  expect(submissions).toHaveLength(1);
  expect(submissions[0]?.args[3]).toEqual({task_id:"prior",version:3,change_field:"compose",mode:"candidate"});
});
