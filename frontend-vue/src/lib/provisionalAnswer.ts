import type {AgentStreamEvent} from "./agentApi"

export interface ProvisionalAnswer {
  provisionalContent?: string
  provisionalCallSeq?: number
}

/** 临时正文仅供 pending 气泡显示；累计覆盖，旧调用的撤回不能清掉新调用。 */
export function applyProvisionalAnswer<T extends {status?: string}>(message: T & ProvisionalAnswer,
  event: Extract<AgentStreamEvent, {type: "answer_delta" | "answer_reset"}>): T & ProvisionalAnswer {
  if (message.status !== "pending" || !Number.isSafeInteger(event.call_seq) || event.call_seq < 1
    || event.call_seq < (message.provisionalCallSeq ?? 0)) return message
  if (event.type === "answer_delta") {
    if (typeof event.text !== "string") return message
    return {...message, provisionalContent: event.text, provisionalCallSeq: event.call_seq}
  }
  return {...message, provisionalContent: "", provisionalCallSeq: event.call_seq}
}

export function clearProvisionalAnswer<T extends ProvisionalAnswer>(message: T): T {
  const {provisionalContent: _text, provisionalCallSeq: _seq, ...finalized} = message
  return finalized as T
}
