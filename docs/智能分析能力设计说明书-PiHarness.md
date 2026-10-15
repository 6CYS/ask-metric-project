# 智能问数双模式设计说明书（精确问数 + 智能分析，基于 Pi Harness）

| 项    | 内容                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档版本 | V1.0（评审稿，替代 V0.1 草稿）                                                                                                                                                                      |
| 编写日期 | 2026-10-09                                                                                                                                                                                |
| 适用范围 | agent-service（Pi Harness 宿主、工具、Skill）、backend-next（假设策略、语义层）、frontend-vue（模式、计划、假设展示）                                                                                                     |
| 依赖版本 | `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` 0.85.1                                                                                                                          |
| 当前模型 | `deepseek-ai/DeepSeek-V4-Flash`（`agent-service/.env.example`）                                                                                                                             |
| 关联文档 | [pi-business-context.md](pi-business-context.md)、[metric-matching.md](metric-matching.md)、[calculation-tools.md](calculation-tools.md)、[tool-call-governance.md](tool-call-governance.md) |

## 0. 阅读指引

| 读者               | 建议阅读章节                 |
| ---------------- | ---------------------- |
| 领导 / 产品          | 1、5.1、5.2、16、17、19     |
| 架构评审             | 2、4、5、6、7、8、13、18、附录 A |
| agent-service 开发 | 4、6、7、8、9、12、13、附录 B   |
| backend-next 开发  | 8.3、10、14              |
| 前端开发             | 11                     |
| 测试               | 16                     |

### 术语

| 术语             | 含义                                           |
| -------------- | -------------------------------------------- |
| 精确问数           | 现有链路：一次问题对应一个 Frame，条件齐全后执行一次查询              |
| 智能分析           | 新链路：模型围绕业务目标自主规划，多次取数、计算并给出分析结论              |
| Frame          | 现有业务上下文中的“查询表单”，记录指标/机构/日期等字段的解析状态           |
| 假设（Assumption） | 系统代替用户做出的决定（默认日期、默认口径、相似度选择等），必须对用户可见、可修正    |
| 假设策略           | 字段解析时是否允许产生假设：`strict`（现状，不允许）/ `assume`（允许） |
| Lane           | Pi Harness 中一条独立的会话工作线，有独立的执行状态、工具集、模型配置     |
| 回执             | 工具执行结果（Pi 的 toolResult），由 Pi 原生持久化到会话记录      |

---

## 1. 背景与目标

### 1.1 背景

现有问数系统要求用户给出明确的指标、机构、日期，任何一项缺失或有歧义就反问用户。这适合“查一个确定的数”，但无法满足以业务目标发问的场景：用户只描述想了解的经营情况，期望系统自己判断看哪些指标、取哪个日期、做哪些对比并给出结论。

领导给出的示例话术只用于说明方向，本设计据此抽象出通用能力，不针对任何具体问法、指标或机构做定制。

### 1.2 目标能力

| 编号 | 能力         | 判定标准                                   |
| -- | ---------- | -------------------------------------- |
| C1 | 不完整输入下自主补全 | 缺日期、缺口径、指标表述模糊、缺机构时，在可接受置信度内直接给结果      |
| C2 | 业务规则可配置    | 口径默认、说法与口径的对应、主题核心指标等以数据维护，修改无需发版      |
| C3 | 自主规划       | 面对开放性目标，形成“子问题 → 指标范围 → 比较方式”的计划并按计划取数 |
| C4 | 分析而非仅取数    | 时间对比、横向对比与排名、结构拆解、趋势；能在数据层面回答“为什么”     |
| C5 | 可信可纠正      | 每个数字有查询证据；每个假设对用户可见；用户可一句话修正           |
| C6 | 不倒退        | 条件明确的问题与现在一样准确、一样快；新能力出问题时退回现有行为       |

### 1.3 非目标

- 不允许模型生成或执行 SQL；
- 不做客户明细级归因、外部因素推断、未来预测（保留在能力边界说明中）；
- 不替换现有精确问数链路，不重写 Frame 体系。

---

## 2. 设计约束与原则

| 编号 | 原则                    | 在本设计中的体现                                                                                                                      |
| -- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| P1 | 现有精确问数保留并作为保底         | 精确链路代码路径不变；新链路失败时退回现有澄清机制                                                                                                     |
| P2 | 充分利用 Pi Harness，尽量不自研 | 模式切换用 Pi 原生 `activeTools`；分析执行用 Pi 原生工具循环；方法论用 Pi Skill；子任务用 Pi 多 Lane；进度用 Pi 工具更新事件；参数绑定用 Pi `before_tool` 参数改写（详见第 4、5.4 节） |
| P3 | 优先复用现有业务工具            | 结构化查询、数据覆盖、受控计算、目录检索均已存在，分析模式直接开放给模型使用                                                                                        |
| P4 | 模型负责“想”，服务端负责“定”      | 指标归属、默认值、日期换算、权限、计算均由服务端确定性完成                                                                                                 |
| P5 | 模式按意图划分，缺项按策略处理       | “要分析还是要一个数”决定模式；“缺了什么”由假设策略处理，两者正交                                                                                            |
| P6 | 有界自治                  | 工具调用次数、计划规模、子任务数量均有上限，超限有界交付                                                                                                  |

---

## 3. 现状分析

### 3.1 现有链路

```
用户原文
  → transform_context：注入本轮业务状态（焦点 Frame、历史索引、指标预匹配）
  → Pi 首次请求（tool_choice=required，必须选择业务工具或普通回答）
  → resolve_business_turn（Frame 解析：指标/机构/日期/取值方式均必填）
      ├─ READY       → after_tool 就地执行 execute_business_frame → 结果 → Pi 回答
      └─ NEEDS_CLARIFICATION → before_payload 移除全部工具、tool_choice=none → 只能反问
```

### 3.2 阻碍目标能力的约束点

| 位置                                                          | 约束                        | 影响       |
| ----------------------------------------------------------- | ------------------------- | -------- |
| `agent-service/src/business-context/capabilities.ts:11`     | 指标、机构、日期为必填               | C1       |
| `agent-service/src/business-context/core.ts:185-207`        | 任何非 resolved 字段都产生澄清      | C1       |
| `agent-service/src/business-context/resolvers.ts:360`       | 日期缺失必须澄清                  | C1       |
| `backend-next/.../application/field_resolution.py:146-161`  | “最新/最近”判 invalid          | C1       |
| `backend-next/.../application/metric_candidates.py:572-578` | 只说基础指标 → 待确认口径            | C1 C2    |
| `agent-service/src/harnessHost.ts:472-480, 526-528`         | 澄清状态下移除全部工具               | C1 C3    |
| `agent-service/src/harnessHost.ts:529-532`                  | 直接查询/覆盖/计算工具被拦截，只能经 Frame | C3 C4    |
| `backend-next/.../api/routes/tasks.py:164-187`              | 原文覆盖率复核，问题中未覆盖的指标即 409    | C3       |
| `agent-service/src/tools/businessCapability.ts`             | 综合分析、异常诊断等一律回答“不支持”       | C4       |
| `metric_terms` 表                                            | 无主题、无指标关系、无业务规则           | C2 C3 C4 |

### 3.3 可直接复用的现有资产

| 资产             | 位置                                                                       | 现状                                                  | 本设计用法                  |
| -------------- | ------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------- |
| 结构化查询工具        | `tools/structuredQuery.ts`                                               | 已实现，支持多指标 × 多机构 × 多离散日期、排名、区间最新、区间序列；仅经 Frame 适配器调用 | 分析模式直接开放               |
| 数据覆盖工具         | `tools/dataAvailability.ts`                                              | 已实现，可返回共同最新日期                                       | 分析模式直接开放；默认日期计算复用其后端接口 |
| 受控计算工具         | `tools/metricCalculate.ts`                                               | 已实现，按 fact_id 绑定查询快照做四则与聚合                          | 分析计算（变化额、增长率、占比、贡献度）   |
| 目录工具           | `tools/catalog.ts`                                                       | 已实现，指标/机构检索 + 语义推荐                                  | 扩展“按主题/关系探索”动作         |
| Frame → 查询参数映射 | `business-context/adapters.ts:77-94`                                     | 写在适配器闭包内                                            | 抽成函数，供分析模式回执输出可用查询参数   |
| 澄清清单与点选        | `business-context/clarificationOptions.ts`、前端 `ClarificationChoices.vue` | 已实现                                                 | 分析模式的保底澄清直接复用          |
| 回答证据校验         | `answerEvidence.ts`、`replyGuard.ts`                                      | 已实现                                                 | 两种模式共用                 |
| Skill 加载与读取    | `businessSkills.ts`（Pi `loadSkills`）                                     | 已实现                                                 | 新增分析方法 Skill           |

结论：分析模式需要的取数、计算、覆盖、目录能力**已经全部存在**，只是被 Frame 入口挡住。新链路的主要工作是“按模式放开 + 补齐假设策略 + 补齐规划与展示”，而不是新建执行引擎。

---

## 4. Pi Harness 能力盘点与使用决策

本节列出 Pi Harness 0.85.1 的能力、经源码核实的实际行为，以及本设计是否采用。核实依据见附录 A。

