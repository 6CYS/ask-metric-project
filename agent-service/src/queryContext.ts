/** 统一 read 的历史分支不属于查询状态；旧工具名仍可读取。 */
function queryToolName(message: {toolName?: string; details?: {kind?: string}}): string {
  return message.toolName === "read" ? message.details?.kind ?? "read" : message.toolName ?? "";
}

/** 从原生消息生成当次模型请求的查询引用索引；不保存摘要或第二份业务状态。 */
export function coverageContext(messages: readonly unknown[]): string {
  for (const raw of [...messages].reverse()) {
    const message = raw as {role?: string; toolName?: string; details?: Record<string, unknown>};
    if (message.role !== "toolResult") continue;
    const receipt = readReceipt(raw);
    // 参数错误尚未执行成功业务，不应抹掉纠错需要的完整范围。
    if (!receipt || message.details?.retryable) continue;
    if (["metric_ask", "metric_query_structured"].includes(queryToolName(message))) return "";
    if (queryToolName(message) === "metric_read" && (receipt.query_evidence || receipt.rows)) return "";
    if (message.toolName !== "data_availability") continue;
    if (receipt.status !== "succeeded") return "";
    return `\n最近已确认的数据覆盖条件（数据）：${JSON.stringify({
      query_type: "data_coverage", request: receipt.request, org_names: receipt.org_names,
      items: receipt.items, metric_names: receipt.metric_names, page: receipt.page,
      page_size: receipt.page_size, has_more: receipt.has_more,
      // 样例日期不能替换 request 的起止范围；只投影页信息。
      groups: Array.isArray(receipt.groups) ? receipt.groups.map(group => {
        const value = group as Record<string, unknown>;
        return {date_count: value.date_count, has_more: value.has_more};
      }) : undefined,
    })}`;
  }
  return "";
}

function readReceipt(raw: unknown): Record<string, unknown> | undefined {
  const message = raw as {content?: string | Array<{type?: string; text?: string}>; details?: Record<string, unknown>};
  try {
    const value: unknown = JSON.parse(typeof message.content === "string" ? message.content
      : message.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("") ?? "");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* 老会话的结构化 details 仍可作为正式回执。 */ }
  return message.details;
}

/** 只核对来源是否已有正式成功回执，不从用户措辞猜测或替换业务来源。 */
export function knownSuccessfulSource(messages: readonly unknown[], source: unknown): boolean {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const target = source as {task_id?: unknown; version?: unknown};
  if (typeof target.task_id !== "string" || !Number.isInteger(target.version)) return false;
  for (const raw of [...messages].reverse()) {
    const message = raw as {role?: string; toolName?: string; details?: {kind?: string}};
    if (message.role !== "toolResult" || !["metric_ask", "metric_read", "metric_query_structured"].includes(queryToolName(message))) continue;
    const receipt = readReceipt(raw);
    if (!receipt || receipt.task_id !== target.task_id || receipt.version === undefined) continue;
    return String(receipt.status).toLowerCase() === "succeeded" && receipt.version === target.version
      && Boolean(receipt.result_id || (receipt.result as {result_id?: unknown} | undefined)?.result_id);
  }
  return false;
}

