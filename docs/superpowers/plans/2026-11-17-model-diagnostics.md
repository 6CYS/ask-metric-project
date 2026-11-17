# 模型诊断实施计划

**Goal:** 提供管理员可使用的当前问数模型流式诊断。
**Architecture:** Agent 提供受现有鉴权保护的配置摘要与 SSE 检测接口；前端独立面板消费真实进度和终态。复用模型创建、配置快照与错误分类，不建立另一套模型配置。
**Tech Stack:** TypeScript、Hono、现有 pi-ai 客户端、Vue、现有基础组件。
**Spec:** [模型诊断设计](../specs/2026-11-17-model-diagnostics.md)。

## 约束与接口

遵循设计中的权限、一次请求、512 token、60 秒、10 秒间隔和每实例一个检测限制。只做桌面验证，不改变旧页签行为。新功能不自动提交或推送。

- `GET /model-diagnostics` 返回 `DiagnosticTarget`：`model`、`configuration_source: file|database`、`configuration_version: string|null`、`first_response_timeout_ms`、`stream_idle_timeout_ms`、`max_duration_ms`、`cooldown_ms`。
- `POST /model-diagnostics` 不接受配置输入，返回 SSE。`started` 数据为 `{diagnostic_id, started_at, target}`；`progress` 为 `{phase:'receiving', first_output_ms}`；`result` 为 `DiagnosticResult`。心跳只保活。
- `DiagnosticResult`：`diagnostic_id, started_at, finished_at, target, status: succeeded|failed|cancelled, first_output_ms:number|null, duration_ms:number, error_code:string|null, message:string, model_response`。`model_response` 包含 `http_status:number|null, content:string, error:string, error_source:http|client|null, truncated:boolean`；前端兼容旧服务端不返回此字段。
- HTTP 拒绝使用 `{code, detail}`；频率限制附 `retry_after_ms`。模型故障通过 SSE 失败终态表达。主提示使用受控文案，详情展示脱敏后的返回内容，检测编号便于关联日志。
- 浏览器中止请求即停止检测；无结果终态就断流必须显示连接中断，不能判为成功。

## Task 1：服务端诊断

- [x] 新增 `agent-service/src/modelDiagnostics.ts` 和对应测试：先覆盖真实客户端边界的权限、已生效配置、成功、429、超时、断流、取消及频率限制，再实现。
- [x] 在 `agent-service/src/routes.ts` 现有登录鉴权之后挂载路由；无需修改 Python 接口或数据库结构。
- [x] 使用 `createAskMetricModels`、`databaseAgentRuntimeSnapshot` / `materializeAgentRuntime`、`modelFailure`；在每次检测开始重新解析配置并在 started/result 返回同一份摘要。
- [x] 运行相关测试、类型和新文件静态检查，记录结果。

## Task 2：前端诊断面板

- [x] 新增类型、`modelDiagnosticsApi.ts` 与诊断面板；先验证 SSE 解码、无终态断流、权限失败和取消。
- [x] `LlmView.vue` 新增模型诊断页签，诊断面板独立于配置草稿及保存权限；沿用现有组件与字号。
- [x] 检测中显示真实阶段和已用时，完成后显示带时间的结果、配置来源、首输出及总耗时，错误原因与排查编号按需展示。离开页面清理请求与计时器。
- [x] 运行相关前端测试、类型和构建。

## Task 3：集成验证

- [x] 检查实际 diff 和独立评审；确认凭据、配置草稿不会泄露，返回正文仅在检测详情内按需展示且不写入诊断日志。
- [x] 重启本地 Agent，使用现有浏览器登录状态完成桌面真实模型检测。
- [x] 独立故障服务的桌面错误与停止验证：通过原生桌面控制完成 HTTP 429 错误详情、复制与卡顿后停止检测；网关状态确认活动请求归零。
- [x] 报告实际范围、运行入口及内网未验收限制。

## Review Focus

- 页面卸载、切换页签和迟到事件不能覆盖新检测。
- 服务端收到取消及并发请求时释放限额，失败不能保留假绿灯。
- 数据库配置变更以开始检测时的快照为准，不能显示旧模型信息。
- HTTP 200 或有效片段不等于完整成功；每次请求不静默重试。
- 登录过期遵循现有处理，模型凭据失败不能误踢应用登录。

## 本次局部改动：直接展示返回内容

- [x] 后端先补返回内容回归，再在本次诊断内捕获 HTTP 状态、错误响应和正文；敏感内容脱敏、限制长度、保持取消和零重试，日志不带正文。仅修改 `modelDiagnostics.ts` 及其测试，必要的局部辅助文件置于同目录。
- [x] 前端类型/API 接受可选 `model_response`；测试字段解析及旧协议兼容后，在详情区用纯文本展示/复制返回内容，不修改其他页面。
- [x] 相关测试、类型、新增文件 lint 与构建通过后重启本地 Agent，验证真实返回和已有页面行为。

## 实际验证记录（2026-11-17）

- 服务端诊断 24 项测试通过，包含真实 Node HTTP 适配器空 POST；原有模型传输集成 3 项通过。
- 前端诊断 7 项测试通过，与既有取消、故障呈现测试合跑共 38 项通过。
- 前后端类型检查、构建、新文件 ESLint/Prettier、diff 检查通过。LlmView 原有 3 项 lint 问题已对照 HEAD 确认，没有在本任务中扩大修改；构建保留既有大包提示。
- 本地 Agent 已重启且 ready；桌面键盘启动真实模型检测成功，首次输出约 1.6 秒、总耗时约 1.8 秒。仅代表该次短请求，不作为稳定性能结论。
- 初版浏览器扩展自动化连续超时，故障界面与停止按钮验证在下述局部改动验收中通过原生桌面控制补齐。未验证内网网关和实际 Chrome 83 浏览器；旧版取消接口兼容性由回归覆盖。
- 没有变更 Python 模型配置、聊天业务流程或数据库结构。新增配置快照取消参数为可选，旧调用保持兼容。

### 返回内容展示验收

- 服务端诊断共 42 项测试通过，前端 API 与返回展示共 11 项测试通过；前后端类型、相关文件 lint/格式及构建通过。独立评审发现的嵌套凭据及不完整凭据泄露场景已修复并补回归。
- 本地 Agent 重新构建并重启。真实模型检测返回 HTTP 200，正文“连接正常。”；13:47 的该次请求首次输出 2.7 秒、总耗时 2.8 秒，详情和复制反馈已在桌面确认。
- 隔离故障实例返回 HTTP 429 时，详情展示网关 JSON 中的 `rate_limit_exceeded` 和 `QPM rate limit exceeded`；复制反馈正常，应用登录保持有效。
- 隔离首次输出卡顿场景点击停止后，界面显示“本次检测已停止”；测试网关累计 2 个请求、关闭 2 个、活动 0 个，没有自动重试。
- 仅上述故障由隔离服务注入；真实模型成功使用当前生效服务。内网实际网关仍需部署后验证，不将本地结果作为内网可用性保证。
