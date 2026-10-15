import {readFileSync} from "node:fs";
import ts from "../../../frontend-vue/node_modules/typescript/lib/typescript.js";
import {withFailureNotice} from "../../../frontend-vue/src/lib/queryErrors.ts";
const src=readFileSync(new URL("../../../frontend-vue/src/components/chat/BackendNextChatPanel.vue", import.meta.url),"utf8");
function extract(name:string){const start=src.indexOf(`function ${name}(`);const end=src.indexOf("\n}\n",start)+3;return src.slice(start,end)}
const compiled=ts.transpileModule(extract("finalizeAssistantMessage")+"\n"+extract("conversationFromDetail"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
let id=0;
const restore=new Function("withFailureNotice","createId","historyTimestamp",compiled+";return conversationFromDetail;")(withFailureNotice,()=>`review-${++id}`,(x:number)=>new Date(x).toISOString());
const detail={running:false,legacy:false,messages:[{role:"user",text:"查询合成指标",timestamp:1},{role:"assistant",text:"本轮模型响应未完成",error:"本轮模型响应未完成",business_protocol:"frame_v1",timestamp:2},{role:"assistant",text:"自动重试后查询完成。",business_protocol:"frame_v1",timestamp:3}]};
console.log(JSON.stringify({case:"failed-attempt-then-success-history",restored:restore(detail)},null,2));
const stopCompiled="async "+extract("stopActiveConversation");let cancelCalls=0,observationAborts=0;
const stop=new Function("activeConversation","activeConversationIsSending","cancelAgentOperation","abortControllers",stopCompiled+";return stopActiveConversation;")({value:{id:"c",serverId:"s",activeOperationId:null}},{value:true},async()=>{cancelCalls++},new Map([["c",{abort(){observationAborts++}}]]));
await stop();console.log(JSON.stringify({case:"stop-before-accepted",cancelCalls,observationAborts}));
