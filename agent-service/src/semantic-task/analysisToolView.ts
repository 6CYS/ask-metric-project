import {semanticParameters} from "./protocol.js";

/** 正文修正时只发送报告定义；网关降为 auto 仍无法选择重新取数。 */
export function reportProseToolView(payload: Record<string, unknown>, reportTool: string | undefined): Record<string, unknown> {
  if (!reportTool || !Array.isArray(payload.tools)) return payload;
  const tools = payload.tools.filter(raw => {
    const definition = raw as {name?: string; function?: {name?: string}};
    return (definition.function?.name ?? definition.name) === reportTool;
  });
  return {...payload, tools, tool_choice: tools.length ? {type: "function", function: {name: reportTool}} : "none"};
}

/** 宿主已指定唯一工具时，不再发送本次不能调用的其他定义；事实和正式Schema保持原样。 */
export function selectedToolView(payload: Record<string, unknown>): Record<string, unknown> {
  const choice = payload.tool_choice as {type?: string; function?: {name?: string}} | undefined;
  const name = choice?.function?.name;
  if (choice?.type !== "function" || !name || !Array.isArray(payload.tools)) return payload;
  const selected = payload.tools.filter(raw => {
    const tool = raw as {type?: string; function?: {name?: string}} | null;
    return tool?.type === "function" && tool.function?.name === name;
  });
  return selected.length === 1 ? {...payload, tools: selected} : payload;
}

/** 只收窄本轮补查的模型视图；正式解析、权限及证据校验仍使用原协议。 */
export function analysisFollowupToolView(payload: Record<string, unknown>, followup: boolean): Record<string, unknown> {
  if (!followup || !Array.isArray(payload.tools)) return payload;
  const parameters = structuredClone(semanticParameters) as unknown as {
    properties: {targets: {maxItems: number; description?: string}};
    definitions: {target: {properties: {analysis: {oneOf: Array<{properties: {plan: {required: string[]}}}>}}}};
  };
  parameters.properties.targets.maxItems = 1;
  parameters.properties.targets.description = "本轮已经取得分析证据。每次仅提交一个补查目标，不复制已执行的目标；多个新指标写在该目标的plan.steps中。已有证据足够时直接交付报告。";
  for (const branch of parameters.definitions.target.properties.analysis.oneOf)
    branch.properties.plan.required = [...new Set([...branch.properties.plan.required, "inquiry"])];
  return {...payload, tools: payload.tools.map(raw => {
    const definition = raw as {name?: string; function?: {name?: string; description?: string}};
    if (definition.function?.name === "resolve_business_turn") return {...definition, function: {...definition.function,
      parameters, description: `${definition.function.description ?? ""} 补查必须在plan.inquiry说明具体疑问、已有事实basis_refs及新证据如何改变判断，只提交一个目标。`}};
    return definition.name === "resolve_business_turn" ? {...definition, parameters} : raw;
  })};
}
