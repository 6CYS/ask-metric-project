import { CapabilityRegistry } from "./core.js";
import type { FieldSchema } from "./types.js";

const field = (label: string, resolver: string, required = true): FieldSchema => ({label, resolver, required,
  inheritable: true, clearable: true});
const enumeration = (label: string, values: string[], required = true): FieldSchema => ({...field(label, "enum", required), missingIsArgumentError: required, validation: {enum: values}});
const integer = (label: string, min: number, max: number): FieldSchema => ({...field(label, "integer", false), validation: {min, max}});
export function createCapabilities(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register({capability: "metric_query", tool: "metric_query_structured", fields: {
    metrics: field("指标", "metric"), organizations: field("机构", "organization"), time: field("日期范围", "date"),
    selection: enumeration("时间范围取数方式", ["exact", "latest_in_range", "all_in_range"]),
    operation: field("查询操作", "query_operation", false),
  }, completeFields(fields, delta) {
    const time = fields.time;
    const range = time?.resolvedValue as {start?: string; end?: string} | undefined;
    // 已校验的单日没有范围选取歧义。仅补缺省，不覆盖显式选择、清除或多日语义。
    if (fields.selection?.resolutionStatus === "missing" && time?.resolutionStatus === "resolved"
      && range?.start && range.start === range.end
      && !delta.fieldChanges.some(change => change.fieldHint === "selection" && change.operation !== "retain")) {
      fields.selection = {rawValue: "exact", resolvedValue: "exact", source: "resolved", resolver: "enum", resolutionStatus: "resolved"};
    }
  }, validate(fields) {
    const issues: import("./types.js").ValidationIssue[] = [];
    const selection = fields.selection?.resolvedValue;
    const time = fields.time?.resolvedValue as {start?: string; end?: string; dates?: string[]} | undefined;
    const operation = fields.operation?.resolvedValue as import("./types.js").QueryOperation | undefined;
    const hasDates = Array.isArray(time?.dates) && time.dates.length > 0;
    // 多个离散点本质是"多个 exact 点"，start/end 为最早/最晚，不适用单日同日校验。
    if (!hasDates && selection === "exact" && time && time.start !== time.end) issues.push({field: "selection", reason: "invalid", message: "指定日取值要求日期范围为同一天；保留日期目标并修正时间取值方式"});
    if (operation?.kind === "ranking" && selection === "all_in_range") throw new Error("UNSUPPORTED_QUERY_COMBINATION");
    if (hasDates && (operation?.kind === "ranking" || selection === "all_in_range")) throw new Error("UNSUPPORTED_QUERY_COMBINATION");
    return issues;
  }});
  registry.register({capability: "data_availability", tool: "data_availability", fields: {
    metrics: field("指标筛选", "metric", false), organizations: field("机构", "organization"),
    time: field("日期范围", "date", false), dimension: enumeration("覆盖维度", ["metrics", "dates"]),
    match: enumeration("匹配方式", ["any", "all"], false), page: {...integer("页码", 1, 100000), inheritable: false},
    page_size: integer("每页条数", 1, 50),
  }, validate(fields) {
    if ((fields.organizations?.resolvedValue as import("./types.js").ResolvedOrganizations | undefined)?.scope) throw new Error("UNSUPPORTED_ORGANIZATION_SCOPE");
    return [];
  }});
  registry.register({capability: "metric_calculate", tool: "metric_calculate", fields: {
    expressions: {...field("计算表达式", "calculation_expressions"), inheritable: false},
    bindings: {...field("本轮事实引用", "calculation_bindings"), inheritable: false},
    constants: {...field("用户常量", "calculation_constants", false), inheritable: false},
    scope_policy: enumeration("计算范围", ["same_org_date", "cross_date", "cross_org", "explicit"], false),
  }});
  registry.get("metric_query").fields.selection!.description = "根据用户目标选择枚举：exact=单个指定日，或多个明确离散日期逐点取值（如2月末、3月末、4月末）；latest_in_range=连续范围内最后有数据的日期；all_in_range=连续范围的完整时间序列。离散日期不要改写成连续区间，也不要使用 all_in_range。描述如何在日期范围内取数，不承载指标名称中的统计口径。日期跨度改变后须重新确定取数方式。排名独立用 operation。";
  const operation = registry.get("metric_query").fields.operation!;
  operation.description = "省略为普通取值。排名提交 {kind:'ranking',order:'desc'或'asc',top_n:1..100}，只对已确定机构目标排序，不自动展开下级；取消排名提交 {kind:'value'}，整个排名条件随之移除。";
  operation.inputSchema = {oneOf: [
    {type: "object", required: ["kind"], properties: {kind: {const: "value"}}, additionalProperties: false},
    {type: "object", required: ["kind", "order", "top_n"], properties: {kind: {const: "ranking"}, order: {enum: ["asc", "desc"]}, top_n: {type: "integer", minimum: 1, maximum: 100}}, additionalProperties: false},
  ]};
  const calculation = registry.get("metric_calculate").fields;
  for (const capability of ["metric_query", "data_availability"]) {
    registry.get(capability).fields.time!.description = "用户本轮未改变日期时省略或 retain，直接继承，不从历史复制日期重填。仅改变日期时逐字保留本轮完整表达及期末/末/初/日等限定，不截短、不改写、不补年份或自行换算。";
    registry.get(capability).fields.time!.inputSchema = {type: "string", minLength: 1};
    for (const name of ["metrics", "organizations"]) {
      const definition = registry.get(capability).fields[name]!;
      definition.description = "新条件用本轮原文名称或名称数组。用户确认上一轮候选时只传 {candidateIndex: 从1开始的候选序号}，原文由服务端绑定；未修改的字段省略或 retain。";
      definition.inputSchema = {anyOf: [
        {type: "string", minLength: 1, maxLength: 200},
        {type: "array", minItems: 1, maxItems: 100, items: {type: "string", minLength: 1, maxLength: 200}},
        {type: "object", required: ["candidateIndex"], properties: {candidateIndex: {type: "integer", minimum: 1},
          sourceText: {type: "string", description: "旧调用兼容字段；确认原文由服务端绑定，本字段不作为依据"}}, additionalProperties: false},
      ]};
      if (name === "organizations" && capability === "metric_query") {
        definition.description += " 集合原文用 {kind:'authorized_cohort',cohort:'rural_commercial_banks',sourceText:本轮集合原文}；明确某机构下属用 {kind:'children_of',parentName:本轮上级名称,sourceText:本轮范围原文}。权限和层级由服务端确定，不能自行枚举编码；未知具体名称不能改成集合。";
        (definition.inputSchema.anyOf as unknown[]).push(
          {type: "object", required: ["kind", "cohort", "sourceText"], properties: {kind: {const: "authorized_cohort"}, cohort: {const: "rural_commercial_banks"}, sourceText: {type: "string", minLength: 1, maxLength: 200}}, additionalProperties: false},
          {type: "object", required: ["kind", "parentName", "sourceText"], properties: {kind: {const: "children_of"}, parentName: {type: "string", minLength: 1, maxLength: 200}, sourceText: {type: "string", minLength: 1, maxLength: 200}}, additionalProperties: false},
        );
      }
      if (name === "metrics") {
        definition.description = "指标由服务端对完整原文进行词典/拼音/字符算法匹配。新指标传 {fromQuestion:true}，默认使用全部匹配项；若只涉及部分已识别指标（如排除某项），mentionIndexes 引用本轮算法匹配清单的 index（从1开始，不能用0；清单每轮从本轮消息重新抽取，不跨轮复用）。不自行提取名称或改写错字。沿用历史则省略或 retain；确认上一论候选传 {candidateIndex}；用户明确放弃某项指标时 operation=remove，rawValue 传 {mentionIndexes:[上一论 Frame 的 mention 序号，从1开始]}。";
        (definition.inputSchema.anyOf as unknown[]).push({type: "object", required: ["fromQuestion"], properties: {
          fromQuestion: {const: true}, mentionIndexes: {type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: {type: "integer", minimum: 1}},
        }, additionalProperties: false}, {type: "object", required: ["mentionIndexes"], properties: {
          mentionIndexes: {type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: {type: "integer", minimum: 1}},
        }, additionalProperties: false});
      }
    }
  }
  calculation.expressions!.description = "最多10个表达式。变量名以英文字母开头，最长32字符；仅四则、abs、sum、avg、min、max，业务数值使用 bindings 变量。同批表达式相互独立，不能引用另一表达式的 name；变量只能来自 bindings 或 constants。";
  calculation.expressions!.inputSchema = {type: "array", minItems: 1, maxItems: 10, items: {type: "object", required: ["name", "label", "expression"], properties: {
    name: {type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$"}, label: {type: "string", minLength: 1, maxLength: 80}, expression: {type: "string", minLength: 1, maxLength: 2000}, display: {enum: ["decimal", "percent"]}, decimal_places: {type: "integer", minimum: 0, maximum: 8},
  }, additionalProperties: false}};
  calculation.bindings!.inputSchema = {type: "object", additionalProperties: {type: "object", required: ["fact_id"], properties: {fact_id: {type: "string"}}, additionalProperties: false}};
  calculation.constants!.inputSchema = {type: "object", additionalProperties: {type: "object", required: ["value", "source_text"], properties: {value: {type: "string"}, source_text: {type: "string"}}, additionalProperties: false}};
  // 只有这些同义字段允许在覆盖与取值能力之间继承，其他字段保持隔离。
  for (const capability of ["metric_query", "data_availability"]) {
    for (const name of ["metrics", "organizations", "time"]) registry.get(capability).fields[name]!.allowedSourceCapabilities =
      [capability === "metric_query" ? "data_availability" : "metric_query"];
  }
  return registry;
}