### 4.1 能力清单与决策

| #  | Pi 能力                  | API                                                                         | 核实到的行为                                                                                 | 本设计用途                            | 决策                                                                                                                      |
| -- | ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1  | 工具循环                   | `lane.accept` / `lane.drive`                                                | 模型 → 工具 → 回执 → 模型，直到无工具调用                                                              | 分析执行引擎本身                         | **采用**（不自研编排器）                                                                                                          |
| 2  | 活跃工具集                  | `lane.setActiveTools` / `getActiveTools`                                    | 按 lane 持久化；每个模型步骤开始时读取当前配置，运行中修改从下一步生效；只有活跃工具可被执行                                      | 模式切换：精确工具集 ↔ 分析工具集               | **采用**（核心）                                                                                                              |
| 3  | 按 lane 切换模型            | `lane.setModel`                                                             | 同上，下一步生效                                                                               | 分析模式可切换到更强模型（可选配置）               | **采用（可选）**                                                                                                              |
| 4  | 推理档位                   | `lane.setThinkingLevel`                                                     | 同上；通过 pi-ai `reasoning` 参数传给模型网关                                                       | 分析模式提高推理档位（视网关支持）                | **采用（可选）**                                                                                                              |
| 5  | `transform_context` 钩子 | `harness.hooks.on`                                                          | 每次请求前改写发送给模型的消息与系统提示词，不落盘                                                              | 注入“上一次分析摘要”等轮状态                  | **采用**（扩展现有）                                                                                                            |
| 6  | `before_payload` 钩子    | 同上                                                                          | 改写最终请求体（工具列表、tool_choice）                                                              | 保留现有澄清锁定、首步必须动作；分析模式沿用           | **采用**（沿用）                                                                                                              |
| 7  | `before_tool` 钩子       | 同上                                                                          | 可拦截调用，**也可改写参数**（返回 `args`）                                                            | 分析模式绑定可信参数（解析只准不执行、去掉覆盖率复核参数）；预算 | **采用**                                                                                                                  |
| 8  | `after_tool` 钩子        | 同上                                                                          | 可替换回执内容、details、terminate                                                              | 进入分析模式时切换工具集；就地执行（沿用现有）          | **采用**                                                                                                                  |
| 9  | `after_response` 钩子    | 同上                                                                          | 可替换模型回答（含改为工具调用）                                                                       | 追加“本次分析口径”；完成度复核                 | **采用**                                                                                                                  |
| 10 | `before_run_end` 钩子    | 同上                                                                          | 返回 `followUp` 字符串时，以 **user 角色消息**写入会话并继续                                              | —                                | **不采用**：会在会话中插入一条“用户消息”，破坏现有“以最后一条用户消息划分本轮”的全部逻辑，且页面会显示该消息；完成度复核改用 `after_response`（现有 `business_action_required` 同一模式） |
| 11 | 工具参数兼容                 | 工具 `prepareArguments`                                                       | 校验前对模型原始参数做归一                                                                          | 新工具容忍弱模型的常见参数形态偏差                | **采用**                                                                                                                  |
| 12 | 工具重放策略                 | 工具 `replay: "safe"`                                                         | 进程中断恢复时，安全工具会重新执行而非标记中断                                                                | 只读工具（目录、覆盖、查询—后端幂等键保证）           | **采用**                                                                                                                  |
| 13 | 工具进度                   | `onUpdate` → `tool_update` 事件                                               | 运行中推送部分结果，`lane.watch` 可观察                                                             | 子任务进度推送到页面                       | **采用**                                                                                                                  |
| 14 | 工具重放备忘                 | `invocation.getMemo/setMemo`                                                | 每次工具调用的持久化键值，恢复时可读                                                                     | 子任务记录所用子 lane，恢复不重复创建            | **采用**                                                                                                                  |
| 15 | 并行工具执行                 | 创建参数 `toolExecution`                                                        | **Harness 运行时只认全局设置**；工具上的 `executionMode` 在 Harness 运行时不生效（README 描述的是底层 Agent 类）     | —                                | **一期不采用**：全局并行会让精确链路的 Frame 写入并发；分析取数改用单次调用批量（多指标×多机构×多日期）。二期评估见 15 节                                                   |
| 16 | 多 Lane                 | `harness.lane(name, {createAt})`                                            | 每条 lane 独立忙闲（同一 lane 才互斥）、独立工具集/模型/推理档位；`createAt` 指定起点条目，`null` 为空白起点；钩子事件带 `lane` 名称 | 深挖子任务的隔离执行                       | **采用（三期）**                                                                                                              |
| 17 | Skill                  | `loadSkills`、`resources.skills`、`lane.skill(name, 说明)`                      | 可显式以 Skill 作为一次运行的输入；`disableModelInvocation` 可隐藏于模型目录但仍可显式调用                          | 分析方法论（模型按需读取）；子任务以 Skill 启动      | **采用**                                                                                                                  |
| 18 | 提示模板                   | `loadPromptTemplates`、`resources.promptTemplates`、`lane.promptFromTemplate` | Markdown 模板 + 位置参数                                                                     | 子任务简报、复核提示等内部文案外置为 md，不写死在代码     | **采用**                                                                                                                  |
| 19 | 会话值存储                  | `session.setValue/getValue`（命名空间）                                           | 与会话同生命周期持久化                                                                            | 记录“最近一次分析”指针                     | **采用**                                                                                                                  |
| 20 | 插队/追加消息                | `lane.steer` / `followUp` / `nextRun`                                       | 以消息形式注入；`steer` 可传入带自定义字段的 AgentMessage                                                | 运行中用户补充说明（可选）                    | **三期评估**                                                                                                                |
| 21 | 中止/恢复                  | `requestAbort` / `resume`                                                   | 已在用                                                                                    | 沿用                               | 沿用                                                                                                                      |
| 22 | 自动压缩                   | `compaction` 配置                                                             | 已在用                                                                                    | 分析模式回执多，依赖其控制上下文长度               | 沿用                                                                                                                      |
| 23 | 自定义条目                  | `appendCustomEntry` + `entryProjectors`                                     | 可写审计条目并决定是否投影给模型                                                                       | 计划与假设已作为工具回执由 Pi 持久化，无需重复写       | 不采用                                                                                                                     |
| 24 | 遥测                     | `withTelemetryContext`、`startHarnessSpan`                                   | 基于 Context 的 span                                                                      | 可接入现有日志平台时再启用                    | 可选                                                                                                                      |
| 25 | 异步生成 / 会话检索            | `deferred`、`SessionSearchService`                                           | —                                                                                      | 无需求                              | 不采用                                                                                                                     |

### 4.2 Pi 原生与自研的边界

| 功能点      | 由 Pi 原生完成                                                 | 需要自研（薄层）                                    |
| -------- | --------------------------------------------------------- | ------------------------------------------- |
| 模式选择（分流） | 模型的首步工具选择本身就是分流；`tool_choice=required`（现有）                | `start_analysis` 工具（约 60 行）                 |
| 模式切换     | `lane.setActiveTools` / `setModel` / `setThinkingLevel`   | `after_tool` 中 10 余行切换逻辑；工具集常量              |
| 分析执行编排   | Pi 工具循环                                                   | 无                                           |
| 条件解析与假设  | —                                                         | 后端假设策略（主要工作量，见 8.3）；agent 侧在 Frame 解析中按策略调用 |
| 可信参数绑定   | `before_tool` 返回 `args`                                   | 约 20 行规则                                    |
| 分析计划展示   | 回执由 Pi 持久化、`tool_end` 事件推送                                | `analysis_plan` 工具（结构校验 + 日期换算，约 150 行）     |
| 分析计算     | —                                                         | 无（复用 `metric_calculate`）                    |
| 方法论      | Pi Skill 加载与读取（现有）                                        | Skill 正文（Markdown）                          |
| 完成度复核    | `after_response` 改写为内部工具调用                                | 复核规则约 80 行                                  |
| 子任务深挖    | 多 Lane、`lane.skill`、`setActiveTools`、`onUpdate`、`getMemo` | `analysis_subtask` 工具约 150 行；钩子按 lane 区分    |
| 过程展示     | `lane.watch` 事件                                           | 投影新增 `tool_progress`；前端卡片                   |

---

## 5. 总体设计

### 5.1 双模式架构

