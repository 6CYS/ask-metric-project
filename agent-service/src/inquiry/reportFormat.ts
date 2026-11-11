import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import { NarrativeReferenceError } from "../analysis/narrative.js";
import { currentTurnMessages } from "../tools/turnContract.js";

export const reportLayoutSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    sections: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 64 }),
          title: Type.String({ minLength: 1, maxLength: 100 }),
          metric_codes: Type.Array(Type.String({ minLength: 1, maxLength: 150 }), {
            maxItems: 100,
            uniqueItems: true,
          }),
          table: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 12 },
    ),
  },
  { additionalProperties: false },
);

export type ReportLayout = Static<typeof reportLayoutSchema>;
export interface SelectedReportPlan {
  id: string;
  version: string;
  text: string;
  report_layout: ReportLayout;
  org_codes: string[];
}

export const structuredReportSchema = Type.Object(
  {
    plan_id: Type.String({ minLength: 1, maxLength: 128 }),
    overview: Type.String({ maxLength: 2000 }),
    sections: Type.Array(
      Type.Object(
        {
          section_id: Type.String({ minLength: 1, maxLength: 64 }),
          text: Type.String({ maxLength: 1500 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 12 },
    ),
  },
  { additionalProperties: false },
);

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const cell = (value: string) => value.replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");

export function validReportLayout(value: unknown): value is ReportLayout {
  return (
    Check(reportLayoutSchema, value) &&
    new Set(value.sections.map((section) => section.id)).size === value.sections.length &&
    new Set(value.sections.flatMap((section) => section.metric_codes)).size <= 100
  );
}

/** 只接受本轮实际执行回执中的快照，知识召回和上轮方案不决定本轮格式。 */
export function selectedReportPlan(
  messages: AgentMessage[],
  planId?: string,
): SelectedReportPlan | undefined {
  for (const message of [...currentTurnMessages(messages)].reverse()) {
    if (message.role !== "toolResult" || message.isError || message.toolName !== "topic_query")
      continue;
    const execution = record(record(message.details).topic_execution),
      plan = record(execution.report_plan);
    if (
      execution.completed !== true ||
      !validReportLayout(plan.report_layout) ||
      !text(plan.id) ||
      !text(plan.version) ||
      !text(plan.text) ||
      !strings(plan.org_codes).length ||
      (planId !== undefined && plan.id !== planId)
    )
      continue;
    return {
      id: text(plan.id),
      version: text(plan.version),
      text: text(plan.text),
      report_layout: plan.report_layout,
      org_codes: strings(plan.org_codes),
    };
  }
  return;
}

type ReportSource = { evidence: object };
type Budget = { cells: number; characters: number };
const TABLE_LIMIT_NOTICE = "为便于阅读，本节仅展示部分数据，其余见数据明细。";

function tableBuilder(plan: SelectedReportPlan, sources: ReportSource[]) {
  const scoped = sources
    .map((source) => record(source.evidence))
    .filter(
      (source) =>
        source.kind === "analysis_evidence" &&
        source.status === "succeeded" &&
        source.inquiry_scope_role !== "reference",
    );
  const orgs = [...new Set(plan.org_codes)];
  const names = new Map<string, string>();
  const metrics = new Map<string, Row>();
  const facts = new Map<string, Array<{ atom: Row; metric: Row }>>();
  const datesByMetric = new Map<string, Set<string>>();
  for (const source of scoped) {
    const sourceNames = strings(source.org_names);
    strings(source.org_codes).forEach((code, index) => {
      const name = sourceNames[index];
      if (name && orgs.includes(code)) names.set(code, name);
    });
    const descriptors = new Map(
      rows(source.metric_descriptors).map((metric) => [text(metric.code), metric]),
    );
    for (const [code, metric] of descriptors) metrics.set(code, metric);
    for (const atom of rows(source.evidence_items)) {
      const code = text(atom.metric_code),
        org = text(atom.org_code),
        date = text(atom.date),
        metric = descriptors.get(code);
      if (atom.type !== "fact" || !orgs.includes(org) || !date || !text(atom.ref) || !metric)
        continue;
      if (text(atom.org_name)) names.set(org, text(atom.org_name));
      const dates = datesByMetric.get(code) ?? new Set<string>();
      dates.add(date);
      datesByMetric.set(code, dates);
      const key = JSON.stringify([code, date, org]);
      const entries = facts.get(key) ?? [];
      if (!entries.some((entry) => entry.atom.ref === atom.ref)) entries.push({ atom, metric });
      facts.set(key, entries);
    }
  }
  return (section: ReportLayout["sections"][number], budget: Budget): string => {
    if (!section.table || !section.metric_codes.length) return "";
    const header = `| 指标 | 统计日期 | ${orgs.map((org) => cell(names.get(org) ?? org)).join(" | ")} |\n| --- | --- | ${orgs.map(() => "---").join(" | ")} |`;
    const lines: string[] = [];
    let omitted = false,
      missing = false,
      usedCells = 0;
    // 留出缺口说明，避免预算截断表行或影响后续模型结论。
    let usedCharacters = header.length + TABLE_LIMIT_NOTICE.length + 100;
    for (const code of section.metric_codes) {
      const metric = metrics.get(code);
      const dates = [...(datesByMetric.get(code) ?? [])].sort().reverse();
      if (!metric || !dates.length) {
        missing = true;
        continue;
      }
      for (const date of dates) {
        let factCells = 0;
        const values = orgs.map((org) => {
          const entries = facts.get(JSON.stringify([code, date, org])) ?? [];
          if (!entries.length) return "未取得";
          const signatures = new Set(
            entries.map(({ atom, metric: descriptor }) =>
              JSON.stringify([
                atom.value,
                atom.unit ?? descriptor.unit,
                atom.value_encoding ?? descriptor.value_encoding,
              ]),
            ),
          );
          if (signatures.size > 1) return "来源待核对";
          const { atom, metric: descriptor } = entries[0]!;
          const unit = text(atom.unit) || text(descriptor.unit),
            encoding = atom.value_encoding ?? descriptor.value_encoding;
          if (!unit || (unit === "%" && !["ratio", "percent"].includes(text(encoding))))
            return "口径待确认";
          if (atom.value === null || atom.value === undefined || atom.value === "") return "未取得";
          factCells += 1;
          return `{{${text(atom.ref)}}}`;
        });
        const line = `| ${cell(text(metric.name) || code)} | ${cell(date)} | ${values.join(" | ")} |`;
        if (
          usedCells + factCells > budget.cells ||
          usedCharacters + line.length + 1 > budget.characters
        ) {
          omitted = true;
          continue;
        }
        usedCells += factCells;
        usedCharacters += line.length + 1;
        lines.push(line);
      }
    }
    const parts = lines.length ? [[header, ...lines].join("\n")] : [];
    if (omitted) parts.push(TABLE_LIMIT_NOTICE);
    if (missing)
      parts.push(
        lines.length
          ? "本节部分配置指标尚未取得，已展示实际可用数据。"
          : "本次尚未取得本节指标数据。",
      );
    budget.cells -= usedCells;
    const result = parts.join("\n\n");
    budget.characters = Math.max(0, budget.characters - result.length - 2);
    return result;
  };
}

/** 模板只组织正文和正式事实引用；数值、单位及来源仍由原报告接口统一核验。 */
export function compileReportBody(
  input: { body?: string; report?: unknown },
  plan: SelectedReportPlan | undefined,
  sources: ReportSource[],
  ended = true,
): string {
  if (input.report === undefined && !plan) return input.body ?? "";
  if (!plan)
    throw new NarrativeReferenceError("本轮尚未执行该报告方案，请使用本轮已执行方案或body回答。");
  const table = tableBuilder(plan, sources);
  const layout = plan.report_layout;
  const layoutOverhead =
    cell(layout.title).length +
    40 +
    layout.sections.reduce((size, section) => size + cell(section.title).length + 180, 0);
  if (input.report === undefined) {
    const original = input.body ?? "";
    if (!ended) return original;
    const budget = {
      cells: 200,
      characters: Math.max(0, 32000 - original.length - layoutOverhead),
    };
    const sections = plan.report_layout.sections.flatMap((section) => {
      const content = table(section, budget);
      return content ? [`## ${cell(section.title)}（数据对照）\n\n${content}`] : [];
    });
    return original + (sections.length ? "\n\n" + sections.join("\n\n") : "");
  }
  const report = record(input.report),
    items = rows(report.sections);
  if (report.plan_id !== plan.id || (ended && !Check(structuredReportSchema, report)))
    throw new NarrativeReferenceError(
      "报告须引用本轮已执行的plan_id，并使用overview与sections提交分析正文。",
    );
  const ids = items.map((item) => text(item.section_id));
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => id && !plan.report_layout.sections.some((section) => section.id === id))
  )
    throw new NarrativeReferenceError("报告章节须使用该方案中的唯一section_id。");
  // 固定预算让后续段落到达时不会挤掉已经流出的表格；正文有独立字段长度边界。
  const budget = {
    cells: 200,
    characters: Math.max(0, 32000 - 2000 - layout.sections.length * 1500 - layoutOverhead),
  };
  const parts = [`# ${cell(plan.report_layout.title)}`, "## 经营摘要", text(report.overview)];
  for (const section of plan.report_layout.sections) {
    const index = items.findIndex((item) => item.section_id === section.id);
    if (!ended && index < 0) break;
    const narrative = index < 0 ? "" : text(items[index]?.text);
    const stable = ended || index < items.length - 1;
    const evidence = stable ? table(section, budget) : "";
    parts.push(`## ${cell(section.title)}`);
    if (narrative) parts.push(narrative);
    if (evidence) parts.push(evidence);
    if (stable && !narrative && !evidence) parts.push("本次未形成该项分析。");
    if (!stable) break;
  }
  return parts.filter(Boolean).join("\n\n");
}
