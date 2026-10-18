/** 真实端到端验收入口：生产 HTTP/宿主/工具不变，仅隔离原生记录并节流模型请求。 */
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {setTimeout} from 'node:timers/promises';
import {loadConfig} from '../../src/config.js';
import {HarnessHost} from '../../src/harnessHost.js';
import {createAskMetricModels} from '../../src/models.js';
import {NativeSessionStore,acquireWriterLock} from '../../src/nativeSessions.js';
import {loadBusinessSkills,createBusinessSkillReadTool} from '../../src/businessSkills.js';
import {createAskMetricTools} from '../../src/tools/index.js';
import {createApp} from '../../src/routes.js';
import type {BackendUser} from '../../src/backendClient.js';
const config={...loadConfig(),port:8022,dataDir:'../.runtime/tool-governance/native'};
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(config.backendBaseUrl).hostname)) throw new Error('验收仅允许本机后端');
class PacedHost extends HarnessHost {
  override async createSession(actor:BackendUser) {
    const session=await super.createSession(actor);
    session.harness.hooks.on('before_request',async()=>{await setTimeout(5_000);});
    return session;
  }
}
const release=acquireWriterLock(config.dataDir);
const store=new NativeSessionStore(config.dataDir);
const skills=await loadBusinessSkills();
const host=new PacedHost(config,authorize=>createAskMetricModels(config,authorize),store,
  [...createAskMetricTools(),createBusinessSkillReadTool(skills)],{skills});
const app=new Hono();
app.use('*',cors({origin:'http://127.0.0.1:5173',allowHeaders:['Authorization','Content-Type'],allowMethods:['GET','POST','OPTIONS']}));
app.route('/',createApp(config,host,store));
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:config.port});
process.on('SIGTERM',()=>server.close(async()=>{await host.close();await store.close();release();process.exit(0);}));
console.log('验收服务监听127.0.0.1:8022，真实配置、独立原生记录、每次模型请求节流5秒。');