```
                               用户提问
                                  │
                                  ▼
┌──────────────────────── Pi main lane（同一会话、同一条工作线）────────────────────────┐
│                                                                                     │
│  ① 分流：首步工具选择（tool_choice=required）                                         │
│     可选：resolve_business_turn / catalog / read / … / start_analysis               │
│        │                                         │                                  │
│        │ 选择现有工具                              │ 选择 start_analysis              │
│        ▼                                         ▼                                  │
│  ┌───────── 精确问数模式（现有，不变）──────┐   ┌──────── 智能分析模式 ─────────────┐  │
│  │ 活跃工具：现有工具集 + start_analysis    │   │ 活跃工具：分析工具集               │  │
│  │ Frame 解析 → 执行一次查询 → 回答         │   │ （after_tool 用 setActiveTools 切换）│  │
│  │ 假设策略：strict（默认，可配置为 assume）│──▶│ 假设策略：assume                    │  │
│  │ 中途发现是分析目标 → 可调 start_analysis │   │ 规划 → 解析条件 → 批量取数 → 计算    │  │
│  └─────────────────────────────────────────┘   │ → 复核 → 回答（附本次分析口径）      │  │
│                    ▲                            └───────────────┬──────────────────┘  │
│                    │       ③ 保底：遇到必须由用户决定的歧义       │                     │
│                    └──── Frame 返回 NEEDS_CLARIFICATION ─────────┘                     │
│                          → 现有澄清锁定、编号清单、点选确认                              │
│                                                                                     │
│  （三期）分析模式内的深挖子任务 → 独立子 lane 执行，结果以回执返回主 lane               │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                  │ 受治理 HTTP（权限、目录、SQL 构建均在后端）
                                  ▼
            backend-next：resolve-field（含假设策略）│ basic-queries │ data-availability
                          calculation │ catalog（含主题/关系探索）│ 业务规则
```

### 5.2 模式与状态流转

```
         ┌──────────── 新一轮用户输入（接纳时恢复默认工具集、默认模型）────────────┐
         ▼                                                                     │
   [分流（首步工具选择）]                                                        │
     │ 选现有工具            │ 选 start_analysis                                │
     ▼                       ▼                                                  │
 [精确问数] ──start_analysis──▶ [智能分析]                                        │
     │                         │        │                                       │
     │ READY → 查询 → 回答       │        │ 必须用户决定的歧义                      │
     │ 澄清 → 反问               │        ▼                                       │
     ▼                         │  [澄清等待]（现有机制，工具移除）                    │
   结束 ───────────────────────┴──▶ 结束 ─────────────────────────────────────────┘
```


规则：

1. 模式只在本轮内有效，由本轮会话记录推导（本轮存在成功的 `start_analysis` 回执即为分析模式），进程重启恢复后结果一致；
2. 精确 → 分析：允许（分流选择或中途调用 `start_analysis`）；
3. 分析 → 精确：不允许在同一轮内回切；遇到必须用户决定的歧义时进入现有澄清（保底）；
4. 下一轮开始时恢复默认工具集，重新分流。

### 5.3 两种模式的对比

| 维度     | 精确问数          | 智能分析                             |
| ------ | ------------- | -------------------------------- |
| 适用目标   | 一个或几个确定的数     | 需要拆解、对比、解释的业务目标                  |
| 执行单位   | 一个 Frame 一次查询 | 一份计划，多次查询与计算                     |
| 条件来源   | 用户原文          | 用户原文（经 Frame 解析）+ 计划扩展的指标（经目录核验） |
| 缺项处理   | 默认 strict：反问  | assume：补齐并披露                     |
| 覆盖率复核  | 保留            | 不适用（扩展指标由计划声明）                   |
| 工具调用上限 | 24（现值）        | 40（可配置）                          |
| 回答结构   | 现有            | 分析结论 + 证据 + 本次分析口径               |

---

## 6. 方案一：分流

### 6.1 目标

让每个问题进入合适的模式，且不增加模型往返次数。

### 6.2 方案

分流不设独立步骤：**模型在首步的工具选择就是分流**。现有宿主已经在首步要求模型必须选择业务工具或普通回答（`before_payload` 设置 `tool_choice=required`，`harnessHost.ts:486-490`），只需在默认工具集中加入入口工具 `start_analysis`。

模型选择：

- 选择 `resolve_business_turn` 等现有工具 → 精确问数模式（与现在完全相同）；
- 选择 `start_analysis` → 智能分析模式；
- 选择 `respond_without_business_action` → 普通对话（现有）。

### 6.3 `start_analysis` 工具定义

```ts
// agent-service/src/tools/startAnalysis.ts（新增）
const parameters = Type.Object({
  goal: Type.String({minLength: 1, maxLength: 500,
    description: "用户本轮业务目标的原文表述（摘取原文，不改写、不补充条件）"}),
  continue_previous: Type.Optional(Type.Boolean({
    description: "用户在继续上一次智能分析（追问、换条件、深挖）时为 true"})),
}, {additionalProperties: false});

export const START_ANALYSIS = "start_analysis";

/** 进入智能分析模式：只登记意图并返回可用方法，不查询数据；工具集切换由宿主 after_tool 完成。 */
export function createStartAnalysisTool(): AgentHarnessTool<AskMetricRequestContext, typeof parameters> {
  return {
    name: START_ANALYSIS, label: "进入智能分析", parameters,
    description: "用途：用户表达的是需要拆解、对比、排名、趋势或数据层面原因解释的业务目标，"
      + "或问题只给出业务概念而需要自主确定指标范围。不适用：查询一个或几个确定的指标值（使用 resolve_business_turn）。"
      + "返回：分析模式说明与上一次分析摘要；之后可使用分析工具。",
    prepareArguments: (raw) => typeof raw === "string" ? {goal: raw} : raw as never,  // Pi 原生参数兼容
    replay: "safe",
    execute: async (_id, params, _update, request, _invocation, context) => {
      // 预先建立后端查询上下文，避免后续查询各自创建
      if (!await request.commands.getConversationId()) {
        const created = await request.backend.createAgentQueryContext(request.sessionId, {signal: context.abortSignal});
        await request.commands.setConversationId(created.conversation_id);
      }
      const previous = params.continue_previous ? await request.analysis?.lastAnalysis() : undefined;
      return {content: [{type: "text", text: JSON.stringify({status: "ANALYSIS_STARTED",
        guidance: "先用 analysis_plan 提交计划；用户提及的条件用 resolve_business_turn 解析（仅解析）；"
          + "扩展指标用 catalog 探索；取数用 metric_query_structured；计算用 metric_calculate。方法见业务知识 analysis-methods。",
        previous: previous ?? null})}],
        details: {kind: "analysis_mode", status: "ANALYSIS_STARTED", goal: params.goal}};
    },
  };
}
```

### 6.4 宿主改动（`harnessHost.ts`）

**(1) 工具集常量**

```ts
/** 精确问数默认工具集：现有工具 + 分析入口。 */
const PRECISE_TOOL_NAMES = [...existingToolNames, START_ANALYSIS];
/** 分析模式工具集：只读与受控工具；不含普通回答与入口工具。 */
const ANALYSIS_TOOL_NAMES = ["resolve_business_turn", "business_context_read", ANALYSIS_PLAN, "catalog",
  "data_availability", "metric_query_structured", "metric_calculate", "read", "business_skill_read"];
```

所有工具在创建 Harness 时一次注册（`AgentHarness.create({tools})`），模式只改变活跃集合。

**(2) 进入分析模式：`after_tool`**

```ts
if (event.toolName === START_ANALYSIS && !event.isError) {
  // Pi 原生：活跃工具集按 lane 持久化，下一次模型请求只携带分析工具，非活跃工具也无法被执行。
  await lane.setActiveTools(ANALYSIS_TOOL_NAMES, context);
  if (this.config.analysis.model) await lane.setModel(this.config.analysis.model, context);
  if (this.config.analysis.thinkingLevel) await lane.setThinkingLevel(this.config.analysis.thinkingLevel, context);
  return undefined;
}
```

**(3) 每轮恢复默认：接纳阶段**

现有 `admitPromptExclusive`（`harnessHost.ts:837-843`）已在空闲时把活跃工具同步为期望集合，改为同步 `PRECISE_TOOL_NAMES`，并同步恢复默认模型与推理档位。

**(4) 模式推导函数**（供各钩子使用，只看本轮会话记录）

```ts
type BusinessMode = "precise" | "analysis";
/** 本轮存在成功的进入分析回执即为分析模式；恢复后由原生记录重新推导，不另存状态。 */
export function currentMode(turn: AgentMessage[]): BusinessMode {
  return turn.some(message => message.role === "toolResult" && !message.isError
    && message.toolName === START_ANALYSIS
    && (message.details as {status?: string} | undefined)?.status === "ANALYSIS_STARTED") ? "analysis" : "precise";
}
```

**(5) 已有拦截规则改为按模式生效**

| 现有规则             | 位置                       | 改动                |
| ---------------- | ------------------------ | ----------------- |
| 直接查询/覆盖/计算工具被拦截  | `harnessHost.ts:529-532` | 仅精确模式拦截           |
| 单轮工具调用上限 24      | `harnessHost.ts:63, 524` | 按模式取上限（分析模式默认 40） |
| 首步必须动作、澄清锁定、终止失败 | `before_payload`         | 不变，两种模式通用         |

**(6) 降级预案**（若 POC 证实运行中 `setActiveTools` 不能在下一步生效）

改用现有的请求体过滤方式：在 `before_payload` 中按 `currentMode` 过滤工具列表，在 `before_tool` 中拦截非本模式工具。功能等价，只是不使用 Pi 原生的活跃工具集。

### 6.5 引导文案

- 系统提示词（静态，保持前缀缓存）增加一条：“用户要一个或几个确定的数时使用业务条件解析；要拆解、对比、排名、趋势或数据层面原因时进入智能分析。”
- `business_capability_explain` 的能力枚举去掉 `comprehensive_analysis`（综合分析）和 `anomaly_diagnosis`（数据层面异常定位），这两类改由智能分析承接；保留客户级归因、预测、血缘。描述中注明“数据层面的对比、拆解与原因定位使用 start_analysis”。

