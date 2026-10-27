import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {activeEvidence, businessEvidences} from "../answerEvidence.js";
import type {AskMetricRequestContext} from "../requestContext.js";
import {isSemanticFeedback} from "../semantic-task/feedback.js";
import {publicTextProblem} from "./delivery.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];

/** 只处理纯定义检索的空资料；保留已读取的名称和检索范围，不覆盖其它事实交付。 */
export function missingCatalogDefinitionAnswer(messages: readonly AgentMessage[], proposedAnswer: string): string | undefined {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  const definitions = new Map<string, {name: string; explanation: unknown; description: unknown}>();
  const moreByKeyword = new Map<string, boolean>();
  for (const message of messages.slice(start + 1)) {
    if (message.role !== "toolResult") continue;
    const details = record(message.details);
    if (message.isError || !["catalog", "turn_contract"].includes(String(details.kind))) return;
    if (details.kind !== "catalog") continue;
    if (details.status !== "succeeded" || details.definition_only !== true
      || !Array.isArray(details.metric_definition_searches)) return;
    for (const raw of details.metric_definition_searches) {
      const search = record(raw);
      if (search.status !== "succeeded" || !Array.isArray(search.items) || !search.items.length) return;
      if (typeof search.keyword !== "string") return;
      moreByKeyword.set(search.keyword, search.has_more === true);
      for (const rawItem of search.items) {
        const item = record(rawItem);
        if (typeof item.metric_code !== "string" || typeof item.metric_name !== "string") return;
        definitions.set(item.metric_code, {name: item.metric_name,
          explanation: item.metric_explanation, description: item.description});
      }
    }
  }
  if (!definitions.size || [...definitions.values()].some(item =>
    typeof item.explanation !== "string" || item.explanation.trim()
    || typeof item.description !== "string" || item.description.trim())) return;
  // 只保留答复已采用、且目录确实返回的名称，不能把宽泛检索的所有候选铺成用户的新范围。
  const names = [...definitions.values()].map(item => item.name).filter(name => proposedAnswer.includes(name));
  const subject = names.length === 1 ? `「${names[0]}」` : names.length > 1
    ? `本次查到的指标：${names.join("、")}。\n\n上述指标` : "本次查到的相关指标";
  const scope = [...moreByKeyword.values()].some(Boolean)
    ? "\n本次检索仍有更多匹配项；以上仅说明已读取条目的资料情况。" : "";
  return `${subject}尚未维护正式说明和统计口径。目前无法依据正式资料确认你问的统计范围或计算规则，需要补充对应的口径资料后再解释。${scope}`;
}

/** 定义必须绑定本轮成功查询的正式指标；目录候选、模型正文和历史未查询指标均不能补充事实。 */
export async function appendQueryDefinitions(answer: string, messages: readonly AgentMessage[], request: AskMetricRequestContext): Promise<string> {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  const receipts = messages.slice(start + 1).filter((message): message is Extract<AgentMessage, {role: "toolResult"}> => message.role === "toolResult" && !message.isError);
  const definitions = new Map<string, {name: string; explanation: string; description: string}>();
  for (const message of receipts) {
    const details = record(message.details);
    if (details.kind !== "catalog" || details.action !== "search" || !Array.isArray(details.metric_definition_searches)) continue;
    for (const raw of details.metric_definition_searches) {
      const search = record(raw);
      if (search.status !== "succeeded" || !Array.isArray(search.items)) continue;
      for (const rawItem of search.items) {
        const item = record(rawItem);
        if (typeof item.metric_code !== "string" || !item.metric_code || typeof item.metric_name !== "string"
          || typeof item.metric_explanation !== "string" || typeof item.description !== "string") continue;
        definitions.set(item.metric_code, {name: item.metric_name, explanation: item.metric_explanation, description: item.description});
      }
    }
  }
  if (!definitions.size) return answer;
  const semantic = [...receipts].reverse().find(message => isSemanticFeedback(message.details));
  if (semantic && isSemanticFeedback(semantic.details)
    && (!["succeeded", "reused"].includes(semantic.details.status) || semantic.details.state.completion !== "full")) return answer;
  const evidence = activeEvidence(receipts.flatMap(message => businessEvidences(message.details)));
  if (!evidence.length || evidence.some(item => item.status !== "succeeded"
    || !["metric_query_structured", "metric_ask", "metric_read"].includes(item.kind))) return answer;
  const codes = new Set<string>();
  for (const item of evidence) {
    const details = record(item);
    if (typeof details.frame_id === "string") {
      const frame = await request.frames?.get(details.frame_id);
      const expectedRef = item.task_id && item.result_id ? `query:${encodeURIComponent(item.task_id)}:${encodeURIComponent(item.result_id)}` : undefined;
      if (!frame || frame.sessionId !== request.sessionId || frame.status !== "success" || frame.capability !== "metric_query"
        || !expectedRef || frame.resultRef !== expectedRef || frame.fields.metrics?.resolutionStatus !== "resolved") continue;
      // 空结果同样有经过正式执行的指标范围，不能依赖 rows 才能解释口径。
      for (const code of strings(record(frame.fields.metrics.resolvedValue).codes)) codes.add(code);
    } else if (Array.isArray(details.rows)) {
      for (const row of details.rows) {
        const code = record(row).metric_code;
        if (typeof code === "string" && code) codes.add(code);
      }
    }
  }
  const blocks = [...codes].flatMap(code => {
    const definition = definitions.get(code);
    if (!definition) return [];
    const block = [definition.name,
      ...(definition.explanation.trim() ? [`指标说明：${definition.explanation}`] : []),
      `指标口径：${definition.description.trim() ? definition.description : "本次目录未提供正式口径，暂无法确认。"}`].join("\n");
    return publicTextProblem(block) ? [] : [block];
  });
  return blocks.length ? `${answer}\n\n${blocks.join("\n\n")}` : answer;
}
