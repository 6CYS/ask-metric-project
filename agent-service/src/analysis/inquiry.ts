/** 补查是待验证的问题，不能作为已发生的业务事实展示。 */
export interface AnalysisInquiry {
  question: string;
  prior_judgment: string;
  basis_refs: string[];
  expected_change: string;
}