### 6.6 容错

| 情况        | 处理                                            |
| --------- | --------------------------------------------- |
| 应走分析却选了精确 | 精确模式中 `start_analysis` 一直可见，模型可在拿到初步结果后中途进入分析 |
| 应走精确却选了分析 | 分析模式同样能完成单次查询，只是多一步计划，结果正确                    |
| 模型首步只输出文字 | 现有 `business_action_required` 纠错机制（最多 2 次）不变  |

### 6.7 验收

- 分流准确率：评测集中“确定取数类”走精确 ≥ 95%，“分析类”走分析 ≥ 90%（P0 实测后定稿）；
- `ANALYSIS_MODE_ENABLED=false` 时，现有全部自动化测试与真实模型回归结果不变。

---

## 7. 方案二：精确问数链路（保底，基本不变）

### 7.1 不变范围

Frame 解析、继承、校验、覆盖率复核、READY 就地执行、澄清锁定与编号清单、历史结果读取，全部不变。

### 7.2 仅有的改动

| 改动                       | 内容                                                     | 影响                                   |
| ------------------------ | ------------------------------------------------------ | ------------------------------------ |
| 默认工具集加入 `start_analysis` | 见 6.2                                                  | 模型多一个可选项                             |
| 能力边界工具枚举收窄               | 见 6.5                                                  | 综合分析类问题不再直接回答“不支持”                   |
| 旧会话判定修复                  | 见 13.1                                                 | 必须修复，否则所有会话会被误判为只读                   |
| 假设策略开关                   | `PRECISE_RESOLUTION_POLICY=strict\|assume`，默认 `strict` | 默认行为不变；评测通过后可开启，让精确问题缺日期/缺口径时也直接补齐执行 |

### 7.3 关于“可补齐缺项”的处理（对早期方案的修正）

早期讨论中曾设想“精确链路判断缺项可补齐时转入分析链路”。详细设计后改为：**缺项是否补齐由假设策略决定，与模式无关**。理由：

1. “缺个日期”的问题本质仍是要一个数，转入分析模式会多出计划、复核等步骤，变慢且没有收益；
2. 假设策略在两种模式中是同一套服务端逻辑（第 8.3 节），精确模式只需打开开关即可获得相同的补齐能力；
3. 模式只按意图划分，状态更简单，不会出现“为补一个日期而切换模式”的来回跳转。

---

## 8. 方案三：智能分析链路

### 8.1 工具集

| 工具                        | 来源      | 分析模式下的职责                              | 宿主约束（`before_tool`）           |
| ------------------------- | ------- | ------------------------------------- | ----------------------------- |
| `analysis_plan`           | 新增      | 提交/修订分析计划；服务端校验并把比较方式换算为确定日期          | 每轮最多修订 3 次                    |
| `resolve_business_turn`   | 现有      | 解析**用户提及**的指标/机构/日期，按假设策略补齐；回执附可用查询参数 | 参数改写：`executionMode` 强制为“仅解析” |
| `business_context_read`   | 现有      | 读取焦点、历史条件                             | 无                             |
| `catalog`                 | 现有 + 扩展 | 检索指标/机构；新增 `explore` 动作按主题与关系扩展指标范围   | 无                             |
| `data_availability`       | 现有      | 查询数据覆盖与最新日期                           | 无                             |
| `metric_query_structured` | 现有      | 批量取数（多指标 × 多机构 × 多日期）、排名、区间最新、区间序列    | 参数改写：移除覆盖率复核相关参数              |
| `metric_calculate`        | 现有      | 变化额、增长率、占比、贡献度等受控计算                   | 无                             |
| `read`                    | 现有      | 读取历史结果                                | 无                             |
| `business_skill_read`     | 现有      | 读取分析方法 Skill                          | 无                             |

分析模式下不提供：`start_analysis`（已进入）、`respond_without_business_action`（已进入业务处理）、`execute_business_frame`（执行统一走结构化查询）。

### 8.2 执行模型：Pi 工具循环即执行器

分析模式**不新建编排器**。执行顺序由模型在 Pi 原生工具循环中决定，宿主只做约束：

```
start_analysis
  → [可选] business_skill_read(analysis-methods)
  → analysis_plan(submit)                       // 声明子问题、指标、比较方式；服务端换算日期
  → resolve_business_turn(仅解析)                // 用户提到的条件 → 编码 + 假设
  → [可选] catalog(explore)                      // 按主题/关系扩展指标
  → metric_query_structured × N（每次批量）       // 取数
  → metric_calculate × M                        // 计算
  → [可选] analysis_plan(revise) → 继续取数        // 观察结果后深挖
  → 最终回答（宿主追加本次分析口径；必要时触发完成度复核）
```

取数并发：一期 Harness 保持全局串行（第 4.1 节 #15），通过**单次调用批量**取数：`metric_query_structured` 一次即可查询最多 100 个指标、1000 个机构或机构集合、31 个离散日期，后端在一次请求内执行。

### 8.3 条件解析与假设策略（两种模式共享）

#### 8.3.1 为什么复用 Frame 解析

用户提及的条件（指标说法、机构说法、日期说法）在分析模式中仍通过 `resolve_business_turn` 解析，原因：

- 复用指标原文匹配、同音错字、机构别名与集合范围、日期文法、权限过滤等全部已有能力；
- 遇到必须由用户决定的歧义时，直接产生现有的 `NEEDS_CLARIFICATION`，保底澄清零开发；
- 现有模型已熟悉该工具的参数协议。

计划扩展的指标（用户没说、模型依据主题/关系选择的指标）不经过 Frame，直接以目录核验过的编码查询，后端仍按启用目录与权限复核。

#### 8.3.2 策略的传递方式

假设策略由宿主绑定，模型不能自行选择：

```ts
// before_tool：调用 resolve_business_turn 前确定本次解析策略
request.resolutionPolicy = currentMode(turn) === "analysis" ? "assume" : this.config.preciseResolutionPolicy;
// 分析模式：Pi 原生参数改写，只解析不执行（标准参数为 executionMode，紧凑参数 AGENT_COMPACT_TURN_ARGS 下为 mode）
if (currentMode(turn) === "analysis") return {args: {...event.args, [compact ? "mode" : "executionMode"]: "resolve_more"}};
```

#### 8.3.3 消解链（服务端，逐字段执行，命中即停）

```
① 原文精确命中（完整名称、别名、机构名、明确日期）        → resolved
② 业务规则命中（口径默认、说法到口径的对应、默认机构等）    → resolved + 假设(依据=规则)
③ 相似度选择：第一候选得分 ≥ 高阈值，且领先第二候选 ≥ 间隔阈值 → resolved + 假设(依据=相似度，附备选)
④ 系统默认                                                → resolved + 假设(依据=默认)
     日期缺失或“最新/最近”：所选指标与机构的共同最新数据日；
                          机构为集合范围时取本年范围 + 区间最新
     相对期间（本月/本季/今年）：期间范围 + 区间最新
     机构缺失：本人机构
⑤ 以上均不满足，或属阻断类                                → 保持现有状态 → 澄清（保底）
```

阻断类（即使 assume 也必须澄清）：用户明确给出但无法解析的表达；无权限机构；相似度前两名差距小于间隔阈值；业务规则标记为“必须确认”的指标。阈值与阻断清单来自业务规则表（第 10 节）。

#### 8.3.4 落点

| 层     | 文件                                    | 改动                                                                                                                                                                 |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 后端    | `application/field_resolution.py`     | `resolve_field` 增加 `policy` 参数；`assume` 时执行②③④，在返回的 `metadata.assumption` 中写明依据、置信度、备选                                                                             |
| 后端    | `application/metric_candidates.py`    | 候选输出标准化得分与领先间隔，供③使用；缺口径时先查规则                                                                                                                                       |
| 后端    | `api/routes/business_context.py`      | resolve-field 请求体增加 `policy`（默认 `strict`）                                                                                                                          |
| agent | `backendClient.ts`                    | `resolveBusinessField` 透传 `policy`                                                                                                                                 |
| agent | `business-context/resolvers.ts`       | 指标、机构、日期解析器读取 `request.resolutionPolicy` 并透传；日期缺省不再报缺项（仅 assume）                                                                                                   |
| agent | `business-context/core.ts`            | `CapabilityRegistry` 增加可选异步钩子 `deriveDefaults(fields, delta, ctx)`                                                                                                 |
| agent | `business-context/service.ts:123-126` | 在 `mergeFields` 之后、`validateFrame` 之前调用 `deriveDefaults`（仅 assume）                                                                                                 |
| agent | `business-context/capabilities.ts`    | `metric_query` 注册 `deriveDefaults`：机构/指标已解析且日期缺失时，调用数据覆盖接口（`dimension:"dates"`, `match:"all"`）取共同最新日期，写入日期字段并记录假设；单日自动 `selection=exact`（复用现有 `completeFields` 逻辑） |

