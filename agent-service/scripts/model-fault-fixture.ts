/**
 * 本地模型故障验收入口。真实身份/业务后端 + 原生 Harness/SSE；仅模型 HTTP 端点注入失败。
 * 必须显式 --fault-fixture，全部监听回环地址，自动创建独立临时会话目录，不读取 .env 或模型密钥。
 */
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.js";
import { loadBusinessSkills, createBusinessSkillReadTool } from "../src/businessSkills.js";
import { HarnessHost } from "../src/harnessHost.js";
import { createAskMetricModels } from "../src/models.js";
import { NativeSessionStore, acquireWriterLock } from "../src/nativeSessions.js";
import { createApp } from "../src/routes.js";
import { createAskMetricTools } from "../src/tools/index.js";
import { createModelFaultGateway, isModelFaultScenario } from "./model-fault-gateway.js";

const argument = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
function boundedInteger(name: string, fallback: string, min: number, max: number) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid --${name}`);
  return value;
}

async function main() {
  if (!process.argv.includes("--fault-fixture"))
    throw new Error("显式提供 --fault-fixture 才能启动隔离故障验收服务");
  const port = boundedInteger("port", "18020", 1024, 65535);
  const modelPort = boundedInteger("model-port", "18321", 1024, 65535);
  const backendPort = boundedInteger("backend-port", "8010", 1024, 65535);
  if (
    port === modelPort ||
    port === backendPort ||
    modelPort === backendPort ||
    [8010, 8020, 5173].includes(port) ||
    [8010, 8020, 5173].includes(modelPort)
  )
    throw new Error("故障验收端口必须独立，不能占用现有开发服务端口");
  const scenario = argument("scenario", "rate-limit");
  if (!isModelFaultScenario(scenario)) throw new Error("unknown --scenario");
  const defaults = loadConfig({});
  const dataDir = await mkdtemp(join(tmpdir(), "ask-metric-model-fault-"));
  const config = {
    ...defaults,
    host: "127.0.0.1",
    port,
    dataDir,
    backendBaseUrl: `http://127.0.0.1:${backendPort}`,
    modelFirstResponseTimeoutMs: boundedInteger("first-timeout-ms", "30000", 100, 60000),
    modelStreamIdleTimeoutMs: boundedInteger("idle-timeout-ms", "10000", 100, 60000),
    modelRetry: {
      ...defaults.modelRetry,
      baseDelayMs: boundedInteger("retry-delay-ms", "1000", 100, 60000),
    },
    answerStreaming: true,
    compaction: { ...defaults.compaction, enabled: false },
    model: {
      ...defaults.model,
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      name: "local-fault-fixture",
      apiKey: "local-fixture-not-a-secret",
    },
  };
  const gateway = createServer(createModelFaultGateway(scenario));
  gateway.listen(modelPort, "127.0.0.1");
  await once(gateway, "listening");
  const release = acquireWriterLock(dataDir);
  const store = new NativeSessionStore(dataDir);
  const skills = await loadBusinessSkills();
  const host = new HarnessHost(
    config,
    (authorize) => createAskMetricModels(config, authorize),
    store,
    [...createAskMetricTools(), createBusinessSkillReadTool(skills)],
    { skills },
  );
  const app = createApp(config, host, store);
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    console.log(
      JSON.stringify({
        fixture: true,
        agent: `http://127.0.0.1:${port}`,
        modelControl: `http://127.0.0.1:${modelPort}/__fault/state`,
        scenario,
        dataDir,
        externalModel: false,
      }),
    );
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    gateway.closeAllConnections();
    gateway.close();
    server.close(() => {
      host
        .close()
        .then(() => store.close())
        .then(() => {
          release();
          process.exit(0);
        })
        .catch(() => {
          release();
          process.exit(1);
        });
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "故障验收服务启动失败");
  process.exit(1);
});
