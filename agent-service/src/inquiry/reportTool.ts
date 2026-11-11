import type { AnswerStreamPreview } from "../answerStream.js";
import { selectReportSources } from "../analysis/reportSources.js";
import { markPartialAnalysisReport } from "../tools/partialAnalysis.js";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AskMetricRequestContext } from "../requestContext.js";
import { BackendApiError } from "../backendClient.js";
import { isCurrentAnalysisEvidence, type EvidenceReference } from "../answerEvidence.js";
import type { AnalysisEvidence } from "../analysis/tools.js";
import {
  narrativeEvidenceRefs,
  normalizeReportNarrative,
  parseNarrativeReference,
  NarrativeReferenceError,
  verifiedNarrativeRefs,
} from "../analysis/narrative.js";
import {
  analysisEvidenceAliases,
  expandFindingRefs,
  findingDependencies,
} from "../analysis/verifiedFindings.js";
import {
  reportChartHasNarrativeEvidence,
  reportChartSchema,
  type BusinessReportChart,
} from "../analysis/reportCharts.js";
import { layoutReportCharts } from "../analysis/reportChartLayout.js";
import { buildInquiryChart, inquiryCharts } from "./chartTool.js";
import { currentTurnMessages } from "../tools/turnContract.js";
import { isInquiryCalculation, type InquiryCalculation } from "./calculationTool.js";
import type { TimeAlternative } from "../business-context/types.js";
import { currentInquiryTarget, inquiryTargetCoverage } from "./target.js";
import { compileReportBody, selectedReportPlan, structuredReportSchema } from "./reportFormat.js";

const parameters = Type.Object(
  {
    body: Type.Optional(
      Type.String({
        minLength: 1,
        // 旧正文传输边界保持兼容；模板附表另有独立预算。
        maxLength: 24000,
        description:
          "自然回答原问题。精确数字使用{{e1.v1}}，最终显示该事实的数值和单位；机构、指标、日期按引用所属结果表述。{{e1.v1|cite}}只关联来源，不显示值，也不证明整句判断已经核验。可自然概括已有且口径确认的比例，不为措辞补查、计算或逐段重复引用；新增运算结果仍通过计算工具取得。先给业务结论，再用关键数据说明，不逐项抄表。缺数如实说明，口径未确认的比例暂不用于分析。",
      }),
    ),
    report: Type.Optional(structuredReportSchema),
    chart: Type.Optional(reportChartSchema),
    charts: Type.Optional(
      Type.Array(reportChartSchema, {
        maxItems: 12,
        description:
          "按分析内容选择多张图，每张只引用真实数据。图表自动放在对应证据段落后；多个机构的多个指标会拆成独立小图。省略时按正文自动配图，空数组表示不配图。与旧chart参数二选一。",
      }),
    ),
  },
  { additionalProperties: false },
);

type Source = EvidenceReference & {
  evidence: AnalysisEvidence & { time_variants?: TimeAlternative[] };
};

function currentTimeAlternatives(
  sources: Source[],
  request: AskMetricRequestContext,
): TimeAlternative[] {
  if (request.timeOverride) return [];
  const choices = sources
    .filter(({ evidence }) => isCurrentAnalysisEvidence(evidence, request.operationId))
    .map(({ evidence }) => evidence.time_variants ?? []);
  const first = choices[0] ?? [];
  // 页面切换作用于整个问题；多个查询的备选期间不一致时，不把局部备选当成全局条件。
  return choices.every((choice) => JSON.stringify(choice) === JSON.stringify(first)) ? first : [];
}

