import { CapabilityRegistry } from "./core.js";
import type { FieldSchema } from "./types.js";

const field = (label: string, resolver: string, required = true): FieldSchema => ({label, resolver, required,
  inheritable: true, clearable: true});
const enumeration = (label: string, values: string[], required = true): FieldSchema => ({...field(label, "enum", required), validation: {enum: values}});
const integer = (label: string, min: number, max: number): FieldSchema => ({...field(label, "integer", false), validation: {min, max}});
export function createCapabilities(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register({capability: "metric_query", tool: "metric_query_structured", fields: {
    metrics: field("指标", "metric"), organizations: field("机构", "organization"), time: field("日期范围", "date"),
    selection: enumeration("时间范围取数方式", ["exact", "latest_in_range", "all_in_range", "ranking"]),
    order: enumeration("排序方向", ["asc", "desc"], false), top_n: integer("排名条数", 1, 100),
  }, validate(fields) {
    const issues: import("./types.js").ValidationIssue[] = [];
    const selection = fields.selection?.resolvedValue;
    const time = fields.time?.resolvedValue as {start?: string; end?: string} | undefined;
    const organizations = fields.organizations?.resolvedValue as {codes?: string[]} | undefined;
    if (selection === "exact" && time && time.start !== time.end) issues.push({field: "selection", reason: "invalid", message: "指定日取值要求日期范围为同一天"});
    if (selection === "ranking" && organizations?.codes?.length !== 1 && fields.organizations?.resolutionStatus === "resolved") issues.push({field: "organizations", reason: "invalid", message: "排名必须明确一个范围机构"});
    if (selection !== "ranking") for (const name of ["order", "top_n"]) {
      if (fields[name]?.resolutionStatus === "resolved") issues.push({field: name, reason: "invalid", message: "排名参数仅在排名时使用，请清除"});
    }
    return issues;
  }});
  registry.register({capability: "data_availability", tool: "data_availability", fields: {
    metrics: field("指标筛选", "metric", false), organizations: field("机构", "organization"),
    time: field("日期范围", "date", false), dimension: enumeration("覆盖维度", ["metrics", "dates"]),
    match: enumeration("匹配方式", ["any", "all"], false), page: {...integer("页码", 1, 100000), inheritable: false},
    page_size: integer("每页条数", 1, 50),
  }});
  registry.register({capability: "metric_calculate", tool: "metric_calculate", fields: {
    expressions: {...field("计算表达式", "calculation_expressions"), inheritable: false},
    bindings: {...field("本轮事实引用", "calculation_bindings"), inheritable: false},
    constants: {...field("用户常量", "calculation_constants", false), inheritable: false},
    scope_policy: enumeration("计算范围", ["same_org_date", "cross_date", "cross_org", "explicit"], false),
  }});
  registry.get("metric_query").fields.selection!.description = "根据用户目标选择枚举：exact=单个指定日；latest_in_range=范围内最后有数据的日期；all_in_range=完整时间序列；ranking=范围机构的下级排名。描述如何在日期范围内取数，不承载指标名称中的统计口径。日期跨度改变后须重新确定取数方式。";
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
      if (name === "metrics") {
        definition.description = "指标由服务端对完整原文进行词典/拼音/字符算法匹配。新指标传 {fromQuestion:true}，默认使用全部匹配项；若只涉及部分已识别指标（如排除某项），mentionIndexes 使用匹配项明确的 index（从1开始，不能用0）。不自行提取名称或改写错字。沿用历史则省略或 retain；用户确认候选传 {candidateIndex}。";
        (definition.inputSchema.anyOf as unknown[]).push({type: "object", required: ["fromQuestion"], properties: {
          fromQuestion: {const: true}, mentionIndexes: {type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: {type: "integer", minimum: 1}},
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
