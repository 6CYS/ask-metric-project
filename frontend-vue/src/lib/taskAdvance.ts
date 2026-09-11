import type { BackendNextTaskResult } from "@/types/api"

export function needsSemanticResume(task: BackendNextTaskResult): boolean {
  if (task.status !== "RUNNING" || task.logical_dsl || task.clarification) return false
  if (task.current_stage === "SLOT_EXTRACTION") return true
  const route = task.debug?.execution_route as Record<string, unknown> | undefined
  const answers = task.debug?.clarification_answers
  return task.current_stage === "VALIDATION"
    && route?.selected_pipeline === "MULTITURN_CLARIFICATION"
    && !!task.missing?.includes("multiturn_context")
    && Array.isArray(answers) && answers.length > 0
}
