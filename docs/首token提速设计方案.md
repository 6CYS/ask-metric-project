# 智能问数首 token 提速设计方案

> 适用范围：`agent-service`（Pi 宿主）与 `frontend-vue`（问数页面）。后端 `backend-next` 不改。
> 本文档面向开发者（含 AI 开发助手），按阶段给出可直接实施的设计、改动点、测试与验收标准。

## 0. 硬约束（所有阶段必须遵守）

1. **不影响功能**：任何阶段都不得改变业务校验、权限、Frame 状态机、查询执行、结果快照与会话存档的语义；不得使任何当前能回答的问题变成无法回答。
2. **最终结果以原有路径为准**：本轮结束时的 `snapshot` / `run_terminal` 仍由原生会话记录投影生成，是页面唯一权威内容。新增的一切（流式文本、精简参数）都只是“更早地展示”或“更短地表达”，不能替代最终投影。
3. **失败即降级**：新增逻辑出错时必须回落到当前行为（不流式 / 旧参数格式），不得中断本轮驱动、不得吞掉回答。
4. **可开关、可回退**：每个阶段一个独立配置开关，关闭即完全恢复现行为；上线顺序为“默认关闭 → 测试环境开启 → 灰度 → 全量”。
5. **有回归门禁**：改变模型可见内容的阶段（二期）必须通过真实模型回归前后对比，不达标不合并。
6. **不做的事**：本方案不做网关缓存优化、不改后端查询与权限、不改业务 Frame 规则、不换模型（换模型列为可选项，另行评估）。

## 1. 现状与瓶颈（实测数据）

数据来源：真实模型回归 `scripts/check-query-intent-v2.ts --live`（47 用例 / 55 轮，模型 DeepSeek-V4-Flash，合成后端）及本地真实会话复测。

一次查数提问（中位数）：

```
0.1s   身份校验、历史权限复核、接纳
4.9s   第 1 次模型调用：首 token ~1.5s + 生成 resolve_business_turn 参数 239 token ~3.4s   ← 最大头
0.3s   工具执行（解析条件 + 就地执行查询）
2.8s   第 2 次模型调用：首 token ~1.5s + 生成回答 86 token ~1.3s
────── 本轮结束后才一次性显示全部回答：用户首字 ≈ 8～9 s
```

普通对话（问候、解释）：1 次调用，回答写在 `respond_without_business_action` 的 `answer` 参数里，写完才显示：7.7～10 s。

两个根因：

- **R1 不流式**：`agent-service/src/sessionProjection.ts` 的 `projectWatchEvent` 丢弃 `message_update`，前端只在最终 `snapshot` 时显示正文。用户首字 = 整轮完成时间。
- **R2 第 1 次调用输出过长**：`resolve_business_turn` 参数是 `fieldChanges: [{fieldHint, operation, rawValue}, …]` 结构，每个字段重复包装。实测参数中位 488 字符，改为扁平结构可降至 251 字符（-49%）。

## 2. 总体方案与预期收益

| 阶段 | 内容 | 是否改变模型可见内容 | 预计收益 | 风险 |
|---|---|---|---|---|
| 零期 | 首字耗时埋点 | 否 | 可度量 | 无 |
| 一期 | 回答流式展示（查数回答 + 普通对话回答） | 否 | 普通对话首字 7.7～10s → 1.5～3s；查数首字提前约 1.3s | 低 |
| 二期 | `resolve_business_turn` 参数扁平化 | **是** | 查数每轮约 -2s | 中（需回归门禁） |
| 三期（可选，需产品决定） | 简单查询用后端确定性回答，省第 2 次调用 | 否 | 查数首字再 -2.8s | 回答风格变化 |

预计效果：查数首字 8～9s → 一期+二期后约 4.5～5s（加三期约 3～3.5s）；普通对话首字 7.7～10s → 约 1.5～3s。

实施顺序：零期 → 一期 → 二期 →（产品确认后）三期。每期独立提交、独立开关。

---

## 3. 零期：首字耗时埋点（先做，用于验收）

