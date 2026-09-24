import { FieldResolverRegistry } from "./core.js";
import type { FieldCandidate, FieldResolution, MentionResolution, ResolverContext, OrganizationScopeInput } from "./types.js";
import type { MetricMention } from "./metricMentions.js";
import { BusinessInputError } from "./inputError.js";

const invalid = (): FieldResolution => ({status: "invalid"});
const resolved = (value: unknown): FieldResolution => ({status: "resolved", value});
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
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
    ...(mention.resolution.candidates ? {candidates: mention.resolution.candidates} : {})};
}
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
    candidates: remaining.flatMap((mention, index) => mention.status === "resolved" ? []
      : ((mention.candidates ?? []) as FieldCandidate[]).map(candidate => ({
        ...candidate, metadata: {...candidate.metadata, rawValueIndex: index},
      }))),
    metadata: {...metadata, pendingRawValues: remaining.map(mention => mention.status === "resolved"
      ? [...mention.value!.codes] : mention.text)},
  };
}
/** 跨轮候选确认：已 resolved 的 mention 直接沿用可信编码，被确认条目取候选编码，不再重跑目录复核。 */
function confirmMetricMention(candidate: FieldCandidate, previous: NonNullable<ResolverContext["previous"]>,
  entries: MentionResolution[], context: ResolverContext): FieldResolution {
  const index = Number(candidate.metadata?.rawValueIndex ?? -1);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length || entries[index]!.status === "resolved") return invalid();
  const updated = entries.map((entry, entryIndex) => entryIndex === index
    ? {text: entry.text, start: entry.start, end: entry.end, status: "resolved",
      value: {codes: [candidate.code ?? candidate.value as string], names: [candidate.value as string]}}
    : entry);
  const result = remainingMentionResolution(updated, {
    extractedRawValues: previous.metadata?.extractedRawValues ?? updated.map(entry => entry.text),
    ...(typeof previous.metadata?.questionText === "string" ? {questionText: previous.metadata.questionText} : {}),
    mentionResolutions: updated, confirmedRawValues: previous.rawValue, confirmationTurnId: context.turnId,
  });
  return {...result, metadata: {...result.metadata, confirmed: result.status === "resolved"}};
}
/** 显式放弃：从上一论 mention 清单剔除指定项，剩余项按当前状态合成；剔除片段记录供覆盖率原句删除。 */
async function removeMetricMentions(raw: unknown, context: ResolverContext): Promise<FieldResolution> {
  const previous = context.previous;
  const resolutions = previous?.metadata?.mentionResolutions;
  if (Array.isArray(resolutions) && resolutions.length) {
    const entries = resolutions as MentionResolution[];
    const dropped = new Set(mentionIndexSelection(raw, entries.length));
    const removed = entries.filter((_, index) => dropped.has(index + 1));
    const remaining = entries.filter((_, index) => !dropped.has(index + 1));
    if (!remaining.length) throw new BusinessInputError("METRIC_REMOVE_ALL", "metric",
      "放弃全部指标请使用 clear；remove 只放弃其中部分项。原焦点未改变。");
    return remainingMentionResolution(remaining, {
      extractedRawValues: remaining.map(mention => mention.text),
      ...(typeof previous?.metadata?.questionText === "string" ? {questionText: previous.metadata.questionText} : {}),
      mentionResolutions: remaining,
      removedMentions: removed.map(mention => ({text: mention.text, start: mention.start, end: mention.end, status: "removed"})),
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
  return context.inputSource === "inherited" || normalized(context.originalMessage).includes(normalized(raw));
}
export function createFieldResolvers(): FieldResolverRegistry {
  const registry = new FieldResolverRegistry();
  for (const entity of ["metric", "organization"]) registry.register({
    name: entity, supports: schema => schema.resolver === entity,
    removable: entity === "metric",
    async resolve(raw, _schema, context) {
      if (context.fieldOperation === "remove") {
        // 放弃语义只支持指标字段；组织/日期等字段由主循环的 removable 门禁提前拦截。
        if (entity !== "metric") throw new BusinessInputError("FIELD_REMOVE_NOT_SUPPORTED", entity,
          "仅指标字段支持按 mention 放弃单项；其他字段用 clear 或重新 set。原焦点未改变。");
        return removeMetricMentions(raw, context);
      }
      if (entity === "organization" && raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw) {
        const scope = raw as OrganizationScopeInput;
        if (typeof scope.sourceText !== "string" || !scope.sourceText.trim() || !fromCurrentInput(scope.sourceText, context)
          || (scope.kind === "children_of" && (typeof scope.parentName !== "string" || !scope.parentName.trim()
            || !fromCurrentInput(scope.parentName, context) || !normalized(scope.sourceText).includes(normalized(scope.parentName))))) {
          throw new BusinessInputError("FIELD_INPUT_NOT_CURRENT", entity, "范围 sourceText 和上级 parentName 必须来自本轮原文，沿用范围请省略或 retain，不能扩大未知机构范围。原焦点未改变。");
        }
        if (!context.resolveOrganizationScope) throw new Error("ORGANIZATION_SCOPE_RESOLVER_UNAVAILABLE");
        const previousScope = (context.previous?.resolvedValue as import("./types.js").ResolvedOrganizations | undefined)?.scope;
        const source = context.inputSource === "inherited" && scope.kind === "children_of" && previousScope?.kind === "children_of"
          ? {...scope, parentName: previousScope.parent_code} : scope;
        const response = await context.resolveOrganizationScope(source);
        return {...response, metadata: {...response.metadata, refreshOnInherit: response.status === "resolved"}};
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw) && "candidateIndex" in raw) {
        const selection = raw as {candidateIndex?: number; sourceText?: string};
        const previous = context.previous;
        const candidate = previous?.candidates?.[(selection.candidateIndex ?? 0) - 1];
        if (!Number.isInteger(selection.candidateIndex) || !candidate || typeof candidate.value !== "string") {
          throw new BusinessInputError("INVALID_CANDIDATE_REFERENCE", entity, "用待确认 Frame 中从1开始的 candidateIndex 选择候选；不要提交候选名称或编码作为新原文。原焦点未改变。");
        }
        if (context.previousTurnId === context.turnId || !context.originalMessage.trim()) {
          throw new BusinessInputError("CONFIRMATION_REQUIRES_USER_TURN", entity, "候选必须等待下一轮用户确认，不能在当前回合自行确认。请针对候选询问用户。");
        }
        const previousScope = previous?.rawValue as OrganizationScopeInput | undefined;
        if (entity === "organization" && previousScope?.kind === "children_of") {
          if (!context.resolveOrganizationScope) throw new Error("ORGANIZATION_SCOPE_RESOLVER_UNAVAILABLE");
          const response = await context.resolveOrganizationScope({...previousScope, parentName: candidate.code ?? candidate.value});
          return {...response, metadata: {...response.metadata, confirmed: response.status === "resolved", confirmedRawValues: previous.rawValue, refreshOnInherit: response.status === "resolved",
            confirmationTurnId: context.turnId}};
        }
        const mentionResolutions = previous?.metadata?.mentionResolutions;
        if (entity === "metric" && previous && Array.isArray(mentionResolutions) && mentionResolutions.length) {
          // 新 Frame 已逐条保存 mention 解析结果：直接拼装，已 resolved 项不再重跑 resolveCatalog。
          return confirmMetricMention(candidate, previous, mentionResolutions as MentionResolution[], context);
        }
        const pending = previous?.metadata?.pendingRawValues;
        const values: unknown[] = Array.isArray(pending) ? [...pending] : Array.isArray(previous?.rawValue) ? [...previous.rawValue] : [previous?.rawValue];
        const index = Number(candidate.metadata?.rawValueIndex ?? 0);
        if (!Number.isInteger(index) || index < 0 || index >= values.length) return invalid();
        // 同名候选必须用事实源返回的编码复核，不能再次按同名文本解析。
        values[index] = candidate.code ?? candidate.value;
        // 首轮已确定的省略口径保存的是可信编码；复核时展开，候选索引仍按原片段定位。
        const sourceIndexes = values.flatMap((value, valueIndex) =>
          (Array.isArray(value) ? value : [value]).map(() => valueIndex));
        const references = values.flatMap(value => Array.isArray(value) ? value : [value]);
        if (!references.every(value => typeof value === "string" && value)) return invalid();
        const response = await context.resolveCatalog(entity, references as string[]);
        const candidates = entity === "metric" ? response.candidates?.map(item => {
          const rawIndex = Number(item.metadata?.rawValueIndex);
          return {...item, metadata: {...item.metadata,
            ...(Number.isInteger(rawIndex) && sourceIndexes[rawIndex] !== undefined
              ? {rawValueIndex: sourceIndexes[rawIndex]} : {})}};
        }) : response.candidates;
        // 确认语义仍由 Pi 选择候选；原文由宿主绑定，旧 sourceText 参数不作为事实来源。
        return {...response, ...(candidates ? {candidates} : {}), metadata: {...response.metadata, confirmed: response.status === "resolved", confirmedRawValues: previous?.rawValue,
          pendingRawValues: values, confirmationTurnId: context.turnId,
          ...(response.status === "resolved" ? {referenceValues: Object.values(response.value as object).flat()} : {})}};
      }
      if (entity === "metric" && context.resolveMetricMentions && context.inputSource !== "inherited") {
        // 兼容旧名称参数也必须来自本轮，不能把历史名称伪装成用户的新输入。
        if ((typeof raw === "string" && !fromCurrentInput(raw, context))
          || (Array.isArray(raw) && raw.some(value => typeof value !== "string" || !fromCurrentInput(value, context)))) {
          throw new BusinessInputError("FIELD_INPUT_NOT_CURRENT", entity,
            "指标名称不在本轮原文。沿用已确定指标请省略或 retain；选择待确认候选用 {candidateIndex}，不要重新提交历史名称。原焦点未改变。");
        }
        const result = await context.resolveMetricMentions();
        if (result.status === "temporary_error") return {status: "temporary_error"};
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
          if (context.previous) throw new BusinessInputError("METRIC_MENTION_NOT_FOUND", entity,
            "本轮算法没有识别到新指标，不能用空结果覆盖已有字段。若用户仅确认或继续已有查询，省略 metrics 或 retain，并以 executionMode=execute 解析本轮 Frame；若用户明确更换指标但目录未匹配，应说明未匹配，不能执行旧指标。待确认候选使用 {candidateIndex}。原焦点未改变。");
          return {status: "not_found", metadata: {extractedRawValues: [context.originalMessage]}};
        }
        const unresolved = mentions.filter(mention => mention.resolution.status !== "resolved");
        if (unresolved.length) return {
          status: unresolved.some(mention => mention.resolution.status === "ambiguous") ? "ambiguous" : "needs_confirmation",
          candidates: mentions.flatMap((mention, index) => (mention.resolution.candidates ?? []).map(candidate => ({
            ...candidate, metadata: {...candidate.metadata, rawValueIndex: index},
          }))), metadata: {extractedRawValues: rawValues,
            pendingRawValues: mentions.map(mention => mention.resolution.status === "resolved"
              ? [...(mention.resolution.value as {codes: string[]}).codes] : mention.text),
            // 逐条快照供跨轮确认/放弃直接拼装；questionText 供执行期构造覆盖率复核原句。
            questionText: context.originalMessage, mentionResolutions: mentions.map(mentionSnapshot)},
        };
        const merged = mergeMetricValues(mentions.map(mention => mention.resolution.value as {codes: string[]; names: string[]}));
        return {status: "resolved", value: merged,
          metadata: {extractedRawValues: rawValues, referenceValues: [...merged.codes, ...merged.names],
            questionText: context.originalMessage, mentionResolutions: mentions.map(mentionSnapshot)}};
      }
      const values = typeof raw === "string" ? [raw] : raw;
      if (!Array.isArray(values) || !values.length || values.length > 100
        || !values.every(item => typeof item === "string" && item.trim() && item.length <= 200 && fromCurrentInput(item, context))) {
        throw new BusinessInputError("FIELD_INPUT_NOT_CURRENT", entity, "set 只接受本轮原文名称。继承已有字段请省略或 retain；确认已有候选请传 {candidateIndex: 序号}。原焦点和候选未改变，不能通过检索目录绕过原文校验。");
      }
      // 只传原文；正式编码由当前授权目录的精确/别名匹配返回。
      const response = await context.resolveCatalog(entity, values);
      return response.status === "resolved" ? {...response, metadata: {...response.metadata,
        referenceValues: Object.values(response.value as object).flat()}} : response;
    },
  });
  registry.register({name: "date", supports: schema => schema.resolver === "date",
    async resolve(raw, _schema, context) {
      if (typeof raw !== "string" || !fromCurrentInput(raw, context)) {
        throw new BusinessInputError("FIELD_INPUT_NOT_CURRENT", "date", "日期 set 必须使用本轮原始表达，不自行换算。沿用已有日期请省略或 retain；原焦点未改变。");
      }
      const previous = context.previous?.resolutionStatus === "resolved" ? context.previous.resolvedValue as {start?: string; end?: string} : undefined;
      const startYear = previous?.start?.slice(0, 4);
      const endYear = previous?.end?.slice(0, 4);
      // 仅省略年份的日历表达继承可信历史年份；相对今天的表达由后端仍按今天计算。
      const resolution = await context.resolveCatalog("date", [raw], startYear && startYear === endYear ? Number(startYear) : undefined);
      // 原文日期本身无效属于真实业务澄清；时间取值方式冲突另由组合校验判断。
      return resolution.status === "invalid" ? {...resolution, metadata: {...resolution.metadata, userInputIssue: true}} : resolution;
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
    async resolve(raw) {
      const value = raw as import("./types.js").QueryOperation | undefined;
      if (value?.kind === "value" && Object.keys(value).length === 1) return resolved(value);
      if (value?.kind === "ranking" && ["asc", "desc"].includes(value.order) && Number.isInteger(value.top_n)
        && value.top_n >= 1 && value.top_n <= 100 && Object.keys(value).every(key => ["kind", "order", "top_n"].includes(key))) return resolved(value);
      throw new BusinessInputError("QUERY_OPERATION_INVALID", "operation", "按 operation 判别联合提交普通取值或完整排名参数，不能丢弃用户的排名目标。原焦点未改变。");
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
