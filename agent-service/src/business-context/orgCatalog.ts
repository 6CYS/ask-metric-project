import {BackendApiError} from "../backendClient.js";
import type {AskMetricRequestContext} from "../requestContext.js";

export interface OrgCatalogItem {code: string; name: string; aliases: string[]}
export interface OrgCatalog {items: OrgCatalogItem[]; status?: "temporary_error"}

/**
 * 一轮只拉取一次有权机构清单；与 metricMentions 同一缓存约定：
 * 只缓存成功结果，临时失败不缓存（同轮后续调用和重试重新拉取）。
 * 目录不可用是降级而非失败：本轮注入“暂不可用”提示，模型仍可按原文名称提交机构字段。
 */
export function orgCatalog(request: AskMetricRequestContext): Promise<OrgCatalog> {
  if (request.orgCatalog) return request.orgCatalog;
  const pending = fetchOrgCatalog(request);
  request.orgCatalog = pending;
  const forget = () => { if (request.orgCatalog === pending) delete request.orgCatalog; };
  pending.then(result => { if (result.status === "temporary_error") forget(); }, forget);
  return pending;
}

/**
 * 轮状态块的机构清单文本，fixed_v1 与 semantic_v2 两协议共用同一来源与降级约定。
 * 后端客户端不支持 orgCatalog（旧桩/旧部署）时返回空串，不注入。
 */
export async function orgCatalogTurnState(request: AskMetricRequestContext): Promise<string> {
  if (typeof request.backend.orgCatalog !== "function") return "";
  const catalog = await orgCatalog(request);
  if (catalog.status === "temporary_error") {
    return "\n有权机构清单：暂不可用（机构目录服务临时失败）；机构字段仍可按本轮业务表达提交。";
  }
  if (!catalog.items.length) return "\n有权机构清单：当前账号无可用机构。";
  // 建议字段的键名按当前协议（fixed 协议 orgSuggestion / 语义协议 suggestion），excerpt 均为用户原文片段。
  return "\n有权机构清单（编码|名称|别名，每行一条；据此自主判断用户所指的机构，可在机构字段按当前协议的建议键提交结论，名称或编码取自清单）：\n"
    + catalog.items.map(item => `${item.code}|${item.name}|${item.aliases.join(",")}`).join("\n");
}

async function fetchOrgCatalog(request: AskMetricRequestContext): Promise<OrgCatalog> {
  try {
    const result = await request.backend.orgCatalog();
    if (!result || !Array.isArray(result.items) || result.items.length > 1000
      || !result.items.every(item => item && typeof item.code === "string" && !!item.code
        && typeof item.name === "string" && !!item.name
        && Array.isArray(item.aliases) && item.aliases.every(alias => typeof alias === "string"))) {
      throw new Error("INVALID_ORG_CATALOG");
    }
    return {items: result.items};
  } catch (error) {
    // 401/403 属于授权边界，与 resolveBusinessField 现有约定一致向上抛，不伪装成目录暂不可用。
    if (error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
    console.error(JSON.stringify({event: "org_catalog_unavailable", request_id: request.requestId,
      session_id: request.sessionId, operation_id: request.operationId,
      reason: error instanceof Error ? error.message : String(error)}));
    return {items: [], status: "temporary_error"};
  }
}
