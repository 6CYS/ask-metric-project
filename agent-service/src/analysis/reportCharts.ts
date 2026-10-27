import {Type} from "@earendil-works/pi-ai";
import {analysisEvidenceAliases} from "./verifiedFindings.js";
import type {BusinessPieChart} from "./overviewCharts.js";

export const reportChartSchema = Type.Object({
  type: Type.Union([Type.Literal("bar"), Type.Literal("line")]),
  evidence_refs: Type.Array(Type.String({minLength: 1}), {minItems: 2, maxItems: 24, uniqueItems: true,
    description: "图中每个点的真实数值原子引用。通用报告用e1.v1等，专项用personal.mom.difference等；不提交手写数值。柱图选择同日同单位同基期的可比数据，折线只选同机构同指标不同真实日期。"}),
}, {additionalProperties: false});

export interface ReportChartSelection {type: "bar" | "line"; evidence_refs: string[]}
export interface BusinessSeriesChart {
  type: "bar" | "line";
  title: string;
  dates: string[];
  unit: string;
  source_refs: string[];
  points: Array<{name: string; value: string; display: string}>;
}
export type BusinessReportChart = BusinessPieChart | BusinessSeriesChart;
type Source = {ref: string; evidence: object};
type Row = Record<string, unknown>;
type Point = {ref: string; name: string; metric: string; org: string; orgName: string; date: string;
  unit: string; value: string; display: string; period: string; group: string};
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown) => typeof value === "string" ? value : "";
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const numeric = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

export function prefersReportText(question: string): boolean {
  // 只识别独立的排他格式指令；表格与图表可以同时交付，不能跨分句推断禁图。
  return question.split(/[，,。.;；!?！？\n]/u).some(part =>
    /(?:只|仅)(?:要|用|看|需)?(?:文字|文本|表格|列表)$|(?:不要|不用|不需要|不)(?:画|绘制|生成|展示|显示)?图(?:表|形)?$/u.test(part.trim()));
}

/** 百分比只按回执明确的编码转换；十进制移位不引入浮点舍入。 */
function percentage(value: string, encoding: unknown): string | undefined {
  if (encoding === "percent") return value;
  if (encoding !== "ratio") return undefined;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (!match) return undefined;
  const digits = match[2]! + (match[3] ?? ""), position = match[2]!.length + Number(match[4] ?? 0) + 2;
  if (Math.abs(position) > 220) return undefined;
  return (match[1] + (position <= 0 ? `0.${"0".repeat(-position)}${digits}`
    : position >= digits.length ? digits + "0".repeat(position - digits.length)
    : `${digits.slice(0, position)}.${digits.slice(position)}`)).replace(/^([+-]?)0+(?=\d)/u, "$1");
}

function point(source: Row, atom: Row): Point | undefined {
  const overview = source.kind === "business_overview";
  const ref = text(atom.ref), parts = overview ? ref.split(".") : [];
  const descriptor = rows(source.metric_descriptors).find(item => item.code === atom.metric_code) ?? {};
  const hint = record(descriptor.analysis_hint);
  const orgs = Array.isArray(source.org_codes) ? source.org_codes : [];
  const org = text(atom.org_code) || (overview && orgs.length === 1 ? text(orgs[0]) : "");
  const orgName = text(atom.org_name) || (overview && orgs.length === 1 ? text(source.org_name) : "");
  const baseLabel = overview ? text(rows(source.evidence_items).find(item => item.ref === `${parts[0]}.current`)?.label) : "";
  const comparisonLabel = ({mom: "较上月", yoy: "较同期", ytd: "较年初"} as Record<string, string>)[parts[1] ?? ""];
  const name = baseLabel && comparisonLabel ? `${baseLabel}${comparisonLabel}${parts[2] === "rate" ? "增幅" : "增减额"}`
    : text(atom.metric_name) || text(atom.label) || text(descriptor.name);
  const metric = text(atom.metric_code) || (overview ? parts[0] ?? "" : "");
  const unit = text(atom.unit), raw = text(atom.value), date = text(atom.date), display = text(atom.display);
  const period = overview ? parts.slice(1).join(".") : JSON.stringify([
    atom.comparison ?? hint.comparison ?? descriptor.value_basis ?? "current",
    atom.comparison_role ?? hint.comparison_role ?? atom.name ?? "value",
  ]);
  const value = unit === "%" ? percentage(raw, atom.value_encoding ?? descriptor.value_encoding) : raw;
  if (!ref || !metric || !name || !org || !orgName || !datePattern.test(date) || !unit || !display
    || !value || value.length > 220 || !numeric.test(value) || !Number.isFinite(Number(value))) return undefined;
  return {ref, name, metric, org, orgName, date, unit, value, display, period,
    group: overview ? text(source.topic) : text(hint.topic)};
}

