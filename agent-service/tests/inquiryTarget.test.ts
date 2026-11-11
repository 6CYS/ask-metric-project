import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { QueryDate } from "../src/inquiry/sourceConditions.js";
import type { DateModelValue } from "../src/business-context/types.js";
import { BackendApiError, type BackendClient } from "../src/backendClient.js";
import { inquiryTargetReference } from "../src/inquiry/targetContext.js";
import { catalogBindingState } from "../src/analysis/bindings.js";
import { MemoryCommandBridge, testRequestContext } from "../src/tools/testUtils.js";
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
  it("只换机构时单独保留继承的分析要求，新主题不继承", async () => {
    const { context } = fixture();
    const next = await resolveInquiryTarget({
      mode: "update", base_ref: baseline.ref,
      organizations: { mode: "replace", scope: "named", names: ["B"] },
    }, context);
    expect(readInquiryTargetSnapshot(next)).toMatchObject({
      sourceQuestion: "追问", analysisQuestion: baseline.sourceQuestion,
    });
    const different = await resolveInquiryTarget({
      mode: "update", base_ref: baseline.ref, topic: "营业收入",
    }, context);
    expect(different.analysisQuestion).toBeUndefined();
  });

  it("按原问提供已确认的目录引用，追问可看见原范围，且同轮不重复匹配", async () => {
    const matchMetricQuestion = vi.fn((question: string) => Promise.resolve({
      mentions: question === baseline.sourceQuestion ? [
        { text: "存款余额", resolution: { status: "resolved", value: { codes: ["D"] }, metadata: { match: "exact" } } },
        { text: "相似项", resolution: { status: "resolved", value: { codes: ["X"] }, metadata: { match: "homophone" } } },
      ] : [],
    }));
    const analysisBindMetrics = vi.fn(() => Promise.resolve({ items: [
      { code: "D", name: "存款余额当日数", binding_ref: "signed-D" },
    ], comparison_items: [
      { code: "D_YOY", name: "存款余额较同期", binding_ref: "signed-D-YOY", base_metric_code: "D", comparison_period: "yoy" },
    ] }));
    const request = testRequestContext({
      resolveBusinessField: (_field: string, codes: string[]) => Promise.resolve({ status: "resolved", value: { codes } }),
      matchMetricQuestion, analysisBindMetrics,
    } as unknown as BackendClient, new MemoryCommandBridge(), {
      originalMessage: "乙行呢", inquiryTargetContext: { version: 1, baseline },
    });
    const messages: AgentMessage[] = [
      { role: "user", content: "乙行呢", timestamp: 0 },
      {
        role: "toolResult", toolName: "metric_search", toolCallId: "lookup", timestamp: 0,
        isError: false, content: [],
        details: { kind: "analysis_catalog", status: "succeeded", binding_map: { k1: "signed-other" } },
      },
    ];
    const first = await inquiryTargetReference(request, messages);
    expect(JSON.parse(first.split("\n").at(-1)!)).toMatchObject({ previous_question_metrics: [{
      text: "存款余额", code: "D", name: "存款余额当日数", binding_ref: "D",
      comparisons: [{ period: "yoy", code: "D_YOY", binding_ref: "D_YOY" }],
    }] });
    expect(first).not.toContain("signed-D");
    expect(first).not.toContain("相似项");
    expect(catalogBindingState(request)["code:D"]).toBe("signed-D");
    expect(catalogBindingState(request)["code:D_YOY"]).toBe("signed-D-YOY");
    expect(catalogBindingState(request).k1).toBe("signed-other");
    expect(await inquiryTargetReference(request, messages)).toBe(first);
    expect(matchMetricQuestion).toHaveBeenCalledTimes(2);
    expect(analysisBindMetrics).toHaveBeenCalledExactlyOnceWith(["D"], { signal: undefined, includeComparisons: true });
  });

  it("目录参考临时不可用时沿用普通问数，认证错误仍传播", async () => {
    const request = (failure: Error) => testRequestContext({
      matchMetricQuestion: () => Promise.reject(failure),
    } as unknown as BackendClient, new MemoryCommandBridge(), {
      inquiryTargetContext: { version: 1 },
    });
    await expect(inquiryTargetReference(request(new TypeError("network unavailable")), []))
      .resolves.toContain('"current_target":null');
    const denied = new BackendApiError(403, "forbidden");
    await expect(inquiryTargetReference(request(denied), [])).rejects.toBe(denied);
  });

  it("全机构的空名单规范化为授权集合，不缩成空目标", async () => {
    const { context, resolveOrganizations } = fixture();
    const target = await resolveInquiryTarget({
      mode: "new", topic: "存款余额", time: { expression: "2026-07-31" },
      organizations: { mode: "replace", scope: "all_banks", names: [] },
    }, context);
    expect(resolveOrganizations).toHaveBeenCalledWith("all_banks", undefined);
    expect(target.organizations).toMatchObject({ codes: ["A", "B"] });
  });
  it.each([
    { scope: "named" as const, names: [] },
    { scope: "all_banks" as const, names: ["A"] },
  ])("机构范围与名单不一致仍拒绝：$scope", async (organizations) => {
    const { context, resolveOrganizations } = fixture();
    await expect(resolveInquiryTarget({
      mode: "new", topic: "存款余额", time: { expression: "2026-07-31" },
      organizations: { mode: "replace", ...organizations },
    }, context)).rejects.toMatchObject({ code: "INQUIRY_TARGET_INVALID" });
    expect(resolveOrganizations).not.toHaveBeenCalled();
  });
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

