# 10:31 请求停留在“正在理解”的只读诊断

本次仅检查既有原生记录、日志和代码，使用本地 Schema 重放验证未执行的参数；没有新增真实模型请求，没有执行数据库查询，没有修改业务代码或运行配置。

## 结论

指标识别已完成。截图中的等待发生于第一次模型工具参数响应流尚未正常结束、宿主尚未执行工具的阶段。之后约 62 秒出现取消请求并落为 aborted。不能将该等待归因于纠错算法、查询 SQL 或恢复循环；本轮尚未进入这些执行步骤。

后续用户已确认：因等待过久主动结束本轮。取消来源现已明确，本次不是程序自行超时；上游响应流为何未正常结束仍缺少原始终止事件证据。

工具参数输出期间，页面仍显示泛化的“理解问题，确定处理方式”，缺少“正在生成业务请求参数”的阶段反馈。与此同时，已输出的参数确实包含入口结构错误，直接用当前工具 Schema 离线验证失败；它们是正常结束后可能继续触发纠错的问题，不是此前等待的直接原因。

## 已观察证据

- request：`af25c0fc-a138-46db-b53a-2472195e1dc9`。
- session：`01a13840-2e12-7172-bae8-0e48c4efe797`。
- operation：`01a13840-2e2e-7172-bae8-0e4a75269580`。
- 原生 JSONL：`agent-service/data/native-v1/u_46c20338f84cfc35fddd56937467806a/--Users-yubobo-Documents-服务项目-江苏农信-ask-metric-intent-goldendb-Harness-agent-service-data-native-v1--/2026-10-14T02-31-32-626Z_01a13840-2e12-7172-bae8-0e48c4efe797.jsonl`。
- 首次模型输出约 3665 ms；第 14 行为 `resolve_business_turn` 的 toolcall_start。
- 随后有 104 个 toolcall_delta、累计 997 字符；累计 JSON 可以解析，但没有 toolcall_end 或正常 done。
- 第 119 行为 cancel_requested；第 120 行 assistant.stopReason=aborted，错误为“模型请求已取消”；第 121 行 pi.result.status=aborted。操作总耗时约 62270 ms。
- 日志 model_usage：输入 14213 tokens、输出 399 tokens、payload_bytes=62362、duration_ms=62249；实际业务工具执行记录和工具耗时均为空。

这些记录不能进一步拆分供应商生成、网络和本地流消费各自耗时，也不能证明供应商是否已经发出 finish_reason；没有原始 SSE 结束元数据。累计 JSON 闭合不等于模型响应协议已正常结束，不宜在结束前执行该工具。

## 本地验证的入口错误

只把原生记录中的累计工具参数送入 `validateToolArguments`，没有执行工具处理函数：

1. `fieldIntents` 被输出为 `{metric_query:{organizations:...,metrics:...}}`；现契约要求字段直接位于 fieldIntents 下。离线返回 `fieldIntents.metric_query.sourceText` 缺少所需属性及额外属性错误。
2. 排名输出 `{kind:'ranking',position:'top',top_n:null}`；正常 ranking 的 top_n 必须是整数，缺项应走已有 clarify 分支。单独核验 operation.inputSchema 失败。

字段声明说明目前附带按能力分组的要求映射，而实际提交是扁平字段映射；这可能增加模型误读成本，是需处理的契约表达风险，尚不能据单次输出断言唯一因果。当前请求携带约 14k 输入 tokens，也提示首轮模型材料偏重，但仅凭本次记录不能将全部延迟归因于上下文长度。

## 后续外层与内层 Schema 边界复核

仅运行本地 `validateToolArguments`，不执行处理函数。legacy 和 compact 各验证三种输入，六次外层校验均接受：不存在的字段名、`metrics:{unexpected:true}`、`operation:{kind:'ranking',position:'top',top_n:null}`。后两种由能力字段的 inputSchema 拒绝，不存在的字段由业务注册表与合并层拒绝。外层接受不代表可以查询。

具体边界：legacy 的 fieldHint 是普通字符串、rawValue 是 Type.Unknown；compact 的字段值同样是 Type.Unknown 且 set.additionalProperties=true。fieldIntents 的每项三键已有固定结构，真实记录中的错误 capability 嵌套会被外层拒绝；它的字段名本身仍是开放 Record。能力字段的严格 inputSchema 另附在系统提示词中，没有嵌入对应真实工具参数位置。当前工具也未声明 SDK constrainedSampling；不能把本地拒绝校验等同于模型端已经启用结构化约束生成。

因此需收紧的是模型面对的字段及值类型，并减少双份修改声明，而不是删除后端校验。应从现有能力注册表生成强类型入口，保留旧 Frame/参数的内部兼容及当前权限、来源、口径和执行门禁。上述事实可解释错形输入的空间和后续纠错负担，但不单独证明本次响应流等待的全部原因。

## 代码位置与验证边界

- `agent-service/src/harnessHost.ts:701-727`：首轮读取上下文和识别指标后，播报泛化模型活动标签。
- `agent-service/src/answerStream.ts:49-67`：业务工具参数不作为用户正文展示。
- `agent-service/src/tools/businessContext.ts:30-41`：能力要求说明和实际 fieldIntents 输入契约。
- `agent-service/src/models.ts:46-65`：输出进度重置空闲计时；持续输出没有固定总时长中断。本次不是旧的 120 秒 deadline 故障。

上一轮离线回归证明确定输入下的程序契约、确认恢复及执行门禁；本地编排的模型事件会完整结束，未验证真实模型的慢流、结束协议与这份错误形状的实际生成概率。下一步应针对工具入口表达负担、未决控制值输入和真实流式阶段反馈收束，并用本次既有记录增加离线重放，不以增加业务限制或默认前 10 名解决等待。
