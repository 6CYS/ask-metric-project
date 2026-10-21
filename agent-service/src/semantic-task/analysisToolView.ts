import {semanticParameters} from "./protocol.js";

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
