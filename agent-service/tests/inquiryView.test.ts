import {describe, expect, it} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {inquiryCatalogView, inquiryEvidenceView, projectInquiryMessages} from "../src/inquiry/view.js";

const fact = (ref: string, metric: string, org: string, display: string) => ({ref, type: "fact", fact_id: `fact:${ref}`,
  step_ids: ["s1"], metric_code: metric, metric_name: metric === "M1" ? "测试金额" : "测试比率", org_code: org,
  org_name: `机构${org}`, date: "2026-07-31", value: "123456789.0123", display, unit: metric === "M1" ? "元" : "%"});
function evidence(): Record<string, unknown> {
  return {kind: "analysis_evidence", status: "succeeded", run_ref: "run-1", scope_id: "scope-1", frame_id: "frame-1",
    actual_dates: ["2026-07-31"], org_codes: ["A", "B"], org_names: ["机构A", "机构B"], complete: false,
    metric_descriptors: [{code: "M1", name: "测试金额", unit: "元", value_basis: "当日数", description: "金额定义"},
      {code: "M2", name: "测试比率", unit: "%", value_encoding: null}],
    evidence_items: [fact("r.f1", "M1", "A", "1.23亿元"), {...fact("r.f2", "M2", "A", "原始值0.987654321"), value: "0.987654321"},
      fact("r.f3", "M1", "B", "2.34亿元")],
    gaps: [{metric_code: "M3", reason: "未取得观测值"}], limitations: ["定义尚不完整"],
    requirement_dispositions: [{id: "q1", question: "收益如何", status: "partial", step_ids: ["s1"]}],
    rows: [{private_internal: true}], binding_map: {k1: "huge-binding"}, candidate_map: [{internal: true}]};
}
const view = (value: Record<string, unknown>, ref = "e1") => inquiryEvidenceView(value, ref) as {
  organizations: Record<string, string>; tables: Array<{metric_code: string; date: string; unit: string; columns: string[]; rows: string[][]}>;
  unavailable_metrics: Array<{metric_code: string; reason: string; row_count: number}>;
  findings: Array<{ref: string; input_refs: string[]}>; calculations: Array<{ref: string; input_refs: string[]; calculation: unknown}>;
};
const tool = (body: unknown, details: unknown, toolName = "resolve_business_turn"): AgentMessage => ({role: "toolResult",
  toolName, toolCallId: "call-1", timestamp: 0, isError: false, content: [{type: "text", text: JSON.stringify(body)}], details});

