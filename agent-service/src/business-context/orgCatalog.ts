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
 * 轮状态块的机构清单文本，semantic_v2 使用本轮权限目录，不将完整目录写入固定提示词或历史。
 * 后端客户端不支持 orgCatalog（旧桩/旧部署）时返回空串，不注入。
 */
export async function orgCatalogTurnState(request: AskMetricRequestContext): Promise<string> {
  if (typeof request.backend.orgCatalog !== "function") return "";
  const catalog = await orgCatalog(request);
  if (catalog.status === "temporary_error") {
    return "\n有权机构清单：暂不可用（机构目录服务临时失败）；机构字段仍可按本轮业务表达提交。";
  }
  if (!catalog.items.length) return "\n有权机构清单：当前账号无可用机构。";
  // suggestion 只辅助未决成员；完整机构原值始终保留在 value。
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


/** 目录中的完整名称/别名优先于连接词，避免把“和盛银行”等正式身份拆坏。 */
export async function organizationValues(request: AskMetricRequestContext, text: string): Promise<string[]> {
  const catalog = typeof request.backend.orgCatalog === "function" ? await orgCatalog(request) : undefined;
  const terms = [...new Set(catalog?.items.flatMap(item => [item.name, ...item.aliases]) ?? [])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const values: string[] = [];
  let start = 0;
  for (let position = 0; position < text.length;) {
    const term = terms.find(value => text.startsWith(value, position));
    if (term) {position += term.length; continue;}
    const separator = /^(?:、|，|,|以及|和|与|及)/u.exec(text.slice(position));
    if (!separator) {position++; continue;}
    const value = text.slice(start, position).trim();
    if (value) values.push(value);
    position += separator[0].length; start = position;
  }
  const tail = text.slice(start).trim();
  if (tail) values.push(tail);
  return values;
}
