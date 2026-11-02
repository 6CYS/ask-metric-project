import {describe, expect, it, vi} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import type {BusinessEvidence} from "../src/answerEvidence.js";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import {createAskMetricTools} from "../src/tools/index.js";
import {createInquiryAnswerTool} from "../src/inquiry/runtime.js";
import {createInquiryReportTool} from "../src/inquiry/reportTool.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

type ToolResult = {content: [{type: "text"; text: string}]; details: BusinessEvidence; isError?: boolean; terminate?: boolean};

const source = {kind: "analysis_evidence", status: "succeeded", run_ref: "run-1", execution_turn_id: "old-turn",
  result_reused: true, org_codes: ["A"], metric_descriptors: [],
  evidence_items: [{ref: "run-1.f1", type: "fact"}, {ref: "run-1.f2", type: "fact"}]};
const result = {kind: "metric_calculate", status: "succeeded", calculation_ref: {task_id: "task", calculation_id: "calc"},
  run_refs: ["run-1"], inputs: {current: {ref: "run-1.f1", display: "120元", task_id: "task", fact_id: "fact:task:0:metric_value"},
    base: {ref: "run-1.f2", display: "100元", task_id: "task", fact_id: "fact:task:1:metric_value"}},
  limitations: [], evidence_items: [{ref: "calculation.calc.difference", type: "calculation", name: "difference",
    value: "20", unit: "元", display: "20元", input_refs: ["run-1.f1", "run-1.f2"]}]};
const tool = () => {
  const registered = createAskMetricTools().find(item => item.name === "analysis_calculate");
  if (!registered) throw new Error("缺少结果计算入口");
  return registered;
};
function fixture() {
  const analysisCalculate = vi.fn((): Promise<Record<string, unknown>> => Promise.resolve(result));
  const analysisReport = vi.fn(() => Promise.resolve({kind: "business_report", status: "succeeded", public_answer: "差额20元。",
    report: {summary: "差额20元。", sections: [], body_evidence: [{paragraph: 1, evidence_refs: ["calculation.calc.difference"]}]}}));
  const bridge = new MemoryCommandBridge(); bridge.conversationId = "conversation";
  const request = testRequestContext({analysisCalculate, analysisReport} as unknown as BackendClient, bridge,
    {answerEvidence: () => Promise.resolve([{ref: "e1", evidence: source}])});
  return {request, analysisCalculate, analysisReport};
}