假设统一记录在字段 `metadata.assumption`，**不新增解析状态**，`validateFrame` 无需改动：

```ts
/** 系统代替用户做出的一项决定；写入 Frame 字段 metadata，随 Frame 持久化。 */
export interface Assumption {
  field: "metrics" | "organizations" | "time" | "selection";
  chosen: {label: string; codes?: string[]; value?: unknown};
  basis: {kind: "rule" | "similarity" | "default"; ruleId?: string; score?: number; gap?: number};
  alternatives: Array<{label: string; code?: string; score?: number}>;
  sourceText?: string;   // 触发该假设的原文片段；无则为缺省
}
```

#### 8.3.5 分析模式下的解析回执

“仅解析”回执（现有状态 `READY` + `resolve_more`，不触发就地执行）在现有内容上增加两项：

```json
{
  "status": "READY",
  "frame_id": "…",
  "assumptions": [{"field": "time", "chosen": {"label": "2026-10-08（所选指标与机构共同的最新数据日）"},
                   "basis": {"kind": "default"}, "alternatives": []}],
  "query_args": {"metric_codes": ["…"], "org_codes": ["…"], "start": "2026-10-08", "end": "2026-10-08",
                 "selection": "exact", "operation": {"kind": "value"}}
}
```


`query_args` 由 `adapters.ts:77-94` 现有映射逻辑生成（抽成 `frameQueryParams(frame)` 共用，去掉覆盖率复核字段），模型可直接用于 `metric_query_structured`，或在其上增加指标、日期后批量查询。

### 8.4 分析计划工具 `analysis_plan`

#### 8.4.1 职责

1. 让“自主规划形成的指标范围”显式化：页面展示、会话留存、复核依据；
2. 把比较方式换算为确定日期（纯日历计算，确定性），模型不自行换算日期；
3. 校验规模，防止计划过大。

不负责执行；执行由模型在后续步骤中调用查询与计算工具完成。

#### 8.4.2 参数

```ts
const comparison = StringEnum(["none", "prev_period_end", "same_period_last_year", "year_start",
  "same_progress_prev_period", "peers", "composition", "trend"]);
const parameters = Type.Object({
  action: StringEnum(["submit", "revise"]),
  goal: Type.String({minLength: 1, maxLength: 500}),
  as_of: Type.Optional(Type.String({pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "基准日期，取自解析回执或数据覆盖结果；缺省时按解析回执中的日期"})),
  sub_questions: Type.Array(Type.Object({
    id: Type.String({pattern: "^q[0-9]{1,2}$"}),
    question: Type.String({minLength: 1, maxLength: 200}),
    metrics: Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 20,
      description: "指标名称（来自解析回执或目录检索结果）"}),
    comparisons: Type.Array(comparison, {minItems: 1, maxItems: 4}),
  }, {additionalProperties: false}), {minItems: 1, maxItems: 6}),
}, {additionalProperties: false});
```

#### 8.4.3 服务端处理

1. 规模校验：子问题 ≤ 6；去重后指标 ≤ 30（可配置）；
2. 日期换算：以 `as_of` 为基准，确定性计算各比较方式对应的日期：

| 比较方式                        | 对比日期            | 说明                 |
| --------------------------- | --------------- | ------------------ |
| `prev_period_end`           | 上月末             | 环比                 |
| `same_period_last_year`     | 上年同日            | 同比                 |
| `year_start`                | 上年末             | 较年初                |
| `same_progress_prev_period` | 上月同日（无该日取上月末）   | 期内进度对齐，避免“未满月对比全月” |
| `peers`                     | 同 `as_of`       | 机构集合横向对比，配合排名      |
| `composition`               | 同主比较方式          | 沿构成关系查询子指标         |
| `trend`                     | 近 N 个月末（N 默认 6） | 以离散日期查询            |

1. 回执内容：子问题、指标、每个子问题对应的日期清单、规模、版本号；`details.kind="analysis_plan"` 供页面渲染计划卡片。

修订（`revise`）即提交新版本，最新版本生效。

### 8.5 分析方法与现有工具的对应

以下内容同时写入 Skill `analysis-methods`，供模型按需读取。

| 分析方法          | 取数（`metric_query_structured`）                              | 计算（`metric_calculate`）                    |
| ------------- | ---------------------------------------------------------- | ----------------------------------------- |
| 当前值           | `selection=exact`，`as_of`                                  | —                                         |
| 环比 / 同比 / 较年初 | `dates=[对比日, as_of]`（一次调用）                                 | `b-a`；`(b-a)/a`，`scope_policy=cross_date` |
| 期内进度对比        | `dates=[上上月末, 上月同日, 上月末, as_of]`                           | 本期增量 `d-c`、上期同进度增量 `b-a`、二者之差             |
| 横向对比 / 排名     | `organization_scope=机构集合` + `operation=ranking`；或目录中的排名类指标 | 与均值偏离：`x-avg(...)`                        |
| 结构拆解          | 父指标与子指标（由 `catalog explore` 的构成关系得到）两期取数                   | 子项变化额、贡献度 `Δ子/Δ父`、占比 `子/父`                |
| 趋势            | `dates=近 N 个月末` 或 `selection=all_in_range`                 | 最大、最小、均值（`max/min/avg`）                   |

“为什么”的回答依据结构拆解与期内进度对比的结果，只陈述“哪些组成部分贡献了多少变化”，不推断数据之外的原因（`analysis-boundary` Skill 修订后明确此边界）。

### 8.6 预算与终止

| 项        | 默认值           | 实现                                     |
| -------- | ------------- | -------------------------------------- |
| 单轮工具调用上限 | 40            | `before_tool` 现有计数逻辑按模式取值；超限沿用现有有界交付文案 |
| 计划修订次数   | 3             | `before_tool` 统计本轮 `analysis_plan` 回执  |
| 计划规模     | 6 子问题 / 30 指标 | `analysis_plan` 服务端校验                  |
| 连续参数错误   | 3 次           | 现有 `after_response` 逻辑不变               |

### 8.7 完成度复核

时机：分析模式下模型给出最终文字回答（无工具调用）时，在 `after_response` 中检查：

1. 最新计划中每个子问题的指标，是否在本轮成功的查询回执中出现，或回答中已说明缺数；
2. 本轮是否存在失败后未重试、也未在回答中说明的查询。

不满足且仍在预算内时，沿用现有 `business_action_required` 的做法：把这次回答替换为一次内部工具调用 `analysis_review`，其回执列出缺口，模型在同一轮继续补查或说明。每轮最多复核 1 次。

不使用 `before_run_end` 的原因见第 4.1 节 #10。

### 8.8 假设披露

在 `after_response` 的最终回答末尾，由宿主追加“本次分析口径”区块，内容来自本轮解析回执与计划回执中的 `assumptions`、`as_of`、对比日期。实现方式与现有澄清编号清单追加（`harnessHost.ts:665-674`）相同：

```
本次分析口径：
- 机构：××（未指定机构，默认本人机构）
- 日期：2026-10-08（所选指标与机构共同的最新数据日）
- 指标：×× 按「当日数」口径（业务规则：未指明口径时默认当日数）；可选：日均、较上月
- 对比：环比 2026-09-30、同比 2025-10-08
```

该区块同时以结构化数据放在回执 `details` 中，前端渲染为可点选的假设卡片（第 11 节）。

### 8.9 保底：退回澄清

分析模式中，`resolve_business_turn` 若返回 `NEEDS_CLARIFICATION`（只会是阻断类歧义），现有宿主逻辑自动生效：移除工具、`tool_choice=none`、追加编号清单（`harnessHost.ts:472-480, 665-674`）。用户下一轮作答后：

- 现有确认机制完成该 Frame 的解析；
- 轮状态中带有“上一次智能分析等待澄清”的摘要（第 8.10 节），模型分流时选择 `start_analysis(continue_previous=true)` 继续分析。

### 8.10 多轮与跨模式衔接

| 场景                     | 处理                                                                        |
| ---------------------- | ------------------------------------------------------------------------- |
| 分析后追问修改条件（换机构、换日期、换口径） | 分流到分析模式（`continue_previous=true`）；`start_analysis` 回执带上一次计划摘要；模型提交修订计划后重查 |
| 分析后追问深挖                | 同上，在原计划上追加子问题                                                             |
| 分析后转为查一个确定的数           | 分流到精确模式；轮状态提示“上一业务轮为智能分析”，模型应以独立问题解析，避免继承更早的 Frame 焦点                     |
| 精确查询后要求分析              | 分流到分析模式；解析回执可沿用当前焦点 Frame 的条件                                             |

“上一次分析摘要”的维护（Pi 原生会话值）：

```ts
const lastAnalysisValue = value<LastAnalysis>("askmetric", "analysis/last");
interface LastAnalysis { operationId: string; goal: string; planVersion: number;
  subQuestions: string[]; asOf?: string; status: "answered" | "waiting_user" | "incomplete" }
```

- 写入：分析模式最终回答（`after_response`）或进入澄清时；
- 读取：`transform_context` 把摘要放进本轮状态块（不进入系统提示词，保持前缀缓存）；`start_analysis` 在 `continue_previous=true` 时返回。

