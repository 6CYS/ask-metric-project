import { FieldResolverRegistry } from "./core.js";
import type { FieldResolution, ResolverContext } from "./types.js";
import { BusinessInputError } from "./inputError.js";

const invalid = (): FieldResolution => ({status: "invalid"});
const resolved = (value: unknown): FieldResolution => ({status: "resolved", value});
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
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
    async resolve(raw, _schema, context) {
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
        const pending = previous?.metadata?.pendingRawValues;
        const values = Array.isArray(pending) ? [...pending] : Array.isArray(previous?.rawValue) ? [...previous.rawValue] : [previous?.rawValue];
        const index = Number(candidate.metadata?.rawValueIndex ?? 0);
        if (!Number.isInteger(index) || index < 0 || index >= values.length) return invalid();
        // 同名候选必须用事实源返回的编码复核，不能再次按同名文本解析。
        values[index] = candidate.code ?? candidate.value;
        const response = await context.resolveCatalog(entity, values as string[]);
        // 确认语义仍由 Pi 选择候选；原文由宿主绑定，旧 sourceText 参数不作为事实来源。
        return {...response, metadata: {...response.metadata, confirmed: response.status === "resolved", confirmedRawValues: previous?.rawValue,
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
        const indexes = selection === undefined ? result.mentions.map((_, i) => i + 1) : selection;
        if (!Array.isArray(indexes) || !indexes.every(i => Number.isInteger(i) && i >= 1 && i <= result.mentions.length)
          || new Set(indexes).size !== indexes.length || (selection !== undefined && !indexes.length)) {
          throw new BusinessInputError("INVALID_MENTION_REFERENCE", entity, "只用本轮目录算法结果中的 mentionIndexes（从1开始）；不要自行切分指标名称。原焦点未改变。");
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
          }))), metadata: {extractedRawValues: rawValues, pendingRawValues: rawValues},
        };
        const values = new Map<string, string>();
        for (const mention of mentions) {
          const value = mention.resolution.value as {codes: string[]; names: string[]};
          value.codes.forEach((code, i) => values.set(code, value.names[i]!));
        }
        return {status: "resolved", value: {codes: [...values.keys()], names: [...values.values()]},
          metadata: {extractedRawValues: rawValues, referenceValues: [...values.keys(), ...values.values()]}};
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
      return context.resolveCatalog("date", [raw], startYear && startYear === endYear ? Number(startYear) : undefined);
    }});
  registry.register({name: "enum", supports: schema => !!schema.validation?.enum,
    async resolve(raw, schema) {
      const values = schema.validation!.enum!;
      if (values.includes(raw)) return resolved(raw);
      // 协议枚举由 Pi 按 Schema 生成；拼错参数不能变成业务澄清并锁死本轮纠正。
      throw new BusinessInputError("FIELD_ENUM_INVALID", schema.label,
        `rawValue 必须使用 Schema 枚举 ${JSON.stringify(values)}。${schema.description ?? ""}请根据用户语义修正调用，不要求用户填写内部枚举；保留完整业务名称，不能把名称中的限定词移作控制参数。原焦点未改变。`);
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