function availabilityRequests(messages: AgentMessage[], sources: Source[]) {
  const requests = currentTurnMessages(messages).flatMap((message) => {
    if (
      message.role !== "toolResult" ||
      message.isError ||
      message.toolName !== "metric_availability"
    )
      return [];
    const receipt = message.details as
      | {
          kind?: string;
          status?: string;
          request?: {
            dimension?: string;
            metric_codes?: string[];
            org_codes?: string[];
            start?: string;
            end?: string;
          };
        }
      | undefined;
    const spec = receipt?.request;
    const metrics = spec?.metric_codes,
      orgs = spec?.org_codes;
    if (
      receipt?.kind !== "data_availability" ||
      receipt.status !== "succeeded" ||
      spec?.dimension !== "dates" ||
      Boolean(spec.start) !== Boolean(spec.end) ||
      !metrics?.length ||
      !orgs?.length
    )
      return [];
    return sources.some(
      ({ evidence }) =>
        metrics.every((code) =>
          evidence.metric_descriptors?.some((metric) => metric.code === code),
        ) && orgs.every((code) => evidence.org_codes.includes(code)),
    )
      ? [spec]
      : [];
  });
  // 仅传真实工具请求；日期是否可用仍由后端按当前权限重新查询。
  return [...new Map(requests.map((spec) => [JSON.stringify(spec), spec])).values()].slice(-3);
}

/** 将本轮可信来源和正文交给后端校验；重试与恢复时机由 inquiry runtime 决定。 */
export function createInquiryReportTool(): AgentHarnessTool<
  AskMetricRequestContext,
  typeof parameters
> {
  return {
    name: "analysis_answer",
    label: "回答业务问题",
    parameters,
    description:
      "完成必要调查后依据真实结果交付自然正文。本轮topic_execution.report_plan带report_layout时，使用report：plan_id填该方案id，overview写经营摘要，sections按配置顺序提交section_id与分析text；系统按配置生成标题、章节和正式事实对照表，无需模型抄表。数字仍使用{{ref}}。普通问数使用body；body与report只提交一种。可用charts同时选择多张有助理解的图，或省略以按章节自动配图。来源自动采用本轮成功查询或已鉴权读取的结果；历史结果须先analysis_read。校验错误按所指问题修正，已有数据不重复查询，确实缺少依据时可定向补查。图表只引用现有结果，不提交手写数值。",
    prepareArguments: (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("回答参数必须是对象。");
      // 兼容升级前尚未执行的调用；来源不再由模型重复筛选，其余参数仍交给原 schema 校验。
      const input = { ...(args as Record<string, unknown>) };
      delete input.evidence_refs;
      return input;
    },
    execute: (_id, input, _update, request, _invocation, context) =>
      executeInquiryReport(input, request, context.abortSignal),
  };
}

