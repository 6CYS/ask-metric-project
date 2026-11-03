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
import { createSessionEvaluationClient } from "./evaluation/sessionClient.js";
import { EvaluationStore } from "./evaluation/store.js";
import { EvaluationService } from "./evaluation/service.js";

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
    [...createAskMetricTools({ topicsEnabled: config.topicQueryEnabled ?? false }), createBusinessSkillReadTool(skills)],
    { skills },
  );
  // 复用同一组会话路由和鉴权；内部请求不绕开当前账号权限，也不另建 Agent。
  const evaluationClient = createSessionEvaluationClient((path, init) => Promise.resolve(app.request(path, init)));
  let evaluations: EvaluationService | undefined;
  try {
    evaluations = new EvaluationService(new EvaluationStore(config.dataDir), evaluationClient, config);
  } catch {
    // 独立维护模块不可用时保留现有问数服务，测评接口明确返回不可用。
    console.error("测评存储初始化失败，测评接口暂不可用");
  }
  const app = createApp(config, host, store, evaluations);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`ask-metric-agent-service listening on ${info.address}:${info.port}`);
  });

  const shutdown = () => {
    const evaluationShutdown = evaluations?.shutdown().catch(() => {
      console.warn("测评任务未能在停机前完全结束，下次启动将标记为中断");
    });
    server.close(async () => {
      await evaluationShutdown;
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
