import { describe, expect, it } from "vitest"
import { groupCatalogSteps, toolCallLabel, toolCallSummary } from "../src/lib/toolCallSummary"

const catalogDetails = (candidateCount: number, options = {}) => ({
  kind: "analysis_catalog", status: "succeeded",
  search_summary: { candidate_count: candidateCount, has_more: false, reused: false, exhausted: false, ...options },
})
const searchStep = (id: string, candidateCount: number, options = {}) => ({
  id, tool: "metric_search", status: "done", elapsedMs: 10,
  summary: toolCallSummary(catalogDetails(candidateCount, options)),
})

describe("工具回执进度摘要", () => {
  it.each([true, false])("指标选择不符合要求时解释本次查询原因，保留失败事实（传输标记 %s）", (isError) => {
    for (const validationStage of ["binding_resolution", "binding_duplicates"]) {
      expect(toolCallSummary({ kind: "inquiry_query_error", status: "error",
        code: "ANALYSIS_BINDING_INVALID", validation_stage: validationStage,
        correction_fields: ["metric_refs"], message: "内部编码与查询参数" }, isError))
        .toEqual({ note: "指标选择需调整，本次未执行", failed: true })
    }
  })

  it("其他查询异常不误报指标问题，也不暴露内部错误内容", () => {
    for (const code of ["INQUIRY_FORBIDDEN", "BACKEND_UNAVAILABLE", "UNKNOWN_ERROR", undefined]) {
      expect(toolCallSummary({ kind: "inquiry_query_error", status: "error", code,
        message: "内部 SQL 与连接信息" }, true))
        .toEqual({ note: "本次查询未完成", failed: true })
    }
    expect(toolCallSummary(undefined, true)).toEqual({ note: "执行失败" })
  })

  it("目录摘要区分本次候选、空匹配、分页、复用和耗尽", () => {
    expect(toolCallSummary(catalogDetails(3))?.note).toBe("找到 3 个可能相关的指标")
    expect(toolCallSummary(catalogDetails(0))?.note).toBe("暂未找到符合问题的指标")
    expect(toolCallSummary(catalogDetails(2, { has_more: true }))?.note).toBe("找到 2 个可能相关的指标，还有后续结果")
    expect(toolCallSummary(catalogDetails(0, { has_more: true }))?.note).toBe("本页暂未找到相关指标，还有后续结果")
    expect(toolCallSummary(catalogDetails(3, { reused: true }))?.note).toBe("已沿用已有指标查找结果，找到 3 个可能相关的指标")
    expect(toolCallSummary(catalogDetails(0, { reused: true }))?.note).toBe("已沿用已有指标查找结果，暂未找到符合问题的指标")
    expect(toolCallSummary(catalogDetails(0, { exhausted: true }))?.note).toBe("已无更多结果，本次未继续查找")
    expect(toolCallSummary({ ...catalogDetails(3), status: "failed" })).toMatchObject({ note: "指标查找未完成", failed: true })
    expect(toolCallSummary(catalogDetails(3), true)).toMatchObject({ note: "指标查找未完成", failed: true })
  })

  it("旧目录回执仅使用有效分页事实，不把累计快照或缺失字段猜成零匹配", () => {
    const details = { kind: "analysis_catalog", status: "succeeded" }
    expect(toolCallSummary({ ...details, search_pages: [{ total: 0, has_more: false }] })?.note).toBe("暂未找到符合问题的指标")
    expect(toolCallSummary({ ...details, search_pages: [{ total: 12, has_more: true }, { total: 0, has_more: false }] })?.note)
      .toBe("找到可能相关的指标，还有后续结果")
    expect(toolCallSummary({ ...details, reused: true, search_pages: [{ total: 0, has_more: false }] })?.note)
      .toBe("已沿用已有指标查找结果，暂未找到符合问题的指标")
    for (const search_pages of [[], [{ total: 0 }], [{ total: 0, has_more: false }, {}], [{ total: -1, has_more: false }]]) {
      expect(toolCallSummary({ ...details, search_pages })?.note).toBe("已完成指标查找")
    }
    expect(toolCallSummary({ ...details, search_summary: { candidate_count: -1 }, search_pages: [] })?.note)
      .toBe("已完成指标查找")
  })

  it("连续完成的同类检索只派生一项，保留累计次数、已有命中和原始事件", () => {
    const steps = [searchStep("one", 2), searchStep("two", 0), searchStep("three", 0)]
    const original = JSON.stringify(steps)
    const grouped = groupCatalogSteps(steps)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toMatchObject({ id: "one", count: 3, elapsedMs: 30, summary: { note: "找到可能相关的指标" } })
    expect(groupCatalogSteps(steps.slice(0, 2))[0]?.id).toBe(grouped[0]?.id)
    expect(JSON.stringify(steps)).toBe(original)
    expect(groupCatalogSteps([searchStep("one", 0), searchStep("two", 0)])[0]?.summary?.note).toBe("暂未找到符合问题的指标")
  })

  it("失败、运行中、不同动作和查询阶段隔开目录归并，不隐藏失败", () => {
    for (const separator of [
      { tool: "metric_search", status: "error" },
      { tool: "metric_search", status: "running" },
      { tool: "metric_query", status: "done" },
      { tool: "analysis_catalog", status: "done" },
      { tool: "metric_search", status: "done", summary: { failed: true, note: "指标查找未完成" } },
    ]) {
      const steps = [searchStep("one", 0), separator, searchStep("two", 0)]
      expect(groupCatalogSteps(steps)).toEqual(steps)
    }
  })

  it("合并复用和耗尽时保留各自次数，未知旧回执不被其后空结果覆盖", () => {
    const grouped = groupCatalogSteps([
      searchStep("one", 1), searchStep("two", 1, { reused: true }), searchStep("three", 0, { exhausted: true }),
    ])
    expect(grouped[0]?.summary?.note).toBe("找到可能相关的指标；沿用已有指标查找结果 1 次；已无更多结果 1 次")
    expect(groupCatalogSteps([
      { tool: "metric_search", status: "done", summary: { note: "已完成指标查找" } }, searchStep("two", 0),
    ])[0]?.summary?.note).toBe("已完成指标查找")
    expect(groupCatalogSteps([
      { tool: "metric_search", status: "done", summary: { note: "找到匹配指标" } }, searchStep("two", 0),
    ])[0]?.summary?.note).toBe("已完成指标查找")
  })

  it("分析查询按当前回执行数展示，不能将不存在的旧字段当成零条", () => {
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", row_count: 6,
      analysis_date: "2026-08-27", rows: [{}, {}, {}, {}, {}, {}] })?.note).toBe("已取得 6 条数据")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", rows: [{}, {}, {}] })?.note)
      .toBe("已取得 3 条数据")
  })

  it("空结果和未知数量分开，空日期但有数据也不宣称缺数", () => {
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", row_count: 0, rows: [],
      analysis_date: null })?.note).toBe("未查到符合条件的数据")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded" })?.note).toBe("查询完成")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", row_count: 2,
      analysis_date: null })?.note).toBe("已取得 2 条数据")
  })

  it("兼容旧报告数据行，并保留正式报告完成状态", () => {
    expect(toolCallSummary({ kind: "business_overview", status: "succeeded", table_rows: [{}, {}] })?.note)
      .toBe("已取得 2 条数据")
    expect(toolCallSummary({ kind: "business_report", status: "succeeded" })?.note).toBe("回答与数据明细已生成")
  })

  it("历史计算失败回执覆盖错误的传输成功标记，不扩展到未知业务状态", () => {
    expect(toolCallSummary({ kind: "metric_calculate", status: "error", error_code: "ANALYSIS_CALCULATION_SOURCE" }, false))
      .toMatchObject({ failed: true, note: "指标口径或数据来源不符合计算要求" })
    expect(toolCallSummary({ kind: "metric_calculate", status: "succeeded" }, false))
      .not.toHaveProperty("failed", true)
    expect(toolCallSummary({ kind: "business_context", status: "NEEDS_CLARIFICATION" }, false))
      .not.toHaveProperty("failed", true)
    expect(toolCallSummary({ kind: "unknown", status: "error" }, false)).toBeUndefined()
  })

  it("当前计算工具使用实际动作名称", () => {
    expect(toolCallLabel("analysis_calculate")).toBe("计算已有结果")
  })

  it("当前工具各自显示实际动作，读取已有结果不显示为重新查询", () => {
    expect(toolCallLabel("metric_search")).toBe("查找相关指标")
    expect(toolCallLabel("metric_query", { kind: "analysis_evidence" })).toBe("查询指标数据")
    expect(toolCallLabel("analysis_read", { kind: "analysis_evidence" })).toBe("读取已有查询结果")
    expect(toolCallLabel("metric_query", { kind: "analysis_evidence", result_reused: true })).toBe("读取已有查询结果")
    expect(toolCallLabel("analysis_answer", { kind: "business_report" })).toBe("生成回答")
    expect(toolCallLabel("business_knowledge_search")).toBe("查阅业务说明")
    expect(toolCallLabel("metric_availability")).toBe("查看数据可用范围")
    expect(toolCallLabel("analysis_chart")).toBe("准备图表展示")
  })

  it("直接查询较上月指标时，从实际回执展示指标、机构和日期，不虚构两期计算", () => {
    const details = { kind: "analysis_evidence", status: "succeeded", row_count: 1,
      metric_descriptors: [{ name: "保证金存款利息支出金额较上月" }],
      org_names: ["江苏农商联合银行（全省汇总）"], actual_dates: ["2026-07-31"],
      requested_date: "2026-10-30", analysis_date: "2026-07-31",
      plan: { objective: "我行机构保证金存款利息支出金额较上月是多少", steps: [{ method: "observe" }] } }
    expect(toolCallSummary(details)).toEqual({ note: "已取得 1 条数据", conditions: [
      { label: "指标", value: "保证金存款利息支出金额较上月" },
      { label: "机构", value: "江苏农商联合银行（全省汇总）" },
      { label: "数据日期", value: "2026-07-31" },
    ] })
    expect(toolCallLabel("metric_query", details)).not.toContain("计算")
  })

  it("多个实际日期逐项列出，不将缺失期间伪装成连续数据", () => {
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded",
      metric_descriptors: [{ name: "存款余额" }, { name: "存款余额" }, { name: "贷款余额" }],
      org_names: ["紫金农商行", "江南农商行"], actual_dates: ["2026-07-31", "2026-09-30"] })?.conditions)
      .toEqual([
        { label: "指标", value: "存款余额、贷款余额" },
        { label: "机构", value: "紫金农商行、江南农商行" },
        { label: "数据日期", value: "2026-07-31、2026-09-30" },
      ])
  })

  it("目录候选快照不当作已选指标或本次命中数量，知识只展示本次命中数量", () => {
    expect(toolCallSummary({ kind: "analysis_catalog", status: "succeeded",
      binding_map: { A: { name: "存款余额" } }, candidate_map: { B: { name: "贷款余额" } } }))
      .toEqual({ note: "已完成指标查找" })
    expect(toolCallSummary({ kind: "business_skill_read", status: "ok", name: "inquiry-analysis" }))
      .toEqual({ note: "已读取业务分析方法" })
    expect(toolCallSummary({ kind: "business_knowledge_search", status: "ok",
      entries: [{ title: "口径说明", text: "不在进度中展示的内部资料" }] }))
      .toEqual({ note: "找到 1 条参考信息" })
    expect(toolCallSummary({ kind: "business_knowledge_search", status: "ok", entries: [] })?.note)
      .toBe("暂未找到相关业务说明")
  })

  it("部分结果、读取复用和失败分别说明，不虚构正在核验或已完成", () => {
    expect(toolCallSummary({ kind: "semantic_results", status: "partial" })?.note).toBe("部分查询已完成，其余查询未完成")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", complete: false, row_count: 2 })?.note)
      .toBe("已取得 2 条数据，部分查询尚未完成")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", complete: false, row_count: 0 }))
      .toEqual({ note: "本次未取得可用数据，部分查询尚未完成" })
    expect(toolCallSummary({ kind: "semantic_results", status: "succeeded",
      results: [{ kind: "analysis_evidence", complete: false, row_count: 2 }] })?.note)
      .toBe("已取得查询结果，部分查询尚未完成")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", complete: true,
      row_count: 1, limitations: ["指标口径有说明"] })?.note).toBe("已取得 1 条数据")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", result_reused: true, row_count: 2 })?.note)
      .toBe("已读取 2 条已有数据")
    expect(toolCallSummary({ kind: "analysis_evidence", status: "failed", message: "内部 SQL 错误" }))
      .toEqual({ note: "查询未完成", failed: true })
    expect(toolCallSummary({ kind: "business_report", status: "succeeded", partial_analysis: true })?.note)
      .toBe("已生成部分结果说明")
    expect(toolCallSummary({ kind: "analysis_answer", status: "ARGUMENT_ERROR" }))
      .toEqual({ note: "回答尚未生成", failed: true })
  })

  it.each([
    ["ANALYSIS_CALCULATION_FACT_REQUIRED", "缺少可用于计算的原始数据"],
    ["ANALYSIS_CALCULATION_METRIC_MISMATCH", "所选指标或口径不同，不能直接比较"],
    ["ANALYSIS_CALCULATION_UNIT_UNCONFIRMED", "指标单位或百分比口径尚未确认"],
    ["ANALYSIS_CALCULATION_SCOPE_MISMATCH", "机构和日期同时变化，需先对齐比较范围"],
  ])("按已知计算错误 %s 说明原因，不透传内部异常", (errorCode, note) => {
    expect(toolCallSummary({ kind: "metric_calculate", status: "error", error_code: errorCode,
      message: "数据库连接串及内部 SQL 错误", retryable: false }))
      .toEqual({ note, failed: true })
  })

  it("保留当前和参照对象的对应关系，不展示内部引用和原始数值", () => {
    const inputs = {
      current: { metric_name: "营业收入金额较同期", org_name: "紫金农商行", date: "2026-07-31", ref: "e1.v2", value: "-123" },
      base: { metric_name: "营业收入金额当日数", org_name: "紫金农商行", date: "2026-07-31", ref: "e1.v1", value: "456" },
    }
    const summary = toolCallSummary({ kind: "metric_calculate", status: "error",
      error_code: "ANALYSIS_CALCULATION_METRIC_MISMATCH", inputs })
    expect(summary?.conditions).toEqual([
      { label: "比较对象", value: "营业收入金额较同期 · 紫金农商行 · 2026-07-31" },
      { label: "参照对象", value: "营业收入金额当日数 · 紫金农商行 · 2026-07-31" },
    ])
    expect(JSON.stringify(summary)).not.toContain("e1.v")
    expect(JSON.stringify(summary)).not.toContain("-123")
  })

  it("重复失败被阻止、暂时不可用和未知失败分开说明", () => {
    expect(toolCallSummary({ kind: "metric_calculate", status: "error", repeated_failure: true,
      error_code: "ANALYSIS_CALCULATION_METRIC_MISMATCH" })?.note)
      .toBe("相同条件已失败，未重复计算；所选指标或口径不同，不能直接比较")
    expect(toolCallSummary({ kind: "metric_calculate", status: "error", retryable: true })?.note)
      .toBe("计算服务暂不可用")
    expect(toolCallSummary({ kind: "metric_calculate", status: "error", message: "内部异常" }))
      .toEqual({ note: "计算未完成", failed: true })
    expect(toolCallSummary({ kind: "metric_calculate", status: "succeeded" })).toEqual({ note: "计算完成" })
  })

  it("部分回答展示公开的未完成项，长说明允许换行", () => {
    const gap = "营业收入金额较同期增幅的数值口径尚待确认，暂不用于分析。"
    expect(toolCallSummary({ kind: "business_report", status: "succeeded", partial_analysis: true,
      gaps: [gap, "", gap, "业务及管理费金额较同期增幅的数值口径尚待确认，暂不用于分析。"] }))
      .toEqual({ note: "已生成部分结果说明", conditions: [{ label: "未完成项", wrap: true,
        value: `${gap}\n业务及管理费金额较同期增幅的数值口径尚待确认，暂不用于分析。` }] })
    expect(toolCallSummary({ kind: "business_report", status: "failed", partial_analysis: true, gaps: [gap] })?.conditions)
      .toBeUndefined()
    expect(toolCallSummary({ kind: "analysis_evidence", status: "succeeded", gaps: ["内部诊断"] })?.conditions)
      .toBeUndefined()
  })
})
