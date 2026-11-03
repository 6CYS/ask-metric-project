import { describe, expect, it } from "vitest"
import { appendQuerySqlReferences } from "../src/lib/querySql"
import { applyChatToolResult } from "../src/lib/chatToolResults"

describe("回答关联的取数记录", () => {
  it("保留精准查询身份，重复回执不增加入口数量", () => {
    const receipt = {
      kind: "metric_ask",
      status: "succeeded",
      task_id: "t1",
      result_id: "result:t1",
    }
    const refs = appendQuerySqlReferences([], receipt)
    expect(refs).toEqual([{ task_id: "t1", result_id: "result:t1" }])
    expect(appendQuerySqlReferences(refs, receipt)).toBe(refs)
  })

  it("收集分析批次内的真实任务，忽略语义目标及覆盖查询", () => {
    expect(
      appendQuerySqlReferences([], {
        kind: "semantic_results",
        results: [
          {
            kind: "analysis_evidence",
            status: "succeeded",
            tasks: [
              { task_id: "t1", status: "succeeded" },
              { task_id: "t2", status: "failed" },
            ],
          },
          { kind: "data_availability", task_id: "not-sql" },
          { kind: "analysis_evidence", task_ref: "semantic-only", tasks: [] },
        ],
      }),
    ).toEqual([{ task_id: "t1" }, { task_id: "t2" }])
  })

  it("历史结果与计算的来源指向已有取数，不将计算身份当 SQL", () => {
    const refs = appendQuerySqlReferences([], {
      kind: "metric_read",
      status: "succeeded",
      task_id: "old",
      result_id: "result:old",
    })
    expect(
      appendQuerySqlReferences(refs, {
        kind: "metric_calculate",
        task_id: "calculation",
        sources: [
          { task_id: "old", result_id: "result:old", historical: true },
          { task_id: "current", result_id: "result:current" },
        ],
      }),
    ).toEqual([
      { task_id: "old", result_id: "result:old" },
      { task_id: "current", result_id: "result:current" },
    ])
  })

  it("拒绝无身份、澄清和未选中的回执，不用计划或正文推测 SQL", () => {
    for (const receipt of [
      null,
      { kind: "metric_ask", task_id: "clarify", status: "clarification_required" },
      { kind: "metric_read", status: "SUCCEEDED", task_id: "status-only" },
      { kind: "business_report", answer_selected: false, tasks: [{ task_id: "rejected" }] },
      { kind: "analysis_evidence", tasks: [{ task_id: "" }, { task_id: 12 }] },
      { kind: "catalog_overview", task_id: "catalog" },
    ])
      expect(appendQuerySqlReferences([], receipt)).toEqual([])
  })

  it("相同任务的显式不同执行分别保留，泛引用合并到明确来源", () => {
    const first = appendQuerySqlReferences([], {
      kind: "analysis_evidence",
      tasks: [{ task_id: "t" }],
    })
    const precise = appendQuerySqlReferences(first, {
      kind: "metric_ask",
      status: "succeeded",
      task_id: "t",
      run_id: 7,
    })
    expect(precise).toEqual([{ task_id: "t", run_id: 7 }])
    expect(
      appendQuerySqlReferences(precise, {
        kind: "metric_ask",
        status: "failed",
        task_id: "t",
        run_id: 8,
      }),
    ).toEqual([
      { task_id: "t", run_id: 7 },
      { task_id: "t", run_id: 8 },
    ])
  })

  it("实时与历史回放共用来源收集，不覆盖已交付正文", () => {
    const receipt = {
      protocol_version: 2,
      state: {
        evidence: { kind: "analysis_evidence", tasks: [{ task_id: "a" }, { task_id: "b" }] },
      },
    }
    const state = { content: "当前业务回答", nativeAnswer: true }
    const live = applyChatToolResult(state, receipt)
    expect(live).toMatchObject({
      content: "当前业务回答",
      querySqlReferences: [{ task_id: "a" }, { task_id: "b" }],
    })
    expect(applyChatToolResult(state, JSON.parse(JSON.stringify(receipt)) as unknown)).toEqual(live)
  })
})