**目标**：线上可直接读到“用户多久看到第一个字”，每期验收都用它，不靠估算。

改动：

1. `agent-service/src/requestContext.ts` 的 `timings` 增加：
   - `firstVisibleAt?: number`：本请求第一次向浏览器发送回答正文（一期的 `answer_delta`；无流式时为最终 `snapshot`）的时刻。
   - `modelFirstTokenMs: number[]`：每次模型调用从 `before_request` 到第一个 `message_update` 的耗时。
2. `agent-service/src/routes.ts` 提问路由：在发送首个正文事件时写 `firstVisibleAt`；`run_terminal.timings_ms` 与 `agent_request_timing` 日志增加 `first_visible_ms`、`model_first_token_ms`。
3. 前端诊断面板可选展示 `first_visible_ms`（不强制）。

验收：本地一轮查数与一轮普通对话，日志中出现上述两个字段且数值合理。

---

## 4. 一期：回答流式展示

### 4.1 设计要点

- **只多发、不替换**：新增 SSE 事件把“正在生成的回答”提前推给页面；本轮结束时照旧发送 `snapshot` + `run_terminal`，页面以最终快照整体替换流式文本。
- **只在“这次调用的正文就是最终回答”时流式**：由宿主在每次模型调用前（`before_payload`，此时已知本轮状态）判定流式模式，路由按模式转发。
- **能撤回**：一旦发现本次调用不是最终回答（例如正文后又出现工具调用），发送撤回事件，页面清空临时文本，回到“处理中”。
- **不影响模型与存档**：流式只读 `watch` 事件，不改原生记录、不改发送给模型的上下文、不改 `after_response` 逻辑。

### 4.2 SSE 协议（向后兼容）

新增两个事件，协议版本仍为 3。旧前端 `parseSseBlock` → `onEvent` 会忽略未知事件类型，行为不变。

```jsonc
// 事件名 answer_delta：累计文本（不是增量片段），重复或丢失任意一条都不影响正确性
{"protocol_version":3, "session_id":"…", "operation_id":"…", "request_id":"…",
 "call_seq": 2,                 // 本请求内第几次模型调用，从 1 开始
 "mode": "text" | "reply",      // text=助手正文；reply=普通对话工具的 answer 参数
 "text": "截至目前生成的完整文本"}

// 事件名 answer_reset：撤回该次调用已推送的临时文本
{"protocol_version":3, …, "call_seq": 2, "reason": "tool_call" | "retry" | "error" | "superseded"}
```

发送节流：同一 `call_seq` 至少间隔 80ms 合并发送一次；调用结束（`message_end`）时补发最后一次。

### 4.3 服务端：流式模式判定（`agent-service/src/harnessHost.ts`）

在 `AskMetricRequestContext` 增加：

```ts
/** 本次模型调用的流式模式；由 before_payload 按本轮状态判定，路由据此转发 watch 事件。 */
answerStream?: {callSeq: number; mode: "none" | "text" | "reply"};
```

在 `before_payload` 钩子**每个 return 分支之前**设置 `request.answerStream`（`callSeq` 每次调用 +1）。判定规则（与现有分支一一对应）：

| 当前 `before_payload` 分支 | 流式模式 | 理由 |
|---|---|---|
| `step` 为 `compaction` / `branch_summary` | `none` | 不是回答 |
| 本轮用户消息不是 `businessProtocol: "frame_v1"`（旧协议回合） | `none` | 旧协议回合展示时有证据核验（`safeUnverifiedText`），不能先显示 |
| `conversationAnswer(current) !== undefined`（兜底：已有普通回答后又请求模型） | `none` | 输出会被 `after_response` 替换为原回答 |
| `NEEDS_CLARIFICATION` 分支（`tool_choice: "none"`） | `text` | 正文即澄清问题；宿主追加的候选清单会在最终快照中出现 |
| `pendingBusinessAction` 强制指定工具 | `none` | 本次必然是工具调用 |
| `contractActive && !hasTurnAction(current)`（`tool_choice: "required"`） | `reply` | 只可能是工具调用；若选普通对话工具，流式其 `answer` 参数 |
| 其他（本轮已有业务动作、可自由作答） | `text` | 通常是最终回答；若随后出现工具调用则撤回 |

