import { CapabilityRegistry } from "./core.js";
import type { FieldInputCorrection, FieldSchema, QueryOperation, ValidationIssue } from "./types.js";
import {historyFieldReferenceSchema} from "./historyReferences.js";
import {resolveRankingEvidence} from "./rankingEvidence.js";
import {analysisPlanSchema, overviewPlanSchema} from "../analysis/contracts.js";
import {inheritAnalysisDate} from "./analysisContinuationDate.js";

const field = (label: string, resolver: string, required = true): FieldSchema => ({label, resolver, required,
  inheritable: true, clearable: true});
const enumeration = (label: string, values: string[], required = true): FieldSchema => ({...field(label, "enum", required), missingIsArgumentError: required, validation: {enum: values}});
const integer = (label: string, min: number, max: number): FieldSchema => ({...field(label, "integer", false), validation: {min, max}});
/** 指标与机构共用确认输入契约；候选分组及接受资格仍由服务端校验。 */
export const FIELD_CONFIRMATION_DESCRIPTION = "确认契约：本轮以名称或编号明确选择已保存候选时可传{confirm:true}，保留该选择原文。模型理解用户对本字段每个已保存待确认项均唯一的提案作语义接受时，包括同句修改其它条件，必须传{confirm:true,evidence:{decision:'accept',sourceText:本轮完整同意原文}}，不能只传裸confirm。fieldIntents只声明意图，不能替代字段值中的evidence。完整同意原文保留否定与转折，不复制未出现在本轮的候选标签。唯一性按服务端待确认项分组判断，不按整个字段的候选总数；同一项有多个候选时须用户明确选择，不能用accept任选。候选归属、来源及各项唯一性由服务端核验，无已保存候选不能凭口头同意补事实。";
export function createCapabilities(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register({capability: "business_analysis", tool: "general_analysis", fields: {
    plan: {...field("通用分析计划", "analysis_plan"), missingIsArgumentError: true,
      description: "适用于任意业务主题和跨主题经营分析。先analysis_catalog发现正式binding_ref，再规划objective、scope_notice、requirements和steps。每个子问题有执行节点或缺口；步骤使用observe/compare/trend/ranking/structure并声明answers、依赖和理由。结构需要审核relation_id，不自行编公式。可按实际证据补查，最终analysis_report_present。", inputSchema: analysisPlanSchema},
    organizations: {...field("机构", "organization", false), description: "明确机构按本轮原文；沿用时继承。独立问题未指定机构时由后端使用认证账户所属机构并披露，不扩大范围。集合使用与基础查询相同的受控机构范围对象。"},
    time: {...field("分析日期或期间", "overview_date", false), description: "明确日期和范围按完整原文set；最近按原文set；独立问题没有日期则省略，由实际覆盖确定截至日。追问继承未变日期，不要求用户选择内部取数方式。"},
  }, completeFields: inheritAnalysisDate});
  registry.register({capability: "business_overview", tool: "business_overview", fields: {
    plan: {...field("概览分析计划", "overview_plan"), missingIsArgumentError: true,
      description: "读取主题后规划贷款或存款分析（plan.topic=loan/deposit）。除 goal/sections，还应提交 objective、questions（具体子问题）、metric_ids（主题逻辑ID）、comparisons（mom/yoy/ytd）和 rationale（查询理由）。只查解决问题所需指标；观察回执可修改计划补查，最多三轮，然后 business_report_present 交付表格和报告。编码、公式、权限由服务端确定。",
      inputSchema: overviewPlanSchema},
    organizations: {...field("机构", "organization", false), description: "明确机构传本轮原文；沿用时继承；独立问题未指定机构时使用后端认证账户所属机构并说明，不扩大范围。"},
    time: {...field("分析日期或期间", "overview_date", false), description: "明确日期、月份或连续期间按原文set，如今年五月份到十月份；服务端解析并按每月实际最新记录分析，缺数月份披露，不追问内部取数方式。最近/近期按原文set；独立问题无日期省略time，选择最新实际记录。沿用日期时省略或retain；单日严格查询，明确范围不换成其他期间。"},
  }});
  registry.register({capability: "metric_query", tool: "metric_query_structured", fields: {
    metrics: field("指标", "metric"), organizations: field("机构", "organization"), time: field("日期范围", "date"),
    comparison_organizations: field("位次比较总体", "organization", false),
    selection: enumeration("时间范围取数方式", ["exact", "latest", "latest_in_range", "all_in_range"]),
    operation: field("查询操作", "query_operation", false),
  }, async completeFields(fields, delta, context, base) {
    const time = fields.time;
    const range = time?.resolvedValue as {start?: string; end?: string} | undefined;
    // 已校验的单日没有范围选取歧义。仅补缺省，不覆盖显式选择、清除或多日语义。
    if (fields.selection?.resolutionStatus === "missing" && time?.resolutionStatus === "resolved"
      && range?.start && range.start === range.end
      && !delta.fieldChanges.some(change => change.fieldHint === "selection" && change.operation !== "retain")) {
      fields.selection = {rawValue: "exact", resolvedValue: "exact", source: "resolved", resolver: "enum", resolutionStatus: "resolved"};
    }
    const change = delta.fieldChanges.find(item => item.fieldHint === "operation");
    const operation = fields.operation!;
    const metrics = fields.metrics;
    const metricTerms: string[] = [];
    if (metrics?.metadata?.confirmationTurnId === context.turnId && metrics.metadata.confirmed === true) {
      const value = metrics.resolvedValue as {codes?: string[]; names?: string[]};
      metricTerms.push(...value.names ?? []);
      for (const candidate of base?.fields.metrics?.candidates ?? []) {
        if (candidate.code && value.codes?.includes(candidate.code) && typeof candidate.metadata?.value_basis === "string") {
          metricTerms.push(candidate.metadata.value_basis);
        }
      }
    }
    // set 已由同一 Resolver 核验；缺省、继承、清除也不能吞掉本轮排序目标。未决部分继续保留。
    const recheckConfirmation = metricTerms.length > 0 && change?.operation === "set"
      && operation.resolutionStatus === "ambiguous" && operation.metadata?.rankingEvidence;
    if (change?.operation !== "set" && ["missing", "resolved"].includes(operation.resolutionStatus) || recheckConfirmation) {
      const previous = base?.capability === "metric_query" ? base.fields.operation : undefined;
      const resolution = await resolveRankingEvidence(recheckConfirmation ? operation.rawValue as QueryOperation : operation.resolutionStatus === "resolved"
        ? operation.resolvedValue as QueryOperation : {kind: "value"}, registry.get("metric_query").fields.operation!,
      {...context, ...(previous ? {previous} : {})}, metricTerms);
      if (resolution.status !== "resolved" || recheckConfirmation) fields.operation = {...operation, source: operation.resolutionStatus === "missing" ? "explicit" : operation.source,
        resolver: "query_operation", resolutionStatus: resolution.status, resolvedValue: resolution.value,
        metadata: resolution.metadata ?? {}};
    }
  }, validate(fields) {
    const issues: ValidationIssue[] = [];
    const selection = fields.selection?.resolvedValue;
    // 组合建议只使用已解析事实；日期尚未确定时不能据缺省值猜测单日或月末。
    const time = fields.time?.resolutionStatus === "resolved"
      ? fields.time.resolvedValue as {start?: string; end?: string; dates?: string[]; preset?: string} | undefined : undefined;
    const operation = fields.operation?.resolutionStatus === "resolved" ? fields.operation.resolvedValue as QueryOperation | undefined : undefined;
    if (time?.preset === "latest" || selection === "latest") {
      if (time?.preset !== "latest" || selection !== "latest" || operation?.kind && operation.kind !== "value")
        issues.push({field: "selection", reason: "invalid", message: "最新有效数据日仅用于普通取值，不能混用日历范围或排名。"});
      return issues;
    }
    const hasDates = Array.isArray(time?.dates) && time.dates.length > 0;
    // 逐日排名尚未实现，不能通过修改取数方式取消用户明确的时间序列目标。
    const isRank = operation?.kind === "ranking" || operation?.kind === "rank_position";
    if (hasDates && (isRank || selection === "all_in_range")
      || isRank && selection === "all_in_range") throw new Error("UNSUPPORTED_QUERY_COMBINATION");
    if (operation?.kind === "rank_position" && fields.comparison_organizations?.resolutionStatus === "missing") {
      issues.push({field: "comparison_organizations", reason: "missing", message: "请确定关注对象与哪些机构比较位次；已提供的机构、指标和日期会保留。"});
    }
    if (operation?.kind !== "rank_position" && fields.comparison_organizations?.resolutionStatus === "resolved") {
      issues.push({field: "comparison_organizations", reason: "invalid", message: "比较总体仅用于位次查询；普通取值或前后 N 名榜单应明确清除该条件，不能静默忽略。"});
    }
    const timeKind = !time?.start || !time.end ? undefined
      : hasDates ? "discrete_dates" : time.start === time.end ? "single_day" : "continuous_range";
    const allowedValues = ["exact", "latest_in_range", "all_in_range"].filter(value =>
      !(timeKind === "continuous_range" && value === "exact")
      && !((isRank || hasDates) && value === "all_in_range"));
    const reason = fields.selection?.resolutionStatus === "missing" ? "missing"
      : fields.selection?.resolutionStatus === "invalid" || (selection === "exact" && timeKind === "continuous_range") ? "invalid" : undefined;
    if (reason) {
      const message = reason === "missing" ? "缺少时间取数方式；根据用户目标选择合法值，保留已解析日期、机构、指标和排名条件，不自行默认日期或取数方式"
        : selection === "exact" ? "指定日取值要求日期范围为同一天；保留完整日期范围并修正时间取数方式"
          : "时间取数方式无效；根据已解析日期和用户目标修正为合法值，不修改其他业务条件";
      const correction: FieldInputCorrection = {field: "selection", reason, message, allowedValues,
        inputSchema: {type: "string", enum: allowedValues}, context: {
          ...(timeKind ? {timeKind} : {}),
          ...(fields.operation?.resolutionStatus === "resolved" && operation ? {operationKind: operation.kind}
            : fields.operation?.resolutionStatus === "missing" ? {operationKind: "value" as const} : {}),
        }};
      issues.push({field: "selection", reason, message, correction});
    }
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
    bindings: {...field("查询快照事实引用", "calculation_bindings"), inheritable: false},
    constants: {...field("用户常量", "calculation_constants", false), inheritable: false},
    scope_policy: enumeration("计算范围", ["same_org_date", "cross_date", "cross_org", "explicit"], false),
  }});
  registry.get("metric_query").fields.selection!.description = "取数方式：latest=普通取值的最新有效数据日，不代表今天；exact=指定单日或明确的多个离散日期逐点取值；latest_in_range=连续范围内最后有数据的日期；all_in_range=连续范围的完整时间序列。保留离散日期，不改成连续区间；离散日期不使用 all_in_range。连续多日范围只限定可取数区间，不自动决定取数方式。已解析单日且口径缺省、没有本轮对该口径的显式修改时，服务端无损确定 exact，无需额外询问；显式用户选择优先且仍须符合组合校验。正常值须有本轮取数意图、可信继承或Schema明确无损派生的依据；枚举合法、甚至唯一合法，不代表用户选择。日期范围改变后重新核对兼容性，不缩短范围以通过校验。指标名称中的统计口径不属于此字段，排名由 operation 表达。必要取数选择缺失时显式提交声明的 clarify 输入，保存其它条件并提问，不先试填最新日或月末。";
  const operation = registry.get("metric_query").fields.operation!;
  registry.get("metric_query").fields.selection!.userClarification = {
    question: "在这个日期范围内，您希望取哪个日期的数据？若需按多个日期分别查看，也请说明具体方式。",
  };
  operation.userClarification = {question: "您希望查询关注对象在比较总体中的位次，还是查看前后若干名的榜单？请补充尚未确定的比较范围或榜单条件。"};
  operation.description = "按业务目标区分：value=普通取值；ranking=前后 N 名榜单，position/top_n 分别来自用户表达或可信继承，服务端核验其原文数量和方向依据，未知时保存条件并澄清，不默认榜单条数；rank_position=关注对象在比较总体中的位次，无需 TopN 或用户填写排序方向。位次中 organizations 是关注对象，comparison_organizations 是受治理比较总体，服务端按指标正式排序规则在整个总体中计算后筛选关注对象；不能将关注对象当总体，也不能把总体数量当 top_n。比较总体没有可信来源时保存其它条件，仅澄清缺失总体；不自动扩展下级或猜集合。日期范围不自动决定统计时点，仍保留 selection 口径校验。省略仅适用于没有独立排序目标或继承既有操作。指标名称中的排名或名次口径不等于额外排序要求。取消排名用 {kind:'value'}，已有比较总体须同时明确清除，避免丢失条件。";
  operation.inputSchema = {oneOf: [
    {type: "object", required: ["kind"], properties: {kind: {const: "value"}}, additionalProperties: false},
    {type: "object", required: ["kind", "position", "top_n"], properties: {kind: {const: "ranking"}, position: {enum: ["top", "bottom"]}, top_n: {type: "integer", minimum: 1, maximum: 100}}, additionalProperties: false},
    {type: "object", required: ["kind"], properties: {kind: {const: "rank_position"}}, additionalProperties: false},
  ]};
  const calculation = registry.get("metric_calculate").fields;
  for (const capability of ["metric_query", "data_availability"]) {
    registry.get(capability).fields.time!.description = "改变日期时传本轮完整日期原文，保留年份有无、期初期末及日历粒度等限定，不截短、改写、补年份或自行换算。未改变则省略或 retain，从所选来源继承，不复制历史日期重填。日历日期用于解析相对时间，不代表营业日、批次日或最新数据日。";
    registry.get(capability).fields.time!.inputSchema = {type: "string", minLength: 1};
    for (const name of ["metrics", "organizations"]) {
      const definition = registry.get(capability).fields[name]!;
      definition.description = "具体机构使用本轮原文名称或名称数组；未变化则省略或 retain。回复已保存候选时按下文确认契约提交，服务端展示规范清单并核验所选项；不自行罗列、改写或挑选候选。";
      definition.inputSchema = {anyOf: [
        {type: "string", minLength: 1, maxLength: 200},
        {type: "array", minItems: 1, maxItems: 100, items: {type: "string", minLength: 1, maxLength: 200}},
        {type: "object", required: ["confirm"], properties: {confirm: {const: true}, evidence: {
          type: "object", required: ["decision", "sourceText"], properties: {decision: {const: "accept"}, sourceText: {type: "string", minLength: 1}}, additionalProperties: false,
        }}, additionalProperties: false},
        {type: "object", required: ["candidateIndex"], properties: {candidateIndex: {type: "integer", minimum: 1, description: "旧调用兼容字段；所选项由系统按用户回复确定，本序号不作依据"},
          sourceText: {type: "string", description: "旧调用兼容字段；确认原文由服务端绑定，本字段不作为依据"}}, additionalProperties: false},
      ]};
      if (name === "organizations") {
        definition.requireTurnIntent = true;
        definition.turnIntentCollection = "codes";
        definition.description += " 整笔历史业务用 baseReference 明确定位，机构未重新指定时直接继承，无需重复包装机构引用；特定机构字段独立指代、明确数量约束或多源组合时，结合本会话索引按 inputSchema 提交 fromHistory、sourceText、sources 和 combine：single 引用完整单源，union 按正式编码合并去重。sourceText 来自本轮指代原文；expectedCount 仅声明用户明确的完整机构数量，与排名条数无关。来源唯一且无数量要求时可直接引用，多个合理来源或数量不符才澄清，不按最近记录或数量凑选来源。add 只追加本轮新名称。续补同一组合时 retainResolvedAdditions:true 保留已确定新增项、未决项与数量；replaceAdditions 按焦点 unresolvedAdditions 的0基 index 替换指定未决名称，value 来自本轮，未列项仍保留。服务端复核来源、状态、目录和权限，不展开历史名称或生成编码。sources 只决定机构，其余条件由 baseReference 继承；动态范围不能混并。";
        (definition.inputSchema.anyOf as unknown[]).push(historyFieldReferenceSchema);
      }
      if (name === "organizations" && capability === "metric_query") {
        definition.description += " 用户要求机构集合或下辖范围时使用 inputSchema 声明的范围对象：authorized_cohort 对应已支持集合，children_of 以 parentName 指定本轮上级名称；sourceText 保留完整范围原文。纯文本不能代替范围对象。权限和层级由服务端确定，不枚举成员编码，也不把未知具体名称改为集合。";
        (definition.inputSchema.anyOf as unknown[]).push(
          {type: "object", required: ["kind", "cohort", "sourceText"], properties: {kind: {const: "authorized_cohort"}, cohort: {const: "rural_commercial_banks"}, sourceText: {type: "string", minLength: 1, maxLength: 200}}, additionalProperties: false},
          {type: "object", required: ["kind", "parentName", "sourceText"], properties: {kind: {const: "children_of"}, parentName: {type: "string", minLength: 1, maxLength: 200}, sourceText: {type: "string", minLength: 1, maxLength: 200}}, additionalProperties: false},
        );
      }
      if (name === "metrics") {
        definition.description = "新指标传 {fromQuestion:true}，模型保留完整原文，由服务端识别并保留全部匹配项；服务端仅在目录和口径证据可核验时纠正名称并保留原文及正式指标来源，模型不自行提取名称或改写错字。只涉及部分已识别指标时，mentionIndexes 使用本轮匹配清单的1基 index；清单每轮重新抽取，不跨轮复用。沿用历史则省略或 retain。回复已保存候选按统一确认契约提交，服务端按用户回复或点选匹配并展示清单；不罗列或挑选候选。待确认项按服务端保存的基础指标及来源分组，同一基础指标的多口径按既有分组一并确认，不按整个候选总数合并或拆组；只给基础指标而口径未定时不默认。";
        (definition.inputSchema.anyOf as unknown[]).push({type: "object", required: ["fromQuestion"], properties: {
          fromQuestion: {const: true}, mentionIndexes: {type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: {type: "integer", minimum: 1}},
        }, additionalProperties: false}, {type: "object", required: ["mentionIndexes"], properties: {
          mentionIndexes: {type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: {type: "integer", minimum: 1}},
        }, additionalProperties: false});
      }
      definition.description += ` ${FIELD_CONFIRMATION_DESCRIPTION}`;
      // 确认说明位于移除说明之前，使 compact 的 set.metrics 同样保留完整确认契约。
      if (name === "metrics") definition.description += "；用户明确放弃某项指标时 operation=remove，rawValue 传 {mentionIndexes:[上一轮 Frame 的 mention 序号，从1开始]}。";
    }
  }
  // 同一目录解析器服务两个业务角色，比较总体不借用关注对象字段扩大范围。
  const subjects = registry.get("metric_query").fields.organizations!;
  const comparison = registry.get("metric_query").fields.comparison_organizations!;
  comparison.inputSchema = structuredClone(subjects.inputSchema!);
  comparison.requireTurnIntent = true;
  comparison.turnIntentCollection = "codes";
  comparison.description = `位次查询的比较总体，与 organizations 关注对象分离。具体名称、正式范围、历史来源和候选确认遵循同一机构契约。总体数量只约束比较集合，不表示榜单条数；不能凭关注对象名称、指标或日期猜范围。${subjects.description}`;
  comparison.userClarification = {question: "要将关注对象放在哪个机构范围中比较位次？"};
  calculation.expressions!.description = '计算公式和 bindings 每轮都须显式设置，不从查询 Frame 继承。用户已说明运算和来源时直接构造参数并执行，不向用户索要技术字段。rawValue 直接传数组，如 [{"name":"difference","label":"两项差额","expression":"a-b"}]，不再包装为 {expressions:[...]}。最多10个表达式。变量名以英文字母开头，最长32字符；仅四则、abs、sum、avg、min、max，变量只能来自 bindings 或 constants，同批表达式不能互相引用 name。';
  calculation.expressions!.inputSchema = {type: "array", minItems: 1, maxItems: 10, items: {type: "object", required: ["name", "label", "expression"], properties: {
    name: {type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$"}, label: {type: "string", minLength: 1, maxLength: 80}, expression: {type: "string", minLength: 1, maxLength: 2000}, display: {enum: ["decimal", "percent"]}, decimal_places: {type: "integer", minimum: 0, maximum: 8},
  }, additionalProperties: false}};
  calculation.bindings!.inputSchema = {type: "object", additionalProperties: {type: "object", required: ["fact_id"], properties: {fact_id: {type: "string"}}, additionalProperties: false}};
  calculation.bindings!.description = 'rawValue 为变量映射，如 {"a":{"fact_id":"引用A"},"b":{"fact_id":"引用B"}}，与表达式变量一一对应，和 expressions、scope_policy 同次提交。按引用的机构/日期选择 scope_policy，同日两机构须 cross_org。使用查询 facts 或历史 fact_refs 的精确 fact_id（fact:任务:行号:字段）；已有匹配索引时直接绑定，无需先 read_business_result，缺少引用才读取指定结果。result_id/frameId 不能当 fact_id。执行复核权限、过期、完整性与单位；来源歧义须澄清，改变条件或刷新须先取新数。';
  calculation.scope_policy!.description = "同机构同日期用 same_org_date；同日期跨机构求差/合计用 cross_org；同机构跨日期用 cross_date；明确同时跨机构和日期用 explicit。按用户已明确的比较范围选择，不改变事实的原机构和日期。";
  calculation.constants!.inputSchema = {type: "object", additionalProperties: {type: "object", required: ["value", "source_text"], properties: {value: {type: "string"}, source_text: {type: "string"}}, additionalProperties: false}};
  calculation.constants!.description = "仅绑定用户本轮明确给出的常量，value 为数字字符串，source_text 保留本轮常量原文。查询得到的业务数值必须通过 bindings 引用 fact_id，不能抄成常量。";
  const availability = registry.get("data_availability").fields;
  availability.dimension!.description = "metrics 发现指定范围有哪些指标有记录；dates 发现哪些日期有记录。按用户目标显式选择，记录覆盖不代表数值有效或完整连续。";
  availability.match!.description = "any 表示范围内有记录；all 用于已明确指标与机构的共同日期。保留用户明确的匹配范围，不把共同日期改为任一日期。";
  availability.page!.description = "覆盖结果分页页码，分页只改变页码，继承原机构、指标筛选和完整日期范围。";
  availability.page_size!.description = "每页返回条数，按 validation 限制。样例页不代表完整覆盖；判断完整性须使用回执的总数、截断和后续页标记。";
  // 只有这些同义字段允许在覆盖与取值能力之间继承，其他字段保持隔离。
  for (const capability of ["business_analysis", "business_overview"]) {
    for (const name of ["organizations", "time"]) registry.get(capability).fields[name]!.allowedSourceCapabilities =
      ["business_analysis", "business_overview", "metric_query", "data_availability"].filter(item => item !== capability);
  }
  for (const capability of ["metric_query", "data_availability"]) {
    for (const name of ["metrics", "organizations", "time"]) registry.get(capability).fields[name]!.allowedSourceCapabilities =
      [capability === "metric_query" ? "data_availability" : "metric_query"];
  }
  return registry;
}
