import {Type} from "@earendil-works/pi-ai";
import type {AgentHarnessTool} from "@earendil-works/pi-agent-core";
import type {AskMetricRequestContext} from "../requestContext.js";
import {numberTokens} from "../replyGuard.js";
import type {BusinessEvidence} from "../answerEvidence.js";
import {BackendApiError} from "../backendClient.js";
import {narrativeEvidenceRefs, narrativeParagraphEvidence, normalizeReportNarrative, reviewNarrativeDensity} from "../analysis/narrative.js";
import {expandFindingRefs} from "../analysis/verifiedFindings.js";
import {publicTextProblem} from "../runtime/delivery.js";

interface EvidenceItem {ref: string; display: string; label: string; type?: string; value?: string; ranked_increases?: string[]; judgment_kind?: string; input_refs?: string[]}
export interface OverviewEvidence extends BusinessEvidence {
  frame_id?: string;
  topic?: "loan" | "deposit"; topic_version?: string; topic_name?: string; source_notice?: string; context_notice?: string;
  metric_sources?: Record<string, string>;
  analysis_date: string | null; requested_date: string; org_codes: string[]; org_name: string;
  basis: string; evidence_items: EvidenceItem[]; table_rows: Record<string, string>[];
  table_columns: string[]; tasks: Array<{task_id: string; status: string}>;
  gaps: Array<{label?: string; reason: string}>;
  plan?: {objective?: string; questions?: string[]; rationale?: string; metric_ids?: string[]};
  followup_candidates?: Array<{parent: string; metric_ids: string[]; comparisons: string[]; reason: string}>;
  date_selection?: "exact" | "latest_snapshot" | "available_in_range";
  data_freshness?: {checked_on: string; as_of: string | null; lag_days: number | null; notice: string};
  period?: {start: string; end: string; checked_on: string; snapshot_dates: string[];
    months: Array<{month: string; as_of: string | null; date_count: number}>};
}
export interface ReportInput {
  evidence_refs: string[]; summary: string;
  sections: Array<{title: string; text: string; evidence_refs: string[]}>;
  metric_ids: string[];
}

