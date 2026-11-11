import type { BusinessReportChart } from "./reportCharts.js";

interface ChartPlacement {
  after_paragraph: number;
  section_index?: number;
}

type PositionedChart = BusinessReportChart & { placement?: ChartPlacement };
type Row = Record<string, unknown>;
type Anchor = { placement: ChartPlacement; refs: Set<string>; group: string };
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const refs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item)
    : [];
const paragraphs = (value: unknown): string[] =>
  typeof value === "string" ? value.split(/\n\s*\n/u).filter((part) => part.trim()) : [];

/** 标题仅用于分散自动配图，不据标题文字判断业务主题。 */
function headingGroups(parts: string[]): string[] {
  let group = "opening";
  let fence: { marker: string; length: number } | undefined;
  return parts.map((part, index) => {
    for (const line of part.split("\n")) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (delimiter) {
        const marker = delimiter[1]!;
        if (!fence) fence = { marker: marker[0]!, length: marker.length };
        else if (
          marker[0] === fence.marker &&
          marker.length >= fence.length &&
          !delimiter[2]?.trim()
        )
          fence = undefined;
        continue;
      }
      if (!fence && /^ {0,3}#{1,6}(?:[ \t]+|$)/u.test(line)) group = `heading-${index}`;
    }
    return group;
  });
}

function evidenceAnchors(report: Row): Anchor[] {
  const parts = paragraphs(report.summary);
  const groups = headingGroups(parts);
  const anchors: Anchor[] = rows(report.body_evidence).flatMap((item) => {
    const paragraph = item.paragraph;
    if (
      typeof paragraph !== "number" ||
      !Number.isInteger(paragraph) ||
      paragraph < 1 ||
      paragraph > parts.length
    )
      return [];
    return [
      {
        placement: { after_paragraph: paragraph },
        refs: new Set(refs(item.evidence_refs)),
        group: `summary:${groups[paragraph - 1]}`,
      },
    ];
  });
  rows(report.sections).forEach((section, sectionIndex) => {
    const count = paragraphs(section.text).length;
    if (count)
      anchors.push({
        placement: { section_index: sectionIndex, after_paragraph: count },
        refs: new Set(refs(section.evidence_refs)),
        group: `section:${sectionIndex}`,
      });
  });
  return anchors;
}

/** 位置只取最终核验正文的证据交集；没有可靠位置的图继续在文末显示。 */
export function layoutReportCharts(
  charts: BusinessReportChart[],
  reportValue: unknown,
  automatic = false,
): PositionedChart[] {
  const anchors = evidenceAnchors(record(reportValue));
  const seen = new Set<string>();
  const located = charts.flatMap((chart) => {
    const key = JSON.stringify([chart.type, [...chart.source_refs].sort()]);
    if (seen.has(key)) return [];
    seen.add(key);
    let best: Anchor | undefined;
    let score = 0;
    for (const anchor of anchors) {
      const overlap = chart.source_refs.filter((ref) => anchor.refs.has(ref)).length;
      if (overlap > score) {
        best = anchor;
        score = overlap;
      }
    }
    return [
      {
        chart: { ...chart, ...(best ? { placement: best.placement } : {}) },
        group: best?.group ?? "unplaced",
      },
    ];
  });
  if (!automatic) return located.map(({ chart }) => chart);
  // 默认简报先覆盖不同章节，再补充同章比较；显式选图不受默认简报数量限制。
  const selected = new Set<number>();
  const groups = new Set<string>();
  for (let index = 0; index < located.length && selected.size < 4; index++) {
    const group = located[index]!.group;
    if (!groups.has(group)) {
      groups.add(group);
      selected.add(index);
    }
  }
  for (let index = 0; index < located.length && selected.size < 4; index++) selected.add(index);
  return located.filter((_, index) => selected.has(index)).map(({ chart }) => chart);
}