function candidates(sources: Source[]) {
  const byRef = new Map<string, Point | null | undefined>(), points: Array<Point | undefined> = [];
  const aliases = new Map<string, string>();
  for (const source of sources) {
    const evidence = record(source.evidence), atoms = rows(evidence.evidence_items);
    if (evidence.status !== "succeeded") return;
    const sourceAliases = evidence.kind === "analysis_evidence" ? analysisEvidenceAliases(source.ref,
      atoms.map(atom => ({ref: text(atom.ref), type: text(atom.type), judgment_kind: text(atom.judgment_kind)}))) : new Map<string, string>();
    for (const [alias, ref] of sourceAliases) aliases.set(alias, ref);
    for (const atom of atoms) {
      const numericAtom = evidence.kind === "analysis_evidence" ? ["fact", "calculation"].includes(text(atom.type))
        : evidence.kind === "business_overview" && /(?:\.current|\.(?:mom|yoy|ytd)\.(?:difference|rate))$/u.test(text(atom.ref));
      if (!numericAtom && atom.type !== "observation" && !text(atom.judgment_kind)) continue;
      // null只表示已存在的非数值依据；缺值或无效数值仍为undefined，不能静默略过。
      const value = numericAtom ? point(evidence, atom) : null, ref = text(atom.ref);
      const previous = byRef.get(ref);
      if (byRef.has(ref)) {
        const same = previous && value ? distinctPoints([previous, value])?.length === 1 : previous === value;
        if (!same) {byRef.set(ref, undefined); points.push(undefined);}
      } else {byRef.set(ref, value); if (value !== null) points.push(value);}
    }
  }
  // 所有来源读完后再绑定短引用，避免先前别名保留后来已发现冲突的值。
  for (const [alias, ref] of aliases) byRef.set(alias, byRef.get(ref));
  return {byRef, points};
}

const unique = (points: Point[], field: keyof Point) => new Set(points.map(item => item[field]));

/** 正文须涉及图中的指标与统计口径，但无需逐项复述图中各机构数值。 */
export function reportChartHasNarrativeEvidence(sources: Source[], selection: ReportChartSelection, narrativeRefs: readonly string[]): boolean {
  const available = candidates(sources);
  if (!available) return false;
  const selected = selection.evidence_refs.map(ref => available.byRef.get(ref));
  if (!selected.length || selected.some(item => !item)) return false;
  const narrative = narrativeRefs.map(ref => available.byRef.get(ref));
  const dates = new Set(selected.map(item => item?.date));
  return selected.every(item => item && narrative.some(context => context
    && item.metric === context.metric && item.unit === context.unit && item.period === context.period
    && (selection.type === "line" ? item.org === context.org && dates.has(context.date) : item.date === context.date)));
}

