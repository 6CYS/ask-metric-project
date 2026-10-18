import {afterEach, expect, it, vi} from "vitest";
import type {AgentMessage} from "@earendil-works/pi-agent-core";
import {fixture, complete, proposal} from "./fixtures.js";
import {referencedQueryNumbers, requestedHistory} from "../../src/semantic-task/historyReference.js";
import {runTool} from "../../src/tools/testUtils.js";
import {createSemanticExecuteTool, createSemanticReadTool} from "../../src/semantic-task/tools.js";
import {prepareSemanticArguments} from "../../src/semantic-task/protocol.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {contextEstimate, workingMessages, scopeAvailable, permissionFilteredAdmission} from "../../src/semantic-task/contextMemory.js";
import {redactInaccessibleHistory, HistoryAuthorizationError} from "../../src/routes.js";
import type {SemanticPlan} from "../../src/semantic-task/store.js";
const closes: Array<() => Promise<void>> = [];
afterEach(async()=>{for(const close of closes.splice(0)) await close();});
async function setup(){const f=await fixture();closes.push(f.close);return f;}

it("多历史来源逐成员继承，共同日期修改不把整笔两家要求压到每个子目标",async()=>{
 const f=await setup(), first=f.request("first","合成机构甲2025年末的合成指标甲");
 const a=await new SemanticPlanService(first).resolve(proposal(complete()));expect(a.status).toBe("ready");
 const b=await new SemanticPlanService(f.request("second","合成机构乙呢")).resolve(proposal([{action:"set",field:"organizations",value:"合成机构乙"}],{kind:"reference",task_ref:a.state.task_ref!,target_ref:a.state.targets[0]!.target_ref}));
 expect(b.status).toBe("ready");
 const request=f.request("group","上述两家机构2024年末的分别是多少");
 const result=await new SemanticPlanService(request).resolve(proposal([{action:"set",field:"time",value:"2024年末"}],{kind:"references",references:[a,b].map(x=>({task_ref:x.state.task_ref!,target_ref:x.state.targets[0]!.target_ref}))}));
 expect(result.status,JSON.stringify(result.issues)).toBe("ready");expect(result.state.targets).toHaveLength(2);
 const plan=await request.semanticTasks!.plan(result.state.task_ref!);
 const tasks=await Promise.all(plan!.steps.map(step=>request.semanticTasks!.get(step.taskRef!)));
 expect(tasks.map(t=>t!.target.fields.organizations!.resolvedValue)).toEqual([{codes:["O1"],names:["合成机构甲"]},{codes:["O2"],names:["合成机构乙"]}]);
 expect(tasks.every(t=>(t!.target.fields.time!.resolvedValue as {start:string}).start==="2024-12-31")).toBe(true);
 expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("百问索引可以精确定位第二个任务、分页及重开恢复，不靠全量消息摘要",async()=>{
 const f=await setup(), request=f.request(),store=request.semanticTasks!;
 for(let i=1;i<=120;i++){
  const plan:SemanticPlan={ref:`plan-${i}`,owner:request.actor.id,revision:1,operationId:`op-${i}`,topicRef:`topic-${i%4}`,intent:"query",originalMessage:`合成历史问题${i}`,status:"completed",completion:"full",issues:[],steps:[{id:`step-${i}`,targetRef:`target-${i}`,operationId:`op-${i}`,kind:"query",source:{kind:"new"},sourceQuestion:`合成历史问题${i}`,operations:[],dependencies:[],status:"succeeded",required:true,issues:[]}]};
  await store.savePlan(plan,(await store.planIndex()).version);
 }
 const old=await store.searchContext({query_number:2});expect(old.references).toHaveLength(1);expect(old.references[0]!.task_ref).toBe("plan-2");
 const page=await store.searchContext({limit:3});expect(page.references).toHaveLength(3);expect(page.total).toBe(120);
 const before=await store.searchContext({limit:3,cursor:page.next_cursor!});expect(before.references.at(-1)!.query_number).toBe(117);
 await expect(store.searchContext({cursor:"forged"})).rejects.toThrow("SEMANTIC_HISTORY_CURSOR_INVALID");
});

it("120轮工作上下文有预算、保留当前工具配对和原始历史",()=>{
 const messages:AgentMessage[]=[];
 for(let i=0;i<120;i++) messages.push({role:"user",content:`历史问题${i}`.repeat(100),timestamp:i},{role:"toolResult",toolName:"business_context_read",toolCallId:`call-${i}`,content:[{type:"text",text:`条件${i}`}],isError:false,timestamp:i});
 messages.push({role:"user",content:"读取第二次查询",timestamp:121},{role:"toolResult",toolName:"business_context_read",toolCallId:"current-call",content:[{type:"text",text:"精确引用"}],isError:false,timestamp:121});
 const before=JSON.stringify(messages),view=workingMessages(messages,1800);
 expect(contextEstimate(view)).toBeLessThan(2000);expect(view.slice(-2)).toEqual(messages.slice(-2));expect(JSON.stringify(messages)).toBe(before);expect(view.length).toBeLessThan(10);
});

it("失权历史屏蔽整轮，其他合法回合及身份保留，不输出旧金额",async()=>{
 const messages=[{role:"user" as const,text:"旧问题",timestamp:1,entry_id:"u1"},{role:"assistant" as const,text:"private-amount",tools:[],timestamp:2,entry_id:"a1"},{role:"user" as const,text:"新问题",timestamp:3,entry_id:"u2"},{role:"assistant" as const,text:"合法结果",tools:[],timestamp:4,entry_id:"a2"}];
 const view=await redactInaccessibleHistory(messages,async turn=>{if(turn[0]!.entry_id==="u1")throw new HistoryAuthorizationError("HISTORY_PERMISSION_DENIED",403);});
 expect(JSON.stringify(view)).not.toContain("private-amount");expect(view[1]!.entry_id).toBe("a1");expect(view[3]).toEqual(messages[3]);expect(messages[1]!.text).toBe("private-amount");
});

it("权限缓存只在请求内复用，下一轮撤权重新核验",async()=>{
 const f=await setup(),a=f.request("a");expect(await scopeAvailable(a,["O1"])).toBe(true);
 vi.mocked(f.backend.resolveBusinessField).mockResolvedValue({status:"not_found"});
 expect(await scopeAvailable(a,["O1"])).toBe(true);expect(await scopeAvailable(f.request("b"),["O1"])).toBe(false);
});

it("全部已选机构排序由完整范围推导条数，不能从日期或机构数量猜TopN",async()=>{
 const f=await setup(),request=f.request("rank-all","查询合成机构甲、合成机构乙2025年末的合成指标甲，从高到低排序");
 const result=await new SemanticPlanService(request).resolve(proposal([...complete().map(op=>op.field==="organizations"?{...op,value:"合成机构甲、合成机构乙"}:op),{action:"rank_all",field:"operation",direction:"descending"}]));
 expect(result.status,JSON.stringify(result.issues)).toBe("ready");
 const plan=await request.semanticTasks!.plan(result.state.task_ref!);const task=await request.semanticTasks!.get(plan!.steps[0]!.taskRef!);
 expect(task!.target.fields.operation!.resolvedValue).toEqual({kind:"ranking",position:"top",top_n:2});
});


it("普通排序表达不依赖模型选择rank_all，方向仍须与原句一致",async()=>{
 const f=await setup();
 const build=(value:string)=>proposal([...complete().map(op=>op.field==="organizations"?{...op,value:"合成机构甲、合成机构乙"}:op),{action:"set",field:"operation",value}]);
 const ok=await new SemanticPlanService(f.request("plain-sort","查询合成机构甲、合成机构乙2025年末的合成指标甲，按指标值从高到低排名")).resolve(build("按指标值从高到低排名"));
 expect(ok.status,JSON.stringify(ok.issues)).toBe("ready");
 const wrong=await new SemanticPlanService(f.request("wrong-sort","查询合成机构甲、合成机构乙2025年末的合成指标甲，按指标值从高到低排名")).resolve(build("按指标值从低到高排名"));
 expect(wrong.status).not.toBe("ready");expect(f.backend.basicQueries).not.toHaveBeenCalled();
});


it("新增动作经过真实公开Schema：排序属于operations，不能伪装成source",()=>{
 const input=proposal([{action:"rank_all",field:"operation",direction:"descending"},{action:"copy",field:"metrics",reference:{task_ref:"p",target_ref:"t"}},{action:"select",field:"organizations",offset:0,limit:2}],{kind:"references",references:[{task_ref:"p",target_ref:"t"}]});
 expect(prepareSemanticArguments(input)).toEqual(input);
 expect(()=>prepareSemanticArguments({...input,targets:[{source:{action:"rank_all",field:"operation",direction:"descending"},operations:[]}]})).toThrow("SHAPE_INVALID");
});


it("用户明确序号直接签发有权来源，错误读取在工具边界拒绝而非只禁直出",async()=>{
 const f=await setup(),plans=[];
 for(const [id,org] of [["old-first","合成机构甲"],["old-second","合成机构乙"]]){
  const request=f.request(id!,`查询${org}2025年末的合成指标甲`);
  const result=await new SemanticPlanService(request).resolve(proposal(complete().map(op=>op.field==="organizations"?{...op,value:org!}:op)));
  const p=(await request.semanticTasks!.plan(result.state.task_ref!))!;
  await runTool(createSemanticExecuteTool(),{task_ref:p.ref,target_ref:p.steps[0]!.targetRef},request);plans.push(p);
 }
 const request=f.request("read-first","重新展示本对话第一次查询的正式结果，不要重新查询");
 await request.semanticTasks!.admit(request.operationId,request.originalMessage);
 const expected=await requestedHistory(request);expect(expected.map(row=>row.task_ref)).toEqual([plans[0]!.ref]);
 const before=f.backend.getTaskResult.mock.calls.length;
 const wrong=await runTool(createSemanticReadTool(),{task_ref:plans[1]!.ref,target_ref:plans[1]!.steps[0]!.targetRef},request);
 expect(wrong.details.issues[0].code).toBe("HISTORY_QUERY_ORDINAL_MISMATCH");expect(f.backend.getTaskResult).toHaveBeenCalledTimes(before);
 const right=await runTool(createSemanticReadTool(),{task_ref:plans[0]!.ref,target_ref:plans[0]!.steps[0]!.targetRef},request);
 expect(right.details.status).toBe("reused");expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
 expect((await request.semanticTasks!.admit("after-view","日期改成2024年末，其他条件不变")).context?.plan?.ref).toBe(plans[1]!.ref);
 expect((await request.semanticTasks!.runtimeContext()).current_task_ref).toBe(plans[1]!.ref);
 expect((await request.semanticTasks!.planIndex()).focus).toBe(plans[1]!.ref);
 const continuedRequest=f.request("after-view","日期改成2024年末，其他条件不变");
 const continued=await new SemanticPlanService(continuedRequest).resolve(proposal([{action:"set",field:"time",value:"2024年末"}],{kind:"current"}));
 expect(continued.status,JSON.stringify(continued.issues)).toBe("ready");
 await runTool(createSemanticExecuteTool(),{task_ref:continued.state.task_ref,target_ref:continued.state.targets[0]!.target_ref},continuedRequest);
 expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({org_codes:["O2"],time:{start:"2024-12-31",end:"2024-12-31"}});
 expect(referencedQueryNumbers("指标沿用第一次查询，日期沿用第十二次查询，不是前3家")).toEqual([1,12]);
 const mismatch=f.request("read-wrong-org","展示第一次查询中合成机构乙的结果");await mismatch.semanticTasks!.admit(mismatch.operationId,mismatch.originalMessage);
 const rejected=await runTool(createSemanticReadTool(),{task_ref:plans[0]!.ref,target_ref:plans[0]!.steps[0]!.targetRef},mismatch);
 expect(rejected.details.issues[0].code).toBe("HISTORY_READ_SCOPE_MISMATCH");
 vi.mocked(f.backend.resolveBusinessField).mockResolvedValue({status:"not_found"});
 const revoked=f.request("read-revoked","重新展示第二次查询的正式结果");await revoked.semanticTasks!.admit(revoked.operationId,revoked.originalMessage);
 const denied=await runTool(createSemanticReadTool(),{task_ref:plans[1]!.ref,target_ref:plans[1]!.steps[0]!.targetRef},revoked);
 expect(denied.details.status).toBe("denied");
});


it("权限目录临时故障传播为503，不能伪装撤权或沿用缓存放行",async()=>{
 const f=await setup();vi.mocked(f.backend.resolveBusinessField).mockResolvedValue({status:"temporary_error"});
 await expect(scopeAvailable(f.request("unavailable"),["O1"])).rejects.toMatchObject({status:503,code:"HISTORY_AUTHORIZATION_UNAVAILABLE"});
});


it("明确不沿用条件不能被来源修复带回旧机构日期",async()=>{
 const f=await setup();await new SemanticPlanService(f.request("reset-origin","查询合成机构甲2025年末的合成指标甲")).resolve(proposal(complete()));
 const request=f.request("reset-new","新问题，不沿用已有条件：帮我查合成指标甲");
 await expect(new SemanticPlanService(request).resolve(proposal([],{kind:"current"}))).rejects.toMatchObject({issue:{code:"CONTEXT_RESET_SOURCE_CONFLICT"}});
 const normalized=await new SemanticPlanService(request).resolve(proposal(complete()));
 expect(normalized.status).toBe("needs_user"); expect(normalized.issues.map(issue=>issue.field)).toEqual(expect.arrayContaining(["organizations","time"]));
 const clean=await new SemanticPlanService(request).resolve(proposal([{action:"set",field:"metrics",value:"合成指标甲"}]));
 expect(clean.status).toBe("needs_user");
 const saved=(await request.semanticTasks!.plan(clean.state.task_ref!))!;const target=(await request.semanticTasks!.get(saved.steps[0]!.taskRef!))!.target;
 expect(Object.keys(target.pending)).toEqual(expect.arrayContaining(["organizations","time"]));
 expect(target.fields.organizations?.resolutionStatus).not.toBe("resolved");expect(target.fields.time?.resolutionStatus).not.toBe("resolved");
 expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("历史组唯一公式展开一次计算，各原来源及历史结果保留且不重查",async()=>{
 const f=await setup(),refs=[];
 for(const [id,date]of [["calc-old-a","2025年末"],["calc-old-b","2024年末"]]){
  const request=f.request(id!,`查询合成机构甲${date}的合成指标甲`),ready=await new SemanticPlanService(request).resolve(proposal(complete().map(op=>op.field==="time"?{...op,value:date!}:op)));
  const p=(await request.semanticTasks!.plan(ready.state.task_ref!))!;await runTool(createSemanticExecuteTool(),{task_ref:p.ref,target_ref:p.steps[0]!.targetRef},request);refs.push({task_ref:p.ref,target_ref:p.steps[0]!.targetRef});
 }
 const request=f.request("calc-group","用两次历史结果计算差额，不要重新查询");
 const result=await new SemanticPlanService(request).resolve(proposal([{action:"set",field:"calculation",value:"`2025年末合成指标甲` - `2024年末合成指标甲`"}],{kind:"references",references:refs},"calculate"));
 expect(result.status,JSON.stringify(result.issues)).toBe("ready");const plan=(await request.semanticTasks!.plan(result.state.task_ref!))!;
 expect(plan.steps.map(step=>step.kind)).toEqual(["query","query","calculation"]);expect(plan.steps[2]!.dependencies).toHaveLength(2);expect(f.backend.basicQueries).toHaveBeenCalledTimes(2);
 await expect(new SemanticPlanService(f.request("calc-label","给来源分别命名")).resolve(proposal([{action:"set",field:"objective",value:"甲"},{action:"set",field:"objective",value:"乙"}],{kind:"references",references:refs},"calculate"))).rejects.toMatchObject({issue:{code:"FIELD_MULTIPLE_ASSIGNMENTS"}});
});


it("多目标单笔修改须有来源线索，歧义持久化后明确机构可继续原日期修改",async()=>{
 const f=await setup();const first=f.request("ambiguity-origin","查询合成机构甲2025年末的合成指标甲；查询合成机构乙2024年末的合成指标甲");
 const result=await new SemanticPlanService(first).resolve({protocol_version:2,intent:"query",targets:[{source:{kind:"new"},operations:complete()},{source:{kind:"new"},operations:complete().map(op=>op.field==="organizations"?{...op,value:"合成机构乙"}:op.field==="time"?{...op,value:"2024年末"}:op)}]});
 expect(result.status,JSON.stringify(result.issues)).toBe("ready");
 const ref={kind:"reference" as const,task_ref:result.state.task_ref!,target_ref:result.state.targets[0]!.target_ref};
 const ambiguous=f.request("ambiguity-next","把那一家的日期改为2025年末");
 await expect(new SemanticPlanService(ambiguous).resolve(proposal([{action:"set",field:"time",value:"2025年末"}],ref))).rejects.toMatchObject({issue:{code:"TARGET_SELECTION_AMBIGUOUS",remediation:"user"}});
 const saved=await ambiguous.semanticTasks!.admit("ambiguity-resume","我说的是合成机构甲那一笔，指标不变");expect(saved.context?.clarification).toBeDefined();
 const reply=f.request("ambiguity-resume","我说的是合成机构甲那一笔，指标不变");
 const resumed=await new SemanticPlanService(reply).resolve({...proposal([{action:"set",field:"time",value:"2025年末"}],ref),context_action:"resume"});
 expect(resumed.status,JSON.stringify(resumed.issues)).toBe("ready");expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("同次查询部分撤权时，用全部旧签发身份识别点名机构，不能先读取另一有权机构",async()=>{
 const f=await setup(),first=f.request("read-mixed-origin","查询合成机构甲2025年末的合成指标甲；查询合成机构乙2025年末的合成指标甲");
 const ready=await new SemanticPlanService(first).resolve({protocol_version:2,intent:"query",targets:[{source:{kind:"new"},operations:complete()},{source:{kind:"new"},operations:complete().map(op=>op.field==="organizations"?{...op,value:"合成机构乙"}:op)}]});
 expect(ready.status,JSON.stringify(ready.issues)).toBe("ready");const plan=(await first.semanticTasks!.plan(ready.state.task_ref!))!;
 for(const step of plan.steps)await runTool(createSemanticExecuteTool(),{task_ref:plan.ref,target_ref:step.targetRef},first);
 const resolve=f.backend.resolveBusinessField.getMockImplementation()!;
 f.backend.resolveBusinessField.mockImplementation(async(entity,raw,...rest)=>entity==="organization"&&raw.includes("O2")?{status:"not_found"}:resolve(entity,raw,...rest));
 f.backend.getTaskResult.mockClear();
 const request=f.request("read-mixed-denied","重新展示第一次查询中合成机构乙那一笔的正式结果");await request.semanticTasks!.admit(request.operationId,request.originalMessage);
 const denied=await runTool(createSemanticReadTool(),{task_ref:plan.ref,target_ref:plan.steps[0]!.targetRef},request);
 expect(denied.details.status).toBe("denied");expect(f.backend.getTaskResult).not.toHaveBeenCalled();
 const call=(f.backend as unknown as {inspectBusinessGoal:ReturnType<typeof vi.fn>}).inspectBusinessGoal.mock.calls.find(call=>call[4]);
 expect(call?.[4]).toMatchObject({conversation_id:"synthetic-conversation",session_id:request.sessionId,sources:expect.arrayContaining([expect.objectContaining({spec:expect.objectContaining({org_codes:["O2"]})})])});
});

it("多机构value加单个suggestion仍完整发送原始集合，不能只解析建议机构",async()=>{
 const f=await setup();
 const suggested=vi.fn(async(entity:string,_suggestions:unknown,_options:unknown,source:string,raw:string[])=>f.backend.resolveBusinessField(entity,raw,undefined,undefined,{source_question:source}));
 Object.assign(f.backend,{resolveBusinessFieldSuggestion:suggested});
 const request=f.request("multi-org-hint","查询合成机构甲、合成机构乙2025年末的合成指标甲");
 const result=await new SemanticPlanService(request).resolve(proposal(complete().map(op=>op.field==="organizations"?{...op,value:"合成机构甲、合成机构乙",suggestion:{name:"合成机构甲",excerpt:"合成机构甲"}}:op)));
 expect(result.status,JSON.stringify(result.issues)).toBe("ready");
 expect(suggested).toHaveBeenCalledWith("organization",[{name:"合成机构甲",excerpt:"合成机构甲"}],expect.anything(),request.originalMessage,["合成机构甲","合成机构乙"]);
 const plan=(await request.semanticTasks!.plan(result.state.task_ref!))!,task=(await request.semanticTasks!.get(plan.steps[0]!.taskRef!))!;
 expect(task.target.fields.organizations!.resolvedValue).toMatchObject({codes:["O1","O2"]});expect(f.backend.basicQueries).not.toHaveBeenCalled();
});

it("入场模型投影只包含有发布证明的当前问题和可信点击",async()=>{
 const f=await setup();
 const initial=f.request("pending-context","查合成机构甲2025年末的待定指标");
 const first=await new SemanticPlanService(initial).resolve(proposal(complete().map(operation=>operation.field==="metrics"?{...operation,value:"待定指标"}:operation)));
 const question=first.pending_questions[0]!;
 const request=f.request("answer-context","用第二个");
 request.questionPublicationProof=async candidate=>candidate.question_id===question.question_id;
 await request.semanticTasks!.admit(request.operationId,request.originalMessage,undefined,undefined,{actorId:request.actor.id,
  answers:[{question_id:question.question_id,version:question.version,choice:{type:"select",option_ids:[question.options[1]!.option_id]},source:{channel:"click",operation_id:request.operationId}}],
  publicationProof:request.questionPublicationProof});
 const projected=await permissionFilteredAdmission(request);
 expect(projected?.pending_questions).toEqual([expect.objectContaining({question_id:question.question_id,version:question.version,options:question.options})]);
 expect(projected?.trusted_answers).toEqual([{question_id:question.question_id,version:question.version,choice:{type:"select",option_ids:[question.options[1]!.option_id]}}]);
 const unproven=f.request("unproven-context","用第二个");
 await unproven.semanticTasks!.admit(unproven.operationId,unproven.originalMessage);
 expect((await permissionFilteredAdmission(unproven))?.pending_questions).toEqual([]);
});