export function queryReferences(messages: readonly unknown[]): Array<Record<string, unknown>> {
  const references: Array<Record<string, unknown>> = [];
  let sourceQuestion = "";
  for (const raw of messages) {
    const message = raw as { role?: string; toolName?: string; details?: {kind?: string}; content?: string | Array<{type?: string; text?: string}> };
    if (message.role === "user") {
      sourceQuestion = typeof message.content === "string" ? message.content
        : (message.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
      continue;
    }
    if (message.role !== "toolResult" || !["metric_ask", "metric_read", "metric_query_structured"].includes(queryToolName(message))) continue;
    const text = typeof message.content === "string" ? message.content
      : message.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("");
    if (!text) continue;
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(text); } catch { continue; }
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) continue;
    if (String(receipt.status).toLowerCase() !== "succeeded" || !receipt.result_id) continue;
    const rows = (receipt.sample_rows ?? receipt.rows) as Array<Record<string, unknown>> | undefined;
    // 只投影引用和查询条件，不把历史金额复制进系统提示词。
    const conditions = [...new Map((Array.isArray(rows) ? rows : []).map(row => Object.fromEntries(
      ["org_name", "metric_name", "stat_date"].filter(key => row[key] !== undefined).map(key => [key, row[key]]),
    )).map(condition => [JSON.stringify(condition), condition])).values()];
    const evidence = receipt.query_evidence as {
      logical_dsl?: { time?: unknown; metrics?: unknown; orgs?: unknown; ops?: unknown };
      catalog?: { metrics?: unknown; organizations?: unknown };
    } | undefined;
    // task 状态读取不包含查询条件，不能覆盖 result 回执的正式基准。
    if (!Array.isArray(rows) && !evidence?.logical_dsl) continue;
    const query = evidence?.logical_dsl ? {
      time: evidence.logical_dsl.time,
      metrics: evidence.catalog?.metrics ?? evidence.logical_dsl.metrics,
      organizations: evidence.catalog?.organizations ?? evidence.logical_dsl.orgs,
      operations: evidence.logical_dsl.ops,
    } : undefined;
    const previousIndex = references.findIndex(item => item.task_id === receipt.task_id && item.result_id === receipt.result_id);
    const previous = previousIndex >= 0 ? references.splice(previousIndex, 1)[0] : undefined;
    references.push({task_id: receipt.task_id, version: receipt.version ?? previous?.version, result_id: receipt.result_id,
      status: "succeeded", row_count: receipt.row_count, source_question: previous?.source_question ?? sourceQuestion,
      // 正式条件覆盖整份结果，不再从每一行重复推导相同条件。
      ...(!query ? {conditions} : {}),
      ...(query ? {query} : {})});
  }
  return references;
}

export function queryReferenceContext(messages: readonly unknown[]): string {
  const references = queryReferences(messages);
  let latest: Record<string,unknown> | undefined;
  for (const raw of [...messages].reverse()) {
    const message = raw as {role?: string; toolName?: string; details?: {kind?: string}; content?: string | Array<{type?: string; text?: string}>};
    if (message.role !== "toolResult" || !["metric_ask", "metric_read", "metric_query_structured"].includes(queryToolName(message))) continue;
    try {
      const receipt = JSON.parse(typeof message.content === "string" ? message.content
        : message.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("") ?? "");
      // 参数校验和宿主拦截未执行业务，不能抹掉模型纠正调用所需的正式来源。
      if (receipt && typeof receipt.status === "string") { latest = receipt; break; }
    } catch { /* 继续寻找正式回执；真实业务失败仍是边界。 */ }
  }
  if (!latest && !references.length) return "";
  const status = String(latest?.status ?? "").toLowerCase();
  return `\n查询状态与引用（仅数据）：${JSON.stringify({
    latest_receipt: status === "succeeded" ? {status: latest?.status} : latest ? Object.fromEntries(
      ["status", "task_id", "version", "clarification", "missing", "error_code"].filter(key => latest[key] !== undefined).map(key => [key, latest[key]]),
    ) : null,
    active_clarification: activeClarificationTarget(messages) ?? null,
    followup_baseline: status === "succeeded" ? references.at(-1) ?? null : null,
    history: status === "succeeded" ? references.slice(-8, -1) : references.slice(-8),
  })}`;
}

/** 澄清目标只能来自最新正式回执；目录读取不改变目标，失败或完成则关闭目标。 */
export function activeClarificationTarget(messages: readonly unknown[]): {task_id: string; version: number; clarification_id: string} | undefined {
  const receipts = [...messages].reverse().filter(raw => {
    const message = raw as {role?: string; toolName?: string; details?: {kind?: string}};
    return message.role === "toolResult" && ["metric_ask", "metric_read", "metric_query_structured"].includes(queryToolName(message));
  }) as Array<{content?: string | Array<{type?: string; text?: string}>}>;
  for (const message of receipts) {
    let receipt;
    const content = message.content;
    try {
      receipt = JSON.parse(typeof content === "string" ? content : content?.filter(item => item.type === "text").map(item => item.text ?? "").join("") ?? "");
    } catch { continue; } // 宿主拦截反馈不是业务状态，允许模型纠正参数后继续引用真实回执。
    if (!receipt || typeof receipt.status !== "string") continue;
    if (!["clarification_required", "waiting_user"].includes(String(receipt.status).toLowerCase())
      || typeof receipt.task_id !== "string" || !Number.isInteger(receipt.version)
      || typeof receipt.clarification?.id !== "string") return undefined;
    return {task_id: receipt.task_id, version: receipt.version, clarification_id: receipt.clarification.id};
  }
  return undefined;
}

