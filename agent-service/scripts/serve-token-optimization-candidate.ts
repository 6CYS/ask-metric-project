/** 私有数据根上的冻结候选浏览器验收入口，不修改当前服务或运行配置文件。 */
import {pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import {appendFile} from 'node:fs/promises';
import {serve} from '@hono/node-server';
const arg = (key: string, fallback: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const root = resolve(arg('source-root', '/private/tmp/ask-metric-token-optimization-20261015/candidate-final-2/agent-service'));
console.log('candidate browser bootstrap: importing frozen modules');
const module = async (name: string) => import(pathToFileURL(join(root, 'src', `${name}.ts`)).href);
const [{loadConfig}, {NativeSessionStore, acquireWriterLock}, {loadBusinessSkills, createBusinessSkillReadTool}, {HarnessHost}, {createAskMetricModels}, {createAskMetricTools}, {createApp}] =
  await Promise.all(['config', 'nativeSessions', 'businessSkills', 'harnessHost', 'models', 'tools/index', 'routes'].map(module));
const config = {...loadConfig(), port: Number(arg('port', '8025')), host: '127.0.0.1',
  dataDir: resolve(arg('data-dir', '/private/tmp/ask-metric-token-optimization-20261015/browser-native-final-2')), businessProtocol: 'semantic_v2' as const};
config.backendBaseUrl = arg('backend-base-url', config.backendBaseUrl);
if (!['http://127.0.0.1:8010', 'http://127.0.0.1:8015'].includes(config.backendBaseUrl)) throw new Error('ONLY_CONFIRMED_DEVELOPMENT_BACKEND');
const auditFile = arg('audit-file', '');
if (auditFile) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const kind = url.origin === new URL(config.model.baseUrl).origin ? 'model_request'
      : url.origin === new URL(config.backendBaseUrl).origin && url.pathname === '/api/v1/basic-queries' && init?.method === 'POST'
        ? 'basic_query_submission' : undefined;
    // 浏览器恢复验证只计请求类型，不记录请求正文、令牌、金额或完整 URL。
    if (kind) await appendFile(resolve(auditFile), `${JSON.stringify({at: new Date().toISOString(), kind})}\n`, {mode: 0o600});
    return originalFetch(input, init);
  };
}
console.log('candidate browser bootstrap: loading isolated native root and skills');
const release = acquireWriterLock(config.dataDir), store = new NativeSessionStore(config.dataDir), skills = await loadBusinessSkills();
const host = new HarnessHost(config, (authorize: any) => createAskMetricModels(config, authorize), store,
  [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
const app = createApp(config, host, store);
console.log('candidate browser bootstrap: starting local HTTP server');
const server = serve({fetch: app.fetch, hostname: config.host, port: config.port}, () => console.log(`frozen token optimization candidate listening on 127.0.0.1:${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => {
  await host.close(); await store.close(); release(); process.exit(0);
}));