另外：`before_request` 中若 `event.attempt > 1`（模型重试），路由需对上一次同 `call_seq` 已推送的文本发送 `answer_reset(reason:"retry")`。

### 4.4 服务端：事件转发（新增纯函数模块 `agent-service/src/answerStream.ts`）

新建可单测的状态机，路由只负责接线：

```ts
export class AnswerStreamProjector {
  constructor(private readonly send: (type: "answer_delta" | "answer_reset", data: object) => void, private readonly throttleMs = 80) {}
  /** 每个 watch 事件调用一次；mode 取自 request.answerStream（读取时的当前值）。 */
  onWatchEvent(event: WatchEvent, stream: {callSeq: number; mode: "none" | "text" | "reply"} | undefined): void;
  /** 本轮结束或异常时调用：清理定时器，不再发送。 */
  close(): void;
}
```

处理规则（只处理 `type === "message_update"` 且 `message.role === "assistant"`）：

- `mode === "text"`：
  - `text_delta`：取 `event.event.partial` 中所有 text 块拼接为累计文本，节流发送 `answer_delta(mode:"text")`。
  - `toolcall_start`：若本 `call_seq` 已推送过文本 → 发送 `answer_reset(reason:"tool_call")`，并对本次调用停止推送（`after_response` 会丢弃带工具调用消息的正文，见 `harnessHost.ts` 中 `if (hasCalls) return {…filter(block => block.type !== "text")}`）。
- `mode === "reply"`：
  - `toolcall_start` / `toolcall_delta`：定位 `partial.content[contentIndex]`，仅当其 `name === "respond_without_business_action"` 时，读取 pi 已增量解析的 `arguments.answer`（pi-ai 在流式中用 `parseStreamingJson` 维护 partial 参数，见 `node_modules/@earendil-works/pi-ai/dist/utils/assistant-message-frame.js`），为字符串且变长时节流发送 `answer_delta(mode:"reply")`。
  - 同一消息出现第二个工具调用（`contentIndex` 不同）→ `answer_reset(reason:"superseded")` 并停止（`after_response` 的 `conflictingAnswer` 会改为纠错调用）。
  - 其他工具名：不推送。
- `mode === "none"` 或 `undefined`：忽略。
- 任一次调用 `message_end` 的消息 `stopReason` 为 `error` / `aborted`，且本 `call_seq` 已推送 → `answer_reset(reason:"error")`。
- 发现 `request.answerStream.callSeq` 变化（新一次调用开始），而上一次调用推送过文本、且上一次调用以工具调用结束 → `answer_reset(reason:"superseded")`。

**防护**：`onWatchEvent` 整体 `try/catch`；异常时记录 `answer_stream_failed` 日志并将本请求的 projector 置为禁用，不影响驱动与最终快照。

### 4.5 路由接线（`agent-service/src/routes.ts` 提问路由）

在现有 `watch.start(...)` 回调中，保留 `projectWatchEvent` 的原有转发，追加：

```ts
if (config.answerStreaming) projector.onWatchEvent(event, admitted.request.answerStream);
```

`drivePrompt` 结束后（无论成功失败）先 `projector.close()` 再发送 `snapshot` 与 `run_terminal`（顺序不可颠倒：最终快照必须在最后一条流式事件之后）。

断线重连的 `/sessions/:id/stream` 路由**不做流式**（没有请求上下文），保持现状：重连后看到快照与终态。

### 4.6 配置开关

`agent-service/src/config.ts` 增加 `answerStreaming: boolean`，读取 `AGENT_ANSWER_STREAMING`（默认 `false`）；同步 `agent-service/.env.example` 与 `deploy/package/runtime/agent.env.example`。

### 4.7 前端（`frontend-vue`）

