import {expect,it,vi} from "vitest";
import type {Entry} from "@earendil-works/pi-agent-core";
import {createHistoryBridge,type HostedSession} from "../src/harnessHost.js";
import {BackendApiError,type BackendClient} from "../src/backendClient.js";
import {testRequestContext,MemoryCommandBridge,runTool} from "../src/tools/testUtils.js";
import {createReadTool} from "../src/tools/readTools.js";
import {historySources, resolveHistoryOrganizationScopes} from "../src/historySources.js";
import {createConversationReplyTool} from "../src/tools/turnContract.js";
import {semanticFeedback} from "../src/semantic-task/feedback.js";
import type {PendingQuestion, QuestionBinding} from "../src/semantic-task/questions.js";
import {authorizeHistory} from "../src/routes.js";

const entry=(id:string,seq:number,message:unknown)=>({kind:"entry",id,seq,parentId:null,type:"message",timestamp:seq,message}) as Entry;
const user=(text:string)=>({role:"user",content:text,timestamp:1});
const receipt={kind:"metric_query_structured",status:"succeeded",task_id:"query-1",result_id:"result-1",columns:["metric_value"],rows:[{metric_value:"987654.32"}]};
function setup(extra:Entry[]=[]) {
  let allowed=true;
  const entries=[entry("u1",1,user("旧查询")),entry("t1",2,{role:"toolResult",toolName:"resolve_business_turn",toolCallId:"c1",details:receipt,content:[{type:"text",text:JSON.stringify(receipt)}],timestamp:2,isError:false}),
    entry("a1",3,{role:"assistant",content:[{type:"text",text:"旧值987654.32"}],timestamp:3}),...extra,entry("current",20,user("找回历史"))];
  const backend={getTask:vi.fn(async()=>{if(!allowed)throw new BackendApiError(403,"当前无权限");return {task_id:"query-1",status:"SUCCEEDED",result:{result_id:"result-1"}};})} as unknown as BackendClient;
  const hosted={lane:{findEntries:vi.fn(async()=>structuredClone(entries))}} as unknown as HostedSession;
  const request=()=>{const ctx=testRequestContext(backend,new MemoryCommandBridge());ctx.history=createHistoryBridge(hosted,()=>ctx);return ctx;};
  return {entries,request,backend,revoke:()=>{allowed=false;},restore:()=>{allowed=true;}};
}
it("原生历史list和entry按原回合当前权限屏蔽正文，恢复权限后原件仍可读",async()=>{
  const f=setup(),before=JSON.stringify(f.entries),r=f.request();
  expect((await r.history.read("a1"))!.text).toContain("987654.32");
  f.revoke();const denied=f.request();
  expect(JSON.stringify(await denied.history.list())).not.toContain("987654.32");
  expect((await denied.history.read("a1"))!.text).not.toContain("987654.32");
  expect((await denied.history.read("t1"))!.text).not.toContain("987654.32");
  f.restore();expect((await f.request().history.read("a1"))!.text).toContain("987654.32");expect(JSON.stringify(f.entries)).toBe(before);
});
it("读取助手正文也持久化原工具来源，下一轮撤权不能从读取回执恢复旧值",async()=>{
  const f=setup(),r=f.request();const read=await runTool(createReadTool(),{kind:"entry",entry_id:"a1"},r);
  expect(read.details).toMatchObject({kind:"session_history_read",history_sources:{tasks:[{task_id:"query-1",result_id:"result-1"}]}});
  const sources=historySources([read.details],()=>{throw Error("unavailable");});expect([...sources.tasks]).toEqual([["query-1","result-1"]]);
  const saved=setup([entry("u2",4,user("旧回读")),entry("r2",5,{role:"toolResult",toolName:"read",toolCallId:"c2",details:read.details,content:read.content,timestamp:5,isError:false}),entry("a2",6,{role:"assistant",content:[{type:"text",text:"回读得到987654.32"}],timestamp:6})]);
  saved.revoke();expect((await saved.request().history.read("r2"))!.text).not.toContain("987654.32");expect((await saved.request().history.read("a2"))!.text).not.toContain("987654.32");
});
it("旧版无来源的历史回读正文不再作为可授权数值通道",async()=>{
  const f=setup([entry("u2",4,user("旧回读")),entry("r2",5,{role:"toolResult",toolName:"read",toolCallId:"c2",details:{kind:"session_history_read",status:"ok"},content:[{type:"text",text:"未经来源绑定的987654.32"}],timestamp:5,isError:false})]);
  expect((await f.request().history.read("r2"))!.text).not.toContain("987654.32");
});
it("百轮会话精确回读只复核目标完整回合，同轮再次读取复用权限结果",async()=>{
  const extra:Entry[]=[];
  for(let i=1;i<=100;i++)extra.push(entry(`u${i+2}`,i*3+4,user(`历史${i}`)),entry(`t${i+2}`,i*3+5,{role:"toolResult",toolName:"resolve_business_turn",toolCallId:`c${i+2}`,details:receipt,content:[{type:"text",text:JSON.stringify(receipt)}],timestamp:i,isError:false}),entry(`copy${i}`,i*3+6,{role:"assistant",content:[{type:"text",text:"旧值987654.32"}],timestamp:i}));
  const f=setup(extra),r=f.request();
  expect((await r.history.read("copy50"))!.text).toContain("987654.32");
  expect(f.backend.getTask).toHaveBeenCalledTimes(1);
  await r.history.read("copy50");expect(f.backend.getTask).toHaveBeenCalledTimes(1);
});
it("普通回答保存模型所见历史来源，复制正文在下一轮撤权后也被屏蔽",async()=>{
  const f=setup(),r=f.request();r.replyHistorySources={tasks:[{task_id:"query-1",result_id:"result-1"}],organizationScopes:[]};
  const reply=await runTool(createConversationReplyTool(),{answer:"旧值987654.32"},r);
  const saved=setup([entry("u2",4,user("复述旧值")),entry("r2",5,{role:"toolResult",toolName:"respond_without_business_action",toolCallId:"c2",details:reply.details,content:reply.content,timestamp:5,isError:false})]);
  saved.revoke();expect((await saved.request().history.read("r2"))!.text).not.toContain("987654.32");
});
it("旧版无来源普通回答不能替已失权的正式来源保留旧数值",async()=>{
  const f=setup([entry("u2",4,user("复述旧值")),entry("r2",5,{role:"toolResult",toolName:"respond_without_business_action",toolCallId:"c2",details:{kind:"conversation_reply",status:"answered",answer:"987654.32元"},content:[{type:"text",text:"987654.32元"}],timestamp:5,isError:false})]);
  f.revoke();expect((await f.request().history.read("r2"))!.text).not.toContain("987654.32");
});

