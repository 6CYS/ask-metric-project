/**
 * 一次性延迟探针：用合成文本（不含任何业务数据）测量模型网关的 TTFT 与总耗时，
 * 并对照 enable_thinking / no_think / 缓存命中对单次调用延迟的影响。
 * 用法：npx tsx --env-file-if-exists=.env scripts/probe-model-latency.ts
 */
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const url = `${config.model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
const headers: Record<string, string> = {"Content-Type": "application/json"};
if (config.model.authPrefix.trimEnd()) headers[config.model.authHeader] = `${config.model.authPrefix.trimEnd()} ${config.model.apiKey}`;
else headers[config.model.authHeader] = config.model.apiKey;

/** 合成填充文本：把同一段中文重复到目标字符数，约等于目标 token 数 */
function filler(chars: number): string {
  const unit = "某省级金融机构的县域网点在季度末的存款余额与贷款余额口径说明。";
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

type Probe = { label: string; extra?: Record<string, unknown>; suffix?: string; chars?: number; repeat?: number };

const probes: Probe[] = [
  {label: "基线 6k tokens", chars: 9000},
  {label: "同前缀第二次（缓存）", chars: 9000, repeat: 2},
  {label: "enable_thinking=false", chars: 9000, extra: {"enable_thinking": false}},
  {label: "/no_think 后缀", chars: 9000, suffix: "\n/no_think"},
  {label: "短上下文 1k tokens", chars: 1500},
];

for (const probe of probes) {
  const messages = [
    {role: "system", content: "你是问数助手，请简洁回答。"},
    {role: "user", content: filler(probe.chars ?? 9000) + "\n请只回答：已读取。" + (probe.suffix ?? "")},
  ];
  const body = {
    model: config.model.name,
    messages,
    max_tokens: 256,
    stream: true,
    ...config.model.extraBody,
    ...probe.extra,
  };
  const runs = probe.repeat ?? 1;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    let ttft: number | null = null;
    let firstContentAt: number | null = null;
    let usage: Record<string, unknown> = {};
    try {
      const response = await fetch(url, {method: "POST", headers, body: JSON.stringify(body)});
      if (!response.ok || !response.body) {
        console.log(`${probe.label} #${index + 1} -> HTTP ${response.status} ${(await response.text()).slice(0, 120)}`);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        ttft ??= performance.now() - started;
        buffer += decoder.decode(value, {stream: true});
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const event = JSON.parse(payload) as {choices?: {delta?: {content?: string; reasoning_content?: string}}[]; usage?: Record<string, unknown>};
            const delta = event.choices?.[0]?.delta;
            if (delta?.reasoning_content && firstContentAt === null) firstContentAt = performance.now() - started;
            if (delta?.content && firstContentAt === null) firstContentAt = performance.now() - started;
            if (event.usage) usage = event.usage;
          } catch { /* 半行 */ }
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      }
      const total = performance.now() - started;
      console.log(
        `${probe.label} #${index + 1} -> 首字节 ${(ttft ?? -1).toFixed(0)}ms | 首内容 ${(firstContentAt ?? -1).toFixed(0)}ms | 总计 ${total.toFixed(0)}ms | usage ${JSON.stringify(usage)}`,
      );
    } catch (error) {
      console.log(`${probe.label} #${index + 1} -> 失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
