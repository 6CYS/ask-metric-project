import { analysisEvidenceAliases } from "../../analysis/verifiedFindings.js";
import { inquiryEvidenceView } from "../view.js";
import { changeDirection, compareDecimal } from "./decimal.js";
import type { TopicDefinition, TopicRegistry } from "./registry.js";

type Row = Record<string, unknown>;
export const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
export const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
export const string = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** 先计算全范围事实，再筛选展示行。完整证据及别名从不截断或重新编号。 */
export function topicEvidenceView(
  source: Row,
  evidenceRef: string,
  topic: TopicDefinition,
  registry: TopicRegistry,
): Row {
  const view = record(inquiryEvidenceView(source, evidenceRef)),
    tables = records(view.tables);
  const atoms = records(source.evidence_items);
  const aliases = analysisEvidenceAliases(
    evidenceRef,
    atoms.map((atom) => ({
      ref: string(atom.ref),
      type: string(atom.type),
      judgment_kind: string(atom.judgment_kind),
      topic_alias: string(atom.topic_alias),
    })),
  );
  const atomsByRef = new Map(atoms.map((atom) => [string(atom.ref), atom]));
  const values = new Map(
    [...aliases].map(([alias, ref]) => [alias, string(atomsByRef.get(ref)?.value)]),
  );
  const numericRows = (table: Row): string[][] =>
    Array.isArray(table.rows)
      ? table.rows.filter(
          (row): row is string[] =>
            Array.isArray(row) &&
            row.length >= 3 &&
            row.every((value) => typeof value === "string") &&
            values.has(row[0]!),
        )
      : [];
  const metrics = new Map(Object.values(registry.metrics).map((metric) => [metric.code, metric]));
  const queriedOrgs = strings(source.org_codes),
    focus = new Set<string>();
  const large = queriedOrgs.length > registry.limits.max_focus_orgs;
  const rankings: Row[] = [],
    distribution: Row[] = [];
  const rankCodes = new Set(topic.rank_keys.map((key) => registry.metrics[key]!.code));
  for (const table of tables) {
    const rows = numericRows(table),
      metric = metrics.get(string(table.metric_code));
    if (!metric) continue;
    distribution.push({
      metric_code: metric.code,
      date: table.date,
      valid_orgs: new Set(rows.map((row) => row[1])).size,
      negative_orgs: rows.filter((row) => compareDecimal(values.get(row[0]!)!, "0") < 0).length,
      coverage: "仅本表同日有效值；不是评价阈值或总体经营评分",
    });
    if (!large || !rankCodes.has(metric.code)) continue;
    const ordered = [...rows].sort(
      (a, b) =>
        compareDecimal(values.get(a[0]!)!, values.get(b[0]!)!) || a[1]!.localeCompare(b[1]!),
    );
    const entries = ordered.slice(0, registry.limits.rank_n).map((row) => {
      focus.add(row[1]!);
      const finding = records(view.findings).find(
        (f) => f.metric_code === metric.code && f.org_code === row[1] && f.date === table.date,
      );
      return {
        org_code: row[1],
        value_ref: row[0],
        ...(finding ? { rank_ref: finding.ref, rank: finding.rank } : {}),
      };
    });
    rankings.push({
      metric_code: metric.code,
      metric_name: metric.name,
      date: table.date,
      position: "bottom",
      entries,
    });
  }
  if (!large) queriedOrgs.forEach((code) => focus.add(code));
  // 无可用排名值时也保留少量可用事实；缺数不能被伪装成空机构范围。
  if (large && !focus.size)
    for (const table of tables)
      numericRows(table)
        .slice(0, registry.limits.rank_n)
        .forEach((row) => focus.add(row[1]!));
  const globalPatterns: Row[] = [];
  const revenue = registry.metrics.revenue_yoy,
    expense = registry.metrics.management_expense_yoy;
  if (revenue && expense)
    for (const table of tables.filter((table) => table.metric_code === revenue.code)) {
      const cost = tables.find(
        (item) =>
          item.metric_code === expense.code && item.date === table.date && item.unit === table.unit,
      );
      if (!cost) continue;
      const costs = new Map(numericRows(cost).map((row) => [row[1], row]));
      const covered = numericRows(table).filter((row) => costs.has(row[1]));
      const matched = covered.filter(
        (row) =>
          compareDecimal(values.get(row[0]!)!, "0") < 0 &&
          compareDecimal(values.get(costs.get(row[1])![0]!)!, "0") > 0,
      );
      globalPatterns.push({
        condition: "同日营业收入同比减少且管理费同比增加",
        date: table.date,
        covered_orgs: covered.length,
        matching_orgs: matched.length,
        complete_scope: covered.length === queriedOrgs.length,
        boundary:
          "程序遍历完整查询范围；不能从展示的少数机构推断唯一性或已证明的根因。统计数量是取数摘要，正文精确数值仍使用正式事实引用。",
      });
    }
  const projectedTables = tables
    .map((table): Row & { rows: string[][] } => {
      const change = metrics.get(string(table.metric_code))?.change !== "value";
      return {
        ...table,
        columns: change ? [...strings(table.columns), "change_direction"] : table.columns,
        rows: numericRows(table)
          .filter((row) => focus.has(row[1]!))
          .map((row) =>
            change
              ? [
                  ...row,
                  { decrease: "减少", increase: "增加", unchanged: "不变" }[
                    changeDirection(values.get(row[0]!)!)
                  ],
                ]
              : row,
          ),
      };
    })
    .filter((table) => table.rows.length);
  const rankingRefs = new Set(
    rankings.flatMap((group) => records(group.entries).map((entry) => string(entry.rank_ref))),
  );
  const findings = records(view.findings).filter((f) => !large || rankingRefs.has(string(f.ref)));
  const compact = Object.fromEntries(
    Object.entries(view).filter(([key]) => !["plan", "followup_metrics"].includes(key)),
  );
  const profiles = [...focus].map((code) => {
    const periods = new Map<string, Row>();
    for (const table of projectedTables) {
      const metric = metrics.get(string(table.metric_code));
      if (!metric) continue;
      const date = string(table.date),
        facts = periods.get(date) ?? {};
      for (const row of table.rows.filter((row) => row[1] === code)) {
        const direction = row[3];
        facts[metric.key] = {
          ref: row[0],
          value: row[2],
          ...(direction
            ? {
                direction,
                expression: `${metric.change === "mom_amount" ? "较上月" : "较同期"}变化为{{${row[0]}}}（${direction}）`,
              }
            : {}),
        };
      }
      if (Object.keys(facts).length) periods.set(date, facts);
    }
    return {
      org_code: code,
      org_name: record(view.organizations)[code],
      periods: [...periods].map(([date, facts]) => ({ date, facts })),
    };
  });
  // 已绑定、同日、同单位的大小关系交给程序；不推导费用率、贡献或因果。
  const comparisons: Row[] = [];
  const compare = (
    left: string[],
    right: string[],
    leftKey: string,
    rightKey: string,
    date: unknown,
  ) => {
    const a = registry.metrics[leftKey]!,
      b = registry.metrics[rightKey]!;
    // 空单位不证明跨指标可比；同指标跨机构比较仍保留。
    if (leftKey !== rightKey && (!projectedTables.some(table => table.metric_code === a.code
      && table.date === date && string(table.unit)) || !projectedTables.some(table => table.metric_code === b.code
      && table.date === date && string(table.unit)))) return;
    const order = compareDecimal(values.get(left[0]!)!, values.get(right[0]!)!);
    const relation = order < 0 ? "小于" : order > 0 ? "大于" : "等于";
    const absolute =
      a.change !== "value"
        ? compareDecimal(
            values.get(left[0]!)!.replace(/^[+-]/u, ""),
            values.get(right[0]!)!.replace(/^[+-]/u, ""),
          )
        : undefined;
    comparisons.push({
      date,
      left: { org_code: left[1], metric_key: leftKey, ref: left[0] },
      right: { org_code: right[1], metric_key: rightKey, ref: right[0] },
      relation,
      ...(absolute !== undefined
        ? { absolute_change_relation: absolute < 0 ? "小于" : absolute > 0 ? "大于" : "等于" }
        : {}),
      expression: `${left[1]}的${a.name}{{${left[0]}}}${relation}${right[1]}的${b.name}{{${right[0]}}}`,
      boundary: "仅同日同单位数值关系；绝对变化额不是变化比例，不证明效率或贡献。",
    });
  };
  if (queriedOrgs.length === 2)
    for (const table of projectedTables) {
      const rows = table.rows,
        key = metrics.get(string(table.metric_code))?.key;
      if (key && rows.length === 2 && rows[0]![1] !== rows[1]![1])
        compare(rows[0]!, rows[1]!, key, key, table.date);
    }
  for (const [leftKey, rightKey] of topic.compare_pairs ?? []) {
    const leftCode = registry.metrics[leftKey]!.code,
      rightCode = registry.metrics[rightKey]!.code;
    for (const table of projectedTables.filter((table) => table.metric_code === leftCode)) {
      const right = projectedTables.find(
        (other) =>
          other.metric_code === rightCode &&
          other.date === table.date &&
          other.unit === table.unit &&
          other.value_encoding === table.value_encoding &&
          other.basis === table.basis,
      );
      if (!right) continue;
      for (const row of table.rows) {
        const other = right.rows.find((other) => other[1] === row[1]);
        if (other) compare(row, other, leftKey, rightKey, table.date);
      }
    }
  }
  return {
    ...compact,
    // 固定机构、日期后再列同名事实，避免模型跨表错配机构或把别的费用当成管理费。
    tables: [],
    metric_dictionary: Object.fromEntries(
      projectedTables.map((table) => [
        metrics.get(string(table.metric_code))!.key,
        {
          code: table.metric_code,
          name: table.metric_name,
          unit: table.unit,
          basis: table.basis,
          value_encoding: table.value_encoding,
        },
      ]),
    ),
    profiles,
    comparisons: comparisons.slice(0, 48),
    comparison_coverage: {
      available: comparisons.length,
      displayed: Math.min(48, comparisons.length),
    },
    findings: findings.map((finding) =>
      Object.fromEntries(Object.entries(finding).filter(([key]) => key !== "display")),
    ),
    organizations: Object.fromEntries(
      Object.entries(record(view.organizations)).filter(([code]) => focus.has(code)),
    ),
    topic: {
      id: topic.id,
      version: registry.version,
      status: registry.status,
      notice: registry.notice,
    },
    projection: {
      queried_orgs: queriedOrgs.length,
      displayed_orgs: focus.size,
      omitted_orgs: queriedOrgs.length - focus.size,
      full_source_available: true,
      notice:
        "先统计完整范围，再选择规模与下降额排名靠后的机构展示；未展示不表示无异常。仅省略明细可用analysis_read的focus指定机构编码和指标编码分页回读；已展示profiles直接引用，无focus读取不会得到新表体。",
    },
    rankings,
    distribution,
    global_patterns: globalPatterns,
    interpretation:
      "change_direction是程序用原始十进制值确认的方向，解释须沿用该方向。变化额引用保留正负号，宜写‘同比变化为{{ref}}’，不要写成‘增加负数’或‘减少负数’。同比/环比金额不是增幅或下降比例，本主题按金额变化排序。当前值与变化额属于不同正式指标，不可交给analysis_calculate反推同比增速；本题无需增速也可回答，不为表达重算、反复尝试或重复取数。不同日期不得合并归因，规模小不等于经营差；收入、费用或减值的并列变化只能作为解释线索，不能称已证明的唯一或主要原因。",
  };
}
