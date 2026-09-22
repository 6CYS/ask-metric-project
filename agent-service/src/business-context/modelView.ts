import {createCapabilities} from "./capabilities.js";
import type {BusinessFrame} from "./types.js";

/** 模型视图只给决策所需的字段；完整溯源留在 Frame Store，按引用读取。 */
export function modelFrame(frame: BusinessFrame, currentTurnId: string) {
  const current = frame.turnId === currentTurnId;
  return {frameId: frame.frameId, parentFrameId: frame.parentFrameId, capability: frame.capability,
    currentTurn: current,
    status: frame.status, executionMode: frame.delta.executionMode, resultRef: frame.resultRef, issues: frame.issues,
    ...(!current && ["clarifying", "ready"].includes(frame.status) ? {continuation: {
      tool: "resolve_business_turn", baseReference: {frameId: frame.frameId},
      unresolvedFields: frame.issues.map(issue => issue.field),
      instruction: "后续用户回合先解析本轮 Frame；未变化字段省略或 retain，不直接执行历史 frameId。",
    }} : {}),
    ...(current && frame.status === "ready" ? {nextAction: frame.delta.executionMode === "execute"
      ? {tool: "execute_business_frame", arguments: {frameId: frame.frameId}}
      : {action: "conditions_saved"}} : {}),
    fields: Object.fromEntries(Object.entries(frame.fields).filter(([, field]) => field.resolutionStatus !== "missing")
      .map(([name, field]) => [name, {rawValue: field.rawValue, value: field.resolvedValue,
        status: field.resolutionStatus, ...(field.candidates ? {candidates: field.candidates} : {})}]))};
}

/** 一次提供必要输入契约，避免模型为了构造参数反复读取完整历史和 Schema。 */
export function modelCapabilitySchemas() {
  return createCapabilities().list().map(schema => ({capability: schema.capability,
    fields: Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, {
      label: field.label, required: field.required, inherit: field.inheritable,
      ...(field.description ? {description: field.description} : {}),
      ...(field.validation ? {validation: field.validation} : {}),
      ...(field.resolver === "date" ? {input: "未改变则省略或 retain；改变时传本轮完整日期原文，省略年份由解析器处理"} : {}),
      ...(field.resolver === "organization" ? {input: "未改变则省略或 retain；改变时传本轮原文名称；待定候选选择用 {candidateIndex}"} : {}),
      ...(field.resolver === "metric" ? {input: "未改变则省略或 retain；新指标用 {fromQuestion:true, mentionIndexes?:number[]}；待定候选选择用 {candidateIndex}"} : {}),
      ...(field.resolver.startsWith("calculation_") ? {inputSchema: field.inputSchema} : {}),
    }]))}));
}
