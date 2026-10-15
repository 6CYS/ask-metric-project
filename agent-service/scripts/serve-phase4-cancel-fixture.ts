/** 只用于accepted时序验收：真实HTTP/身份，模型在本地等待取消，绝不调用外部模型或执行业务查询。 */
import assert from 'node:assert/strict';
import {serve} from '@hono/node-server';
import {createAssistantMessageEventStream,createModels,createProvider,type AssistantMessage,type Model,type ProviderStreams} from '@earendil-works/pi-ai';
import {loadConfig} from '../src/config.js';
import {HarnessHost} from '../src/harnessHost.js';
import {NativeSessionStore,acquireWriterLock} from '../src/nativeSessions.js';
import {createAskMetricTools} from '../src/tools/index.js';
import {createApp} from '../src/routes.js';
assert(process.argv.includes('--cancel-fixture'));
const config={...loadConfig(),host:'127.0.0.1',port:8023,dataDir:'/private/tmp/ask-metric-phase4-stop-fixture',businessProtocol:'semantic_v2' as const};assert.equal(new URL(config.backendBaseUrl).hostname,'127.0.0.1');
const model:Model<'openai-completions'>={id:'phase4-local-cancel',name:'phase4-local-cancel',api:'openai-completions',provider:'phase4-local-cancel',baseUrl:'http://local-fixture.invalid',reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
let calls=0;
const respond:ProviderStreams['streamSimple']=(current,context,options)=>{
 const stream=createAssistantMessageEventStream();calls++;console.log(JSON.stringify({event:'local_cancel_fixture_model_started',calls,external_model:false}));
 const message:AssistantMessage={role:'assistant',content:[],api:current.api,provider:current.provider,model:current.id,stopReason:'aborted',errorMessage:'local cancellation fixture',timestamp:Date.now(),usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 let finished=false;const end=()=>{if(finished)return;finished=true;stream.push({type:'error',reason:'aborted',error:message});stream.end(message);console.log(JSON.stringify({event:'local_cancel_fixture_aborted',calls,external_model:false}));};
 queueMicrotask(async()=>{await options?.onPayload?.({tools:context.tools?.map(tool=>({type:'function',function:tool}))??[]},current);if(options?.signal?.aborted)end();else options?.signal?.addEventListener('abort',end,{once:true});});return stream;
};
const models=createModels();models.setProvider(createProvider({id:model.provider,name:model.name,models:[model],auth:{apiKey:{name:'local-fixture',resolve:async()=>({auth:{}})}},api:{stream:respond,streamSimple:respond}}));
const unlock=acquireWriterLock(config.dataDir),store=new NativeSessionStore(config.dataDir),host=new HarnessHost(config,()=>({models,model}),store,createAskMetricTools()),app=createApp(config,host,store);
const server=serve({fetch:app.fetch,hostname:config.host,port:config.port},()=>console.log('phase4 cancel fixture listening on 127.0.0.1:8023; external_model=false'));
const close=()=>server.close(async()=>{await host.close();await store.close();unlock();process.exit(0);});process.on('SIGINT',close);process.on('SIGTERM',close);
