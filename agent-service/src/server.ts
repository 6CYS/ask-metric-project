/**
 * 服务入口：加载运行配置（敏感项支持 SM4 密文），初始化原生会话宿主与 HTTP 路由。
 * 会话/上下文/压缩/执行状态全部归 pi 原生能力，本服务只做鉴权、接线与投影。
 */
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createAskMetricModels } from "./models.js";
import { HarnessHost } from "./harnessHost.js";
import { acquireWriterLock, NativeSessionStore } from "./nativeSessions.js";
import { createAskMetricTools } from "./tools/index.js";
import { createApp } from "./routes.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // 单数据根单写实例：多副本共写 JSONL 会破坏原生存储，直接拒绝启动
  const releaseLock = acquireWriterLock(config.dataDir);
  const store = new NativeSessionStore(config.dataDir);
  const host = new HarnessHost(
    config,
    (authorize) => createAskMetricModels(config, authorize),
    store,
    createAskMetricTools(),
  );
  const app = createApp(config, host, store);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`ask-metric-agent-service listening on ${info.address}:${info.port}`);
  });

  const shutdown = () => {
    server.close(async () => {
      // 正确关闭：停止接纳并关闭原生句柄，不删除任何历史
      await host.close();
      await store.close();
      releaseLock();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