历史数值复用：`metric_calculate` 已支持绑定本会话历史查询快照的 `fact_id`，跨轮计算无需重新取数。

### 8.11 典型调用序列（示意）

用户：“看看某行最近贷款情况，和同业比怎么样？”

| 步骤 | 调用                                | 关键内容                                                                  |
| -- | --------------------------------- | --------------------------------------------------------------------- |
| 1  | `start_analysis`                  | `goal="最近贷款情况，和同业比"` → 宿主切换为分析工具集                                     |
| 2  | `analysis_plan(submit)`           | q1 当前规模及环比/同比；q2 同业排名                                                 |
| 3  | `resolve_business_turn`（宿主改写为仅解析） | 机构=某行；指标“贷款”→ 规则默认口径；日期缺失 → 共同最新日 2026-10-08；回执带 `query_args` 与 3 条假设 |
| 4  | `metric_query_structured`         | `dates=[2025-10-08, 2026-09-30, 2026-10-08]`，一次查三期                    |
| 5  | `metric_calculate`                | 环比变化额与增长率、同比变化额与增长率                                                   |
| 6  | `metric_query_structured`         | `organization_scope=机构集合`，`operation=ranking`                         |
| 7  | 最终回答                              | 宿主检查计划覆盖情况 → 通过 → 追加“本次分析口径”                                          |

---

## 9. 方案四：深挖子任务 Lane（三期，可选）

### 9.1 场景

某个子问题需要多步下钻（例如沿构成关系逐层查找变化来源），在主 lane 中执行会使上下文迅速膨胀，并干扰后续多轮对话。

### 9.2 方案：Pi 多 Lane

新增工具 `analysis_subtask`（仅分析模式可用），内部使用 Pi 原生多 Lane 执行子任务：

```ts
execute: async (_id, params, onUpdate, request, invocation, context) => {
  const harness = request.harness;                                       // 接纳时绑定到请求上下文
  const name = (await invocation.getMemo("lane")) as string | undefined   // Pi 原生重放备忘：恢复时复用同一子 lane
    ?? `sub/${invocation.operationId}/${invocation.invocationId}`;
  await invocation.setMemo("lane", name);
  // 空白起点：不从主 lane 分叉，避免子 lane 继承主 lane 中尚未完成的工具调用
  const sub = await harness.lane(name, {createAt: null}, context);
  await sub.setActiveTools(SUBTASK_TOOL_NAMES, context);                 // 不含 analysis_subtask，禁止嵌套
  if (this.config.analysis.subtaskThinkingLevel) await sub.setThinkingLevel(this.config.analysis.subtaskThinkingLevel, context);
  onUpdate({content: [{type: "text", text: "子任务开始"}], details: {status: "running", lane: name}});
  // 以 Skill 启动（Pi 原生）：Skill 正文为下钻方法，附加说明为任务简报
  const run = await sub.skill("analysis-drilldown", renderBrief(params), context);
  const answer = await finalAssistantText(sub, context);
  const evidence = currentTurnEvidence(await laneMessages(sub, context));
  return {content: [{type: "text", text: JSON.stringify({status: "succeeded", answer, evidence})}],
    details: {kind: "analysis_subtask", lane: name, evidence}};
}
```

| 使用的 Pi 能力                                                    | 作用                                  |
| ------------------------------------------------------------ | ----------------------------------- |
| `harness.lane(name, {createAt: null})`                       | 独立工作线，独立忙闲，不阻塞主 lane 的工具执行          |
| `sub.setActiveTools` / `setThinkingLevel`                    | 子任务独立工具集与推理档位                       |
| `sub.skill(name, 说明)` + Skill `disableModelInvocation: true` | 子任务方法以 Skill 维护，不出现在主模型的知识目录中       |
| `lane.promptFromTemplate`（备选）                                | 任务简报模板外置为 Markdown                  |
| `onUpdate`                                                   | 子任务进度经主 lane 的 `tool_update` 事件推送页面 |
| `invocation.getMemo/setMemo`                                 | 进程中断恢复时复用同一子 lane                   |

### 9.3 宿主钩子按 lane 区分

钩子在所有 lane 上触发，事件携带 `lane` 名称。现有钩子中读取主 lane 消息的逻辑（`currentLaneMessages(lane, context)`）须改为按 `event.lane` 取对应 lane；子 lane 使用独立策略：

| 钩子                  | 主 lane       | 子 lane                 |
| ------------------- | ------------ | ---------------------- |
| `transform_context` | 现有 + 分析摘要    | 仅注入任务简报中的条件，不注入焦点与历史索引 |
| `before_payload`    | 现有           | 不启用首步动作契约与澄清锁定         |
| `before_tool`       | 现有预算         | 子任务预算（默认 12 次）         |
| `after_response`    | 现有 + 复核 + 披露 | 不追加披露（由主 lane 统一追加）    |

### 9.4 证据回传

子 lane 的查询回执不在主 lane 会话记录中。`analysis_subtask` 回执携带子任务证据清单（fact_id、指标、机构、日期、值），回答证据校验（`replyGuard`）需接受该回执作为证据来源；主 lane 也可用这些 fact_id 调用 `metric_calculate`。

### 9.5 限制

- 一期 Harness 全局串行，同一批多个子任务依次执行；
- 子任务不能再启动子任务；
- 子 lane 作为会话的一部分持久化，页面只展示主 lane。

---

## 10. 方案五：业务语义层（backend-next）

### 10.1 现状

`metric_terms` 已有：编码、名称、基础名（`base_name`）、口径（`value_basis`）、说明、单位；`metric_synonyms` 已有同义词。缺少：主题、指标关系、业务规则。

### 10.2 新增表

```sql
-- 指标主题（可分层），一个指标可属多个主题
CREATE TABLE metric_topics (
  topic_code        VARCHAR(64)  PRIMARY KEY,
  topic_name        VARCHAR(128) NOT NULL,
  parent_topic_code VARCHAR(64),
  sort_order        INT          NOT NULL DEFAULT 0,
  enabled           BOOLEAN      NOT NULL DEFAULT TRUE
);
CREATE TABLE metric_topic_members (
  topic_code VARCHAR(64)  NOT NULL,
  member_ref VARCHAR(255) NOT NULL,      -- base_name 或 metric_code
  member_kind VARCHAR(16) NOT NULL,      -- base | metric
  is_core    BOOLEAN      NOT NULL DEFAULT FALSE,  -- 主题核心指标
  PRIMARY KEY (topic_code, member_ref)
);

-- 指标关系：构成 / 派生 / 配对
CREATE TABLE metric_relations (
  id            BIGINT       PRIMARY KEY,
  relation_type VARCHAR(16)  NOT NULL,   -- composition | derivation | pairing
  parent_ref    VARCHAR(255) NOT NULL,   -- base_name 或 metric_code
  child_ref     VARCHAR(255) NOT NULL,
  role          VARCHAR(32),             -- pairing：plan/actual、balance/average 等
  formula       VARCHAR(2000),           -- derivation：与受控计算同语法
  enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
  note          VARCHAR(500)
);

-- 业务规则：业务人员维护
CREATE TABLE business_rules (
  id           BIGINT       PRIMARY KEY,
  rule_type    VARCHAR(32)  NOT NULL,
  scope_kind   VARCHAR(16)  NOT NULL,    -- global | topic | base
  scope_ref    VARCHAR(255),
  condition_json TEXT,
  action_json  TEXT         NOT NULL,
  priority     INT          NOT NULL DEFAULT 100,
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  owner        VARCHAR(64)  NOT NULL,
  updated_at   TIMESTAMP    NOT NULL,
  note         VARCHAR(500)
);
```

### 10.3 规则类型

| `rule_type`            | 含义            | `action_json` 示例                            |
| ---------------------- | ------------- | ------------------------------------------- |
| `value_basis_default`  | 未指明口径时采用的口径   | `{"value_basis": "<口径名>"}`                  |
| `value_basis_alias`    | 某种说法等同于某口径    | `{"alias": "<说法>", "value_basis": "<口径名>"}` |
| `must_confirm`         | 该范围内的指标必须用户确认 | `{}`                                        |
| `confidence_threshold` | 相似度阈值         | `{"high": 0.85, "gap": 0.1}`                |
| `time_default`         | 默认日期策略        | `{"policy": "common_latest"}`               |
| `org_default`          | 默认机构策略        | `{"policy": "self"}`                        |

“某种说法等于某口径”这类业务口径即 `value_basis_alias` 的一行数据。规则按 `scope_kind` 从具体到全局匹配，同级按 `priority`。

### 10.4 接口

| 接口                                                         | 用途                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `POST /api/v1/business-context/resolve-field`（扩展 `policy`） | 第 8.3 节消解链                                                |
| `POST /api/v1/catalog/metrics/explore`（新增）                 | 输入主题/概念/种子指标，返回相关基础指标、可用口径、主题路径、构成/配对关系、核心标记；结果按权限与启用目录过滤 |
| `GET /api/v1/business-rules?version=`（新增）                  | 规则快照与版本，供缓存                                               |
| 规则维护接口与导入脚本（新增）                                            | 增删改与审计；首批数据以 Excel 模板导入                                   |