/** 正式交付和预览共享来源、引用及计算身份转换，数值仍由后端统一核验。 */
async function prepareInquiryReport(
  input: Static<typeof parameters>,
  request: AskMetricRequestContext,
  options: { fallback?: boolean; preview?: boolean } = {},
) {
  const { fallback = false, preview = false } = options;
  if (!input.body?.trim() && !input.report)
    throw new BackendApiError(422, "请提交完整回答正文。", "ANALYSIS_REPORT_SUMMARY");
  if (input.chart && input.charts !== undefined)
    throw new BackendApiError(
      422,
      "请使用charts或兼容的chart参数之一提交图表。",
      "ANALYSIS_REPORT_FORMAT",
    );
  const turnEvidence = (await request.answerEvidence?.()) ?? [];
  const available = turnEvidence.filter(
    (item): item is Source =>
      item.evidence.kind === "analysis_evidence" &&
      item.evidence.status === "succeeded" &&
      typeof (item.evidence as AnalysisEvidence).run_ref === "string",
  );
  if (!available.length)
    throw new BackendApiError(
      422,
      "本轮还没有成功查询或已鉴权读取的来源，请先取得所需数据。",
      "ANALYSIS_REPORT_EVIDENCE",
    );
  const needsTargetCoverage = Boolean(request.inquiryTargetContext && !request.inquiryAdmission);
  // 预览不选图或复查可用日期，仅目标覆盖检查需要消息；来源仍逐段交后端复核。
  const messages = !preview || needsTargetCoverage ? ((await request.turnMessages?.()) ?? []) : [];
  if (input.body !== undefined && input.report !== undefined)
    throw new NarrativeReferenceError("body与report只提交一种，避免丢失或重复正文。");
  const reportPlan = selectedReportPlan(messages, input.report?.plan_id);
  // 预览接收同一编译器已生成的累计正文，不再次附表。
  const body = preview
    ? (input.body ?? "")
    : compileReportBody(input, reportPlan, available);
  const target = needsTargetCoverage
    ? currentInquiryTarget(messages, request.operationId)
    : undefined;
  const targetCoverage = target ? inquiryTargetCoverage(messages, target) : undefined;
  if (targetCoverage && !targetCoverage.complete && !fallback)
    throw new BackendApiError(
      422,
      "主目标尚有机构或期间未完成查询，请按target_coverage补足缺少部分；已完成的查询不必重复。",
      "INQUIRY_TARGET_INCOMPLETE",
      targetCoverage,
    );
  const calculations = turnEvidence.filter(
    (item): item is EvidenceReference & { evidence: InquiryCalculation } =>
      isInquiryCalculation(item.evidence) &&
      item.evidence.execution_turn_id === request.operationId &&
      item.evidence.run_refs.every((ref) =>
        available.some((source) => source.evidence.run_ref === ref),
      ),
  );
  const sourcesWithCalculations = [...available, ...calculations];
  const aliases = new Map(
    sourcesWithCalculations.flatMap((item) => [
      ...analysisEvidenceAliases(item.ref, item.evidence.evidence_items ?? []),
    ]),
  );
  const known = new Set(
    sourcesWithCalculations.flatMap(
      (item) => item.evidence.evidence_items?.map((atom) => atom.ref) ?? [],
    ),
  );
  const rawRef = (ref: string) => aliases.get(ref) ?? ref;
  const narrative = normalizeReportNarrative({ body });
  const refs = [...new Set(narrativeEvidenceRefs(narrative.summary).map(rawRef))];
  const explicitSelections = input.charts ?? (input.chart ? [input.chart] : undefined);
  const prepared = explicitSelections !== undefined || preview ? [] : inquiryCharts(messages);
  const chartChoices =
    explicitSelections !== undefined
      ? explicitSelections.map((selection) => ({
          selection: { ...selection, evidence_refs: selection.evidence_refs.map(rawRef) },
          run_refs: [] as string[],
        }))
      : prepared;
  const selections = chartChoices.map((choice) => ({
    ...choice,
    available:
      choice.run_refs.every((ref) => available.some((item) => item.evidence.run_ref === ref)) &&
      choice.selection.evidence_refs.every((ref) => known.has(ref)),
  }));
  if (refs.some((ref) => !known.has(ref)))
    throw new BackendApiError(
      422,
      "正文或图表包含不属于本轮成功来源的原子，请使用回执中的真实引用。",
      "ANALYSIS_REPORT_REFERENCE",
    );
  // 无效选图只影响自身；有效图独有的来源仍必须进入最终后端鉴权。
  const focusRefs = [
    ...new Set([
      ...refs,
      ...selections
        .filter((choice) => choice.available)
        .flatMap((choice) => choice.selection.evidence_refs),
    ]),
  ];
  const referenced = new Set(focusRefs);
  const selectedCalculations = calculations.filter((item) =>
    item.evidence.evidence_items.some((atom) => referenced.has(atom.ref)),
  );
  selectedCalculations.forEach((item) =>
    item.evidence.evidence_items.forEach((atom) => {
      if (referenced.has(atom.ref)) atom.input_refs.forEach((ref) => referenced.add(ref));
    }),
  );
  const {
    sources: usable,
    runRefs,
    contextRunRefs: contextRefs,
  } = selectReportSources(available, request.operationId, referenced);
  const historical = usable.filter((item) => contextRefs.includes(item.evidence.run_ref));
  const reuseOnly = historical.length === usable.length;
  if (reuseOnly && !refs.length)
    throw new BackendApiError(
      422,
      "请用正文中的真实引用明确本次追问关注的指标；数字使用{{e1.v1}}，已写数值紧随{{e1.v1|cite}}关联依据。",
      "ANALYSIS_REPORT_REFERENCE",
      { reason: "missing_body_reference" },
    );
  const factBindings: Array<{
    ref: string;
    org_code: string;
    metric_code: string;
    date: string;
  }> = [];
  const summary = narrative.summary.replace(/\{\{([^{}]+)\}\}/gu, (_full, value: string) => {
    const { ref, citation, binding } = parseNarrativeReference(value);
    if (binding) factBindings.push({ ...binding, ref: rawRef(ref) });
    return `{{${rawRef(ref)}${citation ? "|cite" : ""}}}`;
  });
  const availability = preview
    ? []
    : availabilityRequests(
        messages,
        usable.filter((item) => !contextRefs.includes(item.evidence.run_ref)),
      );
  const fallbackFocus: string[] = [];
  if (fallback && !reuseOnly) {
    const atoms = [
      ...usable.flatMap(({ evidence }) => evidence.evidence_items ?? []),
      ...selectedCalculations.flatMap(({ evidence }) => evidence.evidence_items),
    ];
    const dependencies = findingDependencies(atoms);
    let selected: Set<string>;
    try {
      selected = new Set(expandFindingRefs([...referenced], dependencies));
    } catch {
      throw new BackendApiError(
        422,
        "已选历史事实的依据链不完整，请核对真实来源。",
        "ANALYSIS_REPORT_REFERENCE",
      );
    }
    const historyAtoms = new Map(
      historical.flatMap(({ evidence }) =>
        (evidence.evidence_items ?? []).map((atom) => [atom.ref, atom] as const),
      ),
    );
    // 判断保留原引用，由后端展开完整依据；旧计算仅有 fact_id 时仍需转为父事实。
    const judgments = [...referenced]
      .flatMap((ref) => {
        if (!historyAtoms.get(ref)?.judgment_kind) return [];
        const complete = expandFindingRefs([ref], dependencies);
        if (!complete.every((parent) => historyAtoms.has(parent))) return [];
        const original = expandFindingRefs([ref], historyAtoms);
        return original.length === complete.length &&
          original.every((parent) => complete.includes(parent))
          ? [{ ref, references: original }]
          : [];
      })
      .sort((left, right) => right.references.length - left.references.length);
    const covered = new Set<string>();
    // 恢复必须保留具体运算；同一计算回执的其他结果不随计算身份自动入选。
    for (const atom of selectedCalculations.flatMap(({ evidence }) => evidence.evidence_items)) {
      if (!referenced.has(atom.ref)) continue;
      fallbackFocus.push(atom.ref);
      expandFindingRefs([atom.ref], dependencies).forEach((ref) => covered.add(ref));
    }
    for (const judgment of judgments) {
      if (covered.has(judgment.ref)) continue;
      fallbackFocus.push(judgment.ref);
      judgment.references.forEach((ref) => covered.add(ref));
    }
    // 只补未被所选判断覆盖的历史事实，不从单条事实反向选择更宽的判断。
    fallbackFocus.push(
      ...[...historyAtoms.values()]
        .filter((atom) => atom.type === "fact" && selected.has(atom.ref) && !covered.has(atom.ref))
        .map((atom) => atom.ref),
    );
    // 当前查询与历史采用相同的显式选择；恢复不因取数集合较宽而扩展回答。
    fallbackFocus.push(
      ...[...referenced].filter((ref) => !historyAtoms.has(ref) && !covered.has(ref)),
    );
  }
  // 服务端重读不可变运行并校验权限、来源、范围、数字、单位和日期。
  const payload = {
    run_refs: runRefs,
    context_run_refs: contextRefs,
    focus_refs: reuseOnly ? focusRefs : fallbackFocus,
    summary,
    fact_bindings: factBindings,
    sections: narrative.sections,
    ...(selectedCalculations.length
      ? {
          calculation_refs: [
            ...new Map(
              selectedCalculations.map((item) => [
                item.evidence.calculation_ref.calculation_id,
                item.evidence.calculation_ref,
              ]),
            ).values(),
          ],
        }
      : {}),
    ...(availability.length ? { availability_requests: availability } : {}),
  };
  return {
    payload,
    refs,
    usable,
    // 计算结果随身份提交后端核验，但没有绘图维度；自动选图仅忽略这些结果引用，保留父事实。
    calculationAtomRefs: new Set(
      selectedCalculations.flatMap(({ evidence }) =>
        evidence.evidence_items.map((atom) => atom.ref),
      ),
    ),
    selections,
    automaticCharts: explicitSelections === undefined && !prepared.length,
    runRefs,
    targetCoverage,
    reportPlan: reportPlan ?? null,
  };
}

