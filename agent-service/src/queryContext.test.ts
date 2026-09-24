import { expect, it } from "vitest";
import { coverageContext, knownSuccessfulSource, queryReferenceContext, queryReferences } from "./queryContext.js";

it("追问基准来自最后成功回执，不按机构选择旧日期，且不复制金额", () => {
  const receipt = (task: string, org: string, date: string) => ({role: "toolResult", toolName: "metric_ask", content: [{type: "text", text: JSON.stringify({status: "succeeded", task_id: task, version: 3, result_id: `r:${task}`, sample_rows: [{org_name: org, metric_name: "存款余额", stat_date: date, metric_value: "1234567.89"}]})}]});
  const context = queryReferenceContext([receipt("old", "紫金", "2026-03-31"), receipt("current", "江阴", "2026-04-30")]);
  expect(context.split("\n")[1]).toContain('"task_id":"current"');
  expect(context.split("\n")[1]).toContain("2026-04-30");
  expect(context).toContain('"task_id":"old"');
  expect(context).not.toContain("1234567.89");
});


it("空结果和截断结果仍以正式执行条件作为追问日期基准", () => {
  const receipt = (task_id: string, date: string) => ({role:"toolResult",toolName:"metric_ask",content:[{
    type:"text",text:JSON.stringify({task_id,result_id:task_id,status:"succeeded",row_count:0,sample_rows:[],query_evidence:{
      logical_dsl:{time:{start:date,end:date},metrics:["M1"],orgs:["O1"]},
      catalog:{metrics:[{code:"M1",name:"存款余额",unit:"元"}],organizations:[{code:"O1",name:"紫金"}]},
    }}),
  }]});
  const messages = [receipt("old","2026-03-31"),receipt("empty","2026-04-30")];
  expect(queryReferenceContext(messages).split("\n")[1]).toContain("2026-04-30");
  expect(queryReferenceContext(messages).split("\n")[1]).toContain('"row_count":0');

});

it("同日期的两个空结果保留各自产生时的用户简称，不能丢失引用差异", () => {
  const receipt = (task_id: string) => ({role: "toolResult", toolName: "metric_ask", content: [{
    type: "text", text: JSON.stringify({task_id, result_id: task_id, status: "succeeded", row_count: 0, sample_rows: []}),
  }]});
  const references = queryReferences([
    {role: "user", content: "甲行3月末利润"}, receipt("a"),
    {role: "user", content: [{type: "text", text: "那乙行呢？"}]}, receipt("b"),
  ]);
  expect(references.map(item => [item.task_id, item.source_question])).toEqual([
    ["a", "甲行3月末利润"], ["b", "那乙行呢？"],
  ]);
});

it("重复回读不重复索引、不覆盖原问题或版本，最新基准仅出现一次", () => {
  const receipt=(toolName:string, task_id:string, extra={})=>({role:"toolResult",toolName,content:[{type:"text",text:JSON.stringify({status:"succeeded",task_id,result_id:`r:${task_id}`,rows:[{org_name:"甲",stat_date:"2026-03-31"},{org_name:"甲",stat_date:"2026-03-31"}],...extra})}]});
  const messages=[{role:"user",content:"原始问题"},receipt("metric_ask","a",{version:3}),
    {role:"user",content:"第二笔"},receipt("metric_ask","b",{version:2}),
    {role:"user",content:"回读旧结果"},receipt("metric_read","a")];
  const references=queryReferences(messages);
  expect(references).toHaveLength(2);
  expect(references.at(-1)).toMatchObject({task_id:"a",version:3,source_question:"原始问题"});
  expect(references.at(-1)?.conditions).toHaveLength(1);
  expect(queryReferenceContext(messages).match(/"task_id":"a"/g)).toHaveLength(1);
});

it("来源只检查正式成功回执和版本，不用最近来源覆盖旧来源", () => {
  const receipt=(task_id:string, status="succeeded", version=3)=>({role:"toolResult",toolName:"metric_read",content:[{type:"text",text:JSON.stringify({status,task_id,result_id:task_id,version,rows:[]})}]});
  const messages=[receipt("old"),receipt("new")];
  expect(knownSuccessfulSource(messages,{task_id:"old",version:3})).toBe(true);
  expect(knownSuccessfulSource(messages,{task_id:"invented",version:3})).toBe(false);
  expect(knownSuccessfulSource(messages,{task_id:"old",version:2})).toBe(false);
  expect(knownSuccessfulSource([...messages,receipt("old","FAILED",4)],{task_id:"old",version:3})).toBe(false);
});