/** 同值重复只比较十进制文本，不将金额转为浮点数；输出仍保留首次引用的原值。 */
function decimalKey(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (!match) return value;
  const fraction = match[3] ?? "", digits = (match[2]! + fraction).replace(/^0+/u, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/u, "");
  const exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${match[1] === "-" ? "-" : ""}${significant}e${exponent}`;
}

function distinctPoints(points: Point[]): Point[] | undefined {
  const result = new Map<string, Point>();
  for (const item of points) {
    const key = JSON.stringify([item.metric, item.org, item.date, item.period, item.unit]), previous = result.get(key);
    if (previous && decimalKey(previous.value) !== decimalKey(item.value)) return;
    if (!previous) result.set(key, item);
  }
  return [...result.values()];
}

function seriesChart(values: Point[], selection?: ReportChartSelection): BusinessSeriesChart | undefined {
  if (values.length < 2 || values.length > 24
    || unique(values, "unit").size !== 1 || unique(values, "period").size !== 1) return;
  const first = values[0]!;
  const sameMetric = unique(values, "metric").size === 1, sameOrg = unique(values, "org").size === 1;
  const dates = [...unique(values, "date")].sort();
  const line = sameMetric && sameOrg && dates.length === values.length;
  const orgComparison = sameMetric && dates.length === 1 && unique(values, "org").size === values.length;
  if (!selection && !orgComparison && values.length < 3) return;
  // 多指标比较必须显式选点，并来自同一个已知主题；不因单位相同混画存量、变动和比率。
  const metricComparison = !!selection && sameOrg && dates.length === 1 && unique(values, "metric").size === values.length
    && !!first.group && unique(values, "group").size === 1;
  const type = selection?.type ?? (line ? "line" : "bar");
  if (type === "line" ? !line : !(orgComparison || metricComparison)) return;
  const ordered = type === "line" ? [...values].sort((left, right) => left.date.localeCompare(right.date)) : values;
  const chartPoints = ordered.map(item => ({name: type === "line" ? item.date : orgComparison ? item.orgName : item.name,
    value: item.value, display: item.display}));
  if (new Set(chartPoints.map(item => item.name)).size !== chartPoints.length) return;
  return {type, title: sameMetric ? first.name : "指标比较", dates, unit: first.unit,
    source_refs: ordered.map(item => item.ref), points: chartPoints};
}

/** 调用方先核验回执归属、权限与事实；此处只从这些回执选点，不接收模型数值。 */
export function buildReportChart(sources: Source[], selection?: ReportChartSelection, question = "", narrativeRefs?: readonly string[]):
  {charts: BusinessSeriesChart[]; notice?: string} {
  if (prefersReportText(question)) return {charts: []};
  const fail = () => ({charts: [], ...(selection ? {notice: "所选数据的机构、日期、单位或比较口径不一致，暂未绘制图表。"} : {})});
  const available = candidates(sources);
  if (!available) return fail();
  const {byRef, points} = available;
  const selected = selection ? selection.evidence_refs.map(ref => byRef.get(ref))
    : narrativeRefs !== undefined ? narrativeRefs.map(ref => byRef.get(ref)).filter(item => item !== null) : points;
  if (selection && new Set(selection.evidence_refs).size !== selection.evidence_refs.length || selected.some(item => !item)) return fail();
  const values = distinctPoints(selected as Point[]);
  if (!values) return fail();
  if (!selection && narrativeRefs !== undefined) {
    const groups = new Map<string, Point[]>();
    for (const item of values) {
      const key = JSON.stringify([item.metric, item.unit, item.period]), group = groups.get(key) ?? [];
      group.push(item); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const chart = seriesChart(group);
      if (chart) {
        if (chart.type === "bar") chart.title += "（文中机构）";
        return {charts: [chart]};
      }
    }
    return fail();
  }
  const chart = seriesChart(values, selection);
  if (chart) return {charts: [chart]};
  if (selection?.type === "bar" && values.length <= 24 && unique(values, "metric").size > 1
    && unique(values, "org").size > 1 && unique(values, "date").size === 1
    && unique(values, "unit").size === 1 && unique(values, "period").size === 1) {
    const groups = [...unique(values, "metric")].map(metric => seriesChart(values.filter(item => item.metric === metric), selection));
    // 只有每组本身可比时才提示重新选指标，不用单系列限制掩盖日期、单位或缺值问题。
    if (groups.every(group => group !== undefined)) {
      const choices = groups.slice(0, 3).map(group => group.title);
      return {charts: [], notice: `不同机构可以比较；当前同时选择了多个指标和多个机构，跨机构柱图每次只选一个指标。可选择：${choices.join("、")}。`};
    }
  }
  return fail();
}
