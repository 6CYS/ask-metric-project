import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { businessEvidences } from "../answerEvidence.js";
import type { AskMetricRequestContext } from "../requestContext.js";
import { safeWorkingHistory } from "../semantic-task/contextMemory.js";
import { sourceConditions } from "./sourceConditions.js";
import { inquiryCatalogView } from "./view.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const MAX_HISTORY_TURNS = 3;
const MAX_SOURCES_PER_TURN = 16;
const MAX_ANSWER_LENGTH = 6000;
const MAX_RELATED_RELATIONS = 8;
const MAX_RELATED_METRICS = 24;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(record) : []);
function turns(messages: readonly AgentMessage[]): AgentMessage[][] {
  const output: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") output.push([]);
    output.at(-1)?.push(message);
  }
  return output;
}

function historicalAnswer(messages: AgentMessage[]): string {
  if (
    messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.details === undefined &&
        message.content.some(
          (block) => block.type === "text" && block.text === "历史来源当前不可访问。",
        ),
    )
  )
    return "此轮历史证据当前不可访问，不能据此复述数值或继承条件。";
  for (const message of [...messages].reverse()) {
    if (message.role === "toolResult" && !message.isError && record(message.details)) {
      const details = message.details;
      if (
        details.kind === "conversation_reply" &&
        details.status === "answered" &&
        text(details.answer)
      )
        return text(details.answer);
      if (
        details.kind === "runtime_delivery" &&
        details.status === "delivered" &&
        text(details.public_answer)
      )
        return text(details.public_answer);
      const answers = businessEvidences(details).filter(
        (source) => source.status === "succeeded" && text(source.public_answer),
      );
      if (answers.length) return answers.map((source) => source.public_answer).join("\n\n");
    }
  }
  return "上一轮未完成可交付的回答。";
}

/** 只投影同轮已查询对象的目录邻居；原引用由执行入口从授权原生回执恢复。 */
function relatedCatalog(messages: AgentMessage[], sources: Row[]): unknown {
  const queried = new Set(
    sources.flatMap((source) => rows(source.metrics).map((metric) => text(metric.code))),
  );
  if (!queried.size) return undefined;
  const metrics = new Map<string, Row>(),
    relations = new Map<string, Row>();
  let hasMore = false;
  for (const message of [...messages].reverse()) {
    if (
      message.role !== "toolResult" ||
      message.isError ||
      !record(message.details) ||
      message.details.kind !== "analysis_catalog" ||
      message.details.status !== "succeeded"
    )
      continue;
    const bindings = record(message.details.binding_map) ? message.details.binding_map : {};
    const registered = new Map(
      rows(message.details.candidate_map)
        .filter((item) => item.match_type !== "semantic")
        .map((item) => [text(item.code), text(item.binding_ref)]),
    );
    for (const block of message.content) {
      if (block.type !== "text") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(block.text);
      } catch {
        continue;
      }
      const view = inquiryCatalogView(payload);
      if (!record(view)) continue;
      const pages = Array.isArray(view.results) ? rows(view.results) : [view];
      // 正文描述已通过目录视图筛选；内部 candidate_map 仅校验原引用，不直接发送。
      const candidates = new Map(
        [...rows(view.items), ...pages.flatMap((page) => rows(page.related_metrics))]
          .filter((item) => {
            const code = text(item.code),
              ref = text(item.binding_ref),
              signed = text(bindings[ref]);
            return (
              item.match_type !== "semantic" &&
              registered.get(code) === ref &&
              signed &&
              signed === bindings[`code:${code}`]
            );
          })
          .map((item) => [text(item.code), item]),
      );
      for (const page of pages) {
        for (const relation of rows(page.relations)) {
          if (!text(relation.id) || !Array.isArray(relation.children)) continue;
          const members = [text(relation.parent), ...relation.children.map(text)];
          if (
            !members.some((code) => queried.has(code)) ||
            members.some((code) => !code || !candidates.has(code))
          )
            continue;
          hasMore ||= page.has_more_relations === true;
          if (relations.has(text(relation.id))) continue;
          const additional = members.filter((code) => !metrics.has(code));
          if (
            relations.size >= MAX_RELATED_RELATIONS ||
            metrics.size + additional.length > MAX_RELATED_METRICS
          ) {
            hasMore = true;
            continue;
          }
          relations.set(text(relation.id), relation);
          for (const code of members) {
            const descriptor = candidates.get(code);
            if (descriptor) metrics.set(code, descriptor);
          }
        }
      }
    }
  }
  if (!relations.size) return undefined;
  return inquiryCatalogView({
    items: [...metrics.values()],
    relations: [...relations.values()],
    has_more_relations: hasMore,
    notice:
      "以下仅为已查询指标的一跳目录导航，不是已查询事实或完整组成证明；按本轮目标选择引用取数。",
  });
}

function compactTurn(messages: AgentMessage[]): { messages: AgentMessage[]; reference?: Row } {
  const user = messages[0],
    assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!user || !assistant || assistant.role !== "assistant")
    return { messages: user ? [user] : [] };
  const seen = new Set<string>();
  const sources = messages
    .flatMap((message) =>
      message.role === "toolResult" && !message.isError
        ? businessEvidences(message.details).map((source) => ({ source, message }))
        : [],
    )
    .filter(({ source }) => source.status === "succeeded")
    .flatMap(({ source, message }) => {
      if (source.kind === "business_report") return [];
      const context = sourceConditions(source, message)?.reference;
      if (!context) return [];
      const id = String(context.run_ref ?? context.task_id);
      if (seen.has(id)) return [];
      seen.add(id);
      return [context];
    });
  const body = historicalAnswer(messages);
  const content =
    body.length > MAX_ANSWER_LENGTH
      ? `${body.slice(0, MAX_ANSWER_LENGTH)}\n（历史正文后续部分省略。）`
      : body;
  const question =
    user.role === "user"
      ? typeof user.content === "string"
        ? user.content
        : user.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
      : "";
  const visibleSources = sources.slice(0, MAX_SOURCES_PER_TURN);
  const catalog = relatedCatalog(messages, visibleSources);
  // 来源条件与目录导航独立交给参考资料入口，不能伪装成已查询事实或助手正文。
  return {
    messages: [
      user,
      { ...assistant, content: [{ type: "text", text: content }], stopReason: "stop" },
    ],
    ...(sources.length
      ? {
          reference: {
            question,
            sources: visibleSources,
            ...(catalog ? { related_catalog: catalog } : {}),
            ...(sources.length > MAX_SOURCES_PER_TURN ? { sources_truncated: true } : {}),
          },
        }
      : {}),
  };
}

/** 先核验最近回合的原始来源，再压缩已完成轮；本轮完整保留，历史目录大小不再决定是否失忆。 */
export async function prepareInquiryHistory(
  request: AskMetricRequestContext,
  messages: readonly AgentMessage[],
) {
  const grouped = turns(messages),
    current = grouped.pop() ?? [];
  const selected = [...grouped.slice(-MAX_HISTORY_TURNS).flat(), ...current];
  const authorizedMessages = await safeWorkingHistory(request, selected);
  const checked = turns(authorizedMessages),
    active = checked.pop() ?? [];
  const history = checked.map(compactTurn);
  return {
    authorizedMessages,
    messages: [...history.flatMap((turn) => turn.messages), ...active],
    referenceContext: history.flatMap((turn) => (turn.reference ? [turn.reference] : [])),
  };
}
