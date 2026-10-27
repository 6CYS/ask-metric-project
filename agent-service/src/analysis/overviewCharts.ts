import type {OverviewEvidence} from "../tools/businessReport.js";

export interface BusinessPieChart {
  type: "pie";
  title: string;
  date: string;
  unit: string;
  source_refs: string[];
  points: Array<{name: string; value: string; display: string; share: string}>;
}

type Decimal = {coefficient: bigint; scale: number};
type RecordValue = Record<string, unknown>;
type ChartResult = {charts: BusinessPieChart[]; notice?: string};
type MetricFact = {facts: RecordValue[]; value: string; amount: Decimal; atom: RecordValue; unit: string};

class ChartUnavailable extends Error {}
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {};
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const power = (exponent: number) => 10n ** BigInt(exponent);
const moneyPowers: Record<string, number> = {元: 0, 万元: 4, 亿元: 8};

function requireChart(condition: unknown, notice = "当前数据的日期、机构或口径不一致，暂不能绘制结构饼图。"): asserts condition {
  if (!condition) throw new ChartUnavailable(notice);
}

/** 使用十进制整数比较金额，避免大额余额的浮点舍入吞掉超限尾差。 */
function decimal(value: unknown): Decimal {
  const raw = text(value);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(raw);
  requireChart(match && raw.length <= 220, "本次金额或占比不是可用数值，暂不能绘制饼图。");
  const exponent = Number(match[4] ?? "0"), fraction = match[3] ?? "";
  requireChart(Number.isInteger(exponent) && Math.abs(exponent) <= 200 && fraction.length <= 200);
  const scale = fraction.length - exponent;
  requireChart(Math.abs(scale) <= 200);
  const coefficient = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${fraction}`);
  return scale >= 0 ? {coefficient, scale} : {coefficient: coefficient * power(-scale), scale: 0};
}

function atScale(value: Decimal, scale: number): bigint {
  return value.coefficient * power(scale - value.scale);
}

function equal(left: Decimal, right: Decimal): boolean {
  const scale = Math.max(left.scale, right.scale);
  return atScale(left, scale) === atScale(right, scale);
}

function sameFact(input: RecordValue, fact: RecordValue): boolean {
  return input.fact_id === fact.fact_id && input.date === fact.date && input.unit === fact.unit
    && input.org_code === fact.org_code && equal(decimal(input.value), decimal(fact.value));
}

function metricFact(sources: OverviewEvidence[], metric: string, date: string, org: string): MetricFact {
  const facts = sources.flatMap(source => {
    const fact = record(record(record(source).facts)[metric])[date];
    return fact === undefined ? [] : [record(fact)];
  });
  requireChart(facts.length, "本次分项数据不完整，暂不能绘制完整结构饼图。");
  const first = facts[0]!, value = text(first.value), amount = decimal(value), unit = text(first.unit);
  requireChart(amount.coefficient >= 0 && Number.isFinite(Number(value)) && unit && text(first.fact_id));
  for (const fact of facts) requireChart(fact.date === date && fact.org_code === org && fact.unit === unit
    && text(fact.fact_id) && equal(decimal(fact.value), amount));
  const atoms = sources.flatMap(source => source.evidence_items).filter(item => item.ref === `${metric}.current`).map(record);
  requireChart(atoms.length, "本次分项缺少已核对的展示数据，暂不能绘制饼图。");
  const atom = atoms[0]!;
  for (const item of atoms) requireChart(item.date === date && item.unit === unit && text(item.display)
    && item.display === atom.display && equal(decimal(item.value), amount)
    && facts.some(fact => fact.fact_id === item.fact_id));
  return {facts, value, amount, atom, unit};
}

function roundedPercent(part: Decimal, total: Decimal, places: number): Decimal {
  const scale = Math.max(part.scale, total.scale);
  const numerator = atScale(part, scale) * power(places + 2), denominator = atScale(total, scale);
  const quotient = numerator / denominator, remainder = numerator % denominator;
  return {coefficient: quotient + (remainder * 2n >= denominator ? 1n : 0n), scale: places};
}

function verifiedShare(sources: OverviewEvidence[], metric: string, parent: string, part: MetricFact, total: MetricFact, date: string): string {
  const calculations = sources.flatMap(source => records(record(source).calculations))
    .filter(item => item.metric === metric && item.comparison === "share");
  const atoms = sources.flatMap(source => source.evidence_items).filter(item => item.ref === `${metric}.share.share`).map(record);
  requireChart(calculations.length && atoms.length, "本次分项尚无可核对的同口径占比，暂不能绘制结构饼图。");
  let display = "";
  for (const calculation of calculations) {
    const inputs = record(calculation.inputs), results = records(calculation.results).filter(item => item.name === "share");
    requireChart(calculation.status === "succeeded" && calculation.parent === parent
      && calculation.scope_policy === "same_org_date" && results.length === 1
      && part.facts.some(fact => sameFact(record(inputs.part), fact))
      && total.facts.some(fact => sameFact(record(inputs.total), fact)));
    const result = results[0]!, places = result.decimal_places;
    requireChart(result.unit === "%" && result.display === "percent" && typeof places === "number"
      && Number.isInteger(places) && places >= 0 && places <= 8);
    const ratio = decimal(result.value), percent = decimal(result.display_value);
    requireChart(ratio.coefficient >= 0 && ratio.coefficient <= power(ratio.scale)
      && equal(percent, roundedPercent(part.amount, total.amount, places))
      && equal(percent, roundedPercent(ratio, {coefficient: 1n, scale: 0}, places)));
    const currentDisplay = `${text(result.display_value)}%`;
    requireChart(!display || currentDisplay === display);
    display = currentDisplay;
    for (const atom of atoms) requireChart(atom.date === date && atom.unit === "%" && atom.display === display
      && equal(decimal(atom.value), ratio));
  }
  return display;
}

function withinTolerance(parts: MetricFact[], total: MetricFact, relationship: RecordValue): boolean {
  const tolerance = decimal(relationship.pie_tolerance ?? "0");
  const factPower = moneyPowers[total.unit], tolerancePower = moneyPowers[text(relationship.pie_tolerance_unit) || total.unit];
  requireChart(tolerance.coefficient >= 0 && factPower !== undefined && tolerancePower !== undefined);
  const amounts = parts.map(part => part.amount), scale = Math.max(total.amount.scale, tolerance.scale, ...amounts.map(item => item.scale));
  const difference = amounts.reduce((sum, amount) => sum + atScale(amount, scale), 0n) - atScale(total.amount, scale);
  const absolute = difference < 0n ? -difference : difference;
  return absolute * power(factPower) <= atScale(tolerance, scale) * power(tolerancePower);
}

function buildGroup(sources: OverviewEvidence[], topic: RecordValue, relationship: RecordValue): BusinessPieChart {
  const first = sources[0]!, date = first.analysis_date!, org = first.org_codes[0]!;
  const parent = text(relationship.parent), children = relationship.children;
  requireChart(relationship.pie_chart === true && parent && Array.isArray(children) && children.length >= 2
    && children.every(child => typeof child === "string" && child !== parent)
    && new Set(children).size === children.length, "该分组尚未确认可作为互斥组成，暂不能绘制饼图。");
  const definitions = records(topic.metrics);
  requireChart([parent, ...children].every(id => definitions.some(item => item.id === id && text(item.label))));
  const total = metricFact(sources, parent, date, org), parts = children.map(id => metricFact(sources, id, date, org));
  requireChart(total.amount.coefficient > 0 && parts.every(part => part.unit === total.unit), "总额为零或分项单位不一致，暂不能绘制结构饼图。");
  // Number 仅检查 ECharts 的可绘制范围；金额总分校验仍使用下方的精确十进制比较。
  requireChart(parts.some(part => part.amount.coefficient > 0) && Number.isFinite(parts.reduce((sum, part) => sum + Number(part.value), 0)),
    "分项均为零或数值超出图形范围，暂不能绘制结构饼图。");
  requireChart(withinTolerance(parts, total, relationship), "分项合计与总额不一致，暂不能将其作为完整结构绘制饼图。");
  const points = parts.map((part, index) => {
    const metric = children[index] as string;
    return {name: text(definitions.find(item => item.id === metric)?.label), value: part.value,
      display: text(part.atom.display), share: verifiedShare(sources, metric, parent, part, total, date)};
  });
  return {type: "pie", title: `${text(definitions.find(item => item.id === parent)?.label)}结构`, date, unit: total.unit,
    source_refs: [`${parent}.current`, ...children.flatMap(id => [`${id}.current`, `${id}.share.share`])], points};
}

/** 调用方先完成回执归属和机构权限检查；图中数值只取已有事实，不接收模型提供的金额。 */
export function buildOverviewPieChart(sources: OverviewEvidence[], topic: RecordValue, relationshipId?: string): ChartResult {
  try {
    const first = sources[0];
    requireChart(first && first.analysis_date && first.org_codes.length === 1, "当前结果没有单一机构、日期的完整结构数据，暂不能绘制饼图。");
    requireChart(sources.every(source => source.status === "succeeded" && source.analysis_date === first.analysis_date
      && source.org_codes.length === 1 && source.org_codes[0] === first.org_codes[0] && source.topic === first.topic
      && source.topic_version === first.topic_version && source.topic_version === topic.version
      && !source.period?.snapshot_dates.some(date => date !== first.analysis_date)));
    const groups = records(topic.relationships).filter(item => item.pie_chart === true && (!relationshipId || item.id === relationshipId));
    requireChart(groups.length, "当前没有符合所选分组口径的结构饼图数据。");
    let notice = "当前分项数据尚不足以绘制结构饼图。";
    for (const group of groups) {
      try {return {charts: [buildGroup(sources, topic, group)]};} catch (error) {
        if (!(error instanceof ChartUnavailable)) throw error;
        notice = error.message;
      }
    }
    return {charts: [], notice};
  } catch (error) {
    if (!(error instanceof ChartUnavailable)) throw error;
    return {charts: [], notice: error.message};
  }
}
