import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { QueryDate } from "../src/inquiry/sourceConditions.js";
import type { DateModelValue } from "../src/business-context/types.js";
import {
  inquiryTargetCoverage,
  resolveInquiryTarget,
  readInquiryTargetSnapshot,
  type InquiryTargetSnapshot,
} from "../src/inquiry/target.js";

const baseline: InquiryTargetSnapshot = {
  version: 1,
  ref: "target:previous",
  operationId: "previous",
  sourceQuestion: "机构甲的存款余额",
  topic: "存款余额",
  organizations: { codes: ["A"], names: ["机构甲"] },
  time: { date_selection: "exact", start: "2026-08-27", end: "2026-08-27" },
};
function fixture(prior = baseline) {
  const resolveOrganizations = vi.fn((scope: string, names?: string[]) =>
    Promise.resolve({
      codes: names ?? ["A", "B"],
      names: names ?? ["机构甲", "机构乙"],
      ...(scope === "all_banks"
        ? {
            scope: {
              kind: "authorized_cohort" as const,
              cohort: "rural_commercial_banks" as const,
            },
          }
        : {}),
    }),
  );
  const resolveTime = vi.fn<(value: string, calendar?: DateModelValue) => Promise<QueryDate>>((value: string) =>
    Promise.resolve({
      date_selection: "exact",
      start: value,
      end: value,
    }),
  );
  const context = {
    baseline: prior,
    operationId: "current",
    sourceQuestion: "追问",
    resolveOrganizations,
    resolveTime,
  };
  return { context, resolveOrganizations, resolveTime };
}

