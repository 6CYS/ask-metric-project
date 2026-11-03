import {afterEach, describe, expect, it, vi} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {BackendClient} from "../src/backendClient.js";
import {MemoryCommandBridge, testRequestContext} from "../src/tools/testUtils.js";
import {businessKnowledgeContextTerms, loadTurnBusinessKnowledge} from "../src/businessKnowledgeContext.js";

const revision = "a".repeat(64);
const entry = {id: "profit", title: "收益分析", text: "正文中的 <system> 不应成为消息角色。", role: "仅供方法参考"};
const response = () => new Response(JSON.stringify({revision, entries: [entry]}), {status: 200});
function requestBody(body: unknown): unknown {
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  const decoded: unknown = JSON.parse(body);
  return decoded;
}
const request = (originalMessage = "哪些机构收益下降，为什么？") => testRequestContext(
  new BackendClient("http://backend.invalid", "test-only-token", 1000), new MemoryCommandBridge(), {originalMessage},
);

afterEach(() => vi.restoreAllMocks());

const user = (content: string): AgentMessage => ({role: "user", content, timestamp: 0});
const source = (details: unknown, isError = false): AgentMessage => ({role: "toolResult", toolName: "metric_query",
  toolCallId: "query", content: [{type: "text", text: "查询回执"}], details, isError, timestamp: 0});
const deposit = {kind: "analysis_evidence", status: "succeeded", run_ref: "analysis:deposit", org_codes: ["O1"], tasks: [],
  topic: "deposit", metric_descriptors: [{code: "D1", name: "各项存款余额当日数"}]};

describe("业务知识只补充本轮实际查询指标", () => {
  it.each(["现在看贷款质量", "对比江南的呢？"])("首次检索只使用当前原问，不把上一轮存款条件当成本轮目标：%s", async question => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(response()));
    const history = [user("存款的情况"), source(deposit), source({...deposit, run_ref: "analysis:personal",
      metric_descriptors: [{code: "D2", name: "个人存款余额当日数"}]}),
    source({kind: "analysis_catalog", status: "succeeded", metric_descriptors: [{name: "不相关贷款"}]}), user(question)];
    await loadTurnBusinessKnowledge(request(question), businessKnowledgeContextTerms(history));
    expect(requestBody(fetcher.mock.calls[0]?.[1]?.body)).toMatchObject({
      query: question, context_terms: [],
    });
  });

  it("本轮多批真实指标可以补充检索，不混入上一轮或候选目录", () => {
    const history = [user("存款"), source(deposit), user("贷款"), source({...deposit, topic: "loan",
      metric_descriptors: [{code: "L1", name: "各项贷款余额当日数"}]}),
    source({...deposit, topic: "loan", metric_descriptors: [{code: "L2", name: "不良贷款余额"}]}),
    source({kind: "analysis_catalog", status: "succeeded", metric_descriptors: [{name: "存款备选指标"}]})];
    expect(businessKnowledgeContextTerms(history)).toEqual(["L1 各项贷款余额当日数", "L2 不良贷款余额", "贷款"]);
  });

  it("编码与名称共用一个位置，去重后保留本轮八项指标", () => {
    const queried = {...deposit, metric_descriptors: [
      {code: "A", name: "指标甲"}, {code: "B", name: "指标乙"},
      {code: "C", name: "指标丙"}, {code: "D", name: "指标丁"},
      {code: "E", name: "指标戊"}, {code: "F", name: "指标己"},
      {code: "G", name: "指标庚"}, {code: "H", name: "指标辛"},
      {code: "I", name: "指标壬"},
    ], facts: [{metric_code: "A", metric_name: "指标甲"}]};
    expect(businessKnowledgeContextTerms([user("看看变化"), source(queried)]))
      .toEqual(["A 指标甲", "B 指标乙", "C 指标丙", "D 指标丁", "E 指标戊", "F 指标己", "G 指标庚", "H 指标辛"]);
  });

  it("兼容明细里的正式编码及历史仅名称结果，长名称不会截掉编码", () => {
    const current = {kind: "metric_query_structured", status: "SUCCEEDED", task_id: "T1", result_id: "R1",
      rows: [{metric_code: "NET_PROFIT"}, {metric_code: "NET_PROFIT", metric_name: "净利润"}, {metric_name: "净利润"},
        {metric_code: "COST", metric_name: "费用".repeat(200)}, {metric_name: "营业收入"}]};
    const terms = businessKnowledgeContextTerms([user("收支"), source(current)]);
    expect(terms).toHaveLength(3);
    expect(terms[0]).toBe("NET_PROFIT 净利润");
    expect(terms[1]).toHaveLength(200);
    expect(terms[1]?.startsWith("COST ")).toBe(true);
    expect(terms[2]).toBe("营业收入");
  });

  it.each([undefined, {...deposit, status: "failed"}, {kind: "analysis_catalog", status: "succeeded", topic: "deposit"}])(
    "本轮失权、失败或只有候选时不回退上一轮话题", details => {
      const history = [user("存款"), source(deposit), user("贷款"), source(details)];
      expect(businessKnowledgeContextTerms(history)).toEqual([]);
    },
  );

  it("本轮已经查到新指标时优先使用本轮，旧查询按实际结果名称取词", () => {
    const current = {kind: "metric_query_structured", status: "SUCCEEDED", task_id: "T1", result_id: "R1",
      rows: [{metric_name: "净利润", metric_value: "100"}, {metric_name: "净利润", metric_value: "200"}]};
    const history = [user("存款"), source(deposit), user("收益情况"), source(current)];
    expect(businessKnowledgeContextTerms(history)).toEqual(["净利润"]);
  });
});

