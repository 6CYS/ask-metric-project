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
import { DatabaseSessionStore } from "./databaseSessions.js";
import { mysqlSessionDatabase } from "./sessionDatabase.js";
import { createAskMetricTools } from "./tools/index.js";
import { createApp } from "./routes.js";
import { createSessionEvaluationClient } from "./evaluation/sessionClient.js";
import { DatabaseEvaluationStore } from "./evaluation/databaseStore.js";
import { EvaluationStore } from "./evaluation/store.js";
import { EvaluationService } from "./evaluation/service.js";
import { BusinessSkillStore } from "./businessSkillStore.js";
import { databaseBusinessSkillSnapshot } from "./databaseBusinessSkills.js";
import { databaseInquiryTopicSnapshot } from "./databaseInquiryTopics.js";
import { databaseAgentRuntimeSnapshot, materializeAgentRuntime } from "./databaseAgentRuntime.js";
import { BackendClient } from "./backendClient.js";

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  // 单数据根单写实例：多副本共写 JSONL 会破坏原生存储，直接拒绝启动
  const sharedSessions = config.sessionStorage?.mode === "database";
  const releaseLock = sharedSessions ? () => {} : acquireWriterLock(config.dataDir);
  const store = sharedSessions
    ? new DatabaseSessionStore(config.dataDir, mysqlSessionDatabase(config.sessionStorage!.databaseUrl))
    : new NativeSessionStore(config.dataDir);
  if (store.cluster) {
    try { await store.cluster.ready(); }
    catch (error) {
      await store.close();
      if (error instanceof Error && error.message.startsWith("检测到本机会话历史")) throw error;
      throw new Error("共享会话数据库不可用或尚未完成迁移，拒绝启动", {cause: error});
    }
  }
  const databaseSkills = config.businessConfigurationStorage === "database";
  const skills = databaseSkills ? [] : await loadBusinessSkills();
  const skillStore = databaseSkills ? undefined : new BusinessSkillStore(config.dataDir, skills);
  const host = new HarnessHost(
    config,
    (authorize, runtime = config) => createAskMetricModels(runtime, authorize),
    store,
    [...createAskMetricTools({ topicsEnabled: databaseSkills || (config.topicQueryEnabled ?? false),
      databaseConfiguration: databaseSkills }), createBusinessSkillReadTool(skills)],
    databaseSkills ? { getSkillSnapshot: databaseBusinessSkillSnapshot,
      getTopicSnapshot: databaseInquiryTopicSnapshot, getRuntimeSnapshot: databaseAgentRuntimeSnapshot }
      : { getSkills: () => skillStore!.snapshot() },
  );
  // 复用同一组会话路由和鉴权；内部请求不绕开当前账号权限，也不另建 Agent。
  const evaluationClient = createSessionEvaluationClient((path, init, versions) => Promise.resolve(
    app.fetch(new Request(new URL(path, "http://evaluation.internal"), init), versions ? { evaluationConfigurationVersions: versions } : {}),
  ));
  let evaluations: EvaluationService | undefined;
  let databaseEvaluations: DatabaseEvaluationStore | undefined;
  try {
    const evaluationStore = store.cluster ? new DatabaseEvaluationStore(store.cluster.database) : new EvaluationStore(config.dataDir);
    if (evaluationStore instanceof DatabaseEvaluationStore) {
      await evaluationStore.ready();
      databaseEvaluations = evaluationStore;
    }
    evaluations = new EvaluationService(evaluationStore, evaluationClient, config, databaseSkills ? {
      configuration: async (token) => {
        const backend = new BackendClient(config.backendBaseUrl, token, config.backendTimeoutMs);
        const [runtime, skills] = await Promise.all([databaseAgentRuntimeSnapshot(backend), databaseBusinessSkillSnapshot(backend)]);
        const topic = runtime.document.topicQueryEnabled ? await databaseInquiryTopicSnapshot(backend) : undefined;
        return { config: materializeAgentRuntime(config, runtime.document), versions: {
          agentRuntimeVersion: runtime.version_id, businessSkillVersion: skills.version_id,
          ...(topic ? { inquiryTopicVersion: topic.version_id } : {}),
        } };
      },
    } : {});
  } catch {
    // 独立维护模块不可用时保留现有问数服务，测评接口明确返回不可用。
    console.error("测评存储初始化失败，测评接口暂不可用");
  }
  const app = createApp(config, host, store, evaluations, skillStore, async () => {
    await store.cluster?.ready();
    if (sharedSessions && (!evaluations || !databaseEvaluations)) return false;
    await databaseEvaluations?.ready();
    const response = await fetch(`${config.backendBaseUrl.replace(/\/+$/, "")}/health/ready`, {
      signal: AbortSignal.timeout(config.backendTimeoutMs),
    });
    return response.ok;
  });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`ask-metric-agent-service listening on ${info.address}:${info.port}`);
  });

  const shutdown = () => {
    const evaluationShutdown = evaluations?.shutdown().catch(() => {
      console.warn(sharedSessions ? "测评任务未能在停机前完全结束，需确认停止，不会自动重跑" : "测评任务未能在停机前完全结束，下次启动将标记为中断");
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