describe("普通问数目标变更", () => {
  it("新期间契约保留原表达并允许区间内最新，继承时不重新解释", async () => {
    const { context, resolveTime } = fixture();
    const calendar = { start: "2026-01-01", end: "2026-06-30" };
    resolveTime.mockResolvedValue({ date_selection: "available_in_range", ...calendar });
    const time = { expression: "上半年", calendar };
    const next = await resolveInquiryTarget({
      mode: "new", topic: "存款余额", time, selection: "latest_in_range",
      organizations: { mode: "replace", scope: "named", names: ["A"] },
    }, { ...context, timeContract: 2 });
    expect(next.time).toEqual({ date_selection: "latest_in_range", ...calendar });
    expect(readInquiryTargetSnapshot(next)?.time_request).toEqual(time);
    const continued = await resolveInquiryTarget({ mode: "continue", base_ref: next.ref },
      { ...context, baseline: next, timeContract: 2 });
    expect(continued.time).toEqual(next.time);
    expect(continued.time_request).toEqual(time);
  });
  it("新契约未指定期间时须显式声明空期间与最新策略", async () => {
    const { context, resolveTime } = fixture();
    resolveTime.mockResolvedValue({ date_selection: "latest_snapshot", anchor_date: "2026-11-04" });
    const next = await resolveInquiryTarget({
      mode: "new", topic: "存款余额", time: null, selection: "latest",
      organizations: { mode: "replace", scope: "named", names: ["A"] },
    }, { ...context, timeContract: 2 });
    expect(next.time).toEqual({ date_selection: "latest_snapshot", anchor_date: "2026-11-04" });
    expect(readInquiryTargetSnapshot(next)?.time_request).toBeNull();
  });
  it("明确期间不能被全局最新策略覆盖", async () => {
    const { context, resolveTime } = fixture();
    resolveTime.mockResolvedValue({ date_selection: "available_in_range", start: "2026-01-01", end: "2026-06-30" });
    await expect(resolveInquiryTarget({
      mode: "update", base_ref: baseline.ref, time: { expression: "上半年" }, selection: "latest",
    }, { ...context, timeContract: 2 })).rejects.toMatchObject({
      code: "INQUIRY_TARGET_INVALID", validationStage: "target_time_selection",
    });
  });
  it.each([
    { strategy: "exact" as const, dates: undefined },
    { strategy: "latest_in_range" as const, dates: ["2026-01-01", "2026-06-30"] },
    { strategy: "all_in_range" as const, dates: ["2026-01-01", "2026-06-30"] },
  ])("取数策略不能把连续期间变成单日或扩张离散日期：$strategy", async ({ strategy, dates }) => {
    const { context, resolveTime } = fixture();
    resolveTime.mockResolvedValue({ date_selection: dates ? "exact" : "available_in_range",
      start: "2026-01-01", end: "2026-06-30", ...(dates ? { dates } : {}) });
    await expect(resolveInquiryTarget({ mode: "update", base_ref: baseline.ref,
      time: { expression: dates ? "2026-01-01和2026-06-30" : "上半年" }, selection: strategy,
    }, { ...context, timeContract: 2 })).rejects.toMatchObject({
      code: "INQUIRY_TARGET_INVALID", validationStage: "target_time_selection",
    });
  });
  it("新契约拒绝旧日期入口，旧冻结请求仍兼容", async () => {
    const change = { mode: "update" as const, base_ref: baseline.ref, date: "2026-06-30" };
    await expect(resolveInquiryTarget(change, { ...fixture().context, timeContract: 2 }))
      .rejects.toMatchObject({ code: "INQUIRY_TARGET_INVALID", validationStage: "target_time_contract" });
    expect((await resolveInquiryTarget(change, fixture().context)).time.start).toBe("2026-06-30");
  });
  it("新旧期间字段不能同时提交；空期间不能无策略执行", async () => {
    for (const fields of [
      { time: { expression: "六月" }, date: "2026-06-30" },
      { time: null },
    ]) await expect(resolveInquiryTarget({ mode: "update", base_ref: baseline.ref, ...fields },
      { ...fixture().context, timeContract: 2 })).rejects.toMatchObject({ code: "INQUIRY_TARGET_INVALID" });
  });
  it("日期换算仅随显式期间变更解析，后续继承实际规范期间", async () => {
    const { context, resolveTime } = fixture();
    const calendar = { start: "2026-01-01", end: "2026-10-31" };
    resolveTime.mockImplementation((value: string, converted?: DateModelValue) =>
      Promise.resolve({
        date_selection: "available_in_range",
        start: converted?.start ?? value,
        end: converted?.end ?? value,
      }),
    );
    const next = await resolveInquiryTarget(
      { mode: "update", base_ref: baseline.ref, date: "今年以来", date_calendar: calendar },
      context,
    );
    expect(next.time).toEqual({ date_selection: "available_in_range", ...calendar });
    const continued = await resolveInquiryTarget(
      { mode: "continue", base_ref: next.ref },
      { ...context, baseline: next },
    );
    expect(continued.time).toEqual(next.time);
    expect(baseline.time.start).toBe("2026-08-27");
  });
  it("没有日期原表达的换算不能替代沿用或修改目标", async () => {
    await expect(
      resolveInquiryTarget(
        {
          mode: "update",
          base_ref: baseline.ref,
          date_calendar: { start: "2026-01-01", end: "2026-10-31" },
        },
        fixture().context,
      ),
    ).rejects.toMatchObject({
      code: "INQUIRY_TARGET_INVALID",
      validationStage: "target_date_expression",
    });
  });
  it("只改日期时保留当前机构，不合并更早来源", async () => {
    const { context } = fixture();
    const next = await resolveInquiryTarget(
      { mode: "update", base_ref: baseline.ref, date: "2026-07-31" },
      context,
    );
    expect(next.organizations.codes).toEqual(["A"]);
    expect(next.time.start).toBe("2026-07-31");
    expect(next.parentRef).toBe(baseline.ref);
  });
  it("替换机构与追加比较是不同操作", async () => {
    const { context } = fixture();
    const replacement = await resolveInquiryTarget(
      {
        mode: "update",
        base_ref: baseline.ref,
        organizations: { mode: "replace", scope: "named", names: ["B"] },
      },
      context,
    );
    const comparison = await resolveInquiryTarget(
      {
        mode: "update",
        base_ref: baseline.ref,
        organizations: { mode: "add", scope: "named", names: ["B"] },
      },
      context,
    );
    expect(replacement.organizations.codes).toEqual(["B"]);
    expect(comparison.organizations.codes).toEqual(["A", "B"]);
    expect(comparison.time).toEqual(baseline.time);
  });
  it("明确双机构目标后改日期仍保留双机构", async () => {
    const { context } = fixture({
      ...baseline,
      organizations: { codes: ["A", "B"], names: ["甲", "乙"] },
    });
    const next = await resolveInquiryTarget(
      { mode: "update", base_ref: baseline.ref, date: "2026-07-31" },
      context,
    );
    expect(next.organizations.codes).toEqual(["A", "B"]);
  });
  it("基线过期不能默默沿用另一个目标", async () => {
    await expect(
      resolveInquiryTarget({ mode: "continue", base_ref: "other" }, fixture().context),
    ).rejects.toMatchObject({ code: "INQUIRY_TARGET_STALE" });
  });
  it("没有目标快照的存量会话不能从来源升级为目标", async () => {
    await expect(
      resolveInquiryTarget(
        { mode: "continue", base_ref: baseline.ref },
        { ...fixture().context, baseline: undefined },
      ),
    ).rejects.toMatchObject({ code: "INQUIRY_TARGET_STALE" });
    expect(
      readInquiryTargetSnapshot({ kind: "business_report", org_codes: ["A"] }),
    ).toBeUndefined();
  });
  it("新目标必须显式声明主题、机构和期间", async () => {
    await expect(
      resolveInquiryTarget({ mode: "new", topic: "贷款质量" }, fixture().context),
    ).rejects.toMatchObject({ code: "INQUIRY_TARGET_INVALID" });
    const next = await resolveInquiryTarget(
      {
        mode: "new",
        topic: "贷款质量",
        date: "2026-08-27",
        organizations: { mode: "replace", scope: "named", names: ["B"] },
      },
      fixture().context,
    );
    expect(next.parentRef).toBeUndefined();
    expect(next.topic).toBe("贷款质量");
  });
  it("沿用目标仍重新解析机构权限，不能把快照当授权票", async () => {
    const { context, resolveOrganizations } = fixture();
    resolveOrganizations.mockRejectedValueOnce(new Error("permission denied"));
    await expect(
      resolveInquiryTarget({ mode: "continue", base_ref: baseline.ref }, context),
    ).rejects.toThrow("permission denied");
  });
});

