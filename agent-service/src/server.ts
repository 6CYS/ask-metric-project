/**
 * 服务入口：加载运行配置（敏感项支持 SM4 密文），初始化原生会话宿主与 HTTP 路由。
 * 会话/上下文/压缩/执行状态全部归 pi 原生能力，本服务只做鉴权、接线与投影。
 */
import { loadBusinessSkills, createBusinessSkillReadTool } from "./businessSkills.js";
import { serve } from "@hono/node-server";
import { loadRuntimeConfig } from "./nacosConfig.js";
import { createAskMetricModels } from "./models.js";
import { HarnessHost } from "./harnessHost.js";
import { acquireWriterLock, NativeSessionStore } from "./nativeSessions.js";
import { createAskMetricTools } from "./tools/index.js";
import { createApp } from "./routes.js";

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  // 单数据根单写实例：多副本共写 JSONL 会破坏原生存储，直接拒绝启动
  const releaseLock = acquireWriterLock(config.dataDir);
  const store = new NativeSessionStore(config.dataDir);
  const skills = await loadBusinessSkills();
  const host = new HarnessHost(
    config,
    (authorize) => createAskMetricModels(config, authorize),
    store,
    [...createAskMetricTools(), createBusinessSkillReadTool(skills)],
    { skills },
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

void main().catch((error: unknown) => {
  // 启动配置错误只输出受控提示，避免原生错误对象带请求、凭据或响应。
  console.error(error instanceof Error ? error.message : "Agent 启动失败");
  process.exitCode = 1;
});
