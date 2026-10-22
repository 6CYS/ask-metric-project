import {expect, it} from "vitest";
import {semanticFeedback, semanticPublicAnswer, type SemanticFeedback} from "../../src/semantic-task/feedback.js";

function failed(): SemanticFeedback {
  const feedback = semanticFeedback(undefined, "failed", [
    {code: "TIME_EXPRESSION_UNSUPPORTED", field: "time", category: "calendar", remediation: "stop", message: "内部详细诊断"},
    {code: "SEMANTIC_NO_PROGRESS", category: "semantic", remediation: "stop", message: "重复提议"},
  ]);
  feedback.state.targets = [{target_ref: "isolated", status: "blocked", pending: [],
    conditions: [{field: "organizations", display: "合成机构甲", origin: "user_explicit"}]}];
  return feedback;
}
it("失败反馈说明已识别范围与具体障碍，不再只投影空的失败状态", () => {
  const answer = semanticPublicAnswer(failed())!;
  expect(answer).toContain("合成机构甲");
  expect(answer).toContain("时间条件");
  expect(answer).not.toMatch(/内部详细诊断|SEMANTIC|重复提议|没能完成这次查询/);
});
it("已有正式成功回执的公开结果在后续失败时仍可展示", () => {
  const feedback = failed();
  feedback.state.evidence = {kind: "semantic_results", results: [{status: "succeeded", public_answer: "隔离测试：已取得指标结果。"}]};
  expect(semanticPublicAnswer(feedback)).toContain("已取得指标结果");
});
it("权限失效时不展示范围和已取得数据，内部连接信息不外泄", () => {
  const feedback = failed();
  feedback.issues.push({code: "PERMISSION_DENIED", category: "permission", remediation: "stop", message: "secret connection"});
  feedback.state.evidence = {status: "succeeded", public_answer: "不可展示的旧值"};
  expect(semanticPublicAnswer(feedback)).toContain("无权");
  expect(semanticPublicAnswer(feedback)).not.toMatch(/合成机构甲|旧值|secret/);
});

it("大量机构的失败说明只概括家数，完整成员仍留在结构化条件", () => {
  const feedback = failed();
  const names = Array.from({length: 60}, (_, index) => `合成机构${index + 1}`).join("、");
  feedback.state.targets[0]!.conditions[0]!.display = names;
  const answer = semanticPublicAnswer(feedback)!;
  expect(answer).toContain("60家机构");
  expect(answer).not.toContain("合成机构1");
  expect(feedback.state.targets[0]!.conditions[0]!.display).toBe(names);
});
