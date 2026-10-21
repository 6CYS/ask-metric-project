import {expect, it, vi} from "vitest";
import {authorizeHistory} from "./routes.js";
import {BackendApiError, type BackendClient} from "./backendClient.js";
import type {ProjectedMessage} from "./sessionProjection.js";

const message = (details: unknown): ProjectedMessage => ({role: "tool", tool: "execute_business_frame",
  details, timestamp: 1, entry_id: "entry", tool_call_id: "call", is_error: false});
const result = {kind: "business_overview", status: "succeeded", org_codes: ["O1"],
  tasks: [{task_id: "total-task", status: "succeeded"}, {task_id: "personal-task", status: "succeeded"}],
  facts: {total: {"2026-07-31": {value: "120"}}}, public_answer: "合成经营概览"};
const backend = () => ({getTask: vi.fn(async (id: string) => ({task_id: id, status: "SUCCEEDED"})),
  resolveBusinessField: vi.fn(async () => ({status: "resolved", value: {codes: ["O1"]}}))});

it.each(["business_overview", "business_report", "analysis_evidence"])("%s 历史复查每个基础任务和默认机构权限", async kind => {
  const api = backend();
  await authorizeHistory([message({...result, kind})], api as unknown as BackendClient);
  expect(api.getTask.mock.calls.map(call => call[0])).toEqual(["total-task", "personal-task"]);
  expect(api.resolveBusinessField).toHaveBeenCalledWith("organization", ["O1"]);
});
it.each(["business_overview", "business_report", "analysis_evidence"])("%s 任意分项失权阻止历史正文进入模型和页面", async kind => {
  const api = backend();
  api.getTask.mockRejectedValueOnce(new BackendApiError(403, "失权", "DENIED"));
  await expect(authorizeHistory([message({...result, kind})], api as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
});
it("无数据概览也必须复核机构范围", async () => {
  const api = backend();
  api.resolveBusinessField.mockResolvedValueOnce({status: "invalid", value: {codes: []}});
  await expect(authorizeHistory([message({...result, tasks: [], facts: {}})], api as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_PERMISSION_DENIED"});
});
it.each([{tasks: undefined}, {org_codes: []}])("无法复核的概览引用拒绝读取：%j", async changed => {
  await expect(authorizeHistory([message({...result, ...changed})], backend() as unknown as BackendClient))
    .rejects.toMatchObject({code: "HISTORY_SCOPE_UNAVAILABLE"});
});