1. `src/lib/agentApi.ts` 的 `AgentStreamEvent` 类型增加 `answer_delta` / `answer_reset`。
2. `src/components/chat/BackendNextChatPanel.vue` 事件处理：
   - `answer_delta`：写入当前待答气泡的 `provisionalContent`（新字段，与最终 `content` 分开），按现有 markdown 渲染显示；气泡保持 `pending` 状态（停止按钮、进度仍可用）。
   - `answer_reset`：清空 `provisionalContent`，恢复进度展示。
   - `snapshot` / `run_terminal`：维持现有逻辑（`applyAgentSnapshot` 整体替换消息），并清空 `provisionalContent`。**最终内容一律以快照为准。**
3. 若 `run_terminal` 表示失败：按现有失败展示，临时文本不得残留。
4. 临时文本不写入 localStorage、不参与导出与复制。

### 4.8 测试（必须全部新增）

服务端（vitest，模型桩，不访问后端）：

1. `answerStream.spec.ts`（纯函数）：
   - text 模式：多次 `text_delta` → 累计文本、节流合并、`message_end` 补发最后一次。
   - text 模式后出现 `toolcall_start` → 发送 reset 且之后不再推送。
   - reply 模式：`respond_without_business_action` 的 `answer` 逐步变长 → 推送；其他工具不推送；出现第二个工具调用 → reset。
   - `stopReason: "error"` → reset；projector 内部异常 → 不抛出、之后不再推送。
2. `harnessHost` 判定：对 4.3 表格每一行构造场景，断言 `request.answerStream.mode`。
3. 路由端到端（扩展 `routes.test.ts`）：
   - 查数轮：`answer_delta` 出现在最后一次调用期间；最后一条 `answer_delta.text` 与最终 `snapshot` 最后一条助手正文一致；`run_terminal` 在所有流式事件之后。
   - 普通对话轮：出现 `mode:"reply"` 的 `answer_delta`；最终快照回答与之一致；只调用 1 次模型。
   - 开关关闭：不出现任何 `answer_*` 事件，其余事件序列与改动前完全一致（对比现有用例快照）。
4. 现有全部测试保持通过。

前端（vitest）：`answer_delta` 显示、`answer_reset` 清空、`snapshot` 覆盖、失败终态不残留临时文本。

### 4.9 验收

- 真实模型：本地各跑 10 轮普通对话与 10 轮查数（含澄清、历史追问），`first_visible_ms` 中位：普通对话 ≤ 3.5s，查数较零期基线下降 ≥ 1s。
- 功能：`check-query-intent-v2 --live` 通过率不低于基线（本阶段不改模型可见内容，理论上应完全一致）；所有轮次最终快照内容与关闭开关时一致（抽查 10 轮比对）。
- 撤回率：`answer_reset` 次数 / 有流式的调用次数 ≤ 5%（日志统计），超过则分析原因后再全量。

---

## 5. 二期：`resolve_business_turn` 参数扁平化

### 5.1 新参数格式（对模型暴露）

```jsonc
{
  "capability": "metric_query",          // 原 capabilityHint，可省略
  "base": null,                          // 原 baseReference：省略=当前焦点；null=独立问题；对象=历史选择器（结构不变）
  "mode": "execute",                     // 原 executionMode："execute" | "resolve_more" | "reuse_result"
  "set":    {"metrics": {"fromQuestion": true}, "time": "2026年4月末", "selection": "exact"},  // 每个键=字段名，值=原 rawValue
  "remove": {"metrics": {"mentionIndexes": [2]}},     // 原 operation=remove
  "clear":  ["organizations"],                        // 原 operation=clear
  "retain": ["time"]                                  // 原 operation=retain
}
```

语义与内部 `ContextDelta` 一一对应，**不新增、不删除任何能力**：

| 新 | 内部 `ContextDelta` |
|---|---|
| `capability` | `capabilityHint` |
| `base`（含省略与 `null` 的区别） | `baseReference`（省略→不设置该键；`null`→`null`） |
| `mode` | `executionMode` |
| `set[k] = v` | `fieldChanges.push({fieldHint:k, operation:"set", rawValue:v})` |
| `remove[k] = v` | `{fieldHint:k, operation:"remove", rawValue:v}` |
| `clear: [k]` | `{fieldHint:k, operation:"clear"}` |
| `retain: [k]` | `{fieldHint:k, operation:"retain"}` |