describe("SQL 选择项的业务摘要", () => {
  it("按事实身份给多任务分配名称和日期，不串用整批条件", () => {
    const receipt = {
      kind: "analysis_evidence",
      tasks: [{ task_id: "t1" }, { task_id: "t2" }, { task_id: "empty" }],
      metric_descriptors: [{ name: "全批指标不能复制给每条" }],
      org_names: ["全批机构不能复制给每条"],
      analysis_date: "2026-10-31",
      evidence_items: [
        {
          type: "fact",
          fact_id: "fact:t1:0:metric_value",
          metric_name: "存款余额",
          org_name: "测试甲行",
          date: "2026-09-30",
        },
        {
          type: "fact",
          fact_id: "fact:t2:0:metric_value",
          metric_name: "贷款余额",
          org_name: "测试乙行",
          date: "2026-08-31",
        },
        {
          type: "calculation",
          fact_id: "fact:t1:0:metric_value",
          metric_name: "计算结果不是取数",
          org_name: "计算机构",
          date: "2026-10-31",
        },
        { type: "fact", fact_id: "fact:unrelated:0:metric_value", metric_name: "其他任务" },
      ],
    }
    expect(appendQuerySqlReferences([], receipt)).toEqual([
      { task_id: "t1", label: "存款余额", description: "测试甲行 · 2026-09-30" },
      { task_id: "t2", label: "贷款余额", description: "测试乙行 · 2026-08-31" },
      { task_id: "empty" },
    ])
    expect(appendQuerySqlReferences([], JSON.parse(JSON.stringify(receipt)) as unknown)).toEqual(
      appendQuerySqlReferences([], receipt),
    )
  })

  it("兼容经营概览按指标和日期保存的正式事实", () => {
    expect(
      appendQuerySqlReferences([], {
        kind: "business_overview",
        tasks: [{ task_id: "old" }],
        facts: {
          deposits: {
            "2026-06-30": {
              task_id: "old",
              metric_name: "存款余额",
              org_name: "测试甲行",
              date: "2026-06-30",
            },
            "2026-09-30": {
              task_id: "old",
              metric_name: "存款余额",
              org_name: "测试甲行",
              date: "2026-09-30",
            },
          },
        },
      }),
    ).toEqual([
      { task_id: "old", label: "存款余额", description: "测试甲行 · 2026-06-30、2026-09-30" },
    ])
  })

  it("直接结果行继承外层明确任务，但拒绝行自身冲突的身份", () => {
    expect(
      appendQuerySqlReferences([], {
        kind: "metric_query_structured",
        task_id: "direct",
        result_id: "result:direct",
        rows: [
          { metric_name: "存款余额", org_name: "测试甲行", stat_date: "2026-09-30" },
          {
            task_id: "other",
            metric_name: "不得混入",
            org_name: "测试乙行",
            stat_date: "2026-08-31",
          },
        ],
      }),
    ).toEqual([
      {
        task_id: "direct",
        result_id: "result:direct",
        label: "存款余额",
        description: "测试甲行 · 2026-09-30",
      },
    ])
  })

  it("只用直接查询的正式目录和完整日期证据，不把请求日期当数据日期", () => {
    expect(
      appendQuerySqlReferences([], {
        kind: "metric_read",
        task_id: "direct",
        result_id: "result:direct",
        query_evidence: {
          logical_dsl: { metrics: ["M1"], orgs: ["O1"], time: { end: "2026-10-31" } },
          catalog: {
            metrics: [
              { code: "M1", name: "存款余额" },
              { code: "M2", name: "无关指标" },
            ],
            organizations: [{ code: "O1", name: "测试甲行" }],
          },
          query_dates: { complete: true, actual_dates: ["2026-09-30"] },
        },
      }),
    ).toEqual([
      {
        task_id: "direct",
        result_id: "result:direct",
        label: "存款余额",
        description: "测试甲行 · 2026-09-30",
      },
    ])
  })

  it("后续回执补全摘要，重复及无描述回执不丢失已知信息", () => {
    const first = appendQuerySqlReferences([], { kind: "metric_ask", task_id: "t", run_id: 1 })
    const receipt = {
      kind: "metric_ask",
      task_id: "t",
      run_id: 1,
      rows: [{ metric_name: "存款余额", org_name: "测试甲行", stat_date: "2026-09-30" }],
    }
    const enriched = appendQuerySqlReferences(first, receipt)
    expect(enriched).toEqual([
      { task_id: "t", run_id: 1, label: "存款余额", description: "测试甲行 · 2026-09-30" },
    ])
    expect(appendQuerySqlReferences(enriched, receipt)).toBe(enriched)
    expect(
      appendQuerySqlReferences(enriched, { kind: "metric_ask", task_id: "t", run_id: 1 }),
    ).toBe(enriched)
  })

  it("不从无身份分析行、正文、计划或错误fact_id推测各任务名称", () => {
    expect(
      appendQuerySqlReferences([], {
        kind: "analysis_evidence",
        tasks: [{ task_id: "t1" }, { task_id: "t10" }],
        public_answer: "t1 存款余额",
        plan: { objective: "查询贷款" },
        rows: [{ metric_name: "不能对应任务", org_name: "机构", stat_date: "2026-09-30" }],
        evidence_items: [
          { type: "fact", fact_id: "fact:t10:0:metric_value", task_id: "t1", metric_name: "冲突" },
          { type: "fact", fact_id: "fact:t1:no-row:metric_value", metric_name: "坏格式" },
          { type: "fact", fact_id: "fact:t1:0:unknown", metric_name: "坏字段" },
        ],
      }),
    ).toEqual([{ task_id: "t1" }, { task_id: "t10" }])
  })

  it("计算来源使用原始输入事实，不用计算结果命名取数任务", () => {
    expect(
      appendQuerySqlReferences([], {
        kind: "metric_calculate",
        task_id: "calc",
        sources: [{ task_id: "old", result_id: "result:old" }],
        inputs: {
          a: { task_id: "old", metric_name: "存款余额", org_name: "测试甲行", date: "2026-09-30" },
        },
        results: [{ label: "变化率" }],
      }),
    ).toEqual([
      {
        task_id: "old",
        result_id: "result:old",
        label: "存款余额",
        description: "测试甲行 · 2026-09-30",
      },
    ])
  })
})

