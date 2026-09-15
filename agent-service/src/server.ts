/**
 * 服务入口：加载运行配置（敏感项支持 SM4 密文），初始化 pi 模型网关与 Agent 管理器。
 */
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createAskMetricModels } from "./models.js";
import { AgentManager } from "./agentManager.js";
import { createApp } from "./routes.js";

function main(): void {
  const config = loadConfig();
  const modelBundle = createAskMetricModels(config);
  const manager = new AgentManager(config, modelBundle);
  const app = createApp(config, manager);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`ask-metric-agent-service listening on ${info.address}:${info.port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
