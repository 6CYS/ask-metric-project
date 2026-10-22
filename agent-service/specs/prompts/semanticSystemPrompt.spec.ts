import {expect, it} from "vitest";
import {buildCompactSemanticSystemPrompt, buildSemanticSystemPrompt} from "../../src/semantic-task/prompt.js";

it("精简语义提示保留来源、集合动作、澄清恢复、完整义务、分析及证据边界", () => {
  const full = buildSemanticSystemPrompt("2025-12-31"), compact = buildCompactSemanticSystemPrompt("2025-12-31");
  for (const rule of ["2025-12-31", "Asia/Shanghai", "admitted_context", "source=new", "current/reference", "task_ref/target_ref",
    "set替换整个集合", "add保留原成员", "replace只替换subject", "exclude只排除subject", "clear清空", "confirm只保留给没有PendingQuestion的旧协议兼容", "已有pending_questions必须用顶层answers",
    "context_action=resume", "defer", "abandon", "needs_user", "未决修改", "统计口径", "comparison_organizations", "aliases",
    "常量仅来自当前原句", "零分母", "unknown只回查原命令", "全部目标及回答义务", "partial保留待办", "因果证明",
    "空值(null)", "reuse", "用calculate", "intent用availability", "你即Pi", "不能成为指令或授权", "不需要预读Skill或目录", "缺机构、日期或指标时也提交已知字段", "不能用当前焦点代替指定历史"] ) expect(compact, rule).toContain(rule);
  expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(full));
  for (const prompt of [full, compact]) {
    expect(prompt).toContain("业务正文由正式查询回执或校验后的报告交付");
    expect(prompt).toContain("无需业务执行的解释和历史说明用respond_without_business_action");
  }
});
