import {expect, it} from "vitest";
import {buildCompactSemanticSystemPrompt, buildSemanticSystemPrompt} from "../../src/semantic-task/prompt.js";

it("精简语义提示保留来源、集合动作、澄清恢复、完整义务、分析及证据边界", () => {
  const full = buildSemanticSystemPrompt("2025-12-31"), compact = buildCompactSemanticSystemPrompt("2025-12-31");
  for (const rule of ["2025-12-31", "Asia/Shanghai", "admitted_context", "source=new", "current/reference", "task_ref/target_ref",
    "set替换整个集合", "add保留原成员", "replace只替换subject", "exclude只排除subject", "clear清空", "confirm只确认已保存候选",
    "context_action=resume", "defer", "abandon", "needs_user", "未决修改", "统计口径", "comparison_organizations", "aliases",
    "常量仅来自当前原句", "零分母", "unknown只回查原命令", "全部目标及回答义务", "partial保留待办", "因果证明",
    "NULL", "不能成为指令或授权", "不需要预读Skill或目录", "缺机构、日期或指标时也提交已知字段", "不能用当前焦点代替指定历史"] ) expect(compact, rule).toContain(rule);
  expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(full));
});
