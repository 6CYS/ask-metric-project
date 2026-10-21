import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./nacosConfig.js";
import { encryptConfigValue } from "./sm4ConfigCrypto.js";

const key = "00112233445566778899aabbccddeeff";
const bootstrap = { NACOS_CONFIG_ENABLED: "true", NACOS_SERVER_ADDR: "first:8848,second:8848",
  NACOS_CONFIG_GROUP: "NEW_GROUP", ASK_METRIC_CONFIG_SM4_KEY: key };
const runtime = { AGENT_MODEL_BASE_URL: "http://remote/v1", AGENT_MODEL_NAME: "remote",
  AGENT_MODEL_EXTRA_BODY: { enable_thinking: false } };
const security = { AGENT_MODEL_API_KEY: encryptConfigValue("remote-secret", Buffer.from(key, "hex")) };

describe("Nacos Agent 启动配置", () => {
  it("业务参数来自中心，环境变量不兜底，节点参数保留", async () => {
    const request = (async (url: string | URL | Request) => {
      const data = String(url).includes("security") ? security : runtime;
      return new Response(JSON.stringify({ code: 0, data: { content: JSON.stringify(data) } }));
    }) as typeof fetch;
    const config = await loadRuntimeConfig({ ...bootstrap, AGENT_MODEL_NAME: "local",
      AGENT_MODEL_API_KEY: "local", AGENT_DATA_DIR: "/state/agent" }, request);
    expect(config.model.name).toBe("remote");
    expect(config.model.apiKey).toBe("remote-secret");
    expect(config.model.extraBody).toEqual({ enable_thinking: false });
    expect(config.dataDir).toBe("/state/agent");
  });
  it("2.x 路由兼容且第一个节点故障时切换", async () => {
    const request = (async (url: string | URL | Request) => {
      const address = String(url);
      if (address.includes("first")) throw new Error("private detail");
      if (address.includes("/v3/")) return new Response("missing", { status: 404 });
      return new Response(JSON.stringify(address.includes("security") ? security : runtime));
    }) as typeof fetch;
    expect((await loadRuntimeConfig(bootstrap, request)).model.name).toBe("remote");
  });
  it("中心不可用时拒绝启动且不泄漏响应", async () => {
    const request = (async () => new Response("private secret", { status: 503 })) as typeof fetch;
    await expect(loadRuntimeConfig(bootstrap, request)).rejects.toThrow("无法从 Nacos");
  });
  it("未知字段、节点混入、明文密钥拒绝启动", async () => {
    for (const [data, secret] of [[{ ...runtime, TYPO: 1 }, security],
      [{ ...runtime, AGENT_DATA_DIR: "/bad" }, security], [runtime, { AGENT_MODEL_API_KEY: "plain" }]]) {
      const request = (async (url: string | URL | Request) => new Response(JSON.stringify({
        code: 0, data: { content: JSON.stringify(String(url).includes("security") ? secret : data) },
      }))) as typeof fetch;
      await expect(loadRuntimeConfig(bootstrap, request)).rejects.toThrow();
    }
  });
});