type PreviewBodyEvidence = { paragraph: number; evidence_refs: string[] };

/** 流式参数未闭合时只编译已形成的字段，仍由原预览接口核验引用与权限。 */
export async function compileInquiryReportDraft(
  input: Record<string, unknown>,
  request: AskMetricRequestContext,
  ended: boolean,
): Promise<string | undefined> {
  if (input.report === undefined) return typeof input.body === "string" ? input.body : undefined;
  const [messages, evidence] = await Promise.all([
    request.turnMessages?.() ?? [],
    request.answerEvidence?.() ?? [],
  ]);
  const report =
    input.report && typeof input.report === "object"
      ? (input.report as Record<string, unknown>)
      : {};
  if (typeof report.plan_id !== "string") return;
  const plan = selectedReportPlan(messages, report.plan_id);
  // 完整回执尚未进入上下文时等待，不将未完成参数降级为业务正文。
  if (!plan) return;
  return compileReportBody({ report: input.report }, plan, evidence, ended);
}

/** 旧后端可只返回文字；仅接受与本次渲染段落一一对应的来源映射。 */
function previewBodyEvidence(value: unknown, text: string): PreviewBodyEvidence[] | undefined {
  const count = text.split(/\n\s*\n/u).filter((part) => part.trim()).length;
  if (!Array.isArray(value) || value.length !== count) return;
  const entries: PreviewBodyEvidence[] = [];
  for (const [index, item] of (value as unknown[]).entries()) {
    if (
      !item ||
      typeof item !== "object" ||
      !("paragraph" in item) ||
      item.paragraph !== index + 1 ||
      !("evidence_refs" in item) ||
      !Array.isArray(item.evidence_refs) ||
      !item.evidence_refs.every((ref: unknown): ref is string => typeof ref === "string" && !!ref)
    )
      return;
    entries.push({ paragraph: index + 1, evidence_refs: item.evidence_refs });
  }
  return entries;
}

