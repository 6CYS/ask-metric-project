import {BackendApiError} from "../backendClient.js";
import type {SemanticIssue} from "./store.js";

/** 后端业务拒绝交模型修正；诊断留在回执中，用户文案由投影统一生成。 */
export function backendIssue(error: unknown, field?: string): SemanticIssue {
  const scope = field ? {field} : {};
  if (error instanceof BackendApiError) {
    if ([401, 403].includes(error.status)) return {...scope, code: error.code ?? "PERMISSION_DENIED",
      message: "当前身份无权继续此查询。", category: "permission", remediation: "stop"};
    if (error.status >= 400 && error.status < 500 && error.status !== 429) return {...scope,
      code: error.code ?? "BACKEND_INPUT_REJECTED", message: error.message, category: "input_shape", remediation: "pi"};
    return {...scope, code: error.code ?? "BACKEND_UNAVAILABLE", message: error.message, category: "infrastructure", remediation: "stop"};
  }
  return {...scope, code: "FIELD_BINDING_FAILED", message: error instanceof Error ? error.message : "字段绑定未完成",
    category: "infrastructure", remediation: "stop"};
}
