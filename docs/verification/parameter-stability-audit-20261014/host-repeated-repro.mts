import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createAssistantMessageEventStream,createModels,createProvider} from "../../../agent-service/node_modules/@earendil-works/pi-ai/dist/index.js";
import {BACKGROUND_CONTEXT} from "../../../agent-service/node_modules/@earendil-works/pi-agent-core/dist/index.js";
import {HarnessHost} from "../../../agent-service/src/harnessHost.ts";
import {NativeSessionStore} from "../../../agent-service/src/nativeSessions.ts";
import {NativeFrameStore} from "../../../agent-service/src/business-context/store.ts";
import {createAskMetricTools} from "../../../agent-service/src/tools/index.ts";
import {projectEntries} from "../../../agent-service/src/sessionProjection.ts";
function testConfig(dataDir: string, compaction?: any): any {
  return {
    host: "127.0.0.1",
    port: 0,
    backendBaseUrl: "http://127.0.0.1:1",
    backendTimeoutMs: 1000,
    model: {
      baseUrl: "http://faux.local",
      name: "faux-1",
      apiKey: "",
      authHeader: "Authorization",
      authPrefix: "Bearer",
      userMessageSuffix: "",
      extraBody: {},
      contextWindow: 128_000,
      maxTokens: 8192,
    },
    dataDir,
    compaction: compaction ?? { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    modelRetry: { enabled: true, maxRetries: 1, baseDelayMs: 1_000 },
  };
}

const model:any={id:"faux-1",name:"faux-1",api:"openai-completions",provider:"faux",baseUrl:"http://faux.invalid",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8192};
function faux(script:any[]){let count=0;const respond=(m:any,c:any,o:any)=>{const r=script[Math.min(count++,script.length-1)];const stream=createAssistantMessageEventStream();const msg:any={role:"assistant",content:r.content,stopReason:r.stopReason??"toolUse",...(r.errorMessage?{errorMessage:r.errorMessage}:{}),api:m.api,provider:m.provider,model:m.id,timestamp:Date.now(),usage:{input:100,output:20,totalTokens:120,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(async()=>{await o?.onPayload?.({tools:c.tools?.map((tool:any)=>({type:"function",function:tool}))??[]},m);stream.push({type:"start",partial:msg});stream.push(msg.stopReason==="error"?{type:"error",reason:"error",error:msg}:{type:"done",reason:msg.stopReason,message:msg});stream.end(msg);});return stream;};const provider=createProvider({id:"faux",name:"faux",models:[model],auth:{apiKey:{name:"faux",resolve:async()=>({auth:{}})}},api:{stream:respond,streamSimple:respond}} as any);const models=createModels();models.setProvider(provider);return{models,model,get calls(){return count}};}
const actor:any={id:"review-user",username:"review",org_code:"O",org_name:"合成机构",role_code:"tester"};
const valid:any={protocol_version:1,capability:"metric_query",base:null,mode:"execute",changes:{metrics:{action:"set",value:{fromQuestion:true}},organizations:{action:"set",source_text:"合成机构",expected_count:null,value:{kind:"name",name:"合成机构"}},time:{action:"set",value:"2026年4月30日"},selection:{action:"set",value:"exact"}}};
const bad:any={...structuredClone(valid),changes:{...structuredClone(valid.changes),metrics:{action:"set",value:{mentionIndexes:[99]}},organizations:{action:"set",source_text:"另一个机构",expected_count:null,value:{kind:"name",name:"另一个机构"}}}};
const tool=(id:string,args:any)=>({type:"toolCall",id,name:"resolve_business_turn",arguments:args});
async function main(){const oldInfo=console.info;console.info=()=>{};const dir=mkdtempSync(join(tmpdir(),"readonly-host-review-"));let queries=0;const f=faux([{content:[tool("first",bad)]},{content:[tool("second",bad)]},{content:[],stopReason:"error",errorMessage:"MODEL_TOOL_PROTOCOL_ERROR: synthetic broken output"}]);const store=new NativeSessionStore(dir);const host=new HarnessHost(testConfig(dir),()=>({models:f.models,model:f.model}),store,createAskMetricTools());const backend:any={
matchMetricQuestion:async(question:string)=>({mentions:[{text:"合成指标",start:question.indexOf("合成指标"),end:question.indexOf("合成指标")+4,resolution:{status:"resolved",value:{codes:["M"],names:["合成指标"]}}}]}),
resolveBusinessField:async(entity:string,names:string[])=>({status:"resolved",value:entity==="date"?{start:"2026-04-30",end:"2026-04-30"}:{codes:[entity==="organization"?"O":"M"],names}}),
createAgentQueryContext:async()=>({conversation_id:"synthetic"}),basicQueries:async()=>{queries++;return{result:{task_id:"synthetic-review-task",status:"succeeded",rows:[],columns:[],row_count:0}};},getTask:async()=>({task_id:"synthetic-review-task",status:"SUCCEEDED",version:1,result:{result_id:"synthetic-review-result"}})};
try{const s=await host.createSession(actor);const out=await host.runPrompt(s,{protocol_version:3,request_id:"review-batch",message:"查询合成机构2026年4月30日合成指标，再查询另一个机构的指标"},{actor,backend});const entries=await s.lane.findEntries({order:"oldestFirst"},BACKGROUND_CONTEXT);const msgs=projectEntries(entries);console.log(JSON.stringify({case:"repeat-then-model-error",queries,providerCalls:f.calls,result:out,answers:msgs.filter(x=>x.role==="assistant"&&x.text),receipts:msgs.filter(x=>x.role==="tool").map((x:any)=>({tool:x.tool,details:x.details})),frames:(await new NativeFrameStore(s.session).list()).map(x=>({status:x.status,frameId:x.frameId}))},null,2));}finally{await host.close();await store.close();rmSync(dir,{recursive:true,force:true});console.info=oldInfo;}}
main().catch(e=>{console.error(e);process.exitCode=1});