### 10.5 agent 侧

`catalog` 工具增加动作 `explore`（参数：`concepts`、`topics`、`seed_metrics`、`relations`），调用 explore 接口，返回不含内部字段的指标范围候选。仍遵循现有“检索结果须核对、推荐不能直接锁定”的回执说明。


## 12. 配置、灰度与回滚

| 配置项                           | 默认       | 说明                                |
| ----------------------------- | -------- | --------------------------------- |
| `ANALYSIS_MODE_ENABLED`       | `false`  | 关闭时不注册 `start_analysis`，行为与现状完全一致 |
| `PRECISE_RESOLUTION_POLICY`   | `strict` | 精确模式假设策略；`assume` 时缺项补齐执行         |
| `ANALYSIS_MAX_TOOL_CALLS`     | `40`     | 分析模式单轮工具调用上限                      |
| `ANALYSIS_MAX_PLAN_REVISIONS` | `3`      | 计划修订上限                            |
| `ANALYSIS_MODEL`              | 空        | 非空时分析模式切换到该模型（`lane.setModel`）    |
| `ANALYSIS_THINKING_LEVEL`     | 空        | 非空时分析模式设置推理档位                     |
| `ANALYSIS_REVIEW_ENABLED`     | `true`   | 完成度复核                             |
| `ANALYSIS_SUBTASK_ENABLED`    | `false`  | 深挖子任务（三期）                         |

灰度建议：按用户白名单开启 `ANALYSIS_MODE_ENABLED`；`PRECISE_RESOLUTION_POLICY` 在分析模式稳定后单独评估开启。回滚：关闭开关即可，会话数据无迁移。

---

## 13. 兼容性与迁移

### 13.1 旧会话判定必须修复

现有逻辑以“活跃工具包含 `metric_query_structured` 等直接工具”判定为旧协议会话并置为只读（`harnessHost.ts:337-339`）。分析模式会把这些工具加入活跃集合，若不修改，**所有经历过分析模式的会话下次打开都会被误判为只读**。

修改：改为在会话值中记录协议版本（`askmetric/protocol = "frame_v1" | "dual_mode_v1"`），以协议版本判定旧会话；创建会话时写入，旧会话缺失该值时按原规则判定。

### 13.2 在途操作恢复

活跃工具集由 Pi 按 lane 持久化。分析模式执行中进程重启，恢复后仍使用分析工具集继续，与中断前一致；下一轮接纳时恢复默认集合。

### 13.3 回归测试分组

| 分组      | 配置                                    | 期望                                  |
| ------- | ------------------------------------- | ----------------------------------- |
| 现有回归    | `ANALYSIS_MODE_ENABLED=false`         | 全部通过，结果不变                           |
| 精确 + 入口 | `ANALYSIS_MODE_ENABLED=true`、`strict` | 现有精确类用例仍走精确且结果不变                    |
| 假设策略    | `PRECISE_RESOLUTION_POLICY=assume`    | 原“缺日期/缺口径澄清”用例改为“补齐执行 + 披露”，评审后替换期望 |
| 分析      | 新增用例                                  | 见第 16 节                             |

---

## 14. 安全与治理

- **权限**：所有取数、覆盖、计算、目录探索均在后端按当前用户权限复核；子 lane 使用同一请求上下文，不扩大权限；
- **不生成 SQL**：分析模式只调用已注册的受控工具；
- **可信参数**：模式、解析策略、覆盖率复核参数由宿主绑定或改写，模型无法自行设置；
- **审计**：现有工具审计（`toolAudit.ts`）覆盖新工具的提出、放行、拦截、执行；计划与假设随回执由 Pi 持久化；
- **规则治理**：业务规则带负责人与更新时间，变更留痕，可按版本回滚；
- **边界**：客户级归因、预测、血缘仍由能力边界工具说明；“为什么”只做数据拆解。

---

## 15. 性能

| 项    | 设计                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------- |
| 分流   | 不增加模型往返（首步工具选择即分流）                                                                              |
| 批量取数 | 单次查询覆盖多指标、多机构、多日期                                                                               |
| 前缀缓存 | 系统提示词保持静态；分析摘要只进入本轮状态块。分析模式工具集不同，模式内缓存可复用，跨模式不共享（与现有按状态过滤工具的行为一致）                               |
| 自动执行 | 精确模式 READY 就地执行（现有）                                                                             |
| 二期并行 | 若批量不足以满足时延，评估把 Harness 设为全局并行：需在 `before_tool` 增加“同一批次最多一个 Frame 写入类工具”的规则，并经 POC 验证网关的并行工具调用支持 |
| 目标   | 精确问题耗时不劣于现状；分析问题端到端 P50 ≤ 25 秒（P0 实测后定稿）                                                        |

---

## 16. 评测与验收

### 16.1 评测集（按能力构造，不按话术）

两个维度交叉，每格至少 5 种表述（同义、口语、错别字、省略）：

| 输入完整度 \ 目标类型     | 取值 | 时间对比 | 横向/排名 | 结构拆解 | 概览 | 数据层面原因 |
| ---------------- | -- | ---- | ----- | ---- | -- | ------ |
| 条件完整             |    |      |       |      |    |        |
| 缺日期              |    |      |       |      |    |        |
| 缺口径              |    |      |       |      |    |        |
| 指标模糊或错字          |    |      |       |      |    |        |
| 只给业务概念           |    |      |       |      |    |        |
| 缺机构              |    |      |       |      |    |        |
| 多轮追问（换条件/深挖/转精确） |    |      |       |      |    |        |

领导提供的示例话术作为抽查样本并入。

### 16.2 指标

| 指标     | 定义               | 一期目标（P0 后定稿）        |
| ------ | ---------------- | ------------------- |
| 分流准确率  | 进入预期模式的比例        | 取值类 ≥ 95%，分析类 ≥ 90% |
| 直接完成率  | 无需澄清给出结果         | ≥ 85%               |
| 不必要澄清率 | 澄清中本可按策略补齐的比例    | ≤ 5%                |
| 假设合理率  | 人工评审认可的假设比例      | ≥ 90%               |
| 证据完整率  | 回答数值均有查询证据       | 100%                |
| 越界率    | 产生外部原因或预测性结论     | 0                   |
| 精确类回归  | `strict` 下现有用例结果 | 100% 不变             |

### 16.3 实现

- 单元/集成：`business-context` 增加假设策略用例；`harnessHost.test.ts` 增加分流、模式切换、参数改写、预算、复核、保底澄清、旧会话判定用例；
- 真实模型回归：新增 `agent-service/scripts/check-analysis-mode.ts`（沿用现有 `check-*.ts` 结构与 `--live` 参数），校验工具序列、模式、取数次数、假设、证据与终态；
- 验证记录写入 `docs/verification/`。

---

## 17. 实施计划

| 阶段              | 内容                                                                                                                                                                                                                       | 产出          | 依赖              | 预估                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------- | ----------------- |
| **P0 验证**       | ① 运行中 `setActiveTools`/`setModel`/`setThinkingLevel` 在下一步生效（在 `after_tool` 中调用）；② 子 lane 在主 lane 工具执行期间运行；③ `tool_update` 经 watch 推送；④ 用 DeepSeek-V4-Flash 跑分流与规划小样本                                                     | POC 结论与指标基线 | 无               | 3 天               |
| **P1 分析模式 MVP** | `start_analysis`；模式切换与默认恢复；按模式放开直接工具；`before_tool` 参数改写；假设策略（后端 resolve-field + agent `deriveDefaults`，先支持日期默认、机构默认、口径规则、相似度选择）；`business_rules` 表与首批规则；“本次分析口径”追加；旧会话判定修复；`analysis-methods` Skill；能力边界枚举收窄；前端模式标识与假设卡片 | 可灰度的分析模式    | 首批口径规则（可先由开发录入） | 2 周               |
| **P2 规划与语义层**   | `analysis_plan`（含日期换算）；主题与关系表、explore 接口、`catalog explore`；完成度复核；“上一次分析摘要”与跨轮衔接；计划卡片；`assumption_override`                                                                                                               | 自主规划与结构拆解   | 业务方整理主题、构成关系    | 1.5 周（开发）+ 业务整理并行 |
| **P3 深挖与优化**    | `analysis_subtask` 子 lane；钩子按 lane 区分；进度投影；评估全局并行与 `steer`                                                                                                                                                               | 深挖能力        | P0 结论           | 1 周               |
| **P4 评测固化**     | 评测集全量、回归脚本、指标看板                                                                                                                                                                                                          | 可量化验收       | 各阶段             | 持续                |

每阶段完成条件：自动化测试、类型检查、构建通过；真实模型回归达到该阶段指标；验证记录入库。

---

## 18. 风险与对策