it("仅有问题候选的包装历史也按全部展示机构复核当前权限",async()=>{
  const question=organizationQuestion(),binding=organizationBinding(question),feedback=semanticFeedback(undefined,"needs_user");
  feedback.pending_questions=[question];
  const sources=historySources([{semantic_task:feedback}],()=>{throw Error("unavailable");});
  const reader={question:vi.fn(async()=>({question,binding}))};
  expect(sources.questions).toEqual([{question_id:question.question_id,version:1,option_ids:question.options.map(option=>option.option_id),selected:false}]);
  expect(await resolveHistoryOrganizationScopes(sources,reader,()=>{throw Error("unavailable");})).toEqual([["O1","O2"]]);
  const backend={resolveBusinessField:vi.fn(async()=>({status:"resolved",value:{codes:["O1"],names:["合成机构甲"]}}))} as unknown as BackendClient;
  const message={role:"tool" as const,tool:"resolve_business_turn",tool_call_id:"q1",details:feedback,is_error:false,timestamp:1,entry_id:"q1"};
  await expect(authorizeHistory([message],backend,undefined,reader)).rejects.toMatchObject({code:"HISTORY_PERMISSION_DENIED"});
  expect(backend.resolveBusinessField).toHaveBeenCalledWith("organization",["O1","O2"]);
});

it("受理回执只核验实际展示的已选机构，未展示候选失权不误判",async()=>{
  const question=organizationQuestion(),binding=organizationBinding(question),selected=question.options[0]!;
  const answer={question_id:question.question_id,version:1,choice:{type:"select" as const,option_ids:[selected.option_id] as [string]},source:{channel:"click" as const,operation_id:"answer"}};
  binding.receipts=[{receipt_id:"receipt",answer,outcome:"applied",planRef:"plan",targetRef:"target",selected_options:[selected],notice:"已确认"}];
  const feedback=semanticFeedback(undefined,"succeeded");
  feedback.answer_receipts=[{question_id:question.question_id,version:1,outcome:"applied",selected_options:[selected],notice:"已确认"}];
  const sources=historySources([feedback],()=>{throw Error("unavailable");});
  const reader={question:vi.fn(async()=>({question,binding}))};
  expect(await resolveHistoryOrganizationScopes(sources,reader,()=>{throw Error("unavailable");})).toEqual([["O1"]]);
  const backend={resolveBusinessField:vi.fn(async()=>({status:"resolved",value:{codes:["O1"],names:["合成机构甲"]}}))} as unknown as BackendClient;
  const message={role:"tool" as const,tool:"resolve_business_turn",tool_call_id:"q2",details:feedback,is_error:false,timestamp:1,entry_id:"q2"};
  await expect(authorizeHistory([message],backend)).rejects.toMatchObject({code:"HISTORY_SCOPE_UNAVAILABLE"});
  await expect(authorizeHistory([message],backend,undefined,reader)).resolves.toBeUndefined();
  expect(backend.resolveBusinessField).toHaveBeenCalledWith("organization",["O1"]);
  expect(backend.resolveBusinessField).not.toHaveBeenCalledWith("organization",["O2"]);
});

function organizationQuestion():PendingQuestion{
  return {question_id:"q-org",version:1,scope:{task_ref:"plan",target_ref:"target",field:"organizations",item_ref:"item"},
    prompt:"请选择机构",selection_mode:"multiple",status:"open",issued_operation_id:"issued",kind:"choice",
    options:[{option_id:"opt-O1",no:1,label:"合成机构甲"},{option_id:"opt-O2",no:2,label:"合成机构乙"}]};
}
function organizationBinding(question:PendingQuestion):QuestionBinding{
  return {question_id:question.question_id,version:1,reason:"candidate_choice",planRef:"plan",targetRef:"target",taskRef:"task",item_ref:"item",
    options:question.options.map((option,index)=>({option_id:option.option_id,candidateKey:`O${index+1}`,candidate:{code:`O${index+1}`,value:option.label}})),
    resolutionBasis:{},businessBasis:{field:"organizations",kind:"choice",prompt:question.prompt,selection_mode:"multiple",
      options:question.options.map((option,index)=>({key:`O${index+1}`,label:option.label}))},receipts:[]};
}
