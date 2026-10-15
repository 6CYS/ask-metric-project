import type {FieldInputCorrection, FieldSchema} from "./types.js";

export const fieldClarificationInputSchema = {type: "object", required: ["clarify", "sourceText"],
  properties: {clarify: {const: true}, sourceText: {type: "string", minLength: 1}}, additionalProperties: false};

/** 公布完整输入契约；正常值仍使用字段原 Schema，业务澄清由字段合并入口单独验证。 */
export function modelFieldInputSchema(field: FieldSchema, valueSchema = field.inputSchema): Record<string, unknown> | undefined {
  return field.userClarification ? {anyOf: [valueSchema ?? (field.validation?.enum ? {enum: field.validation.enum} : {}),
    fieldClarificationInputSchema]} : valueSchema;
}

/** 纠错也公布完整合法路径；组合已收窄的正常值 Schema 保留，缺项判断仍由主模型结合用户依据完成。 */
export function withFieldClarification(field: FieldSchema, correction: FieldInputCorrection): FieldInputCorrection {
  if (!field.userClarification) return correction;
  const inputSchema = correction.userClarification ? correction.inputSchema : modelFieldInputSchema(field, correction.inputSchema);
  return {...correction, ...(inputSchema ? {inputSchema} : {}), userClarification: {
    question: field.userClarification.question,
    instruction: "检查正常业务值的依据：本轮明确表达、可信继承或Schema明确无损派生。已有明确依据时修正正常值参数，不重复询问；allowedValues 即使只剩一个值也不代表用户已选择。缺少必要业务选择时显式set {clarify:true,sourceText:本轮相关原文}，同次保存全部必要未决选择及其它已知条件，不给其它无依据字段试填正常值，由服务端提出声明的问题，不填写问题或候选。Schema必填不授权默认值，不猜排名方向、条数或时间取数口径。",
  }};
}