| 编号 | 风险             | 对策                                                                |
| -- | -------------- | ----------------------------------------------------------------- |
| R1 | Flash 模型规划能力不足 | P0 实测；不足时配置 `ANALYSIS_MODEL` 让分析模式使用更强模型（Pi 按 lane 切换模型），精确模式不受影响 |
| R2 | 假设选错指标         | 阈值 + 领先间隔；“必须确认”规则；假设强制披露 + 一键修正                                  |
| R3 | 计划过大导致慢、答非所问   | 计划规模与调用次数上限；Skill 强调范围从小到大                                        |
| R4 | 把拆解说成因果        | `analysis-methods`/`analysis-boundary` 表述约束；越界率评测                 |
| R5 | 运行中切换工具集不生效    | 降级为请求体过滤 + `before_tool` 拦截（6.4 节第 6 点）                           |
| R6 | 语义层数据不全        | 缺关系时结构拆解不可用，回答如实说明；不以其他指标替代                                       |
| R7 | 旧会话误判只读        | 13.1 节修复列为 P1 必做项                                                 |
| R8 | 跨模式追问继承错误焦点    | 轮状态提示上一业务轮模式；评测集包含跨模式多轮                                           |
| R9 | 工具数增加导致选择混乱    | 两种模式各自暴露的工具不超过约 10 个                                              |

---

## 19. 待确认事项

1. 默认日期语义：多指标、多机构时取“共同最新日”（可比，推荐）还是“各自最新日”。
2. 业务规则（默认口径、说法对应、必须确认清单、阈值）的业务负责人。
3. 主题与指标构成关系的整理负责人与交付时间。
4. 指标目录中是否有计划/目标类、利润类数据；没有时相关目标按能力缺口说明。
5. 是否有更强的模型可用于分析模式（对应 R1）。
6. 分析类问题可接受的最长响应时间。
7. 精确模式何时开启 `assume` 策略（建议分析模式上线并评测后单独决策）。

---

## 附录 A：Pi Harness 源码核实记录

路径前缀：`agent-service/node_modules/@earendil-works/pi-agent-core/dist/harness/`

| 结论                                                                                                                                                                                                                    | 依据                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 钩子共 11 个：`before_run`、`before_drive`、`before_run_end`、`transform_context`、`before_request`、`before_payload`、`after_response`、`before_tool`、`after_tool`、`before_compaction`、`before_navigation`；事件均带 `lane` 与 `runId` | `agent-harness.d.ts:485-610`                                                          |
| `before_tool` 可返回 `args` 改写参数                                                                                                                                                                                         | `agent-harness.d.ts:550-563`                                                          |
| `before_run_end` 的 `followUp` 以 `role:"user"` 消息写入会话并继续运行                                                                                                                                                             | `runtime/drive/boundary.js:90-131`                                                    |
| 每个模型步骤开始时读取 lane 当前配置（工具集、模型、推理档位）                                                                                                                                                                                    | `runtime/drive/boundary.js:12-26`                                                     |
| `setActiveTools`/`setModel`/`setThinkingLevel` 经 `setConfiguration` 提交，无“运行中禁止”检查，仅等待 `runWhenIdle` 回调                                                                                                                | `runtime/lane.js` `setConfiguration`、`command`                                        |
| 只有活跃工具可被执行                                                                                                                                                                                                            | `runtime/drive/tools.js:440-443`、`runtime/drive/generation.js:36-43`                  |
| 工具并行只认全局 `toolExecution`；Harness 运行时不读取工具 `executionMode`                                                                                                                                                             | `runtime/drive/tools.js:445`；全目录检索 `executionMode` 无运行时引用                             |
| 工具 `prepareArguments` 在校验前生效                                                                                                                                                                                          | `execution/tools.js:25`                                                               |
| 工具 `replay: "safe"` 在恢复时重新执行                                                                                                                                                                                          | `runtime/drive/tools.js:348`                                                          |
| 每条 lane 独立判断忙闲（同一 lane 已有操作才返回 LaneBusy）                                                                                                                                                                              | `runtime/lane.js:390-400`                                                             |
| `harness.lane(name, {createAt})` 新建 lane，`createAt` 必须是已存在条目或 `null`；新 lane 从创建参数继承默认配置                                                                                                                               | `runtime/harness.js:56-120`                                                           |
| 运行请求支持 `kind:"skill"` 与 `kind:"prompt_template"`；Skill 调用格式为 `<skill>` 块 + 附加说明                                                                                                                                       | `agent-harness.d.ts:48-77`、`skills.js:8-11`                                           |
| `Skill.disableModelInvocation` 隐藏于模型目录但允许显式调用                                                                                                                                                                         | `types.d.ts`（`Skill` 定义）                                                              |
| `custom` 角色消息发送给模型时转为 `user` 角色                                                                                                                                                                                       | `messages.js:70-77`                                                                   |
| 工具调用备忘 `getMemo/setMemo` 持久化于操作                                                                                                                                                                                       | `types.d.ts`（`AgentHarnessToolInvocation`）、`session/values.d.ts`（`operationToolMemo`） |

## 附录 B：文件改动清单

### agent-service

| 文件                                                             | 类型 | 内容                                                         | 阶段    |
| -------------------------------------------------------------- | -- | ---------------------------------------------------------- | ----- |
| `src/tools/startAnalysis.ts`                                   | 新增 | 分析入口工具                                                     | P1    |
| `src/tools/analysisPlan.ts`                                    | 新增 | 计划工具与日期换算                                                  | P2    |
| `src/tools/analysisReview.ts`                                  | 新增 | 内部复核回执工具                                                   | P2    |
| `src/tools/analysisSubtask.ts`                                 | 新增 | 子 lane 深挖                                                  | P3    |
| `src/tools/index.ts`                                           | 修改 | 注册新工具；导出模式工具集常量                                            | P1    |
| `src/tools/catalog.ts`                                         | 修改 | `explore` 动作                                               | P2    |
| `src/tools/businessCapability.ts`                              | 修改 | 能力枚举收窄                                                     | P1    |
| `src/harnessHost.ts`                                           | 修改 | 模式切换、接纳时恢复默认、按模式放开工具与预算、参数改写、披露追加、复核、旧会话判定、钩子按 lane 区分（P3） | P1–P3 |
| `src/business-context/core.ts`                                 | 修改 | `deriveDefaults` 钩子                                        | P1    |
| `src/business-context/service.ts`                              | 修改 | 调用 `deriveDefaults`                                        | P1    |
| `src/business-context/capabilities.ts`                         | 修改 | `metric_query` 默认日期推导；描述去掉“不能替用户默认”（仅 assume 下）            | P1    |
| `src/business-context/resolvers.ts`                            | 修改 | 透传解析策略                                                     | P1    |
| `src/business-context/adapters.ts`                             | 修改 | 抽出 `frameQueryParams`                                      | P1    |
| `src/business-context/modelView.ts`                            | 修改 | 回执输出 `assumptions`、`query_args`                            | P1    |
| `src/requestContext.ts`                                        | 修改 | `resolutionPolicy`、`harness`、`analysis` 访问器                | P1/P3 |
| `src/backendClient.ts`                                         | 修改 | `policy` 参数；explore 接口                                     | P1/P2 |
| `src/sessionProjection.ts`                                     | 修改 | `tool_update` → `tool_progress`                            | P2    |
| `src/config.ts`                                                | 修改 | 第 12 节配置项                                                  | P1    |
| `src/prompts/businessSystemPrompt.ts`                          | 修改 | 分流原则一句                                                     | P1    |
| `skills/analysis-methods/SKILL.md`                             | 新增 | 分析方法与工具对应                                                  | P1    |
| `skills/analysis-drilldown/SKILL.md`                           | 新增 | 子任务方法（`disableModelInvocation`）                            | P3    |
| `skills/analysis-boundary/SKILL.md`                            | 修改 | 区分数据拆解与客户级归因                                               | P1    |
| `skills/metric-query/SKILL.md`、`skills/data-coverage/SKILL.md` | 修改 | 口径默认、未限定日期的表述随策略调整                                         | P1    |
| `prompts/*.md`（Pi 提示模板）                                        | 新增 | 子任务简报、复核提示                                                 | P2/P3 |
| `scripts/check-analysis-mode.ts`                               | 新增 | 真实模型回归                                                     | P1    |

### backend-next

| 文件                                                       | 类型    | 内容              | 阶段    |
| -------------------------------------------------------- | ----- | --------------- | ----- |
| `application/field_resolution.py`                        | 修改    | 假设策略消解链         | P1    |
| `application/metric_candidates.py`                       | 修改    | 标准化得分、领先间隔、规则口径 | P1    |
| `api/routes/business_context.py`                         | 修改    | `policy` 参数     | P1    |
| `application/business_rules.py`                          | 新增    | 规则读取与匹配         | P1    |
| `application/metric_explore.py`、`api/routes/catalog*.py` | 新增/修改 | explore 接口      | P2    |
| `infrastructure/db/models.py`、迁移脚本                       | 修改/新增 | 第 10.2 节四张表     | P1/P2 |

### frontend-vue

| 文件                                         | 类型 | 内容                        | 阶段    |
| ------------------------------------------ | -- | ------------------------- | ----- |
| `components/chat/AssumptionCard.vue`       | 新增 | 本次分析口径与一键修正               | P1    |
| `components/chat/AnalysisPlanCard.vue`     | 新增 | 计划卡片                      | P2    |
| `components/chat/BackendNextChatPanel.vue` | 修改 | 模式标识、卡片挂载、`tool_progress` | P1/P2 |