/** 每个观察流独立保存已核验前缀；后端仍逐次鉴权，正式报告不复用预览结果。 */
export function createInquiryReportPreview() {
  let previous:
    | {
        operationId: string;
        callSeq: number | undefined;
        backend: AskMetricRequestContext["backend"];
        context: string;
        summary: string;
        text: string;
        bodyEvidence: PreviewBodyEvidence[] | undefined;
      }
    | undefined;
  return async (
    body: string,
    request: AskMetricRequestContext,
    signal?: AbortSignal,
  ): Promise<AnswerStreamPreview | null | undefined> => {
    try {
      signal?.throwIfAborted();
      const { payload, refs, usable, calculationAtomRefs, reportPlan } =
        await prepareInquiryReport({ body }, request, {
          preview: true,
        });
      const { summary, ...sources } = payload;
      const context = JSON.stringify(sources);
      // 来源、历史焦点和计算依赖变化会影响前文核验，必须回到全文。
      const reusable =
        previous &&
        previous.operationId === request.operationId &&
        previous.callSeq === request.answerStream?.callSeq &&
        previous.backend === request.backend &&
        previous.context === context &&
        summary.startsWith(previous.summary + "\n\n")
          ? previous
          : undefined;
      const delta = reusable ? summary.slice(reusable.summary.length + 2) : summary;
      signal?.throwIfAborted();
      const details = await request.backend.analysisReport(
        { ...payload, summary: delta, preview: true },
        { signal },
      );
      signal?.throwIfAborted();
      if (
        details.kind === "analysis_report_preview" &&
        details.status === "succeeded" &&
        typeof details.preview_text === "string" &&
        details.preview_text.trim()
      ) {
        const text = reusable
          ? reusable.text + "\n\n" + details.preview_text
          : details.preview_text;
        const deltaEvidence = previewBodyEvidence(details.body_evidence, details.preview_text);
        const bodyEvidence =
          deltaEvidence && (!reusable || reusable.bodyEvidence)
            ? [
                ...(reusable?.bodyEvidence ?? []),
                ...deltaEvidence.map((item) => ({
                  ...item,
                  paragraph: item.paragraph + (reusable?.bodyEvidence?.length ?? 0),
                })),
              ]
            : undefined;
        let result: AnswerStreamPreview = text;
        if (bodyEvidence) {
          const report = { summary: text, body_evidence: bodyEvidence };
          const generated = await buildInquiryChart(
            usable,
            undefined,
            request,
            (verifiedNarrativeRefs(report, refs) ?? []).filter(
              (ref) => !calculationAtomRefs.has(ref),
            ),
            signal,
            reportPlan,
          );
          result = { text, charts: layoutReportCharts(generated.charts, report, true) };
        } else if (previous?.bodyEvidence) {
          // 映射中途不可用时明确撤下旧图，避免旧图继续附着于无法定位的新正文。
          result = { text, charts: [] };
        }
        signal?.throwIfAborted();
        previous = {
          operationId: request.operationId,
          callSeq: request.answerStream?.callSeq,
          backend: request.backend,
          context,
          summary,
          text,
          bodyEvidence,
        };
        return result;
      }
      // 响应契约异常不是正文确定性错误，留给观察器按服务失败处理。
      throw new Error("Invalid report preview response");
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        error instanceof BackendApiError &&
        error.status === 422 &&
        error.code === "ANALYSIS_REPORT_REFERENCE" &&
        error.details !== null &&
        typeof error.details === "object" &&
        "reason" in error.details &&
        error.details.reason === "missing_body_reference"
      )
        // 首个完整段落可能尚未包含引用，允许后续段落补齐后继续核验。
        return null;
      if (
        error instanceof NarrativeReferenceError ||
        (error instanceof BackendApiError &&
          error.status === 422 &&
          [
            "ANALYSIS_REPORT_FORMAT",
            "ANALYSIS_REPORT_NUMBER",
            "ANALYSIS_REPORT_REFERENCE",
            "ANALYSIS_REPORT_SUMMARY",
            "ANALYSIS_REPORT_EVIDENCE",
            "INQUIRY_TARGET_INCOMPLETE",
          ].includes(error.code ?? ""))
      )
        return undefined;
      // 不吞掉鉴权、来源失效和临时故障，避免追加正文时重复触发同一错误。
      previous = undefined;
      throw error;
    }
  };
}

