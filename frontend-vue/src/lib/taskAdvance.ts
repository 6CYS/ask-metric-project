import type { BackendNextTaskResult } from "@/types/api"

/** 只读兼容旧状态；这些标记来自任务记录，不根据用户用词判断追问。 */
export function isRetiredContextTask(task: Pick<BackendNextTaskResult, "debug" | "clarification">): boolean {
  const shadow = task.debug?.multiturn_shadow as { conversation_act?: string; gray_execution?: { decision?: string } } | undefined
  const route = task.debug?.execution_route as { selected_pipeline?: string } | undefined
  return ["FOLLOW_UP", "REFERENCE_ACTION", "CLARIFICATION_ANSWER"].includes(shadow?.conversation_act ?? "")
    || ["MULTITURN_CONTEXT", "MULTITURN_CLARIFICATION", "LEGACY_GRAY_MULTITURN_OVERRIDE"].includes(route?.selected_pipeline ?? "")
    || ["multiturn_context", "result_reference"].includes(task.clarification?.type ?? "")
    || shadow?.gray_execution?.decision === "PROMOTE"
    || Boolean(task.debug?.context_clarification_pending)
}

export function needsSemanticResume(task: BackendNextTaskResult): boolean {
  if (isRetiredContextTask(task)) return false
  if (task.status !== "RUNNING" || task.logical_dsl || task.clarification) return false
  return task.current_stage === "SLOT_EXTRACTION"
}
