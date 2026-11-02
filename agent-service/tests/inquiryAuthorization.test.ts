import {BACKGROUND_CONTEXT, withAbortSignal, type AgentHarnessTool} from "@earendil-works/pi-agent-core";
import {Type} from "@earendil-works/pi-ai";
import {describe, expect, it} from "vitest";
import {BackendApiError, type BackendClient} from "../src/backendClient.js";
import type {AskMetricRequestContext} from "../src/requestContext.js";
import {inquiryPermissionDenied, withInquiryAuthorization} from "../src/inquiry/authorization.js";
import {authenticationFailure, withBackendAuthentication} from "../src/runtime/authentication.js";
import {MemoryCommandBridge, runTool, testRequestContext} from "../src/tools/testUtils.js";

function rejecting(error: Error): AgentHarnessTool<AskMetricRequestContext> {
  return {name: "metric_query", label: "权限测试", description: "隔离后端错误边界", parameters: Type.Object({}),
    execute: async () => {throw error;}};
}

const request = () => testRequestContext({} as BackendClient, new MemoryCommandBridge(), {executionFlow: "inquiry_v1"});

describe("普通调查权限终态", () => {
  it("403保留可重放终态，公开说明不泄露具体权限条件", async () => {
    const error = new BackendApiError(403, "内部机构范围 O_SECRET、字段 branch_id 不可见", "ORG_SCOPE_FORBIDDEN",
      {org_codes: ["O_SECRET"], condition: "branch_id"});
    const result = await runTool(withInquiryAuthorization(rejecting(error)), {}, request());
    expect(result).toMatchObject({isError: false, terminate: true, details: {
      kind: "runtime_delivery", version: 1, operation_id: "op-1", status: "delivered", outcome: "incomplete",
      error_code: "INQUIRY_FORBIDDEN", history_sources: {tasks: [], organizationScopes: []},
      public_answer: "当前账号无权访问本次所需的数据，请联系管理员确认权限。",
    }});
    expect(inquiryPermissionDenied(result.details)).toBe(true);
    expect(authenticationFailure(result.details)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/O_SECRET|branch_id|ORG_SCOPE_FORBIDDEN/);
  });

  it("401继续交给原鉴权封装，保留登录失效语义", async () => {
    const error = new BackendApiError(401, "登录过期", "AUTH_TOKEN_EXPIRED");
    const wrapped = withInquiryAuthorization(rejecting(error));
    await expect(runTool(wrapped, {}, request())).rejects.toBe(error);
    const result = await runTool(withBackendAuthentication(wrapped), {}, request());
    expect(authenticationFailure(result.details)).toBe(true);
    expect(inquiryPermissionDenied(result.details)).toBe(false);
  });

  it("旧流程的403保持原有处理，不扩大新终态适用范围", async () => {
    const error = new BackendApiError(403, "无权访问");
    const legacy = testRequestContext({} as BackendClient, new MemoryCommandBridge());
    await expect(runTool(withInquiryAuthorization(rejecting(error)), {}, legacy)).rejects.toBe(error);
  });

  it("取消后即使后端返回403也不生成新的权限回答", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new BackendApiError(403, "无权访问");
    await expect(runTool(withInquiryAuthorization(rejecting(error)), {}, request(),
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toBe(error);
  });

  it.each([new DOMException("已取消", "AbortError"), new BackendApiError(422, "参数错误")])("其他错误不被转成权限失败", async error => {
    await expect(runTool(withInquiryAuthorization(rejecting(error)), {}, request())).rejects.toBe(error);
  });

  it("未形成权限终态的普通错误码不触发权限终止", () => {
    expect(inquiryPermissionDenied({error_code: "INQUIRY_FORBIDDEN"})).toBe(false);
    expect(inquiryPermissionDenied({kind: "runtime_delivery", status: "delivered", outcome: "result"})).toBe(false);
    expect(inquiryPermissionDenied(null)).toBe(false);
  });
});
