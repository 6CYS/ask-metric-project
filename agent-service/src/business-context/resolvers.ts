import { FieldResolverRegistry } from "./core.js";
import type { DateModelValue, FieldCandidate, FieldResolution, MentionResolution, ResolverContext, OrganizationScopeInput, HistoryFieldReferenceInput, FieldTurnIntent } from "./types.js";
import type { MetricMention } from "./metricMentions.js";
import { BusinessInputError } from "./inputError.js";
import { hasInputEvidence } from "./inputEvidence.js";
import {resolveRankingEvidence} from "./rankingEvidence.js";

const invalid = (): FieldResolution => ({status: "invalid"});
const resolved = (value: unknown): FieldResolution => ({status: "resolved", value});
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** 模型换算结果只做宽松形状校验：真实日历与口径取舍由服务端严格裁定，畸形时按未提交处理。 */
function looseDateModelValue(raw: unknown): DateModelValue | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as {start?: unknown; end?: unknown; dates?: unknown};
  if (typeof value.start !== "string" || !DATE_ONLY.test(value.start)
    || typeof value.end !== "string" || !DATE_ONLY.test(value.end)) return undefined;
  if (value.dates !== undefined && (!Array.isArray(value.dates) || value.dates.length < 2
    || !value.dates.every(item => typeof item === "string" && DATE_ONLY.test(item)))) return undefined;
  return {start: value.start, end: value.end, ...(value.dates ? {dates: [...(value.dates as string[])]} : {})};
}
/** 多 mention 的最终编码按编码去重合并，名称与编码一一对应。 */
function mergeMetricValues(values: Array<{codes: string[]; names: string[]}>): {codes: string[]; names: string[]} {
  const merged = new Map<string, string>();
  for (const value of values) value.codes.forEach((code, index) => merged.set(code, value.names[index]!));
  return {codes: [...merged.keys()], names: [...merged.values()]};
}
/** 逐条 mention 快照：已 resolved 的编码跨轮保留，候选留待用户确认，不再对已确定项重跑目录。 */
function mentionSnapshot(mention: MetricMention): MentionResolution {
  return {text: mention.text, start: mention.start, end: mention.end, status: mention.resolution.status,
    ...(mention.resolution.value ? {value: mention.resolution.value as {codes: string[]; names: string[]}} : {}),
    ...(mention.resolution.candidates ? {candidates: mention.resolution.candidates} : {}),
    ...(mention.resolution.metadata ? {metadata: structuredClone(mention.resolution.metadata)} : {}),
    ...(mention.group ? {group: {id: mention.group.id}} : {})};
}
/** 同组只暴露首个未决片段的候选：同一组基础指标候选不重复出现，用户确认一次即可。 */
function candidateEntries(entries: MentionResolution[]): number[] {
  const seen = new Set<string>();
  return entries.flatMap((entry, index) => {
    if (entry.status === "resolved") return [];
    if (entry.group && seen.has(entry.group.id)) return [];
    if (entry.group) seen.add(entry.group.id);
    return [index];
  });
}
const resolvedEntry = (entry: MentionResolution, code: string, name: string): MentionResolution => ({
  text: entry.text, start: entry.start, end: entry.end, status: "resolved", value: {codes: [code], names: [name]},
  ...(entry.group ? {group: entry.group} : {}),
  ...(entry.metadata ? {metadata: structuredClone(entry.metadata)} : {}),
});
/** remove 的 mentionIndexes 引用上一论 Frame mention 清单序号（从1开始），按清单大小校验。 */
function mentionIndexSelection(raw: unknown, size: number): number[] {
  const indexes = (raw as {mentionIndexes?: unknown} | undefined)?.mentionIndexes;
  if (!Array.isArray(indexes) || !indexes.length || new Set(indexes).size !== indexes.length
    || !indexes.every(i => Number.isInteger(i) && i >= 1 && i <= size)) {
    throw new BusinessInputError("INVALID_MENTION_REFERENCE", "metric",
      "remove 的 mentionIndexes 引用上一论 Frame mention 清单的序号（从1开始）；放弃整个字段用 clear。原焦点未改变。");
  }
  return indexes as number[];
}
/** 剩余 mention 的合成结果：全部已定则合并 resolved，否则保持澄清且候选只暴露未决项。 */
function remainingMentionResolution(remaining: MentionResolution[], metadata: Record<string, unknown>): FieldResolution {
  const pending = remaining.filter(mention => mention.status !== "resolved");
  if (!pending.length) {
    const merged = mergeMetricValues(remaining.map(mention => mention.value!));
    return {status: "resolved", value: merged,
      metadata: {...metadata, referenceValues: [...merged.codes, ...merged.names]}};
  }
  return {
    status: pending.some(mention => mention.status === "ambiguous") ? "ambiguous" : "needs_confirmation",
    candidates: candidateEntries(remaining).flatMap(index =>
      ((remaining[index]!.candidates ?? []) as FieldCandidate[]).map(candidate => ({
        ...candidate, metadata: {...candidate.metadata, rawValueIndex: index},
      }))),
    metadata: {...metadata, pendingRawValues: remaining.map(mention => mention.status === "resolved"
      ? [...mention.value!.codes] : mention.text)},
  };
}
/**
 * 跨轮候选确认：已 resolved 的 mention 直接沿用可信编码，被确认条目取候选编码，不再重跑目录复核。
 * 基础指标候选确认后，同组其余口径按同一源指标一并确定；只确认了基础指标、口径未定时继续按目录追问口径。
 */