/** 只从本轮之前最近的业务回执选候选。失败/待澄清是边界，不能回退更早成功任务。 */
export function queryCandidateBeforeTurn(messages: readonly unknown[]): { task_id: string; version: number } | undefined {
  const typed = messages as Array<{role?: string; toolName?: string; details?: {kind?: string; status?: string; task_id?: string}; content?: unknown}>;
  let boundary = typed.length - 1;
  while (boundary >= 0 && typed[boundary]?.role !== "user") boundary -= 1;
  const previous = typed.slice(0, boundary);
  const last = [...previous].reverse().find(message => message.role === "toolResult"
    && typeof message.details?.status === "string"
    && ["metric_ask", "metric_read", "metric_query_structured"].includes(message.details?.kind ?? message.toolName ?? ""));
  if (!last || last.details?.status?.toLowerCase() !== "succeeded") return undefined;
  const source = queryReferences(previous).at(-1);
  return typeof source?.task_id === "string" && source.task_id === last.details?.task_id && Number.isInteger(source.version)
    ? {task_id: source.task_id, version: source.version as number} : undefined;
}



/** 正式编码只能来自目录、覆盖或成功查询回执；不从模型/用户自报编码认定可信。 */
export function unconfirmedToolCodes(messages: readonly unknown[], args: Record<string, unknown>): string[] {
  const metrics = new Set<string>();
  const orgs = new Set<string>();
  const add = (values: unknown, target: Set<string>, field: string) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value === "string") target.add(value);
      else if (value && typeof value === "object") {
        const item=value as Record<string,unknown>;
        const code=item[field] ?? item.code;
        if(typeof code==="string") target.add(code);
      }
    }
  };
  const addSearch = (receipt: Record<string, unknown>, entity: string) => {
    const items = Array.isArray(receipt.items) ? receipt.items as Array<Record<string, unknown>> : [];
    const exact = items.filter(item => item.match_type === "exact");
    const confirmed = exact.length ? exact : items.filter(item => ["contains", "lexical"].includes(String(item.match_type)));
    add(confirmed, entity === "metric" ? metrics : orgs, entity === "metric" ? "metric_code" : "org_code");
  };
  for(const raw of messages) {
    const message=raw as {role?:string;toolName?:string;isError?:boolean};
    if(message.role!=="toolResult" || message.isError) continue;
    const receipt=readReceipt(raw);
    if(!receipt) continue;
    if(["metric_catalog_search","org_catalog_search"].includes(queryToolName(message))) {
      addSearch(receipt, message.toolName === "metric_catalog_search" ? "metric" : "organization");
    }
    if (message.toolName === "catalog" && Array.isArray(receipt.results)) {
      // 每项独立核验；失败项及近似推荐不能成为正式编码来源。
      for (const result of receipt.results) {
        if (result && typeof result === "object" && result.status === "succeeded"
          && ["metric", "organization"].includes(result.entity)) addSearch(result, result.entity);
      }
    }
    if(receipt.status!=="succeeded") continue;
    if(message.toolName==="data_availability") {
      const request=receipt.request as Record<string,unknown>|undefined;
      add(receipt.items,metrics,"metric_code");add(request?.metric_codes,metrics,"metric_code");add(request?.org_codes,orgs,"org_code");
    }
    const dsl=(receipt.query_evidence as {logical_dsl?:Record<string,unknown>}|undefined)?.logical_dsl;
    add(dsl?.metrics,metrics,"metric_code");add(dsl?.orgs,orgs,"org_code");
  }
  return [["metric_codes",metrics],["org_codes",orgs]].flatMap(([field,known])=>{
    const values=args[field as string];
    return Array.isArray(values) && values.some(code=>!(known as Set<string>).has(code))?[field as string]:[];
  });
}