describe("追问复用本轮已鉴权读取的期间证据", () => {
  const latest = { date_selection: "latest_snapshot", anchor_date: "2026-11-11" };
  const previous = { ...baseline, time: latest };
  const target: InquiryTargetSnapshot = {
    ...baseline, ref: "target:current", operationId: "current", time: latest, parentRef: previous.ref,
  };
  const history: AgentMessage = {
    role: "toolResult", toolName: "metric_query", toolCallId: "previous-query", timestamp: 0,
    isError: false, content: [], details: { inquiry_target_snapshot: previous },
  };
  const question: AgentMessage = { role: "user", content: "上升还是下降了", timestamp: 1 };
  function read(time = latest, codes = ["A"]): Extract<AgentMessage, { role: "toolResult" }> {
    return {
      role: "toolResult", toolName: "analysis_read", toolCallId: "read", timestamp: 2,
      isError: false, content: [],
      details: {
        kind: "analysis_evidence", status: "succeeded", run_ref: "run:previous",
        execution_turn_id: "previous", scope_id: "previous", result_reused: true,
        inquiry_target_snapshot: previous, inquiry_reuse_target_ref: previous.ref,
        date_selection: time.date_selection, checked_on: time.anchor_date,
        analysis_date: "2026-08-27", org_codes: codes,
      },
    };
  }
  it("已重新读取的最新查询与本轮精确日期补查可共同交付，不改写原来源身份", () => {
    const historical = read();
    const exact: AgentMessage = {
      role: "toolResult", toolName: "metric_query", toolCallId: "compare", timestamp: 3,
      isError: false, content: [],
      details: {
        kind: "analysis_evidence", status: "succeeded", run_ref: "run:comparison",
        execution_turn_id: "current", inquiry_target_snapshot: target,
        inquiry_scope: target.organizations,
        inquiry_date: { date_selection: "exact", start: "2026-08-27", end: "2026-08-27" },
      },
    };
    expect(inquiryTargetCoverage([history, question, historical, exact], target)).toMatchObject({
      complete: true, covered_org_codes: ["A"], missing_queries: [],
    });
    expect(historical.details).toMatchObject({ execution_turn_id: "previous", result_reused: true });
    expect(inquiryTargetCoverage([history, question, exact], target).complete).toBe(false);
  });
  it("上一轮读过的证据不能代替本轮重新鉴权", () => {
    expect(inquiryTargetCoverage([history, read(), question], target).complete).toBe(false);
  });
  it("来源缺少真实目标身份、操作身份不一致或旧证明均不能覆盖", () => {
    for (const changes of [
      {inquiry_target_snapshot: undefined}, {execution_turn_id: "unrelated"},
      {scope_id: "unrelated"}, {inquiry_reuse_target_ref: "target:older"},
      {inquiry_scope_role: "reference"},
    ]) {
      const source = read();
      source.details = {...source.details as object, ...changes};
      expect(inquiryTargetCoverage([history, question, source], target).complete).toBe(false);
    }
  });
  it("读取失败、其他最新截止日或精确日期均不能证明当前最新目标", () => {
    const failed = { ...read(), isError: true };
    const oldAnchor = read({ ...latest, anchor_date: "2026-11-10" });
    const exact = read({ date_selection: "exact", anchor_date: "2026-11-11" });
    expect(inquiryTargetCoverage([history, question, failed, oldAnchor, exact], target).complete).toBe(false);
  });
  it("已读取的机构不能覆盖追加的比较机构", () => {
    expect(inquiryTargetCoverage([history, question, read()], {
      ...target, organizations: { codes: ["A", "B"], names: ["甲行", "乙行"] },
    })).toMatchObject({ covered_org_codes: ["A"], missing_org_codes: ["B"], complete: false });
  });
  it("同机构同期间的其他主题回读不能补足新目标或已变更主题", () => {
    const fresh = { ...target };
    delete fresh.parentRef;
    expect(inquiryTargetCoverage([history, question, read()], fresh).complete).toBe(false);
    expect(inquiryTargetCoverage([history, question, read()], {
      ...target, topic: "不良贷款余额",
    }).complete).toBe(false);
  });
  it("连续追问沿已有父目标关系复用来源，不依赖只支持一次追问的特例", () => {
    const intermediate = { ...target, ref: "target:middle", operationId: "middle" };
    const middle: AgentMessage = {
      ...history, details: { inquiry_target_snapshot: intermediate },
    };
    const source = read();
    source.details = {...source.details as object, inquiry_reuse_target_ref: intermediate.ref};
    expect(inquiryTargetCoverage([history, middle, question, source], {
      ...target, parentRef: intermediate.ref,
    }).complete).toBe(true);
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