const isProseError = (error: unknown): error is Error => error instanceof Error && /^(?:summary |sections\[)/u.test(error.message);

/** 仅合并同一快照的段首日期；跨期比较和句内基期日期保持原样。 */
function overviewDisplayText(text: string, sources: OverviewEvidence[]) {
  const date = sources[0]?.analysis_date;
  if (!date || sources.some(source => source.analysis_date !== date
    || source.period?.snapshot_dates.some(snapshot => snapshot !== date)
    || source.table_rows.some(row => row.data_date && row.data_date !== date))) return text;
  return text.replace(/(^|\n[ \t]*\n)([ \t]*)(?:截至|截止)(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})日?[,，][ \t]*/gu,
    (matched, paragraph: string, indent: string, year: string, month: string, day: string) =>
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` === date ? paragraph + indent : matched);
}

/** 校验细节保存在 gaps；正文只说明受影响的业务比较，合并同一种缺项。 */
function overviewBusinessGaps(sources: OverviewEvidence[]) {
  const groups = new Map<string, Set<string>>();
  for (const gap of sources.flatMap(source => source.gaps)) {
    const comparison = /^(较上月|较同期|较年初)正式比较指标的当前值、增量与增幅不一致或比较分母为零/u.exec(gap.reason);
    const reason = comparison ? `的${comparison[1]}数据暂不可用，相关比较未纳入本次分析。` : gap.reason;
    const labels = groups.get(reason) ?? new Set<string>();
    labels.add(gap.label ?? "");
    groups.set(reason, labels);
  }
  return [...groups].map(([reason, labels]) => [...labels].filter(Boolean).join("、") + reason);
}

/** 表格和文字降级共用同一合并规则，未查询的比较格不能覆盖已经取得的值。 */
function mergedOverviewRows(sources: OverviewEvidence[]) {
  const rows = new Map<string, Record<string, string>>();
  for (const source of sources) for (const row of source.table_rows) {
    const key = row.data_date ? `${row.metric_id}@${row.data_date}` : row.metric_id!;
    const previous = rows.get(key) ?? {};
    rows.set(key, {...previous, ...Object.fromEntries(Object.entries(row)
      .filter(([field, value]) => value !== "—" && value !== "" || previous[field] === undefined))});
  }
  return rows;
}

/** 成文失败与中断交付共用事实正文，不计算新数值或生成经营因果。 */
function overviewFactBody(sources: OverviewEvidence[], metricIds: string[]) {
  const atoms = new Map(sources.flatMap(source => source.evidence_items).map(atom => [atom.ref, atom]));
  const paragraphs: string[] = [], bodyEvidence: Array<{paragraph: number; evidence_refs: string[]}> = [];
  const judgments = [...atoms.values()].filter(atom => atom.judgment_kind);
  const focused = [judgments.find(atom => atom.judgment_kind === "baseline_divergence"),
    ...judgments.filter(atom => atom.judgment_kind === "peer_rate_gap").slice(-2), ...judgments]
    .filter((atom): atom is EvidenceItem => !!atom);
  for (const atom of [...new Map(focused.map(item => [item.ref, item])).values()].slice(0, 3)) {
    paragraphs.push(atom.display);
    bodyEvidence.push({paragraph: paragraphs.length, evidence_refs: [atom.ref, ...atom.input_refs ?? []]});
  }
  for (const row of mergedOverviewRows(sources).values()) {
    if (metricIds.length && !metricIds.includes(row.metric_id!)) continue;
    if (!row["当前值"] || row["当前值"] === "—") continue;
    const prefix = `${row.data_date ? `d${row.data_date.replaceAll("-", "")}.` : ""}${row.metric_id}`;
    const refs = [`${prefix}.current`];
    const date = row.data_date ?? sources[0]!.analysis_date;
    const changes = [{label: "较上月", id: "mom"}, {label: "较同期", id: "yoy"}, {label: "较年初", id: "ytd"}]
      .flatMap(period => {
        const difference = atoms.get(`${prefix}.${period.id}.difference`), rate = atoms.get(`${prefix}.${period.id}.rate`);
        if (!difference && !rate) return [];
        if (difference) refs.push(difference.ref);
        if (rate) refs.push(rate.ref);
        return [`${period.label}${difference ? `变动${difference.display}` : "增幅"}${rate ? `${difference ? "（" : ""}${rate.display}${difference ? "）" : ""}` : ""}`];
      });
    const share = atoms.get(`${prefix}.share.share`);
    if (share) {changes.push(`占比${share.display}`); refs.push(share.ref);}
    paragraphs.push(`${date ? `截至${date}，` : ""}${row["指标"] ?? row.metric_id}为${row["当前值"]}${changes.length ? `；${changes.join("；")}` : ""}。`);
    bodyEvidence.push({paragraph: paragraphs.length, evidence_refs: refs.filter(ref => atoms.has(ref))});
  }
  return {text: paragraphs.join("\n\n"), bodyEvidence};
}

/** 校验失败按自然段保留有依据的正文；没有可保留正文时交付可见事实，不能只剩提示和折叠表。 */
export function composePartialBusinessReport(sources: OverviewEvidence[], input: ReportInput) {
  // 先独立核验机构、日期、快照与指标选择；这些硬边界不进入文字降级。
  composeBusinessReport(sources, {...input, summary: "", sections: []});
  let summary = input.summary;
  try { composeBusinessReport(sources, {...input, sections: []}); }
  catch (error) {
    if (!isProseError(error)) throw error;
    const kept: string[] = [];
    let heading = "";
    for (const paragraph of summary.split(/\n\s*\n/u).filter(part => part.trim())) {
      try {
        const candidate = composeBusinessReport(sources, {...input, summary: paragraph, sections: []});
        if (/^(?:#{1,6}\s+.+|\*\*[^\n]+\*\*)$/u.test(paragraph.trim())) {heading = paragraph; continue;}
        if (candidate.report.body_evidence.length) kept.push(...heading ? [heading, paragraph] : [paragraph]);
      } catch (partError) {if (!isProseError(partError)) throw partError;}
      heading = "";
    }
    summary = kept.join("\n\n");
    // 分别通过的段落合并后仍需校验，防止跨段的口径与推论绕过。
    try {composeBusinessReport(sources, {...input, summary, sections: []});}
    catch (combinedError) {if (!isProseError(combinedError)) throw combinedError; summary = "";}
  }
  const sections = input.sections.filter(section => {
    try { composeBusinessReport(sources, {...input, summary, sections: [section]}); return true; }
    catch (error) {if (!isProseError(error)) throw error; return false;}
  });
  const report = composeBusinessReport(sources, {...input, summary, sections});
  if (!report.report.body_evidence.length && !sections.length) {
    const facts = overviewFactBody(sources, input.metric_ids);
    report.report.summary = overviewDisplayText(facts.text, sources) || "已检查请求范围，未取得可用指标记录，暂不能形成经营判断。";
    report.report.body_evidence = facts.bodyEvidence;
  }
  const lag = sources[0]?.data_freshness?.lag_days;
  const tail = [typeof lag === "number" && lag > 0 ? `当前可用数据距查询日${lag}天。` : "",
    ...overviewBusinessGaps(sources)].filter(Boolean).join("\n\n");
  // 正文不堆叠校验、降级和补查诊断；确实影响解释的业务缺项只说明一次。
  if (tail) {
    if (sections.length) report.report.sections.at(-1)!.text += `\n\n${tail}`;
    else report.report.summary += `\n\n${tail}`;
  }
  report.gaps.push("部分分析文字未通过证据校验，已省略；基础数据和已校验段落仍可查看。");
  return {...report, partial_analysis: true,
    public_answer: overviewPublicAnswer(sources[0]!, report.report.summary, report.report.sections,
      [], report.report.presentation.source_notices)};
}

function overviewPublicAnswer(first: OverviewEvidence, summary: string, sections: ReportInput["sections"], gaps: string[], notices: Array<string | undefined>) {
  const scope = `${first.org_name}${first.topic === "deposit" ? "存款" : "贷款"}分析（${first.period ? `${first.period.start}至${first.period.end}` : first.analysis_date ?? first.requested_date}）。\n\n口径：${first.basis}。`;
  return [scope, ...notices.filter(Boolean), summary,
    ...sections.map(section => `${section.title ? `**${section.title}**\n\n` : ""}${section.text}`),
    ...(gaps.length ? [`**数据与分析边界**\n\n${gaps.map(gap => gap.replace(/[。；\s]+$/u, "")).join("；")}。`] : []),
    first.topic === "deposit" ? "余额和正式比较指标可以说明规模及结构变化；客户流失、资金迁移和付息成本变化需要相应流水、客户和付息数据验证。" : "余额与已发布比较指标可以说明变化及组成；投放、还款、核销和客户行为等业务动因仍需相应证据验证。"].join("\n\n");
}

/** 已尝试但缺数也算完成补查；三轮后以缺口交付，不形成无界查询。 */
export function pendingOverviewFollowup(sources: OverviewEvidence[]) {
  if (sources.length >= 3 || !sources.at(-1)?.analysis_date) return [];
  const attempted = new Set(sources.flatMap(source => source.plan?.metric_ids ?? []));
  return sources.flatMap(source => source.followup_candidates ?? [])
    .map(candidate => ({...candidate, metric_ids: candidate.metric_ids.filter(id => !attempted.has(id))}))
    .filter(candidate => candidate.metric_ids.length);
}

/** 模型撰写文本，数字通过证据占位符引用；表格由回执构造，历史保留原任务授权边界。 */
export function composeBusinessReport(sources: OverviewEvidence[], input: ReportInput, incompleteNotice?: string) {
  for (const text of [input.summary, ...input.sections.flatMap(section => [section.title, section.text])]) {
    const problem = publicTextProblem(text);
    if (problem) throw new Error(`summary ${problem}；请仅保留对用户有用的业务判断及证据。`);
  }
  const first = sources[0];
  if (!first || sources.some(source => source.status !== "succeeded"
    || JSON.stringify(source.org_codes) !== JSON.stringify(first.org_codes)
    || source.analysis_date !== first.analysis_date || source.requested_date !== first.requested_date
    || source.date_selection !== first.date_selection
    || JSON.stringify(source.period) !== JSON.stringify(first.period)
    || (source.topic ?? "loan") !== (first.topic ?? "loan") || source.topic_version !== first.topic_version
    || source.basis !== first.basis)) throw new Error("报告必须引用同一机构、日期和口径且主题版本相同的本轮概览证据。");
  const pending = pendingOverviewFollowup(sources);
  const evidence = new Map<string, EvidenceItem>();
  for (const source of sources) {
    if (!Array.isArray(source.evidence_items) || !Array.isArray(source.table_rows)) throw new Error("概览证据格式不完整，请重新查询。");
    for (const item of source.evidence_items) {
      // 日期选择线索会随补查变化；仅比较结构化新鲜度，不能把说明文字当作业务值冲突。
      if (item.ref === "scope.freshness" && evidence.has(item.ref) && first.data_freshness && source.data_freshness) {
        const sameFreshness = (["checked_on", "as_of", "lag_days"] as const)
          .every(field => first.data_freshness![field] === source.data_freshness![field]);
        if (!sameFreshness || source.data_freshness.as_of !== source.analysis_date) throw new Error("两轮日期覆盖证据发生变化，请确认一致的数据快照。");
        continue;
      }
      if (evidence.has(item.ref) && evidence.get(item.ref)!.display !== item.display) throw new Error("两轮证据值发生变化，请确认一致的数据快照。");
      evidence.set(item.ref, item);
    }
  }
  const rows = mergedOverviewRows(sources);
  const gaps = [...new Set([...sources.flatMap(source => source.gaps.map(gap => `${gap.label ?? ""}${gap.reason}`)),
    ...(incompleteNotice ? [incompleteNotice, ...pending.map(item => `尚未完成补查：${item.reason}`)] : [])])];
  const normalizeDate = (year: string, month: string, day: string) => `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const allowedDates = new Set([first.analysis_date, first.requested_date, first.period?.start, first.period?.end,
    ...first.period?.snapshot_dates ?? [], ...sources.flatMap(source => source.evidence_items
    .flatMap(item => [...item.display.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/gu)].map(match => normalizeDate(match[1]!, match[2]!, match[3]!))))]);
  const allowedMonths = new Set([...allowedDates].filter((date): date is string => !!date).map(date => date.slice(0, 7)));
  first.period?.months.forEach(month => allowedMonths.add(month.month));
  const periods = [{id: "mom", expression: /较上月|环比/u}, {id: "yoy", expression: /较同期|同比/u},
    {id: "ytd", expression: /较年初/u}];
  const growthLeaders = new Set(periods.flatMap(period => evidence.get(`growth_sources.${period.id}`)?.ranked_increases?.slice(0, 1) ?? []));
  const issues: string[] = [];
  const prepareProse = (value: string) => {
    let text = value.replace(/[+-](?=\{\{[^{}]+\}\})/gu, "");
    // 完全相同且唯一的数值展示可自动关联回执；不接纳近似值、换算值或歧义数值。
    const displays = new Map<string, string[]>();
    for (const item of evidence.values()) {
      if (!/^-?\d[\d.]*?(?:亿元|万元|元|%|个百分点)$/u.test(item.display)) continue;
      displays.set(item.display, [...displays.get(item.display) ?? [], item.ref]);
    }
    for (const [display, refs] of [...displays].sort((a, b) => b[0].length - a[0].length)) {
      if (refs.length !== 1) continue;
      const escaped = display.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 正号只是已核验正值的展示形式；负号及数值歧义仍拒绝自动绑定。
      text = text.replace(new RegExp(`(?<![\\d.+-])${display.startsWith("-") ? "" : "\\+?"}${escaped}(?![\\d.])`, "gu"), `{{${refs[0]}}}`);
    }
    const residual = evidence.get("reconciliation.0.value");
    if (residual) text = text.replace(/残差(?:为|是)?(-?\d+(?:\.\d+)?)(?![\d.])/gu,
      (matched, numeric: string) => residual.display.match(/^-?\d+(?:\.\d+)?/u)?.[0] === numeric
        ? "残差为{{reconciliation.0.value}}" : matched);
    return text.replace(/\{\{([^{}]+)\}\}(亿元|万元|元|%|个百分点)/gu, (matched, ref: string, unit: string) =>
      evidence.get(ref)?.display.match(/(亿元|万元|元|%|个百分点)$/u)?.[0] === unit ? `{{${ref}}}` : matched);
  };
  const interpolate = (text: string, path: string): string => {
    if (text.includes("{{scope.freshness}}")) issues.push(`${path} 数据新鲜度由程序在报告开头统一披露，正文删除 {{scope.freshness}}，不要把完整说明作为天数嵌入句子或重复披露。`);
    const isMonthEnd = first.analysis_date && new Date(`${first.analysis_date}T00:00:00Z`).getUTCDate()
      === new Date(Date.UTC(Number(first.analysis_date.slice(0, 4)), Number(first.analysis_date.slice(5, 7)), 0)).getUTCDate();
    const unsupportedPeriods = [...text.matchAll(/月度环比|单月增长|单月回落|当月增长|持续收缩|持续下降|持续增长|连续增长|(?:月度动能|增长动能|增长势头)[^。！？；]{0,8}(?:趋缓|放缓|增强|减弱|加速)/gu)]
      .filter(match => !/(?:不能|无法|不足以|不支持|不代表|不宜)[^。！？；]{0,24}$/u.test(text.slice(Math.max(0, match.index - 30), match.index)))
      .map(match => match[0]);
    const unsupportedTrend = unsupportedPeriods.filter(term => !isMonthEnd || /持续|连续|动能|势头/u.test(term));
    if (unsupportedTrend.length) issues.push(`${path} 只有截至日及正式较上月指标，请将本段所有“${[...new Set(unsupportedTrend)].join("、")}”改为“截至日较上月变化”，不能声称完整月份表现或连续趋势。`);
    for (const sentence of text.split(/[。！？；]/u)) {
      for (const match of sentence.matchAll(/(?:\d{4}年)?(\d{1,2})月(?:末|底)/gu)) {
        const before = sentence.slice(Math.max(0, match.index - 18), match.index);
        const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + 16);
        if (/(?:没有|未取得|缺少|缺失|不代表)[^，,。！？；]{0,12}$/u.test(before)
          || /^(?:的)?(?:数据|记录|余额)?(?:暂无|没有|缺失|未|尚未|无|缺)/u.test(after)) continue;
        const month = match[1]!.padStart(2, "0");
        const actualDates = first.period?.snapshot_dates ?? [first.analysis_date];
        const hasMonthEnd = actualDates.some(day => day && day.slice(5, 7) === month
          && Number(day.slice(8)) === new Date(Date.UTC(Number(day.slice(0, 4)), Number(month), 0)).getUTCDate());
        if (!hasMonthEnd) issues.push(`${path} 实际快照没有${match[0]}记录，月中截至日不能写成月末或月底数据；沿用实际日期。`);
      }
      if (first.topic === "deposit") {
        const caveat = /不能|无法|不足以|不代表|不等于|不宜|待核实|尚未证实|需要.*(?:验证|数据|证据)/u.test(sentence);
        const sourcesByMetric = Object.assign({}, ...sources.map(source => source.metric_sources ?? {})) as Record<string, string>;
        const prefix = /对公/u.test(sentence) ? "company" : /个人/u.test(sentence) ? "personal" : undefined;
        const prefixes = prefix ? [prefix] : ["personal", "company"];
        if (!caveat && /活期.*(?:与|和).*定期.*(?:来源不同|不同.*来源)/u.test(sentence)
          && prefixes.some(key => sourcesByMetric[`${key}_current`]
            && sourcesByMetric[`${key}_current`] === sourcesByMetric[`${key}_fixed`])) {
          issues.push(`${path} 本轮活期与定期指标映射到同一业务来源，不能写为二者来源不同；来源说明以报告中的指标来源标签为准。`);
        }
        // 活期占比变化不能代替定期占比变化；保证金等其他分项使二者未必互补。
        for (const clause of sentence.split(/[，,、]/u)) {
          if (caveat || !/(?:占比|比重|比例|份额).*(?:上升|提升|下降|降低|收缩|扩大|扩张|走高|走低|提高|回落|上行|下行)/u.test(clause)) continue;
          const types = [{name: "活期", id: "current"}, {name: "定期", id: "fixed"}]
            .filter(type => clause.includes(type.name));
          const compared = periods.filter(period => period.expression.test(clause));
          const selectedPeriods = compared.length ? compared : periods;
          const decline = /(?:占比|比重|比例|份额).*(?:下降|降低|收缩|走低|回落|下行)/u.test(clause);
          const clausePrefix = /对公/u.test(clause) ? "company" : /个人/u.test(clause) ? "personal" : prefix;
          const candidates = clausePrefix ? [clausePrefix] : prefixes;
          for (const type of types) {
            const supported = candidates.some(key => {
              const supportsPeriod = (period: typeof periods[number]) => {
                const item = evidence.get(`${key}_${type.id}_share.${period.id}.difference`);
                const value = Number(item?.value ?? item?.display.match(/^-?\d+(?:\.\d+)?/u)?.[0]);
                return Number.isFinite(value) && (decline ? value < 0 : value > 0);
              };
              return compared.length ? selectedPeriods.every(supportsPeriod) : selectedPeriods.some(supportsPeriod);
            });
            if (!supported) issues.push(`${path} 没有对应的同口径${type.name}占比变化证据支持所述方向，不能用其他分项占比或余额变化代替；描述已证实的余额分化。`);
          }
        }
        if (!caveat && /成本|付息/u.test(sentence)
          && /下降|上升|降低|升高|走高|方向相反|推高|抬升|改善|恶化/u.test(sentence)) {
          issues.push(`${path} 当前没有付息率或利息支出证据，不能从活定期结构认定成本变化或其方向；改为待核验问题。`);
        }
        if (!caveat && /客户.*流失|流失.*客户/u.test(sentence)
          && /没有|并未|未见|都|已|出现|说明|表明|证实|证明/u.test(sentence)) {
          issues.push(`${path} 当前没有客户流水和账户证据，余额升降既不能证明也不能排除客户流失；删除确定性判断。`);
        }
      }
      if (/较昨日|较昨天|较上日|日环比/u.test(sentence)
        && !/(?:没有|缺少|不能|无法|不支持|不足以)[^。！？；]{0,24}(?:较昨日|较昨天|较上日|日环比)/u.test(sentence)) {
        issues.push(`${path} 当前只有较上月、较同期和较年初证据，没有逐日比较；沿用回执中的比较标签，不写较昨日或日环比。`);
      }
      if (growthLeaders.size > 1 && /(?:各|所有|每个|全部)(?:比较)?期间|各周期/u.test(sentence)
        && /(?:增量|增加金额|增长额)[^。！？]*(?:最大|第一|首位)|唯一[^。！？]*(?:来源|贡献)/u.test(sentence)
        && !/不同|分别|各自|不能|无法/u.test(sentence)) {
        issues.push(`${path} 各比较期间的最大增加分项不同，请依据 growth_sources.mom/yoy/ytd 分别说明，不能宣称同一分项在所有期间增量最大或为唯一来源。`);
      }
      // 余额和比例可能反向，不能用一个“均改善”替代两个正式指标的比较方向。
      if (/不良(?:贷款)?余额/u.test(sentence) && /不良(?:贷款)?率/u.test(sentence)) {
        for (const match of sentence.matchAll(/(?:不良(?:贷款)?余额\s*(?:与|和|及|、)\s*不良(?:贷款)?率|二者|两项指标)[^。；！？]*?((?:较上月|较同期|同比|较年初)[^。；！？]*?)均(?:有|有所|略有)?(?:小幅)?(回落|下降|降低|改善|上升|增加|增长)/gu)) {
          const decline = ["回落", "下降", "降低", "改善"].includes(match[2]!);
          const compared = periods.filter(period => period.expression.test(match[1]!));
          const supported = compared.length && compared.every(period => ["npl_balance", "npl_ratio"].every(metric => {
            const value = evidence.get(`${metric}.${period.id}.difference`)?.value;
            return value !== undefined && Number.isFinite(Number(value)) && (decline ? Number(value) < 0 : Number(value) > 0);
          }));
          if (!supported) issues.push(`${path} 不良余额和不良率在所述比较期间并非均${match[2]}，或缺少有效比较证据，请分别描述两个正式指标的实际方向。`);
        }
      }
      if (/同比|较同期/u.test(sentence) && /环比|较上月/u.test(sentence) && /放缓|加快|加速/u.test(sentence)
        && !/不能|不足以|无法/u.test(sentence)) issues.push(`${path} 同比与较上月周期不同，不能据二者大小推断增长放缓或加速；删除此推论。`);
      if (/同比|较同期/u.test(sentence) && /较年初|年初至今|年初以来/u.test(sentence)
        && /上半年|下半年|放缓|加快|加速|(?:增长|增量)[^。！？；]{0,8}集中[^。！？；]*(?:年初|月|半年)/u.test(sentence)
        && !/不能|不足以|无法/u.test(sentence)) issues.push(`${path} 同比与较年初的基期不同，且没有连续月度余额，不能推断增长集中在某个半年或增长加速、放缓；删除此推论。`);
      if (/(?:不良率|不良贷款率)[^。！？]*(?:低位|偏低|偏高|较低|较高)|(?:资产质量|风险)[^。！？]*(?:可控|安全|良好)/u.test(sentence)
        && !/不能|不宜|不足以|无法/u.test(sentence)) issues.push(`${path} 当前没有经审核阈值或同业对照，不能评价不良率高低或风险可控；改为描述实证变化与关注点。`);
      if (/不良(?:贷款)?率|\{\{npl_ratio\./u.test(text) && /摊薄|稀释|分母/u.test(sentence) && !/不能|不宜|不足以|无法/u.test(sentence)) issues.push(`${path} 不良率与总贷款的分母口径尚未确认，不能推断贷款规模增长摊薄不良率；删除该推论，分别描述正式指标变化。`);
    }
    const withoutReferences = text.replace(/\{\{([^{}]+?)(\|cite)?\}\}/g, (_match, ref: string) => {
      if (!evidence.has(ref)) issues.push(`${path} 不存在证据 ${ref}，请使用回执中的 ref。`);
      return "";
    });
    for (const match of text.matchAll(/(?:增幅|增速)\s*[（(:：]?\s*(?:为|是|约)?\s*\{\{([^{}]+)\}\}/gu)) {
      const item = evidence.get(match[1]!);
      const prefix = text.slice(Math.max(0, match.index - 20), match.index);
      if (item && /(?:亿元|万元|元)$/u.test(item.display) && !/不能|无法|不等于|不代表|是否/u.test(prefix))
        issues.push(`${path} 金额证据不能称为增幅或增速，请称增量或差额；增幅须引用正式比率或已核验计算。`);
    }
    if (/\{\{|\}\}/.test(withoutReferences)) issues.push(`${path} 证据占位符格式应为 {{ref}}。`);
    // 日期按完整日期比较，兼容中文不补零的月份；不能用日期中的数字放行业务数值。
    const prose = withoutReferences.replace(/(?<!\d)(\d{1,2})\s*[-~～至到]\s*(\d{1,2})月/gu, (matched, start: string, end: string) =>
      first.period && Number(start) <= Number(end)
        && Array.from({length: Number(end) - Number(start) + 1}, (_, index) => Number(start) + index)
          .every(month => first.period!.months.some(item => Number(item.month.slice(5, 7)) === month)) ? "" : matched)
      .replace(/(\d{1,2}(?:[、,，和及]\d{1,2})+)月/gu, (matched, months: string) =>
      months.split(/[、,，和及]/u).every(month => [...allowedMonths].some(date => date.endsWith(`-${month.padStart(2, "0")}`))) ? "" : matched)
      .replace(/(\d+)(?:个|条|份)?(?:月(?:度)?(?:快照)?|(?:可用|有效|实际)?(?:快照|记录|数据点))/gu,
        (matched, count: string) => first.period?.snapshot_dates.length === Number(count) ? "" : matched)
      .replace(/(?:相隔|间隔|滞后)(?:大约|约)?\s*(\d+)\s*天/gu, (matched, days: string) =>
      first.data_freshness?.lag_days === Number(days) ? "" : matched)
      .replace(/(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})日?/gu,
      (matched, year: string, month: string, day: string) => allowedDates.has(normalizeDate(year, month, day)) ? "" : matched)
      .replace(/(\d{4})(?:年|[-/])(\d{1,2})月?/gu, (matched, year: string, month: string) => allowedMonths.has(`${year}-${month.padStart(2, "0")}`) ? "" : matched)
      .replace(/(?<!\d)(\d{1,2})月(?:(\d{1,2})日)?/gu, (matched, month: string, day?: string) => {
        const suffix = `-${month.padStart(2, "0")}${day ? `-${day.padStart(2, "0")}` : ""}`;
        return [...(day ? allowedDates : allowedMonths)].some(date => date?.endsWith(suffix)) ? "" : matched;
      });
    const numbers = [...numberTokens(prose)];
    if (numbers.length) issues.push(`${path} 业务数字只能使用 {{ref}} 引用，需替换的直接数值：${numbers.join("、")}。`);
    const chineseNumbers = [...prose.matchAll(/百分之[零一二三四五六七八九十百两]+|[零一二三四五六七八九十百两]+分之[零一二三四五六七八九十百两]+|[零一二三四五六七八九十百千万两]+(?:成|倍|个百分点|亿元|万元)/gu)].map(match => match[0]);
    if (chineseNumbers.length) issues.push(`${path} 业务数字只能使用 {{ref}} 引用，中文数量“${chineseNumbers.join("、")}”也不能自行计算或估算。`);
    for (const match of text.matchAll(/\{\{([^{}]+)\}\}(亿元|万元|元|%|个百分点)/g)) {
      issues.push(`${path} 的 {{${match[1]}}} 已包含单位，移除紧随其后的“${match[2]}”。`);
    }
    return text.replace(/(下降|减少|降低|回落|收缩|降|减|跌)(了?\s*)(\{\{[^{}]+\}\}(?:[、和及]\{\{[^{}]+\}\})*)/gu,
      (_matched, verb: string, space: string, refs: string) => {
        return `${verb}${space}${refs.replace(/\{\{([^{}]+)\}\}/gu, (matched, ref: string) => {
          const display = evidence.get(ref)?.display;
          return display?.startsWith("-") ? display.slice(1) : matched;
        })}`;
      }).replace(/\{\{([^{}]+?)(\|cite)?\}\}/g,
        (matched, ref: string, citation?: string) => evidence.has(ref) ? citation ? "" : evidence.get(ref)!.display : matched);
  };
  const preparedSummary = prepareProse(input.summary);
  const summary = overviewDisplayText(interpolate(preparedSummary, "summary"), sources);
  const sections = input.sections.map((section, index) => {
    const path = `sections[${index}]`;
    const text = prepareProse(section.text);
    const placeholders = narrativeEvidenceRefs(text);
    const refs = [...new Set([...section.evidence_refs, ...placeholders])];
    if (!refs.length || refs.some(ref => !evidence.has(ref))) issues.push(`${path} 需要有效的分析证据引用；段落 evidence_refs 使用 total.current 等原子 ref，不能使用 e1/e2 回执编号。`);
    return {...section, evidence_refs: refs, title: interpolate(prepareProse(section.title), `${path}.title`),
      text: overviewDisplayText(interpolate(text, `${path}.text`), sources)};
  });
  if (issues.length) throw new Error([...new Set(issues)].join("\n"));
  if (new Set(input.metric_ids).size !== input.metric_ids.length || input.metric_ids.some(id => ![...rows.values()].some(row => row.metric_id === id))) throw new Error("表格只能选择本轮实际取得数据的指标ID，缺数时使用空数组。");
  const tableRows = [...rows.values()].filter(row => input.metric_ids.includes(row.metric_id!))
    .sort((a, b) => (a.data_date ?? "").localeCompare(b.data_date ?? "") || input.metric_ids.indexOf(a.metric_id!) - input.metric_ids.indexOf(b.metric_id!))
    .map(cells => {
    return {metric_name: cells["指标"], ...(cells.data_date ? {stat_date: cells.data_date} : {}), current_value: cells["当前值"],
      mom_change: cells["较上月"], yoy_change: cells["较同期"], ytd_change: cells["较年初"], share: cells["占比"]};
  });
  const tasks = [...new Map(sources.flatMap(source => source.tasks).map(task => [task.task_id, task])).values()];
  const metricSources = new Map(sources.flatMap(source => source.table_rows.map(row =>
    [row["指标"] ?? row.metric_id!, source.metric_sources?.[row.metric_id!] ?? "正式指标目录"] as const)));
  const sourceDetail = first.topic === "deposit" && metricSources.size
    ? `本次有值指标的映射来源：${[...metricSources].map(([label, source]) => `${label}（${source}）`).join("；")}。`
    : "";
  const notices = [first.context_notice, first.source_notice, sourceDetail, first.data_freshness?.notice].filter(Boolean);
  const publicAnswer = overviewPublicAnswer(first, summary, sections, overviewBusinessGaps(sources), notices);
  return {kind: "business_report", status: "succeeded", delivery: "business_evidence_v1",
    answer_policy: "verified_report_v1", public_answer: publicAnswer,
    topic: first.topic ?? "loan", topic_version: first.topic_version, topic_name: first.topic_name, source_notice: first.source_notice, context_notice: first.context_notice,
    org_codes: first.org_codes, org_name: first.org_name, analysis_date: first.analysis_date,
    requested_date: first.requested_date, basis: first.basis, tasks,
    date_selection: first.date_selection, period: first.period, data_freshness: first.data_freshness,
    columns: ["metric_name", ...(first.period ? ["stat_date"] : []), "current_value", "mom_change", "yoy_change", "ytd_change", "share"], rows: tableRows, row_count: tableRows.length,
    partial_analysis: tableRows.length === 0 || gaps.length > 0,
    report: {summary, sections, presentation: {version: 1, body_mode: "narrative", layout: ["summary", "analysis", "data"],
      scope: `${first.org_name} · ${first.period ? `${first.period.start}至${first.period.end}` : first.analysis_date ?? first.requested_date}`,
      source_notices: notices,
      limitations: [first.basis,
        first.topic === "deposit" ? "余额与比较指标用于观察规模及结构变化；客户和资金变动原因仍需流水等证据。" : "余额与比较指标用于观察规模及组成变化；投放、还款、核销等原因仍需相应证据。"]},
      plans: sources.map(source => source.plan), evidence_refs: input.evidence_refs,
      body_evidence: narrativeParagraphEvidence(preparedSummary).map(paragraph => ({...paragraph,
        evidence_refs: expandFindingRefs(paragraph.evidence_refs, evidence)}))},
    gaps, evidence_items: [...evidence.values()]};
}

const parameters = Type.Object({
  evidence_refs: Type.Array(Type.String(), {minItems: 1, maxItems: 3, description: "本轮概览回执的 e1/e2 等引用；包含初查和补查，不引用历史数值。"}),
  body: Type.String({minLength: 1, maxLength: 6000, description: "必填完整自然正文。按关键发现、具体疑问自由组织自然段、要点或Markdown标题，无固定栏目。只引用影响判断的关键数字，完整数据留表格，不重复开篇数字或逐行复述所有比较。补查后用新证据支持、修正或限定初步判断，不能推断未证实因果。展示数值用{{实际原子ref}}；无需展示数值的判断在句后用{{实际原子ref|cite}}关联依据，仍核验并保存。不自行换算；日期沿用实际截至日。"}),
  metric_ids: Type.Array(Type.String(), {maxItems: 16, description: "表格展示的主题指标ID，按用户重点排序；无数值时为空。"}),
}, {additionalProperties: false});

export function createBusinessReportTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {name: "business_report_present", label: "生成经营分析报告", parameters,
    description: "观察初查及补查证据后，必填body交付自主撰写的自然正文并结束；不能只提交表格指标。数字用 {{total.current}} 等实际证据占位符，表格程序生成。围绕问题重点写发现、分化、反例或边界，无固定栏目，不把专家假设当成本机构原因。",
    execute: async (_id, rawInput, _update, request, _invocation, context) => {
      try {
        const input = {...rawInput, ...normalizeReportNarrative(rawInput)};
        const references = await request.answerEvidence?.() ?? [];
        const selected = input.evidence_refs.map(ref => references.find(item => item.ref === ref));
        if (new Set(input.evidence_refs).size !== input.evidence_refs.length
          || selected.some(item => item?.evidence.kind !== "business_overview")) {
          const available = references.filter(item => item.evidence.kind === "business_overview").map(item => item.ref);
          const state = await request.frames?.state();
          throw new Error(available.length
            ? `本轮可用概览引用为 ${available.join("、")}，请用这些 evidence_refs 重新提交报告，不能沿用上一轮编号。`
            : `本轮还未读取概览证据。先调用 read_business_result，frameId=${state?.focusFrameId ?? "请用 business_context_read 定位"}；按读取回执中的本轮 evidence_refs 再提交报告，不让用户重复条件。`);
        }
        const sources = selected.map(item => item!.evidence as OverviewEvidence);
        for (const source of sources) {
          const scope = await request.backend.resolveBusinessField("organization", source.org_codes, {signal: context.abortSignal});
          if (scope.status !== "resolved" || JSON.stringify((scope.value as {codes?: string[]})?.codes) !== JSON.stringify(source.org_codes)) throw new Error("报告机构权限已变化。");
          for (const task of source.tasks) await request.backend.getTask(task.task_id, {signal: context.abortSignal});
        }
        const editorial = reviewNarrativeDensity(request, rawInput.body, sources.flatMap(source => source.evidence_items));
        if (editorial) return editorial;
        let details;
        try { details = composeBusinessReport(sources, input); }
        catch (error) {
          // 只处理正文数字/表达问题；身份、跨范围证据、补查、未知行等硬错误仍拒绝。
          if (!isProseError(error)) throw error;
          details = composePartialBusinessReport(sources, input);
        }
        // 补查是用户目标的内部步骤；交付后焦点回到本轮初查，追问不继承最后一个分项。
        if (sources.length > 1 && request.frames && sources[0]?.frame_id) {
          const state = await request.frames.state();
          const root = await request.frames.get(sources[0].frame_id);
          const current = state.focusFrameId ? await request.frames.get(state.focusFrameId) : undefined;
          if (root?.turnId === request.operationId && current?.turnId === request.operationId
            && root.status === "success" && current.capability === "business_overview"
            && state.focusFrameId !== root.frameId) await request.frames.setFocus(root.frameId, state.version);
        }
        return {content: [{type: "text", text: details.public_answer}], details, terminate: true};
      } catch (error) {
        if (context.abortSignal?.aborted || error instanceof BackendApiError && [401, 403].includes(error.status)) throw error;
        return {content: [{type: "text", text: error instanceof Error ? error.message : "报告证据校验失败"}],
          details: {kind: "business_report", status: "ARGUMENT_ERROR", retryable: true}};
      }
    }};
}
