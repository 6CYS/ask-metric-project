import {Type} from "@earendil-works/pi-ai";
import {Compile} from "typebox/compile";
import {analysisPlanSchema} from "../analysis/contracts.js";
import type {AnalysisPlan} from "../analysis/contracts.js";
import {analysisInquirySchema} from "../analysis/inquiry.js";
import type {OverviewPlan} from "../tools/businessOverview.js";
import type {ModelAnswerInput} from "./questions.js";
import type {OrganizationScopeInput, QueryOperation} from "../business-context/types.js";
export type {ModelAnswerInput} from "./questions.js";
export type SemanticField = "organizations" | "comparison_organizations" | "metrics" | "time" | "selection" | "operation" | "objective" | "calculation" | "availability" | "_analysis";
export type EnhancedAnalysis = {kind: "business_overview"; plan: OverviewPlan} | {kind: "business_analysis"; plan: AnalysisPlan};
/** 模型按有权机构清单自主判断的机构结论：code/name 至少其一取自清单，excerpt 仅记录用户原文片段。 */
export interface OrgSuggestion {code?: string; name?: string; excerpt?: string}
export type ModelCalendar = {start: string; end: string; dates?: string[]};
export type StructuredOrganization = {kind: "named"; names: string[]; suggestion?: OrgSuggestion}
  | {kind: "authorized_cohort"; cohort: "rural_commercial_banks"; source_text: string}
  | {kind: "children_of"; parent_name: string; source_text: string};
export type StructuredOperation = QueryOperation | {kind: "sort"; direction: "ascending" | "descending"}
  | {kind: "ranking"; position: "top" | "bottom" | null; top_n: number | null};
export interface StructuredQuery {
  objective?: string;
  organizations: StructuredOrganization | null;
  metrics: string[] | null;
  time: {expression: string; calendar?: ModelCalendar} | null;
  selection: "exact" | "latest_in_range" | "all_in_range" | null;
  operation: StructuredOperation;
  comparison_organizations?: StructuredOrganization | null;
}
/** 结构化字段编译后沿用现有状态与执行链；这些标记只由工具入口生成。 */
export interface QueryBinding {structured?: true; values?: string[]; organizationScope?: OrganizationScopeInput;
  queryOperation?: StructuredOperation; selectionValue?: StructuredQuery["selection"]}
export type SemanticOperation = ({action: "set" | "add" | "confirm"; field: SemanticField; value: string; suggestion?: OrgSuggestion; modelCalendar?: ModelCalendar} & QueryBinding)
  | {action: "replace"; field: SemanticField; subject: string; value: string; suggestion?: OrgSuggestion; modelCalendar?: ModelCalendar}
  | {action: "exclude"; field: SemanticField; subject: string} | {action: "clear"; field: SemanticField}
  | {action: "copy"; field: SemanticField; reference: SemanticReference}
  | {action: "select"; field: "organizations"; offset: number; limit: number}
  | {action: "rank_all"; field: "operation"; direction: "ascending" | "descending"};
export type SemanticReference = {task_ref: string; target_ref: string};
export type SemanticSource = {kind: "new" | "current"} | ({kind: "reference"} & SemanticReference)
  | {kind: "references"; references: SemanticReference[]};
export interface SemanticRequest {protocol_version: 2; context_action?: "resume" | "defer" | "abandon"; intent: "query" | "prepare" | "reuse" | "analyze" | "availability" | "calculate";
  answers?: ModelAnswerInput[]; targets: Array<{source: SemanticSource; operations: SemanticOperation[]; query?: StructuredQuery; analysis?: EnhancedAnalysis}>}