it("覆盖投影保留全区间、编码、名称和分页；只读任务状态或可纠正参数错误不清除范围", () => {
  const request={dimension:"metrics",org_codes:["O"],start:"2020-01-01",end:"2026-09-21",page:2};
  const coverage={role:"toolResult",toolName:"data_availability",details:{status:"succeeded",request,
    org_names:["测试行"],items:[{metric_code:"M",metric_name:"余额"}],page:2,has_more:true}};
  const status={role:"toolResult",toolName:"metric_read",content:JSON.stringify({status:"SUCCEEDED",task_id:"t",version:3})};
  const blocked={role:"toolResult",toolName:"metric_query_structured",details:{status:"error",retryable:true}};
  const text=coverageContext([coverage,status,blocked]);
  for(const value of ["2020-01-01","2026-09-21",'"metric_code":"M"','"has_more":true','"page":2']) expect(text).toContain(value);
  expect(coverageContext([coverage,{role:"toolResult",toolName:"metric_ask",details:{status:"failed"}}])).toBe("");
});

it("只读任务状态不能覆盖结果正式条件，非法 JSON 形状不进入索引", () => {
  const message=(payload:unknown)=>({role:"toolResult",toolName:"metric_read",content:[{type:"text",text:JSON.stringify(payload)}]});
  const references=queryReferences([
    message({status:"succeeded",task_id:"t",result_id:"r",version:3,rows:[{stat_date:"2026-03-31"}]}),
    message({status:"SUCCEEDED",task_id:"t",result_id:"r",version:3}), message(null),
  ]);
  expect(references).toHaveLength(1);
  expect(references[0]?.conditions).toEqual([{stat_date:"2026-03-31"}]);
});

it("编码须有正式回执依据，精确命中不被近似候选或模型自报编码替换", async()=>{
  const {unconfirmedToolCodes}=await import('./queryContext.js');
  const catalog={role:'toolResult',toolName:'metric_catalog_search',content:JSON.stringify({items:[
    {metric_code:'EXACT',match_type:'exact'},{metric_code:'OTHER',match_type:'lexical'}]})};
  const org={role:'toolResult',toolName:'org_catalog_search',content:JSON.stringify({items:[{org_code:'O',match_type:'exact'}]})};
  expect(unconfirmedToolCodes([catalog,org],{metric_codes:['EXACT'],org_codes:['O']})).toEqual([]);
  expect(unconfirmedToolCodes([catalog,org],{metric_codes:['OTHER'],org_codes:['invented']})).toEqual(['metric_codes','org_codes']);
  expect(unconfirmedToolCodes([{role:'assistant',content:'编码EXACT'}],{metric_codes:['EXACT']})).toEqual(['metric_codes']);
});

it("统一 read 保留正式查询基准，历史读取不清空追问与澄清状态", async () => {
  const {activeClarificationTarget} = await import("./queryContext.js");
  const receipt = (payload: unknown, kind = "metric_read") => ({role: "toolResult", toolName: "read", details: {kind},
    content: [{type: "text", text: JSON.stringify(payload)}]});
  const successful = receipt({status: "succeeded", task_id: "t", version: 3, result_id: "r", rows: [],
    query_evidence: {logical_dsl: {time: {start: "2026-03-31", end: "2026-03-31"}, metrics: ["M"], orgs: ["O"]}}});
  const history = receipt({status: "ok", entries: [], text: "历史正文"}, "session_history_read");
  const messages = [successful, history];
  expect(knownSuccessfulSource(messages, {task_id: "t", version: 3})).toBe(true);
  expect(queryReferences(messages)).toHaveLength(1);
  expect(queryReferenceContext(messages)).toContain('"followup_baseline":{"task_id":"t"');
  const waiting = receipt({status: "WAITING_USER", task_id: "w", version: 2, clarification: {id: "cl"}});
  expect(activeClarificationTarget([waiting, history])).toEqual({task_id: "w", version: 2, clarification_id: "cl"});
  expect(knownSuccessfulSource([{...successful, details: {kind: "session_history_read"}}], {task_id: "t", version: 3})).toBe(false);
});