同一字段在多个分组出现 → 参数错误（`FIELD_CHANGES_INVALID`，沿用现有错误码与“原焦点未改变”语义）。

### 5.2 兼容与转换（`agent-service/src/business-context/turnArgs.ts`，新建）

```ts
/** 新旧两种参数格式统一转换为内部 ContextDelta；无法识别时抛 BusinessInputError（不猜测）。 */
export function toContextDelta(args: unknown): ContextDelta;
/** 内部 ContextDelta 转为新格式（历史发送副本、开关开启时的在途兼容使用）。 */
export function toCompactTurnArgs(delta: ContextDelta): Record<string, unknown>;
/** 内部 ContextDelta 转为旧格式（开关关闭回滚时的在途兼容使用）。 */
export function toLegacyTurnArgs(delta: ContextDelta): Record<string, unknown>;
```

接入点：

1. `tools/businessContext.ts` 的 `createResolveBusinessTurnTool`：`parameters` 按开关选择新/旧 schema；`execute` 内先 `toContextDelta(params)` 再调用 `service.resolve`。**两种格式都接受**。
2. **在途与异常兼容**：在 `resolve_business_turn` 工具定义上实现 pi 的 `prepareArguments(args)`，把参数统一转换为**当前 schema 所要求的格式**：开关开启时旧格式→新格式（`toCompactTurnArgs(toContextDelta(args))`）；开关关闭（回滚）时新格式→旧格式（`turnArgs.ts` 另提供 `toLegacyTurnArgs(delta)`）。两种格式都无法识别时原样返回，由 schema 校验给出参数错误。
   **不能放在 `before_tool` 钩子**：pi 的执行顺序是 `prepareArguments` → `validateToolArguments`（schema 校验）→ `before_tool`（见 `node_modules/@earendil-works/pi-agent-core/dist/harness/execution/tools.js`），旧格式会在进入 `before_tool` 之前就被判为参数错误。升级前在途的操作、模型偶发沿用历史格式都靠 `prepareArguments` 兼容。
   注意 `withToolExecutionAudit`（`toolAudit.ts`）以 `{...tool, execute}` 包装工具，会保留 `prepareArguments`，实施时用测试确认。
3. **历史发送副本一致性**：`modelContext.ts` 的 `projectHistoricalResults` 中，把历史助手消息里 `resolve_business_turn` 的 toolCall 参数转换为新格式（只改发送副本），避免模型看到新旧两种写法混杂。原生记录不改。
4. 回执、确定性续跑（`continuation.ts`）只涉及 `execute_business_frame` / `read_business_result` 的 `{frameId}`，不受影响；实施时逐一确认。

### 5.3 模型可见文字同步清单

开关开启时，以下文案中的 `fieldChanges` / `fieldHint` / `operation` / `retain` / `capabilityHint` / `baseReference` / `executionMode` 必须同步改为新写法（建议集中为常量，按开关选择）：

- `src/prompts/businessSystemPrompt.ts`
- `src/tools/businessContext.ts`（工具描述、`errorReceipt`、各 `message` 纠错提示）
- `src/business-context/service.ts`（`BusinessInputError` 的 correction 文案，如“fieldChanges 必须为空数组”）
- `src/business-context/core.ts`、`resolvers.ts`、`inputError.ts`（纠错文案）
- `src/business-context/modelView.ts`（`modelCapabilitySchemas` 中“未改变则省略或 retain”等 input 说明、历史索引 usage 文案）
- `src/business-context/capabilities.ts`（字段 description）
- `skills/*/SKILL.md`（如提及参数写法）

核对方法：开关开启后，抓取一次完整发送 payload（系统提示词 + 工具定义 + 回执），`grep -E "fieldChanges|fieldHint|capabilityHint|baseReference|executionMode"` 结果必须为空（历史原生记录除外）。

### 5.4 配置开关

