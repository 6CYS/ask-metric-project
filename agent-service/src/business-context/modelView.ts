import {createCapabilities} from "./capabilities.js";
import {clarificationOptions} from "./clarificationOptions.js";
import {fieldLabels} from "./core.js";
import type {BusinessFrame, MentionResolution, ResolvedField, ResolvedOrganizations} from "./types.js";

const CHOICES_NOTE = "服务端展示已保存的规范清单，并按用户回复或点选确定选项。仅说明待确认条件，不自行罗列、改写或挑选候选；已确定项不重复询问。";

/** 待确认候选只给模型数量和说明：清单由系统展示，模型无从打乱、合并或挑选。 */
function withoutCandidates(field: ResolvedField): ResolvedField {
  const mentions = field.metadata?.mentionResolutions;
  const stripped: ResolvedField = Array.isArray(mentions) ? {...field, metadata: {...field.metadata, mentionResolutions: (mentions as MentionResolution[])
    .map(({candidates, ...mention}) => candidates?.length ? {...mention, choices: candidates.length} : mention)}} : field;
  if (!stripped.candidates?.length) return stripped;
  const {candidates, ...rest} = stripped;
  return {...rest, pendingChoices: {count: candidates.length, instruction: CHOICES_NOTE}} as ResolvedField;
}

/** 集合只暴露描述和授权目标数量，完整编码集合留在服务端状态中。 */
export function modelFields(fields: Record<string, ResolvedField>): Record<string, ResolvedField> {
  return Object.fromEntries(Object.entries(fields).map(([name, raw]) => {
    const field = withoutCandidates(raw);
    const value = field.resolvedValue as ResolvedOrganizations | undefined;
    if (name !== "organizations" || !Array.isArray(value?.codes)) return [name, field];
    if (!value.scope) return [name, {...field, resolvedValue: {...value, count: value.codes.length}}];
    return [name, {...field, resolvedValue: {scope: value.scope, count: value.codes.length}, metadata: undefined}];
  }));
}

/** 待确认 Frame 的规范候选清单；展示与回复对应共用，保证编号一致。 */
export function frameClarificationOptions(frame: BusinessFrame) {
  return clarificationOptions(frame, fieldLabels(createCapabilities().get(frame.capability)));
}

function listedNames(names: unknown, unit: string, visible = 3): string | undefined {
  if (!Array.isArray(names) || !names.length || !names.every(name => typeof name === "string" && name)) return undefined;
  return names.length > visible ? `${names.slice(0, visible).join("、")} 等 ${names.length} ${unit}` : names.join("、");
}

/** 机构集合按用户原话展示（如“各家农商行（60 家）”），逐一点名的机构只列前两家，避免长全称铺满一行。 */
function organizationValue(raw: unknown, value: unknown): string | undefined {
  const resolved = value as Partial<ResolvedOrganizations> | undefined;
  if (!Array.isArray(resolved?.names)) return undefined;
  if (resolved.scope) {
    const sourceText = (raw as {sourceText?: unknown} | undefined)?.sourceText;
    const scopeText = typeof sourceText === "string" && sourceText.trim() ? sourceText.trim()
      : resolved.scope.kind === "authorized_cohort" ? "授权范围内农商行" : "下辖机构";
    return `${scopeText}（${resolved.names.length} 家）`;
  }
  return listedNames(resolved.names, "家", 2);
}

const selectionLabels: Record<string, string> = {latest_in_range: "范围内最新数据日", all_in_range: "范围内全部日期"};

function condition(resolver: string, raw: unknown, value: unknown): {label: string; value: string} | undefined {
  let text: string | undefined;
  let label = "";
  if (resolver === "metric") [label, text] = ["指标", listedNames((value as {names?: unknown} | undefined)?.names, "个指标")];
  else if (resolver === "organization") [label, text] = ["机构", organizationValue(raw, value)];
  else if (resolver === "date") {
    const range = value as {start?: unknown; end?: unknown; dates?: unknown} | undefined;
    label = "日期";
    if (Array.isArray(range?.dates)) text = listedNames(range.dates, "个日期");
    else if (typeof range?.start === "string" && typeof range.end === "string") {
      text = range.start === range.end ? range.start : `${range.start} 至 ${range.end}`;
    }
  } else if (resolver === "query_operation") {
    const operation = value as {kind?: unknown; position?: unknown; top_n?: unknown} | undefined;
    label = "排名";
    if (operation?.kind === "ranking" && typeof operation.top_n === "number") text = `${operation.position === "bottom" ? "后" : "前"} ${operation.top_n} 名`;
  } else if (resolver === "enum" && typeof value === "string") {
    // 单日精确取值不必说明；其余内部枚举、分页和计算引用不面向用户展示。
    [label, text] = ["取数方式", selectionLabels[value]];
  }
  return text ? {label, value: text} : undefined;
}

/**
 * 执行过程展示用的已确定条件：只列已解析字段的业务名称（指标、机构、日期、排名、取数方式），
 * 不含编码、候选或内部控制字段；名称均来自服务端按当前用户权限解析的结果。
 */
export function displayConditions(frame: BusinessFrame): Array<{label: string; value: string}> {
  // 展示信息不能影响解析回执，未知能力直接不展示条件。
  const schema = createCapabilities().list().find(item => item.capability === frame.capability);
  return Object.entries(frame.fields).flatMap(([name, field]) => {
    const definition = schema?.fields[name];
    if (!definition || field.resolutionStatus !== "resolved") return [];
    const item = condition(definition.resolver, field.rawValue, field.resolvedValue);
    return item ? [item] : [];
  });
}

/** 恢复回执与上下文同源，公开剩余处理动作，已确认字段不再交给模型重填。 */
export function modelRecovery(frame: BusinessFrame) {
  if (!frame.recovery) return {};
  const recovery = frame.recovery;
  return {retry_reference: {frameId: frame.frameId}, pending_fields: [...recovery.pendingFields],
    pending_changes: recovery.pendingFields.map(field => {
      const change = recovery.pendingChanges?.find(item => item.field === field);
      return {field, operation: change?.operation ?? "unknown", ...(change?.sourceText ? {source_text: change.sourceText} : {}),
        ...(change?.expectedCount !== undefined ? {expected_count: change.expectedCount} : {}),
        may_retain: change?.mayRetain ?? true, inherit_allowed: change?.mayRetain === true};
    }), confirmed_fields: Object.entries(frame.fields).filter(([, field]) => field.resolutionStatus === "resolved"
      && field.metadata?.confirmationTurnId === recovery.turnId).map(([name]) => name)};
}