/** 事实恢复复用同一来源转换；fallback 只由内部运行模块传入，不属于模型参数。 */
export async function executeInquiryReport(
  input: Static<typeof parameters>,
  request: AskMetricRequestContext,
  signal?: AbortSignal,
  fallback = false,
) {
  try {
    const {
      payload,
      refs,
      usable,
      calculationAtomRefs,
      selections,
      automaticCharts,
      runRefs,
      targetCoverage,
      reportPlan,
    } = await prepareInquiryReport(input, request, { fallback });
    let details = await request.backend.analysisReport(
      fallback
        ? { ...payload, summary: "", sections: [], fact_bindings: [], fallback: true }
        : payload,
      { signal },
    );
    if (
      details.kind !== "business_report" ||
      details.status !== "succeeded" ||
      typeof details.public_answer !== "string" ||
      !details.public_answer.trim() ||
      !details.report ||
      typeof details.report !== "object" ||
      Array.isArray(details.report)
    )
      throw new Error("INVALID_ANALYSIS_REPORT");
    const verifiedRefs = verifiedNarrativeRefs(details.report, refs) ?? [];
    const charts: BusinessReportChart[] = [];
    const chartNotices = new Set<string>();
    if (automaticCharts) {
      const generated = await buildInquiryChart(
        usable,
        undefined,
        request,
        verifiedRefs.filter((ref) => !calculationAtomRefs.has(ref)),
        signal,
        reportPlan,
      );
      charts.push(...generated.charts);
      if (generated.notice) chartNotices.add(generated.notice);
    } else {
      for (const choice of selections) {
        if (
          !choice.available ||
          !choice.run_refs.every((ref) => runRefs.includes(ref)) ||
          !reportChartHasNarrativeEvidence(usable, choice.selection, verifiedRefs)
        ) {
          chartNotices.add("所选图表与本次回答的数据范围或指标口径不一致，暂未展示。");
          continue;
        }
        const generated = await buildInquiryChart(
          usable,
          choice.selection,
          request,
          verifiedRefs,
          signal,
        );
        if (!generated.charts.length && choice.selection.type === "grouped_bar") {
          // 来源与正文关联已通过；只重排本次选中的真实点，不扩取正文其他指标或机构。
          const recovered = await buildInquiryChart(
            usable,
            undefined,
            request,
            choice.selection.evidence_refs,
            signal,
            reportPlan,
          );
          if (recovered.charts.length) {
            charts.push(...recovered.charts);
            chartNotices.add("分组图无法直接比较，已按可比数据分别展示。");
            continue;
          }
        }
        charts.push(...generated.charts);
        if (generated.notice) chartNotices.add(generated.notice);
      }
    }
    const notice = [...chartNotices].join("\n\n");
    const report = details.report as Record<string, unknown>;
    const gaps = Array.isArray(details.gaps) ? Array.from<unknown>(details.gaps) : [];
    if (targetCoverage && !targetCoverage.complete) {
      const missing = targetCoverage.missing_queries.map(({ org_name, time }) => {
        const period =
          time.date_selection === "latest_snapshot"
            ? `截至${time.anchor_date}的最新可用数据`
            : (time.dates?.join("、") ??
              (time.start === time.end ? time.start : `${time.start}至${time.end}`));
        return `${org_name}（${period}）`;
      });
      gaps.push(`尚未完成${missing.join("、")}的查询，当前结果仅代表已查询部分。`);
    }
    const reportSummary =
      typeof report.summary === "string" ? report.summary : details.public_answer;
    let publicAnswer = details.public_answer;
    if (notice) publicAnswer += `\n\n${notice}`;
    const timeAlternatives = currentTimeAlternatives(usable, request);
    delete details.time_variants;
    details = {
      ...details,
      public_answer: publicAnswer,
      ...(targetCoverage ? { target_coverage: targetCoverage, gaps } : {}),
      ...(timeAlternatives.length ? { time_variants: timeAlternatives } : {}),
      ...(notice ? { partial_analysis: true, gaps: [...gaps, ...chartNotices] } : {}),
      report: {
        ...report,
        charts,
        ...(notice ? { summary: `${reportSummary}\n\n${notice}` } : {}),
      },
    };
    if (fallback) details = markPartialAnalysisReport(details, "corrections_exhausted");
    const finalReport = details.report as Record<string, unknown>;
    details = {
      ...details,
      report: { ...finalReport, charts: layoutReportCharts(charts, finalReport, automaticCharts) },
    };
    return {
      content: [{ type: "text" as const, text: details.public_answer as string }],
      details,
      terminate: true,
    };
  } catch (caught) {
    const error =
      caught instanceof NarrativeReferenceError
        ? new BackendApiError(422, caught.message, "ANALYSIS_REPORT_FORMAT")
        : caught;
    if (signal?.aborted || (error instanceof BackendApiError && [401, 403].includes(error.status)))
      throw error;
    const invalid = error instanceof BackendApiError && error.status === 422;
    if (!(error instanceof BackendApiError)) {
      // 原始异常可能含 SQL 或凭据，只记录请求关联与调用帧；已知后端异常由后端审计。
      console.error(
        JSON.stringify({
          event: "inquiry_report_failed",
          request_id: request.requestId,
          operation_id: request.operationId,
          error_type: error instanceof Error ? error.constructor.name : "UnknownError",
          stack:
            error instanceof Error
              ? error.stack
                  ?.split("\n")
                  .filter((line) => line.trimStart().startsWith("at "))
                  .slice(0, 12)
              : undefined,
        }),
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text:
            error instanceof BackendApiError
              ? error.code === "INQUIRY_TARGET_INCOMPLETE"
                ? JSON.stringify({ message: error.message, target_coverage: error.details })
                : error.message
              : "回答校验未完成，请稍后重试。",
        },
      ],
      details: {
        kind: "analysis_answer",
        status: invalid ? "ARGUMENT_ERROR" : "error",
        retryable: invalid,
        ...(error instanceof BackendApiError && error.code === "INQUIRY_TARGET_INCOMPLETE"
          ? { validation_stage: "prerequisite", target_coverage: error.details }
          : {}),
        error_code:
          error instanceof BackendApiError
            ? (error.code ?? "INQUIRY_REPORT_FAILED")
            : "INQUIRY_REPORT_FAILED",
      },
    };
  }
}