describe("调查模型紧凑证据视图", () => {
  it("取数视图保留源指标、基础名称和审核依据，未知比率仍不可引用", () => {
    const source = evidence();
    source.metric_descriptors = [
      {code: "M1", name: "测试金额", unit: "元", source_metric_code: "BASE1", base_name: "测试金额",
        value_basis: "当日数", semantic_source: "正式指标目录", semantic_status: "catalog_only",
        binding_ref: "private-signature", metadata_version: "private-version"},
      {code: "M2", name: "测试比率", unit: "%", value_encoding: null, source_metric_code: "BASE1",
        base_name: "测试金额", value_basis: "较同期增幅", semantic_source: "正式指标目录", semantic_status: "catalog_only"},
    ];
    const before = structuredClone(source), result = view(source);
    expect(result.tables).toMatchObject([{metric_code: "M1", source_metric_code: "BASE1", base_name: "测试金额",
      basis: "当日数", semantic_source: "正式指标目录", semantic_status: "catalog_only"}]);
    expect(result.unavailable_metrics).toMatchObject([{metric_code: "M2", source_metric_code: "BASE1", base_name: "测试金额",
      basis: "较同期增幅", semantic_source: "正式指标目录", semantic_status: "catalog_only", reason: "unknown_percentage_encoding"}]);
    expect(JSON.stringify(result)).not.toMatch(/private-signature|private-version|0\.987654321|e1\.v2/);
    expect(source).toEqual(before);
  });
  it("旧证据没有来源结构时保留已有口径，不按名称生成新元数据", () => {
    const result = view(evidence());
    expect(result.tables[0]).toMatchObject({metric_code: "M1", basis: "当日数"});
    for (const key of ["source_metric_code", "base_name", "semantic_source", "semantic_status"]) {
      expect(result.tables[0]).not.toHaveProperty(key);
    }
  });
  it("完整原子先签发别名再过滤未知比率，不改变后续事实编号或原始回执", () => {
    const source = evidence(), before = structuredClone(source), result = view(source);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({metric_code: "M1", date: "2026-07-31", unit: "元", columns: ["ref", "org", "value"],
      rows: [["e1.v1", "A", "1.23亿元"], ["e1.v3", "B", "2.34亿元"]]});
    expect(result.organizations).toEqual({A: "机构A", B: "机构B"});
    expect(result.unavailable_metrics).toMatchObject([{metric_code: "M2", reason: "unknown_percentage_encoding", row_count: 1}]);
    expect(JSON.stringify(result)).not.toMatch(/0\.987654321|e1\.v2|huge-binding|private_internal/);
    expect(result).toMatchObject({query_execution: {complete: false, requirement_dispositions: source.requirement_dispositions},
      gaps: source.gaps, limitations: source.limitations, run_ref: "run-1", scope_id: "scope-1", frame_id: "frame-1"});
    expect(source).toEqual(before);
  });
  it("查询完成只属于当前取数任务，判断边界保留且不修改原回执", () => {
    const source = {...evidence(), complete: true,
      requirement_dispositions: [{id: "q1", question: "查询选中机构的利润同比", status: "completed", step_ids: ["s1"]}],
      verified_findings: {boundary: "仅覆盖所引机构和期间，不证明业务因果。", items: []}};
    const before = structuredClone(source), result = view(source);
    expect(result).toMatchObject({query_execution: {complete: true, requirement_dispositions: source.requirement_dispositions},
      finding_boundary: source.verified_findings.boundary});
    expect(result).not.toHaveProperty("complete");
    expect(result).not.toHaveProperty("requirement_dispositions");
    expect(source).toEqual(before);
  });
  it("明确percent或ratio编码仍使用服务端展示值，不自行换算", () => {
    const source = evidence(); source.metric_descriptors = [{code: "M1", unit: "元"}, {code: "M2", unit: "%", value_encoding: "ratio"}];
    expect(view(source).tables.flatMap(table => table.rows)).toContainEqual(["e1.v2", "A", "原始值0.987654321"]);
  });
  it("未知单位及缺值不作为可引用值交给模型", () => {
    const source = evidence(); source.evidence_items = [{...fact("r.f1", "M1", "A", "999999.321"), unit: ""},
      {...fact("r.f2", "M1", "B", "暂无"), value: null}];
    source.metric_descriptors = [];
    const result = view(source);
    expect(result.tables).toEqual([]);
    expect(result.unavailable_metrics.map(item => item.reason)).toEqual(["unknown_unit", "missing_value"]);
    expect(JSON.stringify(result)).not.toMatch(/999999\.321|e1\.v[12]/);
  });
  it("不同指标、日期、单位及基期分开，不截断大结果", () => {
    const source = evidence(); source.metric_descriptors = [{code: "M1", unit: "元"}];
    source.evidence_items = Array.from({length: 360}, (_, index) => ({...fact(`r.f${index}`, "M1", `O${index}`, `${index}元`),
      date: index < 180 ? "2026-07-31" : "2026-08-31", comparison: index % 2 ? "mom" : "yoy"}));
    const result = view(source);
    expect(result.tables).toHaveLength(4);
    expect(result.tables.flatMap(table => table.rows)).toHaveLength(360);
    expect(new Set(result.tables.flatMap(table => table.rows.map(row => row[0]))).size).toBe(360);
  });
  it("排序及计算保留稳定判断引用和必要输入依据，不重复逐值说明", () => {
    const source = evidence(), atoms = source.evidence_items as Record<string, unknown>[];
    atoms.push({ref: "r.c1", type: "calculation", metric_code: "M1", metric_name: "差额", org_code: "A", org_name: "机构A",
      date: "2026-07-31", unit: "元", value: "1", display: "1元", input_refs: ["r.f1", "r.f3"], calculation: {method: "difference"}},
    {ref: "r.j1", type: "observation", judgment_kind: "ranking", rank: 1, position: "top", display: "机构B排名首位",
      input_refs: ["r.f1", "r.f3"], date: "2026-07-31", org_code: "B"},
    {ref: "r.o1", type: "observation", display: "机构A，2026-07-31，测试金额为1.23亿元。"});
    source.observations = [{type: "value", text: "重复的逐值说明"}];
    const result = view(source);
    expect(result.findings).toMatchObject([{ref: "e1.j1", input_refs: ["e1.v3"], metric_code: "M1", rank: 1, position: "top"}]);
    expect(result.calculations).toMatchObject([{ref: "e1.v4", input_refs: ["e1.v1", "e1.v3"], calculation: {method: "difference"}}]);
    expect(JSON.stringify(result)).not.toContain("重复的逐值说明");
  });
  it("表格按后端名次排列并保留原引用，不根据金额重新排名，未入榜事实仍保留", () => {
    const source = evidence();
    const facts = [fact("r.f1", "M1", "A", "1元"), fact("r.f2", "M1", "B", "1元"), fact("r.f3", "M1", "C", "1元")];
    source.evidence_items = [...facts, ...[facts[1]!, facts[0]!].map((item, index) => ({ref: `r.j${index + 1}`,
      type: "observation", judgment_kind: "ranking", rank: index + 1, position: "bottom", org_code: item.org_code,
      date: item.date, step_ids: ["s1"], display: "已核算名次", input_refs: facts.map(value => value.ref)}))];
    const before = structuredClone(source), result = view(source);
    expect(result.tables[0]!.rows.map(row => row[0])).toEqual(["e1.v2", "e1.v1", "e1.v3"]);
    expect(result.findings).toMatchObject([
      {ref: "e1.j1", metric_code: "M1", org_code: "B", date: "2026-07-31", rank: 1, input_refs: ["e1.v2"]},
      {ref: "e1.j2", metric_code: "M1", org_code: "A", date: "2026-07-31", rank: 2, input_refs: ["e1.v1"]},
    ]);
    expect(source).toEqual(before);
  });
  it("不同指标和日期各自保持后端排序，完整排名不重复发送全体比较引用", () => {
    const source = evidence(), facts: Record<string, unknown>[] = [], judgments: Record<string, unknown>[] = [];
    for (const [metric, day] of [["M1", "2026-07-31"], ["M3", "2026-08-27"]]) {
      const group = Array.from({length: 60}, (_, index) => ({...fact(`${metric}.f${index}`, metric!, `O${index}`, `${index}元`),
        unit: "元", date: day}));
      facts.push(...group);
      judgments.push(...[...group].reverse().map((item, index) => ({ref: `${metric}.j${index}`, type: "observation",
        judgment_kind: "ranking", rank: index + 1, position: "top", org_code: item.org_code, date: day,
        input_refs: group.map(value => value.ref), display: "已核算名次"})));
    }
    source.evidence_items = [...facts, ...judgments];
    const before = structuredClone(source), result = view(source);
    expect(result.tables.map(table => table.rows[0]![0])).toEqual(["e1.v60", "e1.v120"]);
    expect(result.tables.map(table => table.rows.at(-1)![0])).toEqual(["e1.v1", "e1.v61"]);
    expect(result.findings).toHaveLength(120);
    expect(result.findings.flatMap(item => item.input_refs)).toHaveLength(120);
    expect(source).toEqual(before);
  });
  it("失败来源不投影事实", () => {
    const result = inquiryEvidenceView({...evidence(), status: "failed", error_code: "PERMISSION_DENIED"}, "e1");
    expect(result).toMatchObject({status: "failed", error_code: "PERMISSION_DENIED"});
    expect(result).not.toHaveProperty("tables");
  });
  it("未知比率的派生计算及排序判断不重新暴露不可用值", () => {
    const source = evidence(), atoms = source.evidence_items as Record<string, unknown>[];
    atoms.push({...fact("r.c1", "M1", "A", "9876543元"), type: "calculation", input_refs: ["r.f2"]},
      {...fact("r.c2", "M1", "A", "8765432元"), type: "calculation", input_refs: ["r.c1"]},
      {ref: "r.j1", type: "observation", judgment_kind: "ranking", display: "比率排名首位", input_refs: ["r.f2"]});
    const result = view(source);
    expect(result.tables.flatMap(table => table.rows.map(row => row[0]))).toEqual(["e1.v1", "e1.v3"]);
    expect(result.calculations).toEqual([]); expect(result.findings).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/9876543|8765432|e1\.v[245]|e1\.j1/);
    expect(result.unavailable_metrics).toContainEqual(expect.objectContaining({reason: "unavailable_calculation_input", row_count: 2}));
  });
  it("历史引用沿用原条目e7编号，details及原消息不变", () => {
    const source = evidence(), body = {...source, evidence_ref: "e7"};
    const message = tool(body, source), before = structuredClone(message);
    const projected = projectInquiryMessages([message])[0]!;
    if (projected.role !== "toolResult" || projected.content[0]?.type !== "text") throw new Error("缺少投影");
    expect(JSON.parse(projected.content[0].text).tables[0].rows[0][0]).toBe("e7.v1");
    expect(projected.details).toBe(source); expect(message).toEqual(before);
  });
  it("没有原有eN编号的历史结果不猜编号", () => {
    const source = evidence(), message = tool(source, source);
    expect(projectInquiryMessages([message])[0]).toBe(message);
  });
  it("只有旧短引用的历史正文不重新编号，完整父回执存在时才转换为表格", () => {
    const source = evidence(), atoms = source.evidence_items as Record<string, unknown>[];
    const oldBody = {...source, evidence_ref: "e7", evidence_items: [{...atoms[0], ref: "e7.v1"}, {...atoms[2], ref: "e7.v3"}]};
    const alone = tool(oldBody, undefined);
    expect(projectInquiryMessages([alone])[0]).toBe(alone);
    const parent = {protocol_version: 2, state: {evidence: source}};
    const wrapped = {protocol_version: 2, state: {evidence: oldBody}};
    const projected = projectInquiryMessages([tool(wrapped, parent)])[0]!;
    if (projected.role !== "toolResult" || projected.content[0]?.type !== "text") throw new Error("缺少投影");
    expect(JSON.parse(projected.content[0].text).state.evidence.tables[0].rows.map((row: string[]) => row[0])).toEqual(["e7.v1", "e7.v3"]);
  });
});