it("同一结果引用可补充已知执行的摘要，跨结果或多执行不猜", () => {
  const previous = [{ task_id: "t", run_id: 1, result_id: "result:t" }]
  const receipt = {
    kind: "metric_read",
    task_id: "t",
    result_id: "result:t",
    rows: [{ metric_name: "存款余额", org_name: "测试甲行", stat_date: "2026-09-30" }],
  }
  expect(appendQuerySqlReferences(previous, receipt)).toEqual([
    {
      task_id: "t",
      run_id: 1,
      result_id: "result:t",
      label: "存款余额",
      description: "测试甲行 · 2026-09-30",
    },
  ])
  expect(appendQuerySqlReferences(previous, { ...receipt, result_id: "other-result" })).toBe(
    previous,
  )
  const ambiguous = [...previous, { task_id: "t", run_id: 2, result_id: "result:t" }]
  expect(appendQuerySqlReferences(ambiguous, receipt)).toBe(ambiguous)
})

it("已有成功结果的泛引用保留，新执行未确认同源时独立追加", () => {
  const previous = [
    { task_id: "t", result_id: "result:t", label: "旧指标", description: "旧机构 · 2026-09-30" },
  ]
  const explicit = { kind: "metric_ask", task_id: "t", run_id: 8, status: "failed" }
  const updated = appendQuerySqlReferences(previous, explicit)
  expect(updated).toEqual([...previous, { task_id: "t", run_id: 8 }])
  expect(updated[0]).toBe(previous[0])
  expect(updated[1]).not.toHaveProperty("label")
  expect(updated[1]).not.toHaveProperty("description")
  expect(updated[1]).not.toHaveProperty("result_id")
  expect(appendQuerySqlReferences(previous, { ...explicit, result_id: "other-result" })).toEqual([
    ...previous,
    { task_id: "t", run_id: 8, result_id: "other-result" },
  ])
  expect(
    appendQuerySqlReferences(previous, { ...explicit, result_id: "result:t" })[0],
  ).toMatchObject({ label: "旧指标", description: "旧机构 · 2026-09-30" })
  expect(appendQuerySqlReferences([{ task_id: "t", label: "未确认来源的名称" }], explicit)).toEqual(
    [{ task_id: "t", run_id: 8 }],
  )
})