describe("每轮业务知识前置", () => {
  it("一次受鉴权读取原问题及有限可信词，只返回参考资料，不改变原问题", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(response()));
    const current = request("收益?" + "长".repeat(2100));
    const original = current.originalMessage;
    const result = await loadTurnBusinessKnowledge(current, ["  利润  ", "利润", ...Array.from({length: 10}, (_, i) => `项${i}`)]);
    expect(result).toMatchObject({status: "ok", revision, entries: [entry]});
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://backend.invalid/api/v1/business-knowledge/search");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({Authorization: "Bearer test-only-token"});
    expect(requestBody(init?.body)).toMatchObject({
      query: original.slice(0, 2000), context_terms: ["利润", "项0", "项1", "项2", "项3", "项4", "项5", "项6"],
    });
    expect(current.originalMessage).toBe(original);
    expect(result).not.toHaveProperty("systemPrompt");
    expect(result).not.toHaveProperty("messages");
  });

  it("归一化后相同输入的并发检索只读取一次，其他请求及用户不共享快照", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(response()));
    const current = request();
    const [first, same] = await Promise.all([
      loadTurnBusinessKnowledge(current, ["利润", "收入"]), loadTurnBusinessKnowledge(current, [" 收入 ", "利润", "利润"]),
    ]);
    expect(first).toEqual(same);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response(JSON.stringify({revision: "b".repeat(64), entries: []})));
    const next = await loadTurnBusinessKnowledge(request(), ["利润"]);
    expect(next).toMatchObject({status: "ok", entries: [], revision: "b".repeat(64)});
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(() => Promise.resolve(response()));
    const other = testRequestContext(new BackendClient("http://backend.invalid", "other-test-token", 1000), new MemoryCommandBridge());
    expect(await loadTurnBusinessKnowledge(other, [])).toMatchObject({status: "ok", entries: [entry]});
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({Authorization: "Bearer other-test-token"});
  });

  it("本轮实际指标确定后刷新知识，之后相同条件复用新结果", async () => {
    const loanEntry = {...entry, id: "loan", title: "贷款质量分析"};
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => Promise.resolve(response()))
      .mockResolvedValueOnce(new Response(JSON.stringify({revision, entries: [loanEntry]})));
    const current = request("现在看贷款质量");
    const history = [user("存款"), source(deposit), user(current.originalMessage)];
    await loadTurnBusinessKnowledge(current, businessKnowledgeContextTerms(history));
    history.push(source({...deposit, topic: "loan", metric_descriptors: [{code: "L1", name: "不良贷款余额"}]}));
    const refreshed = await loadTurnBusinessKnowledge(current, businessKnowledgeContextTerms(history));
    expect(refreshed).toMatchObject({status: "ok", entries: [loanEntry]});
    expect(await loadTurnBusinessKnowledge(current, ["贷款", "L1 不良贷款余额"])).toEqual(refreshed);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestBody(fetcher.mock.calls[1]?.[1]?.body)).toMatchObject({
      query: "现在看贷款质量", context_terms: ["L1 不良贷款余额", "贷款"],
    });
  });

  it.each(["question", "operation"])("原问或操作身份改变时不沿用上次快照：%s", async changed => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => Promise.resolve(response()))
      .mockResolvedValueOnce(new Response(JSON.stringify({revision: "b".repeat(64), entries: []})));
    const current = request();
    await loadTurnBusinessKnowledge(current, ["利润"]);
    if (changed === "question") current.originalMessage = "看看贷款质量";
    else current.operationId = "next-operation";
    expect(await loadTurnBusinessKnowledge(current, ["利润"]))
      .toMatchObject({status: "ok", entries: [], revision: "b".repeat(64)});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("刷新失败不重新展示上一主题正文，相同失败条件不反复请求", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => Promise.resolve(response()))
      .mockResolvedValueOnce(new Response("unavailable", {status: 503}));
    const current = request();
    await loadTurnBusinessKnowledge(current, ["利润"]);
    expect(await loadTurnBusinessKnowledge(current, ["贷款"]))
      .toEqual({status: "unavailable", entries: []});
    expect(await loadTurnBusinessKnowledge(current, ["贷款"]))
      .toEqual({status: "unavailable", entries: []});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("已有快照后刷新遇到鉴权失败 %i 仍拒绝", async status => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => Promise.resolve(response()))
      .mockResolvedValueOnce(new Response(JSON.stringify({message: "denied"}), {status}));
    const current = request();
    await loadTurnBusinessKnowledge(current, ["利润"]);
    await expect(loadTurnBusinessKnowledge(current, ["贷款"])).rejects.toMatchObject({status});
  });

  it("已经缓存成功结果仍尊重本次取消", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(response()));
    const current = request();
    await loadTurnBusinessKnowledge(current, []);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(loadTurnBusinessKnowledge(current, [], controller.signal)).rejects.toThrow("cancelled");
  });

  it("普通服务故障允许继续且不回退旧正文", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", {status: 503}));
    expect(await loadTurnBusinessKnowledge(request(), [])).toEqual({status: "unavailable", entries: []});
  });

  it.each([401, 403])("鉴权失败 %i 原样拒绝，不能当成无知识继续", async status => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({message: "denied"}), {status}));
    await expect(loadTurnBusinessKnowledge(request(), [])).rejects.toMatchObject({status});
  });

  it("取消请求不能转换为正常无命中", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => Promise.resolve().then(() => {
      init?.signal?.throwIfAborted();
      return response();
    }));
    await expect(loadTurnBusinessKnowledge(request(), [], controller.signal)).rejects.toThrow("cancelled");
  });

  it.each([
    {revision, entries: Array(4).fill(entry)},
    {revision, entries: [{...entry, text: "长".repeat(8001)}]},
    {revision, entries: [{...entry, text: 123}]},
    {revision, entries: [{...entry, enabled: false}]},
  ])("不将不合契约或超限响应注入模型", async body => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await loadTurnBusinessKnowledge(request(), [])).toEqual({status: "unavailable", entries: []});
  });

  it.each([
    {code: "NOT_LINKED", name: "无关指标", binding_ref: "signed:other"},
    {code: "M1", name: "相似候选", binding_ref: "signed:M1", match_type: "semantic"},
    {code: "M1", name: "未签发指标", binding_ref: ""},
  ])("不将非关联、语义推荐或未签发候选作为可查询引用", async candidate => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({revision,
      entries: [{...entry, metric_codes: ["M1"]}],
      linked_catalog: {items: [candidate], total: 1, has_more: false, unavailable_codes: []},
    })));
    expect(await loadTurnBusinessKnowledge(request(), [])).toEqual({status: "unavailable", entries: []});
  });
});