describe("调查目录视图", () => {
  it("同正式编码共享定义，保留关键词匹配、分页和未确认语义建议", () => {
    const metric = {code: "M1", binding_ref: "k1", name: "测试金额", aliases: ["余额"], description: "定义", unit: "元",
      value_basis: "当日数", value_encoding: null, limitations: ["不可混加"]};
    const input = {results: [{keyword: "余额", page: 1, has_more: true, items: [{...metric, match_type: "alias"}], semantic_suggestions: []},
      {keyword: "金额", page: 2, has_more: false, items: [metric], semantic_suggestions: [{name: "近似含义", match_type: "semantic"}]}],
    binding_map: {k1: "private-signature"}, candidate_map: [metric]};
    expect(inquiryCatalogView(input)).toEqual({items: [metric], results: [
      {keyword: "余额", page: 1, has_more: true, matches: [{binding_ref: "k1", match_type: "alias"}], semantic_suggestions: []},
      {keyword: "金额", page: 2, has_more: false, matches: [{binding_ref: "k1"}], semantic_suggestions: [{name: "近似含义", match_type: "semantic"}]}]});
  });
  it("同编码定义冲突或绑定指向不同身份时不错误合并", () => {
    for (const second of [{code: "M1", binding_ref: "k1", unit: "万元"}, {code: "M2", binding_ref: "k1", unit: "元"}]) {
      const value = {results: [{items: [{code: "M1", binding_ref: "k1", unit: "元"}]}, {items: [second]}]};
      expect(inquiryCatalogView(value)).toEqual(value);
    }
  });
  it("语义近似条目不升级成正式绑定", () => {
    const result = inquiryCatalogView({results: [{items: [{code: "M1", name: "近似指标", binding_ref: "k9", match_type: "semantic"}]}]});
    expect(JSON.stringify(result)).not.toContain("k9");
    expect(result).toMatchObject({items: [], results: [{matches: [], semantic_suggestions: [{code: "M1", name: "近似指标", match_type: "semantic"}]}]});
  });
});