describe("已查结果的受控计算", () => {
  it("绑定本轮已读取来源和原问，不手填数值或重复取数", async () => {
    const test = fixture();
    const calculated = await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    expect(test.analysisCalculate).toHaveBeenCalledWith({conversation_id: "conversation", run_refs: ["run-1"],
      current_ref: "run-1.f1", base_ref: "run-1.f2",
      calculation_context: {scope_id: "op-1", user_question: "查询存款余额"}}, expect.any(String), expect.anything());
    expect(calculated.terminate).not.toBe(true);
    expect(calculated.details).toMatchObject({kind: "metric_calculate", execution_turn_id: "op-1"});
    expect(JSON.parse(calculated.content[0].text)).toMatchObject({calculations: [{ref: "e2.v1", display: "20元"}]});
    test.request.answerEvidence = () => Promise.resolve([{ref: "e1", evidence: source}, {ref: "e2", evidence: calculated.details}]);
    const delivered = await runTool(createInquiryReportTool(), {body: "差额{{e2.v1}}。"}, test.request) as ToolResult;
    expect(delivered.terminate).toBe(true);
    expect(test.analysisReport).toHaveBeenCalledWith(expect.objectContaining({
      summary: "差额{{calculation.calc.difference}}。", run_refs: ["run-1"], context_run_refs: ["run-1"],
      focus_refs: ["calculation.calc.difference"], calculation_refs: [{task_id: "task", calculation_id: "calc"}],
    }), expect.anything());
  });

  it("正文恢复仍携带已签发计算身份和历史关注范围", async () => {
    const test = fixture();
    const calculated = await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    test.request.answerEvidence = () => Promise.resolve([{ref: "e1", evidence: source}, {ref: "e2", evidence: calculated.details}]);
    test.request.turnMessages = () => Promise.resolve([{role: "toolResult", toolName: "analysis_answer", toolCallId: "first",
      content: [], timestamp: 0, isError: true,
      details: {kind: "analysis_answer", status: "ARGUMENT_ERROR", error_code: "ANALYSIS_REPORT_NUMBER"}}]);
    test.analysisReport.mockRejectedValueOnce(new BackendApiError(422, "正文数字无依据", "ANALYSIS_REPORT_NUMBER"));
    const delivered: unknown = await runTool(createInquiryAnswerTool(), {body: "差额{{e2.v1}}。"}, test.request);
    expect(delivered).toMatchObject({terminate: true, details: {kind: "business_report"}});
    expect(test.analysisReport).toHaveBeenLastCalledWith(expect.objectContaining({
      fallback: true, summary: "", run_refs: ["run-1"], context_run_refs: ["run-1"],
      focus_refs: ["calculation.calc.difference"], calculation_refs: [{task_id: "task", calculation_id: "calc"}],
    }), expect.anything());
    expect(test.analysisCalculate).toHaveBeenCalledOnce();
  });

  it("未知引用先返回可纠正错误，不查询后端", async () => {
    const test = fixture();
    const calculated = await runTool(tool(), {current_ref: "e99.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    expect(calculated.isError).toBe(true);
    expect(test.analysisCalculate).not.toHaveBeenCalled();
  });

  it.each([
    [422, "ANALYSIS_CALCULATION_SOURCE", false],
    [409, "CALCULATION_CONFLICT", false],
    [503, "SERVICE_UNAVAILABLE", true],
  ])("计算错误%s向模型和宿主提供相同的重试语义", async (status, code, retryable) => {
    const test = fixture();
    test.analysisCalculate.mockRejectedValueOnce(new BackendApiError(status, "计算条件未满足", code));
    const calculated = await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    expect(calculated.isError).toBe(true);
    expect(calculated.details).toMatchObject({status: "error", error_code: code, retryable});
    expect(JSON.parse(calculated.content[0].text)).toMatchObject({status: "error", error_code: code, retryable});
  });

  it("缺少输入任务身份的回执不作为成功事实进入上下文", async () => {
    const test = fixture();
    // 按契约模拟缺少字段，不能让下游历史授权遇到不完整事实。
    test.analysisCalculate.mockResolvedValueOnce({...result, inputs: {current: {ref: "run-1.f1", display: "120元"},
      base: result.inputs.base}});
    expect(await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request)).toMatchObject({isError: true});
  });

  it("同一轮同一对正式事实的不可重试失败直接复用，修正输入仍可计算", async () => {
    const test = fixture();
    test.analysisCalculate.mockRejectedValueOnce(new BackendApiError(422, "所选指标不同", "ANALYSIS_CALCULATION_METRIC_MISMATCH"));
    const first = await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    const messages: AgentMessage[] = [{role: "toolResult", toolName: "analysis_calculate", toolCallId: "first",
      content: first.content, details: first.details, timestamp: 0, isError: true}];
    test.request.turnMessages = () => Promise.resolve(messages);
    // 原始引用与短引用指向同一事实，不能通过换个引用名称重复执行。
    const repeated = await runTool(tool(), {current_ref: "run-1.f1", base_ref: "run-1.f2"}, test.request) as ToolResult;
    expect(repeated).toMatchObject({isError: true, details: {status: "error", repeated_failure: true,
      error_code: "ANALYSIS_CALCULATION_METRIC_MISMATCH"}});
    expect(test.analysisCalculate).toHaveBeenCalledTimes(1);
    const corrected = await runTool(tool(), {current_ref: "e1.v2", base_ref: "e1.v1"}, test.request) as ToolResult;
    expect(corrected.details.status).toBe("succeeded");
    expect(test.analysisCalculate).toHaveBeenCalledTimes(2);
  });

  it("新回合与服务暂时失败不复用上一条不可重试结论", async () => {
    const test = fixture();
    test.analysisCalculate.mockRejectedValueOnce(new BackendApiError(503, "服务暂不可用", "SERVICE_UNAVAILABLE"));
    const first = await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    const messages: AgentMessage[] = [{role: "toolResult", toolName: "analysis_calculate", toolCallId: "first",
      content: first.content, details: first.details, timestamp: 0, isError: true}];
    test.request.turnMessages = () => Promise.resolve(messages);
    expect((await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult).details.status).toBe("succeeded");
    expect(test.analysisCalculate).toHaveBeenCalledTimes(2);
    test.request.operationId = "op-2";
    messages[0] = {...messages[0]!, details: {...first.details, retryable: false}} as AgentMessage;
    expect((await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult).details.status).toBe("succeeded");
    expect(test.analysisCalculate).toHaveBeenCalledTimes(3);
  });

  it("失败回执保留已授权的两条事实条件，不展示内部引用或伪造计算结果", async () => {
    const test = fixture();
    test.request.answerEvidence = () => Promise.resolve([{ref: "e1", evidence: {...source, evidence_items: [
      {ref: "run-1.f1", type: "fact", metric_name: "收入变化金额", org_name: "测试行", date: "2026-07-31"},
      {ref: "run-1.f2", type: "fact", metric_name: "收入金额", org_name: "测试行", date: "2026-07-31"},
    ]}}]);
    test.analysisCalculate.mockRejectedValueOnce(new BackendApiError(422, "所选指标不同", "ANALYSIS_CALCULATION_METRIC_MISMATCH"));
    const failed = await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    expect(failed.details).toMatchObject({inputs: {
      current: {metric_name: "收入变化金额", org_name: "测试行", date: "2026-07-31"},
      base: {metric_name: "收入金额", org_name: "测试行", date: "2026-07-31"},
    }});
    expect(failed.details).not.toHaveProperty("evidence_items");
  });

  it.each([new Error("INVALID_CALCULATION_RECEIPT"), new TypeError("fetch failed")])("未知回执或网络错误不要求用户纠正指标口径", async error => {
    const test = fixture();
    test.analysisCalculate.mockRejectedValueOnce(error);
    const failed = await runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request) as ToolResult;
    expect(failed.details).not.toHaveProperty("retryable", false);
    expect(failed.details).not.toHaveProperty("error_code", "ANALYSIS_CALCULATION_SOURCE");
    expect(failed.details).toHaveProperty("recovery", expect.not.stringContaining("纠正引用"));
  });

  it.each([401, 403])("鉴权失败%s终止相关访问", async status => {
    const test = fixture(), error = new BackendApiError(status, "无权", "FORBIDDEN");
    test.analysisCalculate.mockRejectedValue(error);
    await expect(runTool(tool(), {current_ref: "e1.v1", base_ref: "e1.v2"}, test.request)).rejects.toBe(error);
  });
});
