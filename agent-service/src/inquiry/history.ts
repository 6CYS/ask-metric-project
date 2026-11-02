import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { businessEvidences } from "../answerEvidence.js";
import type { AskMetricRequestContext } from "../requestContext.js";
import { safeWorkingHistory } from "../semantic-task/contextMemory.js";
import { sourceConditions } from "./sourceConditions.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const MAX_HISTORY_TURNS = 3;
const MAX_SOURCES_PER_TURN = 16;
const MAX_ANSWER_LENGTH = 6000;
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
  // 来源条件独立交给参考资料入口，不能伪装成助手已经向用户说过的正文。
  return {
    messages: [
      user,
      { ...assistant, content: [{ type: "text", text: content }], stopReason: "stop" },
    ],
    ...(sources.length
      ? {
          reference: {
            question,
            sources: sources.slice(0, MAX_SOURCES_PER_TURN),
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
