import { isCurrentAnalysisEvidence, type EvidenceReference } from "../answerEvidence.js";
import type { AnalysisEvidence } from "./tools.js";
import { expandFindingRefs, findingDependencies } from "./verifiedFindings.js";
import { BackendApiError } from "../backendClient.js";

type Source = EvidenceReference & { evidence: AnalysisEvidence };

/** 主查询保留目标覆盖；参考补查和历史只保留正文、图表及计算实际使用的运行。 */
export function selectReportSources<T extends Source>(
  available: T[],
  operationId: string,
  referenced: ReadonlySet<string> = new Set(),
) {
  const atoms = available.flatMap(({ evidence }) => evidence.evidence_items ?? []);
  const dependencies = findingDependencies(atoms);
  let selected: Set<string>;
  try {
    // 本轮计算原子另行提交；调用方已带入其父引用。历史判断仍须带齐跨运行父事实。
    selected = new Set(
      expandFindingRefs(
        [...referenced].filter((ref) => dependencies.has(ref)),
        dependencies,
      ),
    );
  } catch {
    throw new BackendApiError(
      422,
      "已选事实的来源链不完整，请核对真实来源。",
      "ANALYSIS_REPORT_REFERENCE",
    );
  }
  const currentRuns = new Set(
    available
      .filter(
        ({ evidence }) =>
          isCurrentAnalysisEvidence(evidence, operationId) &&
          evidence.inquiry_scope_role !== "reference",
      )
      .map(({ evidence }) => evidence.run_ref),
  );
  const sources = available.filter(
    ({ evidence }) =>
      currentRuns.has(evidence.run_ref) ||
      evidence.evidence_items?.some((atom) => selected.has(atom.ref)),
  );
  // 重读同一运行保留模型短引用，但后端只鉴权一次；本轮运行不能同时被标为历史。
  const runRefs = [...new Set(sources.map(({ evidence }) => evidence.run_ref))];
  return {
    sources,
    runRefs,
    contextRunRefs: runRefs.filter((ref) => !currentRuns.has(ref)),
  };
}
