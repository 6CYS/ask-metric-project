import type { AnswerReceipt, PendingQuestion } from "@/lib/agentApi"

type FeedbackRecord = {
  pending_questions?: unknown
  answer_receipts?: unknown
  semantic_task?: unknown
}

function asFeedbackRecord(value: unknown): FeedbackRecord | undefined {
  return value && typeof value === "object" ? value as FeedbackRecord : undefined
}

function isPendingQuestion(value: unknown): value is PendingQuestion {
  if (!value || typeof value !== "object") return false
  const question = value as Partial<PendingQuestion>
  return typeof question.question_id === "string" && typeof question.version === "number"
    && typeof question.prompt === "string" && Array.isArray(question.options)
    && (question.kind === "choice" || question.kind === "confirm")
}

function isAnswerReceipt(value: unknown): value is AnswerReceipt {
  if (!value || typeof value !== "object") return false
  const receipt = value as Partial<AnswerReceipt>
  return typeof receipt.question_id === "string" && typeof receipt.version === "number"
    && typeof receipt.notice === "string"
    && ["applied", "declined", "not_applied", "already_applied"].includes(receipt.outcome ?? "")
}

/** SemanticFeedback 既可直接作为 details，也可由证据包装在 details.semantic_task 中。 */
export function semanticQuestionFeedback(details: unknown): {
  pendingQuestions: PendingQuestion[]
  answerReceipts: AnswerReceipt[]
} {
  const direct = asFeedbackRecord(details)
  const wrapped = asFeedbackRecord(direct?.semantic_task)
  const questionSource = Array.isArray(direct?.pending_questions) ? direct.pending_questions
    : Array.isArray(wrapped?.pending_questions) ? wrapped.pending_questions : []
  const receiptSource = Array.isArray(direct?.answer_receipts) ? direct.answer_receipts
    : Array.isArray(wrapped?.answer_receipts) ? wrapped.answer_receipts : []
  return {
    pendingQuestions: questionSource.filter(isPendingQuestion),
    answerReceipts: receiptSource.filter(isAnswerReceipt),
  }
}