// 与已评审的版本2契约一致；部署不依赖仓库docs目录。
export const semanticParameters = Type.Unsafe<SemanticRequest>({
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "urn:ask-metric:pi-semantic-task:request:v2",
  "title": "Pi 语义业务提案请求候选协议",
  "description": "版本2语义提议。Schema一次校验形状与字段动作；宿主绑定正式条件并统一更新状态，后端控制权限与执行。",
  "type": "object",
  "additionalProperties": false,
  "required": ["protocol_version", "intent", "targets"],
  "properties": {
    "protocol_version": {"type": "integer", "const": 2},
    "context_action": {"type": "string", "enum": ["resume", "defer", "abandon"], "description": "resume续接待明确修改，defer暂缓，abandon放弃；缺省不续接。"},
    "intent": {
      "type": "string",
      "enum": ["query", "analyze", "availability", "calculate", "reuse", "prepare"],
      "description": "prepare只保存条件，reuse只读旧结果；其余按整笔目的选择并接受治理校验。"
    },
    "answers": {"type": "array", "maxItems": 20, "items": {"$ref": "#/definitions/modelAnswer"},
      "description": "回答 admitted_context.pending_questions 的唯一方式；引用 question_id/version/option_id，已有新题时不得改用 operations.confirm。"},
    "targets": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "items": {"$ref": "#/definitions/target"},
      "description": "分别绑定的真实目标组，数组顺序不是历史身份；不能重复同一对象。同一business_analysis计划只提交一个target，多方面问题合并requirements和steps。"
    }
  },
  "definitions": {
    "answerChoice": {
      "oneOf": [
        {"type": "object", "additionalProperties": false, "required": ["type", "option_ids"], "properties": {
          "type": {"const": "select"},
          "option_ids": {"type": "array", "minItems": 1, "maxItems": 100, "uniqueItems": true, "items": {"type": "string", "minLength": 1}}
        }},
        {"type": "object", "additionalProperties": false, "required": ["type"], "properties": {"type": {"const": "accept"}}},
        {"type": "object", "additionalProperties": false, "required": ["type"], "properties": {"type": {"const": "reject"}}},
        {"type": "object", "additionalProperties": false, "required": ["type"], "properties": {"type": {"const": "none_of_these"}}}
      ]
    },
    "modelAnswer": {
      "type": "object",
      "description": "模型对一张已发布问题的回答；evidence.excerpt 必须保留本轮完整选择语句及否定/转折。",
      "additionalProperties": false,
      "required": ["question_id", "version", "choice", "evidence"],
      "properties": {
        "question_id": {"type": "string", "minLength": 1},
        "version": {"type": "integer", "minimum": 1},
        "choice": {"$ref": "#/definitions/answerChoice"},
        "evidence": {"type": "object", "additionalProperties": false, "required": ["excerpt"], "properties": {
          "excerpt": {"type": "string", "minLength": 1, "maxLength": 4000}
        }}
      }
    },
    "businessText": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000,
      "description": "自然语言业务表达，须有本轮依据、可信继承或授权分析来源。"
    },
    "field": {
      "type": "string",
      "enum": ["organizations", "comparison_organizations", "metrics", "time", "selection", "operation", "objective", "calculation", "availability"],
      "description": "业务条件字段。"
    },
    "source": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false, "required": ["kind", "references"],
          "properties": {"kind": {"const": "references"}, "references": {
            "type": "array", "minItems": 1, "maxItems": 100, "items": {
              "type": "object", "additionalProperties": false, "required": ["task_ref", "target_ref"],
              "properties": {"task_ref": {"type": "string", "minLength": 1, "maxLength": 512}, "target_ref": {"type": "string", "minLength": 1, "maxLength": 512}}
            }, "description": "签发引用集合，逐来源继承并应用同一operations，保留各自绑定。"}}
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind"],
          "properties": {"kind": {"const": "new", "description": "空条件新目标；继承须用current/reference。"}}
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind"],
          "properties": {"kind": {"const": "current", "description": "继承冻结的唯一当前目标；多目标用reference。"}}
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "task_ref", "target_ref"],
          "properties": {
            "kind": {"const": "reference"},
            "task_ref": {
              "type": "string", "minLength": 1, "maxLength": 512,
              "description": "复制宿主签发的同会话计划引用。"
            },
            "target_ref": {
              "type": "string", "minLength": 1, "maxLength": 512,
              "description": "复制该计划内的目标引用，与task_ref配对。"
            }
          }
        }
      ]
    },
    "orgSuggestion": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "code": {"type": "string", "minLength": 1, "maxLength": 200, "description": "有权机构清单中的正式编码。"},
        "name": {"type": "string", "minLength": 1, "maxLength": 200, "description": "有权机构清单中的正式名称。"},
        "excerpt": {"type": "string", "minLength": 1, "maxLength": 2000, "description": "用户措辞片段。"}
      },
      "description": "按有权清单建议用户所指机构；code/name至少其一。value逐成员保留用户原文称谓，规范名放suggestion；无法唯一匹配仍保留原称谓，不补成某家机构。宿主复核并明示纠正。"
    },
    "modelCalendar": {
      "type": "object",
      "additionalProperties": false,
      "required": ["start", "end"],
      "properties": {
        "start": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"},
        "end": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"},
        "dates": {"type": "array", "minItems": 2, "maxItems": 31, "items": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}}
      },
      "description": "仅time字段随value原文一并提交的日历换算：按当前业务日期换算的ISO日期（YYYY-MM-DD，start不晚于end），离散多点加升序dates；无法确定时省略。严格日历与口径校验由事实服务完成，模型不编造。"
    },
    "queryOrganization": {
      "oneOf": [
        {"type": "object", "additionalProperties": false, "required": ["kind", "names"], "properties": {
          "kind": {"const": "named"}, "names": {"type": "array", "minItems": 1, "maxItems": 100, "items": {"$ref": "#/definitions/businessText"}},
          "suggestion": {"$ref": "#/definitions/orgSuggestion"}}},
        {"type": "object", "additionalProperties": false, "required": ["kind", "cohort", "source_text"], "properties": {
          "kind": {"const": "authorized_cohort"}, "cohort": {"const": "rural_commercial_banks"},
          "source_text": {"$ref": "#/definitions/businessText", "description": "原句中表达机构集合的完整短语。"}}},
        {"type": "object", "additionalProperties": false, "required": ["kind", "parent_name", "source_text"], "properties": {
          "kind": {"const": "children_of"}, "parent_name": {"$ref": "#/definitions/businessText"}, "source_text": {"$ref": "#/definitions/businessText"}}}
      ]
    },
    "queryOperation": {
      "description": "模型直接给出操作语义，程序按字段绑定执行，不重新解析排序描述。缺少排名方向或条数时写null，不猜测。",
      "oneOf": [
        {"type": "object", "additionalProperties": false, "required": ["kind"], "properties": {"kind": {"const": "value"}}},
        {"type": "object", "additionalProperties": false, "required": ["kind", "position", "top_n"], "properties": {
          "kind": {"const": "ranking"}, "position": {"enum": ["top", "bottom", null]},
          "top_n": {"anyOf": [{"type": "integer", "minimum": 1, "maximum": 100}, {"type": "null"}]}}},
        {"type": "object", "additionalProperties": false, "required": ["kind", "direction"], "properties": {
          "kind": {"const": "sort"}, "direction": {"enum": ["ascending", "descending"]}}},
        {"type": "object", "additionalProperties": false, "required": ["kind"], "properties": {"kind": {"const": "rank_position"}}}
      ]
    },
    "query": {
      "type": "object", "additionalProperties": false,
      "required": ["organizations", "metrics", "time", "selection", "operation"],
      "description": "完整结构化查询条件。同一对象绑定机构、指标、时间及操作；真实缺项写null。新查询使用query，继承和局部修改使用operations。",
      "properties": {
        "objective": {"$ref": "#/definitions/businessText"},
        "organizations": {"anyOf": [{"$ref": "#/definitions/queryOrganization"}, {"type": "null"}]},
        "metrics": {"anyOf": [{"type": "array", "minItems": 1, "maxItems": 100, "items": {"$ref": "#/definitions/businessText"}}, {"type": "null"}]},
        "time": {"anyOf": [{"type": "object", "additionalProperties": false, "required": ["expression"], "properties": {
          "expression": {"$ref": "#/definitions/businessText"}, "calendar": {"$ref": "#/definitions/modelCalendar"}}}, {"type": "null"}]},
        "selection": {"enum": ["exact", "latest_in_range", "all_in_range", null]},
        "operation": {"$ref": "#/definitions/queryOperation"},
        "comparison_organizations": {"anyOf": [{"$ref": "#/definitions/queryOrganization"}, {"type": "null"}]}
      }
    },
    "operation": {
      "oneOf": [
        {"type": "object", "additionalProperties": false, "required": ["action", "field", "queryOperation"],
          "properties": {"action": {"const": "set"}, "field": {"const": "operation"}, "queryOperation": {"$ref": "#/definitions/queryOperation"}}},
        {"type": "object", "additionalProperties": false, "required": ["action", "field", "direction"],
          "properties": {"action": {"const": "rank_all"}, "field": {"const": "operation"}, "direction": {"enum": ["ascending", "descending"]}}},
        {"type": "object", "additionalProperties": false, "required": ["action", "field", "reference"],
          "properties": {"action": {"const": "copy"}, "field": {"enum": ["organizations", "comparison_organizations", "metrics", "time", "selection", "operation"]}, "reference": {
            "type": "object", "additionalProperties": false, "required": ["task_ref", "target_ref"],
            "properties": {"task_ref": {"type": "string", "minLength": 1}, "target_ref": {"type": "string", "minLength": 1}}}}},
        {"type": "object", "additionalProperties": false, "required": ["action", "field", "offset", "limit"],
          "properties": {"action": {"const": "select"}, "field": {"const": "organizations"}, "offset": {"type": "integer", "minimum": 0, "maximum": 999}, "limit": {"type": "integer", "minimum": 1, "maximum": 50}}},
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "field", "value"],
          "properties": {
            "action": {"const": "set"},
            "field": {"$ref": "#/definitions/field"},
            "value": {"$ref": "#/definitions/businessText"},
            "suggestion": {"$ref": "#/definitions/orgSuggestion"},
            "modelCalendar": {"$ref": "#/definitions/modelCalendar"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "field", "subject", "value"],
          "properties": {
            "action": {"const": "replace"},
            "field": {"enum": ["organizations", "comparison_organizations", "metrics", "time"]},
            "subject": {"$ref": "#/definitions/businessText"},
            "value": {"$ref": "#/definitions/businessText"},
            "suggestion": {"$ref": "#/definitions/orgSuggestion"},
            "modelCalendar": {"$ref": "#/definitions/modelCalendar"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "field", "value"],
          "properties": {
            "action": {"const": "add"},
            "field": {"enum": ["organizations", "comparison_organizations", "metrics"]},
            "value": {"$ref": "#/definitions/businessText"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "field", "subject"],
          "properties": {
            "action": {"const": "exclude"},
            "field": {"enum": ["organizations", "comparison_organizations", "metrics"]},
            "subject": {"$ref": "#/definitions/businessText"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "field"],
          "properties": {
            "action": {"const": "clear"},
            "field": {"$ref": "#/definitions/field"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "field", "value"],
          "properties": {
            "action": {"const": "confirm"},
            "field": {"enum": ["organizations", "comparison_organizations", "metrics", "time"]},
            "value": {"$ref": "#/definitions/businessText"}
          }
        }
      ]
    },
    "target": {
      "type": "object",
      "additionalProperties": false,
      "required": ["source"],
      "oneOf": [
        {"required": ["query"], "properties": {"query": {"type": "object"}}, "not": {"anyOf": [{"required": ["operations"]}, {"required": ["analysis"]}]}},
        {"required": ["operations"], "not": {"anyOf": [{"required": ["query"]}, {"required": ["analysis"]}]}},
        {"required": ["analysis"], "not": {"required": ["query"], "properties": {"query": {"type": "object"}}}}
      ],
      "properties": {
        "source": {"$ref": "#/definitions/source"},
        "analysis": {"description": "经营分析扩展：intent=analyze，operations仅提交机构、日期或目标的变化；计划由正式主题或analysis_catalog绑定，不填写内部Frame、编码或执行许可。", "oneOf": [
          {"type": "object", "additionalProperties": false, "required": ["kind", "plan"], "properties": {
            "kind": {"const": "business_analysis"}, "plan": analysisPlanSchema}},
          {"type": "object", "additionalProperties": false, "required": ["kind", "plan"], "properties": {
            "kind": {"const": "business_overview"}, "plan": {"type": "object", "required": ["goal", "sections"], "additionalProperties": false,
              "properties": {"topic": {"enum": ["loan", "deposit"]}, "goal": {"enum": ["overview", "growth", "structure", "quality"]},
                "sections": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"enum": ["scale", "growth", "structure", "quality"]}},
                "inquiry": analysisInquirySchema, "objective": {"type": "string"}, "questions": {"type": "array", "items": {"type": "string"}},
                "metric_ids": {"type": "array", "items": {"type": "string"}}, "comparisons": {"type": "array", "items": {"enum": ["mom", "yoy", "ytd"]}}, "rationale": {"type": "string"}}}}}
        ]},
        "query": {"anyOf": [{"$ref": "#/definitions/query"}, {"type": "null"}], "description": "基础查询条件；analysis目标可省略或写null，不能同时填写有内容的query。"},
        "operations": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {"$ref": "#/definitions/operation"},
          "description": "空数组只表示保留所选来源；新建空目标不能执行。"
        }
      }
    }
  }
});
const validator = Compile(semanticParameters);
type ShapeProblem = {path: string; rule: string; hint?: string};
type DiagnosticError = {instancePath: string; keyword: string; params: object};
const diagnosticProblem = (error: DiagnosticError, prefix = ""): ShapeProblem => {
  const params = error.params as {additionalProperties?: string[]; requiredProperties?: string[]};
  const fields = params.additionalProperties ?? params.requiredProperties;
  return {path: prefix + (error.instancePath || (prefix ? "" : "/")), rule: error.keyword,
    ...(fields?.length ? {hint: `${params.additionalProperties ? "删除未定义字段" : "补齐必需字段"}：${JSON.stringify(fields.slice(0, 12).map(field => field.slice(0, 120)))}`} : {})};
};
type DiscriminatedBranch = {properties: {kind: {const: string}}};
type DiagnosticDefinitions = {source: {oneOf: DiscriminatedBranch[]}; target: {properties: {analysis: {oneOf: DiscriminatedBranch[]}}}};
const definitions = (semanticParameters as unknown as {definitions: DiagnosticDefinitions}).definitions;
const branchValidators = (branches: DiscriminatedBranch[]) => new Map(branches.map(branch => [branch.properties.kind.const,
  Compile(Type.Unsafe({...branch, definitions}))]));