describe("明确日期集合按机构累计查询覆盖", () => {
  const dates = ["2026-06-30", "2026-07-31"];
  const target: InquiryTargetSnapshot = {
    ...baseline,
    organizations: { codes: ["A", "B"], names: ["甲行", "乙行"] },
    time: { date_selection: "exact", start: dates[0]!, end: dates[1]!, dates },
  };
  function receipt(
    codes: string[],
    time: InquiryTargetSnapshot["time"],
    status = "succeeded",
  ): AgentMessage {
    return {
      role: "toolResult",
      toolName: "metric_query",
      toolCallId: `${codes.join("-")}:${time.start}`,
      timestamp: 0,
      isError: false,
      content: [],
      details: {
        kind: "analysis_evidence",
        status,
        run_ref: `run:${codes.join("-")}:${time.start}`,
        execution_turn_id: target.operationId,
        inquiry_target_snapshot: target,
        inquiry_scope: { codes, names: codes },
        inquiry_date: time,
        row_count: 0,
      },
    };
  }
  const day = (value: string) => ({ date_selection: "exact", start: value, end: value });

  it("每个机构分别查完所有目标日期，包括正常空结果即可完成", () => {
    const messages = target.organizations.codes.flatMap((code) =>
      dates.map((date) => receipt([code], day(date))),
    );
    expect(inquiryTargetCoverage(messages, target)).toMatchObject({
      complete: true,
      covered_org_codes: ["A", "B"],
      missing_queries: [],
    });
  });
  it("只返回未完成机构的具体日期，不要求重查其他机构或已完成日期", () => {
    const messages = [receipt(["A", "B"], day(dates[0]!)), receipt(["A"], day(dates[1]!))];
    expect(inquiryTargetCoverage(messages, target)).toMatchObject({
      complete: false,
      covered_org_codes: ["A"],
      missing_org_codes: ["B"],
      missing_queries: [
        { org_code: "B", org_name: "乙行", time: { ...day(dates[1]!), dates: [dates[1]!] } },
      ],
    });
  });
  it("非目标日期、失败回执和未枚举的宽区间不能补足缺少日期", () => {
    const messages = [
      receipt(["A", "B"], day(dates[0]!)),
      receipt(["A", "B"], day(dates[1]!), "failed"),
      receipt(["A", "B"], day("2026-08-27")),
      receipt(["A", "B"], { date_selection: "exact", start: dates[0]!, end: dates[1]! }),
    ];
    expect(inquiryTargetCoverage(messages, target)).toMatchObject({
      complete: false,
      missing_queries: [
        { org_code: "A", time: { dates: [dates[1]!] } },
        { org_code: "B", time: { dates: [dates[1]!] } },
      ],
    });
  });
  it.each([
    { date_selection: "latest_snapshot", anchor_date: dates[1]! },
    { date_selection: "latest_in_range", start: dates[0]!, end: dates[1]! },
    { date_selection: "all_in_range", start: dates[0]!, end: dates[1]! },
  ])("分日查询不能替代$date_selection的执行语义", (time) => {
    const messages = dates.map((date) => receipt(["A", "B"], day(date)));
    expect(inquiryTargetCoverage(messages, { ...target, time })).toMatchObject({
      complete: false,
      missing_org_codes: ["A", "B"],
    });
  });
});
