import type {SemanticOperation, SemanticRequest, StructuredOperation, StructuredOrganization} from "./protocol.js";

export function operationLabel(value: StructuredOperation): string {
  if (value.kind === "value") return "普通取值";
  if (value.kind === "rank_position") return "查询对象位次";
  if (value.kind === "sort") return value.direction === "descending" ? "从高到低排序" : "从低到高排序";
  return `${value.position === "top" ? "前" : value.position === "bottom" ? "后" : "待定方向"}${value.top_n ?? "待定条数"}名`;
}

function organization(field: "organizations" | "comparison_organizations", input: StructuredOrganization): SemanticOperation {
  if (input.kind === "named") return {action: "set", field, value: input.names.join("、"), values: input.names,
    structured: true, ...(input.suggestion ? {suggestion: input.suggestion} : {})};
  return {action: "set", field, value: input.source_text, structured: true, organizationScope: input.kind === "authorized_cohort"
    ? {kind: input.kind, cohort: input.cohort, sourceText: input.source_text}
    : {kind: input.kind, parentName: input.parent_name, sourceText: input.source_text}};
}

/** 只转换字段形状；机构身份、权限、日历与完整性继续走现有绑定和执行链。 */
export function compileQueryRequest(input: SemanticRequest): SemanticRequest {
  return {...input, targets: input.targets.map(target => {
    const query = target.query;
    if (!query) return {...target, operations: target.operations.map(operation => "queryOperation" in operation && operation.queryOperation
      ? {...operation, value: operationLabel(operation.queryOperation), structured: true} : operation)};
    const operations: SemanticOperation[] = [];
    if (query.objective) operations.push({action: "set", field: "objective", value: query.objective, structured: true});
    if (query.organizations) operations.push(organization("organizations", query.organizations));
    if (query.metrics) operations.push({action: "set", field: "metrics", value: query.metrics.join("、"), values: query.metrics, structured: true});
    if (query.time) operations.push({action: "set", field: "time", value: query.time.expression, structured: true,
      ...(query.time.calendar ? {modelCalendar: query.time.calendar} : {})});
    if (query.selection) operations.push({action: "set", field: "selection", value: query.selection,
      selectionValue: query.selection, structured: true});
    operations.push({action: "set", field: "operation", value: operationLabel(query.operation), queryOperation: query.operation, structured: true});
    if (query.comparison_organizations) operations.push(organization("comparison_organizations", query.comparison_organizations));
    return {source: target.source, operations};
  })};
}
