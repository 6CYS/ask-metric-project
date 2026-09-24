import {createCapabilities} from "./capabilities.js";
import type {BusinessFrame, MentionResolution, ResolvedField, ResolvedOrganizations} from "./types.js";

/** 集合只暴露描述和授权目标数量，完整编码集合留在服务端状态中。 */
export function modelFields(fields: Record<string, ResolvedField>): Record<string, ResolvedField> {
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => {
    const value = field.resolvedValue as ResolvedOrganizations | undefined;
    if (name !== "organizations" || !value?.scope) return [name, field];
    return [name, {...field, resolvedValue: {scope: value.scope, count: value.codes.length}, metadata: undefined}];
  }));
}

/** 已 resolved 的 mention 名称；让模型在回执和焦点注入里看到哪些项已锁定，不用再澄清。 */
function lockedMentions(field: ResolvedField): string[] {
  const resolutions = field.metadata?.mentionResolutions;
  if (!Array.isArray(resolutions)) return [];
  return (resolutions as MentionResolution[])
    .filter(mention => mention.status === "resolved" && typeof mention.value?.names?.[0] === "string")
    .map(mention => mention.value!.names[0]!);
}

/** 模型视图只给决策所需的字段；完整溯源留在 Frame Store，按引用读取。 */
export function modelFrame(frame: BusinessFrame, currentTurnId: string) {
  const current = frame.turnId === currentTurnId;
  return {frameId: frame.frameId, parentFrameId: frame.parentFrameId, capability: frame.capability,
    currentTurn: current,
    ...(frame.status === "draft" && frame.errorCode === "TEMPORARY_ERROR" ? {errorCode: frame.errorCode,
      retry_reference: {frameId: frame.frameId}, instruction: "服务暂时不可用，需重试时沿用此引用和原字段，不要求用户重述条件。"} : {}),
    status: frame.status, executionMode: frame.delta.executionMode, resultRef: frame.resultRef, issues: frame.issues,
    ...(!current && ["clarifying", "ready"].includes(frame.status) ? {continuation: {
      tool: "resolve_business_turn", baseReference: {frameId: frame.frameId},
      unresolvedFields: frame.issues.map(issue => issue.field),
      instruction: "后续用户回合先解析本轮 Frame；未变化字段省略或 retain，不直接执行历史 frameId。",
    }} : {}),
    ...(current && frame.status === "ready" ? {nextAction: frame.delta.executionMode === "execute"
      ? {tool: "execute_business_frame", arguments: {frameId: frame.frameId}}
      : {action: "conditions_saved"}} : {}),
    fields: Object.fromEntries(Object.entries(modelFields(frame.fields)).filter(([, field]) => field.resolutionStatus !== "missing")
      .map(([name, field]) => {
        const locked = lockedMentions(field);
        return [name, {rawValue: field.rawValue, value: field.resolvedValue,
          status: field.resolutionStatus, ...(field.candidates ? {candidates: field.candidates} : {}),
          ...(locked.length ? {lockedMentions: locked} : {})}];
      }))};
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
      ...(field.resolver === "metric" ? {input: "未改变则省略或 retain；新指标用 {fromQuestion:true, mentionIndexes?:number[]}（index 属于本轮算法清单，每轮重新抽取、不跨轮）；确认上一论候选用 {candidateIndex}；放弃某项用 operation=remove"} : {}),
      ...(field.inputSchema ? {inputSchema: field.inputSchema} : {}),
    }]))}));
}
