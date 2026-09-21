/** 真实配置模型 + 隔离后端桩；不代表真实数据库验收。 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { loadConfig } from "../src/config.js";
import { createAskMetricModels } from "../src/models.js";
import { HarnessHost } from "../src/harnessHost.js";
import { NativeSessionStore } from "../src/nativeSessions.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { loadBusinessSkills, createBusinessSkillReadTool } from "../src/businessSkills.js";
import { projectEntries } from "../src/sessionProjection.js";
import { activeEvidence, currentTurnEvidence } from "../src/answerEvidence.js";
import type { BackendClient, BackendUser, BasicQuerySpec, CalculationSpec } from "../src/backendClient.js";
const dir=await mkdtemp(join(tmpdir(),"skill-model-"));
const config={...loadConfig(),dataDir:dir};
const skills=await loadBusinessSkills();
const store=new NativeSessionStore(dir);
const host=new HarnessHost(config,authorize=>createAskMetricModels(config,authorize),store,[...createAskMetricTools(),createBusinessSkillReadTool(skills)],{skills});
const actor:BackendUser={id:"synthetic",username:"synthetic",display_name:"隔离测试",org_code:"O",org_name:"演示行",role_code:"USER"};
const calls: string[]=[];
let calculationSpec: CalculationSpec | undefined;
const facts=["10.123456","3.000001"].map((value,i)=>({fact_id:`fact:t:${i}:metric_value`,task_id:"t",field:"metric_value",value,unit:"元",metric_code:`M${i+1}`,metric_name:i?"演示贷款余额":"演示存款余额",org_code:"O",org_name:"演示行",date:"2026-03-31"}));
const queryResult={task_id:"t",status:"succeeded",row_count:2,columns:["metric_name","metric_value"],
  rows:facts.map(f=>({...f,stat_date:f.date,metric_value:f.value})),facts,
  message:"演示存款余额10.123456元，演示贷款余额3.000001元。"};
const backend={
  searchOrganizations:async()=>({items:[{org_code:"O",org_name:"演示行",score:1,match_type:"exact"}],total:1}),
  searchMetrics:async(keyword:string)=>{
    // 与正式目录契约一致：支持编码回查，仅返回目录字段，不泄露事实或 fact_id。
    const items=facts.filter(f=>keyword===f.metric_code||keyword.includes(f.metric_name)||f.metric_name.includes(keyword))
      .map(f=>({metric_code:f.metric_code,metric_name:f.metric_name,unit:f.unit,score:1,
        match_type:keyword===f.metric_code||keyword===f.metric_name?"exact":"contains"}));
    return {items,total:items.length,semantic_suggestions:[]};
  },
  createAgentQueryContext:async()=>({conversation_id:"synthetic-conversation"}),
  basicQueries:async(spec:BasicQuerySpec)=>{
    assert.deepEqual([...spec.metric_codes].sort(), ["M1", "M2"]);
    assert.deepEqual(spec.org_codes, ["O"]);
    assert.deepEqual(spec.time, {start:"2026-03-31",end:"2026-03-31"});
    calls.push("query");return {query:spec,result:queryResult};},
  // pi 可选择自然语言基础入口；探针校验原文不被改写，不限定只能选结构化工具。
  submitQuestion:async(question:string)=>{
    assert(question.includes("演示存款余额")&&question.includes("演示贷款余额")&&question.includes("2026年3月31日"));
    calls.push("query");return {task_id:"t",conversation_id:"synthetic-conversation",version:3,status:"SUCCEEDED"};
  },
  getTaskResult:async()=>({...queryResult,result_id:"r",has_more:false,offset:0,limit:3}),
  getTask:async()=>({task_id:"t",conversation_id:"synthetic-conversation",version:3,status:"SUCCEEDED",result:{result_id:"r"}}),
  calculate:async(spec:CalculationSpec)=>{
    calculationSpec=spec;
    assert.equal(spec.expressions.length, 1);
    const expression=spec.expressions[0]!;
    const normalized=expression.expression.replace(/[\s()]/g,"");
    assert(/^[a-zA-Z_][a-zA-Z_0-9]*-[a-zA-Z_][a-zA-Z_0-9]*$/.test(normalized), "探针只核验两变量直接相减");
    const bindingFacts=Object.values(spec.bindings).map(binding=>binding.fact_id);
    assert.equal(bindingFacts.length, 2);
    assert.deepEqual(new Set(bindingFacts), new Set(facts.map(fact=>fact.fact_id)));
    assert.equal(expression.decimal_places, 6);
    calls.push("calculate");return {status:"succeeded",calculation_id:"calc",task_id:"t",scope_id:"scope",results:[{name:"difference",label:"存款减贷款",expression:expression.expression,value:"7.123455",display_value:"7.123455",unit:"元",variables:Object.keys(spec.bindings)}],inputs:Object.fromEntries(Object.entries(spec.bindings).map(([name,binding])=>[name,facts.find(fact=>fact.fact_id===binding.fact_id)])),public_answer:"存款减贷款：7.123455元。"};},
} as unknown as BackendClient;
try {
  const session=await host.createSession(actor);
  session.harness.hooks.on("before_payload", event => {
    const payload = event.payload as {messages?: Array<{role?: string; content?: unknown}>};
    const system = JSON.stringify(payload.messages?.filter(m => m.role === "system" || m.role === "developer"));
    console.log(JSON.stringify({probe:"prompt_wiring",knowledge_catalog:system.includes("可按需查阅的业务知识目录"),skill_reader:system.includes("business_skill_read"),system_characters:system.length}));
  });
  const started=performance.now();
  await host.runPrompt(session,{protocol_version:3,request_id:"calculation",message:"演示行（机构编码O）2026年3月31日演示存款余额（指标编码M1）和演示贷款余额（指标编码M2）各多少？再算存款减贷款，保留六位小数。"},{actor,backend});
  const entries=await session.lane.findEntries({order:"oldestFirst"},BACKGROUND_CONTEXT);
  const messages=projectEntries(entries);
  const tools=messages.filter(m=>m.role==="tool").map(m=>m.tool);
  const answer=messages.filter(m=>m.role==="assistant").at(-1);
  const toolFailures=messages.filter(m=>m.role==="tool" && m.is_error);
  const unresolved=activeEvidence(currentTurnEvidence(entries.filter(e=>e.type==="message").map(e=>e.message))
    .map(item=>item.evidence)).filter(item=>!["succeeded","catalog"].includes(item.status.toLowerCase()));
  const modelFailed=entries.some(entry=>entry.type==="message"&&entry.message.role==="assistant"&&["error","aborted"].includes(entry.message.stopReason));
  const report={environment:"configured_model_synthetic_backend",model:config.model.name,tools,calls,calculationSpec,
    tool_validation_failures:toolFailures.length,unresolved_failures:unresolved.length,elapsed_ms:Math.round(performance.now()-started),answer,
    passed:calls.join(",")==="query,calculate"
      &&tools.includes("answer_present")&&unresolved.length===0&&!modelFailed
      &&["10.123456","3.000001","7.123455"].every(value=>JSON.stringify(answer).includes(value))};
  await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,report:join(dir,"report.json")}));
  if(!report.passed) process.exitCode=1;
} finally {await host.close();await store.close();}