const sourceDiagnostics = branchValidators(definitions.source.oneOf);
const analysisDiagnostics = branchValidators(definitions.target.properties.analysis.oneOf);
/** 联合Schema的错误可能先报另一分支；只为诊断按已声明kind定位，正式接纳仍由原Schema控制。 */
function branchProblems(raw: unknown): ShapeProblem[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as {targets?: unknown}).targets)) return [];
  return (raw as {targets: Array<Record<string, any>>}).targets.flatMap((target, index) => {
    if (!target || typeof target !== "object") return [];
    return (["source", "analysis"] as const).flatMap(field => {
      const object = target[field];
      if (!object || typeof object !== "object" || typeof object.kind !== "string") return [];
      const selected = (field === "source" ? sourceDiagnostics : analysisDiagnostics).get(object.kind);
      return selected ? selected.Errors(object).map(error => diagnosticProblem(error, `/targets/${index}/${field}`)) : [];
    });
  });
}
export class SemanticInputShapeError extends Error {
  constructor(readonly problems: ShapeProblem[]) {
    super("SEMANTIC_INPUT_SHAPE_INVALID: 请使用版本2工具Schema，保留原用户目标后修正参数形状。");
  }
}
/** 必须先校验原始参数；SDK的类型转换不能使错误协议版本通过。 */
export function prepareSemanticArguments(raw: unknown): SemanticRequest {
  if (!validator.Check(raw)) {
    const specific = branchProblems(raw);
    throw new SemanticInputShapeError((specific.length ? specific : validator.Errors(raw).map(error => diagnosticProblem(error))).slice(0, 4));
  }
  const prepared = structuredClone(raw) as SemanticRequest;
  if (prepared.targets.filter(target => target.analysis?.kind === "business_analysis").length > 1)
    throw new SemanticInputShapeError([{path: "/targets", rule: "singleAnalysisPlan",
      hint: "同一次通用分析只提交一个目标。将不同子问题合并到该计划的requirements和steps；不要复制已执行的目标或整个计划，不删除用户要求"}]);
  // 分析已明确给出计划、没有范围变更时，省略operations等同空数组，不要求模型重复空容器。
  for (const target of prepared.targets) if (target.analysis) {
    target.operations ??= [];
    // Schema显式允许分析分支的空query占位；校验通过后再归一，不丢弃任何实际查询条件。
    if (target.query === null) delete target.query;
  }
  return prepared;
}
