import { expect, it } from "vitest";

it("候选只取本轮前业务成功回执，目录查询和本轮中间结果不能换来源", async () => {
  const { queryCandidateBeforeTurn } = await import("./queryContext.js");
  const receipt = (task_id:string, status="succeeded") => ({role:"toolResult",toolName:"metric_ask",
    details:{kind:"metric_ask",task_id,status},content:[{type:"text",text:JSON.stringify({task_id,status,version:3,result_id:`r:${task_id}`,sample_rows:[]})}]});
  const history=[{role:"user",content:"首问"},receipt("a"),{role:"user",content:"乙机构四月呢"},
    {role:"toolResult",toolName:"search_organizations",details:{status:"ok"}},receipt("current")];
  expect(queryCandidateBeforeTurn(history)).toEqual({task_id:"a",version:3});
  for(const status of ["clarification","failed","error","context_required","pending"]) {
    expect(queryCandidateBeforeTurn([receipt("a"),receipt("b",status),{role:"user",content:"四月呢"}])).toBeUndefined();
  }
  expect(queryCandidateBeforeTurn([{role:"user",content:"新会话"}])).toBeUndefined();
});

it("最新待澄清或失败状态不能被旧成功引用覆盖，手输补充与自然切换都有入口", async () => {
  const {queryReferenceContext}=await import("./queryContext.js");
  const receipt=(value:unknown)=>({role:"toolResult",toolName:"metric_ask",content:[{type:"text",text:JSON.stringify(value)}]});
  const old=receipt({status:"succeeded",task_id:"old",version:3,result_id:"r",sample_rows:[]});
  for(const status of ["clarification_required","WAITING_USER"]) {
    const context=queryReferenceContext([old,receipt({status,task_id:"waiting",version:1,clarification:{id:"cl",missing:["metrics"]}})]);
    expect(context).toContain('"task_id":"waiting"');
    expect(context).toContain("metric_ask action=new");
    expect(context).toContain("action=clarify");
    expect(context).not.toContain("当前连续追问基准");
  }
  expect(queryReferenceContext([old,receipt({status:"error",task_id:"failed"})])).not.toContain("当前连续追问基准");
});

it("澄清目标来自最新正式回执，失败之后不能复用旧编号或臆造编号", async () => {
  const {activeClarificationTarget}=await import("./queryContext.js");
  const receipt=(value:unknown,toolName="metric_ask")=>({role:"toolResult",toolName,content:[{type:"text",text:JSON.stringify(value)}]});
  const waiting=receipt({status:"clarification_required",task_id:"a",version:1,clarification:{id:"cl"}});
  expect(activeClarificationTarget([waiting,receipt({items:[]},"metric_catalog_search")])).toEqual({task_id:"a",version:1,clarification_id:"cl"});
  expect(activeClarificationTarget([waiting,{role:"toolResult",toolName:"metric_ask",content:[{type:"text",text:"工具参数被拦截，请纠正"}]}])).toEqual({task_id:"a",version:1,clarification_id:"cl"});
  for(const status of ["error","FAILED","SUCCEEDED","RUNNING"]) {
    expect(activeClarificationTarget([waiting,receipt({status,task_id:"a",version:2,clarification:{id:"cl"}},"metric_read")])).toBeUndefined();
  }
  expect(activeClarificationTarget([receipt({status:"WAITING_USER",task_id:"a",version:2})])).toBeUndefined();
});