`AGENT_COMPACT_TURN_ARGS`（默认 `false`）。关闭时 schema、文案、转换全部保持现状；开启时仅改变对模型暴露的格式，内部逻辑不变。

### 5.5 测试

1. `turnArgs.spec.ts`：新↔旧双向转换覆盖 set/remove/clear/retain、`base` 省略/`null`/对象三种、同字段多分组报错、未知键报错。
2. 现有 `context.spec.ts`、`queryIntentV2.spec.ts` 等用例在**两种开关下各跑一遍**（参数化），全部通过。
3. `prepareArguments` 兼容：新 schema 下经原生工具循环提交旧格式参数，不产生参数错误回执，工具正常执行，结果与旧格式在旧 schema 下一致。
4. 发送副本：历史 toolCall 被转换为新格式；原生记录不变。
5. 文案扫描测试：开关开启时，构造的系统提示词与工具定义中不出现旧参数名。

### 5.6 回归门禁（不达标不合并）

在同一时间窗口内交替运行（先基线后新版本，再重复），每组 `--repeat 3`：

- `scripts/check-query-intent-v2.ts --live`
- `scripts/check-history-focus-model.ts`、`check-context-semantics.ts`、`check-multiturn-model.ts`、`check-confirmation-model.ts`、`check-metric-name-model.ts`、`check-metric-typo-model.ts`、`check-composed-model.ts`
- `scripts/tool-governance`（32 用例）

判定：

1. 任一用例“新版本 3 次中失败 ≥ 2 次、基线失败 ≤ 1 次” → 不合并，定位原因。
2. 总通过率不低于基线。
3. 第 1 次调用输出 token 中位数下降 ≥ 30%，`first_visible_ms`（查数）中位下降 ≥ 1.5s。

注意：对照版本需在独立副本中运行时，`scripts/check-query-intent-v2.ts` 与 `scripts/syntheticMetricResolver.ts` 中按 `import.meta.dirname` 定位 `backend-next` 的相对路径、`src/businessSkills.ts` 定位 `skills/` 的相对路径都要随之调整，否则对照结果无效。

---

## 6. 三期（可选，需产品决定）：简单查询确定性回答

- 条件：本轮只有一次 `execute_business_frame` 且成功、无计算/覆盖/澄清、回答无需解释。
- 做法：就地执行成功后，工具回执携带 `terminate: true`，页面直接展示后端 `render_fact_answer` 生成的 `message` / `answer_blocks`（后端已有），省去第 2 次模型调用。
- 影响：回答为固定模板风格，不再是模型组织的 markdown 文字；与“模型 markdown 原样渲染”方向不同，**需产品确认**。开关 `AGENT_DETERMINISTIC_SIMPLE_ANSWER`，默认关闭。

---

## 7. 上线与回滚

| 步骤 | 动作 | 回滚 |
|---|---|---|
| 1 | 合并零期 + 一期（开关默认关） | 无需 |
| 2 | 测试环境开启 `AGENT_ANSWER_STREAMING`，按 4.9 验收 | 关闭开关，重启 agent-service |
| 3 | 生产开启一期 | 同上 |
| 4 | 合并二期（开关默认关），按 5.6 门禁 | 无需 |
| 5 | 测试环境开启 `AGENT_COMPACT_TURN_ARGS`，观察 `first_visible_ms`、参数错误率（`ARGUMENT_ERROR` 回执占比）至少 1 天 | 关闭开关 |
| 6 | 生产开启二期 | 关闭开关（开关切换前后的在途操作由 `prepareArguments` 双向兼容） |

生产监控指标：`first_visible_ms` 中位/P90、`answer_reset` 比例、`ARGUMENT_ERROR` 回执占比、`run_terminal.answer_status != ok` 比例。任一指标较开启前明显变差即关闭对应开关。

## 8. 验证命令

```bash
cd agent-service
npx tsc -p tsconfig.json --noEmit
npx vitest run
node --env-file=.env --import tsx scripts/check-query-intent-v2.ts --live --repeat 3 --report /tmp/qi.json
cd ../frontend-vue && npx vue-tsc -b && npx vitest run
git diff --check
```