async function confirmMetricMention(candidate: FieldCandidate, previous: NonNullable<ResolverContext["previous"]>,
  entries: MentionResolution[], context: ResolverContext): Promise<FieldResolution> {
  const index = Number(candidate.metadata?.rawValueIndex ?? -1);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length || entries[index]!.status === "resolved") return invalid();
  const target = entries[index]!;
  let updated: MentionResolution[];
  if (candidate.metadata?.kind === "base_only") {
    // 用户选定了基础指标但原文没有口径：按目录重新解析该基础指标，得到口径候选后继续追问。
    const response = await context.resolveCatalog("metric", [candidate.value as string]);
    const value = response.value as {codes?: string[]; names?: string[]} | undefined;
    const next: MentionResolution = response.status === "resolved" && value?.codes?.length === 1
      ? resolvedEntry(target, value.codes[0]!, value.names![0]!)
      : {text: target.text, start: target.start, end: target.end, status: "needs_confirmation",
        candidates: (response.candidates ?? []).map(({metadata, ...rest}) => {
          const {rawValueIndex: _index, ...kept} = metadata ?? {};
          return Object.keys(kept).length ? {...rest, metadata: kept} : rest;
        }),
        ...(target.group ? {group: target.group} : {})};
    if (next.status !== "resolved" && !next.candidates?.length) return invalid();
    updated = entries.map((entry, entryIndex) => entryIndex === index ? next : entry);
  } else {
    const source = candidate.metadata?.kind === "base" && target.group ? candidate.metadata.source_metric_code : undefined;
    updated = entries.map((entry, entryIndex) => {
      if (entryIndex === index) return resolvedEntry(entry, candidate.code ?? candidate.value as string, candidate.value as string);
      if (source === undefined || entry.status === "resolved" || entry.group?.id !== target.group?.id) return entry;
      const match = ((entry.candidates ?? []) as FieldCandidate[])
        .find(item => item.metadata?.source_metric_code === source && typeof item.code === "string");
      return match ? resolvedEntry(entry, match.code!, match.value as string) : entry;
    });
    // 后端只给出具备全组口径的基础指标候选；同组仍有缺口说明快照不一致，不能部分确定。
    if (source !== undefined && updated.some(entry => entry.group?.id === target.group?.id && entry.status !== "resolved")) {
      return invalid();
    }
  }
  const result = remainingMentionResolution(updated, {
    extractedRawValues: previous.metadata?.extractedRawValues ?? updated.map(entry => entry.text),
    ...(typeof previous.metadata?.questionText === "string" ? {questionText: previous.metadata.questionText} : {}),
    ...(previous.metadata?.removedMentions !== undefined ? {removedMentions: previous.metadata.removedMentions} : {}),
    mentionResolutions: updated, confirmedRawValues: previous.rawValue, confirmationTurnId: context.turnId,
  });
  return {...result, metadata: {...result.metadata, confirmed: result.status === "resolved"}};
}
/** 显式放弃：从上一论 mention 清单剔除指定项，剩余项按当前状态合成；剔除片段供覆盖率复核排除。 */
async function removeMetricMentions(raw: unknown, context: ResolverContext): Promise<FieldResolution> {
  const previous = context.previous;
  const resolutions = previous?.metadata?.mentionResolutions;
  if (Array.isArray(resolutions) && resolutions.length) {
    const entries = resolutions as MentionResolution[];
    const dropped = new Set(mentionIndexSelection(raw, entries.length));
    const removed = entries.filter((_, index) => dropped.has(index + 1));
    const remaining = entries.filter((_, index) => !dropped.has(index + 1));
    const savedRemoved = previous?.metadata?.removedMentions;
    const priorRemoved = savedRemoved === undefined ? [] : savedRemoved;
    if (!Array.isArray(priorRemoved)) throw new Error("INVALID_METRIC_COVERAGE_SNAPSHOT");
    // 多轮 remove/确认始终沿用同一原句；累计已放弃片段，后续复核继续排除这些目标。
    const removedMentions = [...new Map([...priorRemoved, ...removed].map(mention => [
      `${mention.start}:${mention.end}`, {text: mention.text, start: mention.start, end: mention.end, status: "removed"},
    ])).values()];
    if (!remaining.length) throw new BusinessInputError("METRIC_REMOVE_ALL", "metric",
      "放弃全部指标请使用 clear；remove 只放弃其中部分项。原焦点未改变。");
    return remainingMentionResolution(remaining, {
      extractedRawValues: remaining.map(mention => mention.text),
      ...(typeof previous?.metadata?.questionText === "string" ? {questionText: previous.metadata.questionText} : {}),
      mentionResolutions: remaining,
      removedMentions,
      confirmationTurnId: context.turnId,
    });
  }
  // 旧 Frame 回退：只有 pendingRawValues 文本/可信编码，剔除后仍需对剩余原文精确匹配复核。
  const pendingRaw = previous?.metadata?.pendingRawValues;
  if (!previous || !Array.isArray(pendingRaw) || !pendingRaw.length) {
    throw new BusinessInputError("METRIC_REMOVE_NOT_SUPPORTED", "metric",
      "该指标字段没有可放弃的 mention 记录；放弃整个字段用 clear。原焦点未改变。");
  }
  const dropped = new Set(mentionIndexSelection(raw, pendingRaw.length));
  const values = pendingRaw.filter((_, index) => !dropped.has(index + 1));
  if (!values.length) throw new BusinessInputError("METRIC_REMOVE_ALL", "metric",
    "放弃全部指标请使用 clear；remove 只放弃其中部分项。原焦点未改变。");
  const references = values.flatMap(value => Array.isArray(value) ? value : [value]);
  if (!references.every(value => typeof value === "string" && value)) return invalid();
  const response = await context.resolveCatalog("metric", references as string[]);
  return {...response, metadata: {...response.metadata, pendingRawValues: values, confirmationTurnId: context.turnId,
    ...(response.status === "resolved" ? {referenceValues: Object.values(response.value as object).flat()} : {})}};
}
export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(now);
}
function fromCurrentInput(raw: string, context: ResolverContext): boolean {
  return context.inputSource === "inherited" || hasInputEvidence(context.originalMessage, raw);
}
function historyReferenceRecovery(raw: unknown, context: ResolverContext, intent?: FieldTurnIntent): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const reference = raw as HistoryFieldReferenceInput;
  const previous = context.previous;
  if ("fromHistory" in raw && context.inputSource !== "inherited" && typeof reference.sourceText === "string"
    && !fromCurrentInput(reference.sourceText, context) && previous
    && !["resolved", "temporary_error"].includes(previous.resolutionStatus) && !previous.candidates?.length) {
    throw new BusinessInputError("HISTORY_REFERENCE_EVIDENCE_MISSING", context.fieldName ?? "organizations",
      "原字段没有可确认对象，本轮也没有该历史指代原文。请针对原未决条件询问用户，不能重写历史原文继续尝试。", undefined,
      {action: "ask_user", message: "尚未确定机构，请提供具体机构或说明要沿用的历史查询。"});
  }
  if (intent?.mode === "confirm" && ("confirm" in raw || "candidateIndex" in raw) && previous
    && !["resolved", "temporary_error"].includes(previous.resolutionStatus) && !previous.candidates?.length) {
    throw new BusinessInputError("INVALID_CANDIDATE_REFERENCE", context.fieldName ?? "organizations",
      "当前未决字段没有待确认候选，不能用确认声明补造选择；请询问用户补充具体名称。原焦点未改变。", undefined,
      {action: "ask_user", message: "请提供要查询的具体机构名称，当前尚无可确认的候选。"});
  }
}
/** 修复提示必须与已保存状态一致；无候选的未决字段不能靠 confirm 恢复。 */
function currentInputError(entity: string, context: ResolverContext): BusinessInputError {
  const previous = context.previous;
  const hasChoices = !!previous?.candidates?.length
    && ["needs_confirmation", "ambiguous"].includes(previous.resolutionStatus);
  const action = hasChoices
    ? "用户正在回答已保存候选时可传 {confirm:true}，所选项由系统按用户回复确定。"
    : previous?.resolutionStatus === "resolved"
      ? "沿用已确定字段请省略或 retain；历史组合请提交有来源的结构化字段引用。"
      : "当前没有可确认候选，不能用 confirm 或历史名称补造选择；本轮指代历史条件时请提交结构化字段引用及其来源，仅在没有可信来源时询问用户补充条件。";
  return new BusinessInputError("FIELD_INPUT_NOT_CURRENT", entity,
    `set 的名称必须来自本轮原文。${action}原焦点未改变，不能通过检索目录绕过原文校验。`);
}
export function createFieldResolvers(): FieldResolverRegistry {
  const registry = new FieldResolverRegistry();
  for (const entity of ["metric", "organization"]) registry.register({
    name: entity, supports: schema => schema.resolver === entity,
    removable: entity === "metric",
    ...(entity === "organization" ? {recoveryPreflight: (raw: unknown, _schema: unknown, context: ResolverContext, intent?: FieldTurnIntent) => historyReferenceRecovery(raw, context, intent)} : {}),
    async resolve(raw, _schema, context) {
      if (context.fieldOperation === "remove") {
        // 放弃语义只支持指标字段；组织/日期等字段由主循环的 removable 门禁提前拦截。
        if (entity !== "metric") throw new BusinessInputError("FIELD_REMOVE_NOT_SUPPORTED", entity,
          "仅指标字段支持按 mention 放弃单项；其他字段用 clear 或重新 set。原焦点未改变。");
        return removeMetricMentions(raw, context);
      }
      if (entity === "organization" && raw && typeof raw === "object" && !Array.isArray(raw) && "fromHistory" in raw) {
        historyReferenceRecovery(raw, context);
        if (!context.resolveFieldReference) throw new Error("FIELD_REFERENCE_RESOLVER_UNAVAILABLE");
        return context.resolveFieldReference(raw as HistoryFieldReferenceInput, context.fieldName ?? "organizations", context.inputSource, context.previous);
      }
      if (entity === "organization" && raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw) {
        const scope = raw as OrganizationScopeInput;
        if (typeof scope.sourceText !== "string" || !scope.sourceText.trim() || !fromCurrentInput(scope.sourceText, context)
          || (scope.kind === "children_of" && (typeof scope.parentName !== "string" || !scope.parentName.trim()
            || !fromCurrentInput(scope.parentName, context) || !hasInputEvidence(scope.sourceText, scope.parentName)))) {
          throw new BusinessInputError("FIELD_INPUT_NOT_CURRENT", entity, "范围 sourceText 和上级 parentName 必须来自本轮原文，沿用范围请省略或 retain，不能扩大未知机构范围。原焦点未改变。");
        }
        if (!context.resolveOrganizationScope) throw new Error("ORGANIZATION_SCOPE_RESOLVER_UNAVAILABLE");
        const previousScope = (context.previous?.resolvedValue as import("./types.js").ResolvedOrganizations | undefined)?.scope;
        const source = context.inputSource === "inherited" && scope.kind === "children_of" && previousScope?.kind === "children_of"
          ? {...scope, parentName: previousScope.parent_code} : scope;
        const response = await context.resolveOrganizationScope(source);
        return {...response, metadata: {...response.metadata, refreshOnInherit: response.status === "resolved"}};
      }
      if (entity === "organization" && raw && typeof raw === "object" && !Array.isArray(raw) && "orgSuggestion" in raw) {
        // 模型按有权机构清单自主判断的结论：编码/名称至少其一，不再做原文子串校验；
        // excerpt 仅记录用户原文片段供明示与审计，成员校验与编码来源由后端裁定。
        const suggestion = (raw as {orgSuggestion?: unknown}).orgSuggestion;
        const record = suggestion && typeof suggestion === "object" && !Array.isArray(suggestion)
          ? suggestion as Record<string, unknown> : undefined;
        const text = (key: string) => {
          const value = record?.[key];
          return typeof value === "string" && value.trim() ? value.trim() : undefined;
        };
        const code = text("code"), name = text("name"), excerpt = text("excerpt");
        if (!record || (!code && !name)) {
          throw new BusinessInputError("ORG_SUGGESTION_INVALID", entity,
            "orgSuggestion 至少提交有权机构清单中的编码或名称之一，excerpt 为用户原文片段；无法判断时改用本轮原文名称提交或询问用户。原焦点未改变。");
        }
        if (!context.resolveCatalogSuggested) throw new Error("ORG_SUGGESTION_RESOLVER_UNAVAILABLE");
        const response = await context.resolveCatalogSuggested(entity,
          {...(code ? {code} : {}), ...(name ? {name} : {}), ...(excerpt ? {excerpt} : {})});
        // 建议未唯一命中但其值在候选中时标记首推，澄清展示置顶并改为确认式话术。
        const preferred = (candidate: FieldCandidate) =>
          candidate.preferred === true || !!(code && candidate.code === code) || !!(name && candidate.value === name);
        const candidates = response.candidates?.map(candidate => preferred(candidate) ? {...candidate, preferred: true} : candidate);
        return {...response, ...(candidates ? {candidates} : {}),
          metadata: {...response.metadata, ...(excerpt ? {rawExcerpt: excerpt} : {})}};
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw) && ("candidateIndex" in raw || "confirm" in raw)) {
        const previous = context.previous;
        if (!previous?.candidates?.length || !["needs_confirmation", "ambiguous"].includes(previous.resolutionStatus)) {
          const unresolved = !!previous && !["resolved", "temporary_error"].includes(previous.resolutionStatus);
          const label = entity === "metric" ? "指标" : "机构";
          throw new BusinessInputError("INVALID_CANDIDATE_REFERENCE", entity,
            unresolved ? "当前未决字段没有待确认候选，不能把口头同意转成已确定条件；请询问用户补充具体名称。原焦点未改变。"
              : "当前没有待确认的候选；新条件请按本轮原文提交，沿用已确定字段请省略或 retain。原焦点未改变。",
            undefined, unresolved ? {action: "ask_user", message: `请提供要查询的具体${label}名称，当前尚无可确认的候选。`} : undefined);
        }
        if (context.previousTurnId === context.turnId || !context.originalMessage.trim()) {
          throw new BusinessInputError("CONFIRMATION_REQUIRES_USER_TURN", entity,
            "候选必须等待下一轮用户确认，不能在当前回合自行确认。请针对已保存候选询问用户。", undefined,
            {action: "ask_user", message: "请确认下方候选，或补充更准确的名称。"});
        }
        // 所选项由系统按用户回复在规范清单中确定；模型给出的序号不作依据。回复对应不上时保持待确认并重新展示清单。
        const chosen = context.confirmation?.selected ?? [];
        if (!chosen.length) {
          return {status: previous.resolutionStatus, candidates: previous.candidates,
            metadata: {...previous.metadata, confirmedRawValues: previous.metadata?.confirmedRawValues ?? previous.rawValue,
              confirmationUnclear: true}};
        }
        const previousScope = previous.rawValue as OrganizationScopeInput | undefined;
        if (entity === "organization" && previousScope?.kind === "children_of") {
          if (!context.resolveOrganizationScope) throw new Error("ORGANIZATION_SCOPE_RESOLVER_UNAVAILABLE");
          const candidate = chosen[0]!.candidate;
          const response = await context.resolveOrganizationScope({...previousScope, parentName: candidate.code ?? String(candidate.value)});
          return {...response, metadata: {...response.metadata, confirmed: response.status === "resolved", confirmedRawValues: previous.rawValue, refreshOnInherit: response.status === "resolved",
            confirmationTurnId: context.turnId}};
        }
        const mentionResolutions = previous.metadata?.mentionResolutions;
        if (entity === "metric" && Array.isArray(mentionResolutions) && mentionResolutions.length) {
          // 新 Frame 已逐条保存 mention 解析结果：逐个应用所选项，已 resolved 项不再重跑目录复核。
          let entries = mentionResolutions as MentionResolution[];
          let result: FieldResolution = invalid();
          for (const option of chosen) {
            result = await confirmMetricMention(option.candidate, {...previous, metadata: {...previous.metadata, mentionResolutions: entries}}, entries, context);
            if (result.status === "invalid") return result;
            entries = result.metadata?.mentionResolutions as MentionResolution[];
          }
          return {...result, metadata: {...result.metadata, confirmationSource: "user_reply"}};
        }
        const pending = previous.metadata?.pendingRawValues;
        const values: unknown[] = Array.isArray(pending) ? [...pending] : Array.isArray(previous.rawValue) ? [...previous.rawValue] : [previous.rawValue];
        for (const {candidate} of chosen) {
          const index = Number(candidate.metadata?.rawValueIndex ?? 0);
          if (!Number.isInteger(index) || index < 0 || index >= values.length) return invalid();
          // 同名候选必须用事实源返回的编码复核，不能再次按同名文本解析。
          values[index] = candidate.code ?? candidate.value;
        }
        // 首轮已确定的省略口径保存的是可信编码；复核时展开，候选索引仍按原片段定位。
        const sourceIndexes = values.flatMap((value, valueIndex) =>
          (Array.isArray(value) ? value : [value]).map(() => valueIndex));
        const references = values.flatMap(value => Array.isArray(value) ? value : [value]);
        if (!references.every(value => typeof value === "string" && value)) return invalid();
        if (entity === "organization" && previous.rawValue && typeof previous.rawValue === "object"
          && !Array.isArray(previous.rawValue) && "fromHistory" in previous.rawValue) {
          // 新增机构的候选属于完整历史组合提案。确认后仍从绑定来源复核，不能只查询新增项或绕过最新状态。
          const historyCodes = previous.metadata?.referenceHistoryCodes;
          if (!Array.isArray(historyCodes) || !historyCodes.length || !context.resolveFieldReference) return invalid();
          const add = references.slice(historyCodes.length) as string[];
          const response = await context.resolveFieldReference({...previous.rawValue as HistoryFieldReferenceInput, add},
            context.fieldName ?? "organizations", "inherited", previous);
          return {...response, metadata: {...response.metadata, confirmed: response.status === "resolved",
            confirmationSource: "user_reply", confirmationTurnId: context.turnId}};
        }
        const response = await context.resolveCatalog(entity, references as string[]);
        const candidates = entity === "metric" ? response.candidates?.map(item => {
          const rawIndex = Number(item.metadata?.rawValueIndex);
          return {...item, metadata: {...item.metadata,
            ...(Number.isInteger(rawIndex) && sourceIndexes[rawIndex] !== undefined
              ? {rawValueIndex: sourceIndexes[rawIndex]} : {})}};
        }) : response.candidates;
        // 所选项由系统按用户回复确定；旧 sourceText 参数不作为事实来源。
        return {...response, ...(candidates ? {candidates} : {}), metadata: {...response.metadata, confirmed: response.status === "resolved", confirmedRawValues: previous.rawValue,
          // 模型建议通道的原文片段跨确认保留，执行回执的非字面命中明示仍指向用户原话。
          ...(previous.metadata?.rawExcerpt !== undefined ? {rawExcerpt: previous.metadata.rawExcerpt} : {}),
          pendingRawValues: values, confirmationTurnId: context.turnId,
          ...(response.status === "resolved" ? {referenceValues: Object.values(response.value as object).flat()} : {})}};
      }
      // 继承重试上次临时失败的指标：按当时保存的原句重新匹配，而不是要求本轮原文再次出现指标名称。
      const retryQuestion = entity === "metric" && context.inputSource === "inherited"
        && context.previous?.resolutionStatus === "temporary_error"
        && typeof context.previous.metadata?.questionText === "string" ? context.previous.metadata.questionText : undefined;
      if (entity === "metric" && context.resolveMetricMentions && (context.inputSource !== "inherited" || retryQuestion)) {
        const source: ResolverContext = retryQuestion ? {...context, originalMessage: retryQuestion, inputSource: "explicit"} : context;
        // 兼容旧名称参数也必须来自本轮，不能把历史名称伪装成用户的新输入。
        if ((typeof raw === "string" && !fromCurrentInput(raw, source))
          || (Array.isArray(raw) && raw.some(value => typeof value !== "string" || !fromCurrentInput(value, source)))) {
          throw currentInputError(entity, source);
        }
        const result = await context.resolveMetricMentions(retryQuestion);
        // 保存原句：下一次继承重试凭它重新匹配，用户不必重述问题。
        if (result.status === "temporary_error") return {status: "temporary_error", metadata: {questionText: source.originalMessage}};
        const selection = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as {mentionIndexes?: unknown}).mentionIndexes : undefined;
        const requestedIndexes = selection === undefined ? result.mentions.map((_, i) => i + 1) : selection;
        if (!Array.isArray(requestedIndexes) || !requestedIndexes.every(i => Number.isInteger(i) && i >= 1 && i <= result.mentions.length)
          || new Set(requestedIndexes).size !== requestedIndexes.length || (selection !== undefined && !requestedIndexes.length)) {
          throw new BusinessInputError("INVALID_MENTION_REFERENCE", entity, "只用本轮目录算法结果中的 mentionIndexes（从1开始）；不要自行切分指标名称。原焦点未改变。");
        }
        let indexes: number[] = requestedIndexes;
        if (selection !== undefined && indexes.length !== result.mentions.length) {
          const omitted = result.mentions.filter((_, index) => !indexes.includes(index + 1));
          if (omitted.some(mention => mention.resolution.status !== "resolved")) {
            // 漏掉待确认指标时先保留整个目标并澄清；不能让模型的部分选择抹去候选。
            indexes = result.mentions.map((_, index) => index + 1);
          } else if (!context.previous) {
            throw new BusinessInputError("PARTIAL_METRIC_SELECTION", entity,
              "独立新查询必须保留本轮识别到的全部指标；不能用 mentionIndexes 丢弃已确定项。若用户明确修改已有目标，应引用原 Frame 后再选择变化片段。原焦点未改变。");
          }
        }
        const mentions = indexes.map(i => result.mentions[i - 1]!);
        const rawValues = mentions.map(mention => mention.text);
        if (!mentions.length) {
          if (context.previous && !retryQuestion) {
            const guidance = currentInputError(entity, context);
            throw new BusinessInputError("METRIC_MENTION_NOT_FOUND", entity,
              `本轮算法没有识别到新指标，不能用空结果覆盖已有字段。用户明确更换指标但目录未匹配时必须说明未匹配，不能执行旧指标。${guidance.correction}`, undefined, guidance.recovery);
          }
          return {status: "not_found", metadata: {extractedRawValues: [source.originalMessage]}};
        }
        const unresolved = mentions.filter(mention => mention.resolution.status !== "resolved");
        const snapshots = mentions.map(mentionSnapshot);
        if (unresolved.length) return {
          status: unresolved.some(mention => mention.resolution.status === "ambiguous") ? "ambiguous" : "needs_confirmation",
          candidates: candidateEntries(snapshots).flatMap(index => (mentions[index]!.resolution.candidates ?? []).map(candidate => ({
            ...candidate, metadata: {...candidate.metadata, rawValueIndex: index},
          }))), metadata: {extractedRawValues: rawValues,
            pendingRawValues: mentions.map(mention => mention.resolution.status === "resolved"
              ? [...(mention.resolution.value as {codes: string[]}).codes] : mention.text),
            // 逐条快照供跨轮确认/放弃直接拼装；questionText 供执行期构造覆盖率复核原句。
            questionText: source.originalMessage, mentionResolutions: snapshots},
        };
        const merged = mergeMetricValues(mentions.map(mention => mention.resolution.value as {codes: string[]; names: string[]}));
        return {status: "resolved", value: merged,
          metadata: {extractedRawValues: rawValues, referenceValues: [...merged.codes, ...merged.names],
            questionText: source.originalMessage, mentionResolutions: mentions.map(mentionSnapshot)}};
      }
      const values = typeof raw === "string" ? [raw] : raw;
      if (!Array.isArray(values) || !values.length || values.length > 100
        || !values.every(item => typeof item === "string" && item.trim() && item.length <= 200 && fromCurrentInput(item, context))) {
        throw currentInputError(entity, context);
      }
      // 只传原文；正式编码由当前授权目录的精确/别名匹配返回。
      const response = await context.resolveCatalog(entity, values);
      return response.status === "resolved" ? {...response, metadata: {...response.metadata,
        referenceValues: Object.values(response.value as object).flat()}} : response;
    },
  });
  registry.register({name: "date", supports: schema => schema.resolver === "date",
    async resolve(raw, _schema, context) {
      // 宿主绑定的口径切换等同用户明确指定：跳过原文解析与模型换算，不调用后端。
      if (context.timeOverride) {
        return {status: "resolved", value: {...context.timeOverride}, metadata: {timeSource: "user_override"}};
      }
      const input = typeof raw === "string" ? {rawValue: raw}
        : raw && typeof raw === "object" && !Array.isArray(raw) ? raw as {rawValue?: unknown; modelValue?: unknown} : undefined;
      if (!input || typeof input.rawValue !== "string" || !fromCurrentInput(input.rawValue, context)) {
        throw new BusinessInputError("FIELD_INPUT_NOT_CURRENT", "date", "日期 set 提交 {rawValue: 本轮完整日期原文, modelValue: 按当前日历换算的 {start,end}（ISO YYYY-MM-DD，离散多点加 dates）}；无法确定换算时只提交 rawValue。不编造原文或拿系统日期代填。本轮未提供日期时删除 time 修改：已选来源有日期则继承，没有日期则服务端返回缺项澄清，请用户补充。不要重复改写虚构日期；原焦点未改变。");
      }
      const previous = context.previous?.resolutionStatus === "resolved" ? context.previous.resolvedValue as {start?: string; end?: string} : undefined;
      const startYear = previous?.start?.slice(0, 4);
      const endYear = previous?.end?.slice(0, 4);
      // 仅省略年份的日历表达继承可信历史年份；相对今天的表达由后端仍按今天计算。模型换算随原文一并提交，由服务端校验并兜底。
      const resolution = await context.resolveCatalog("date", [input.rawValue], startYear && startYear === endYear ? Number(startYear) : undefined,
        looseDateModelValue(input.modelValue));
      // 原文日期本身无效属于真实业务澄清；时间取值方式冲突另由组合校验判断。
      if (resolution.status === "invalid") return {...resolution, metadata: {...resolution.metadata, userInputIssue: true}};
      // “近N年”歧义的完整年度备选口径存入字段 metadata，执行回执据此透传前端切换。
      if (resolution.status === "resolved" && resolution.alternative) {
        return {...resolution, metadata: {...resolution.metadata, timeAlternative: resolution.alternative}};
      }
      return resolution;
    }});
  registry.register({name: "enum", supports: schema => !!schema.validation?.enum,
    async resolve(raw, schema) {
      const values = schema.validation!.enum!;
      if (values.includes(raw)) return resolved(raw);
      // 协议枚举由 Pi 按 Schema 生成；拼错参数不能变成业务澄清并锁死本轮纠正。
      throw new BusinessInputError("FIELD_ENUM_INVALID", schema.label,
        `rawValue 必须使用 Schema 枚举 ${JSON.stringify(values)}。${schema.description ?? ""}请根据用户语义修正调用，不要求用户填写内部枚举；保留完整业务名称，不能把名称中的限定词移作控制参数。原焦点未改变。`);
    }});
  registry.register({name: "query_operation", supports: schema => schema.resolver === "query_operation",
    async resolve(raw, schema, context) {
      const value = raw as import("./types.js").QueryOperation | undefined;
      if (value?.kind === "value" && Object.keys(value).length === 1) return resolveRankingEvidence(value, schema, context);
      if (value?.kind === "rank_position" && Object.keys(value).length === 1) return resolveRankingEvidence(value, schema, context);
      if (value?.kind === "ranking" && ["top", "bottom"].includes(value.position) && Number.isInteger(value.top_n)
        && value.top_n >= 1 && value.top_n <= 100 && Object.keys(value).every(key => ["kind", "position", "top_n"].includes(key))) return resolveRankingEvidence(value, schema, context);
      throw new BusinessInputError("QUERY_OPERATION_INVALID", "operation", "按 operation 判别联合提交 value 普通取值、ranking 前后 N 名榜单，或 rank_position 关注对象在比较总体中的位次；位次不接收 TopN 参数。不能丢弃用户的排名目标。原焦点未改变。");
    }});
  registry.register({name: "integer", supports: schema => schema.resolver === "integer",
    async resolve(raw, schema) {
      return typeof raw === "number" && Number.isInteger(raw) && raw >= (schema.validation?.min ?? -Infinity)
        && raw <= (schema.validation?.max ?? Infinity) ? resolved(raw) : invalid();
    }});
  const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw);
  registry.register({name: "calculation_expressions", supports: schema => schema.resolver === "calculation_expressions",
    async resolve(raw) {
      return Array.isArray(raw) && raw.length > 0 && raw.length <= 10 && raw.every(item => object(item)
        && typeof item.name === "string" && typeof item.label === "string" && typeof item.expression === "string"
        && item.expression.length <= 2000) ? resolved(raw) : invalid();
    }});
  registry.register({name: "calculation_bindings", supports: schema => schema.resolver === "calculation_bindings",
    async resolve(raw, _schema, context) {
      return object(raw) && Object.keys(raw).length > 0 && Object.keys(raw).length <= 100
        && Object.values(raw).every(item => object(item) && typeof item.fact_id === "string" && item.fact_id.length <= 180)
        && context.resolveFactBindings
        ? context.resolveFactBindings(raw as Record<string, {fact_id: string}>) : invalid();
    }});
  registry.register({name: "calculation_constants", supports: schema => schema.resolver === "calculation_constants",
    async resolve(raw, _schema, context) {
      return object(raw) && Object.keys(raw).length <= 20 && Object.values(raw).every(item => object(item)
        && typeof item.value === "string" && /^-?\d{1,30}(\.\d{1,20})?$/.test(item.value)
        && typeof item.source_text === "string" && item.source_text.length > 0 && fromCurrentInput(item.source_text, context))
        ? resolved(raw) : invalid();
    }});
  return registry;
}
