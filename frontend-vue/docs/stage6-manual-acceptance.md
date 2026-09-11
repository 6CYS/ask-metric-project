# 第六阶段 frontend-vue 手工验收

## 环境与固定数据

启用新链路：

```dotenv
VITE_BACKEND_NEXT_BASE_URL=http://localhost:8010
```

测试数据沿用第五阶段：`M_VALUE/保费收入`、`M_RANK/保费收入排名`；北京、上海、广州；北京普通值 2026-05-30=100、2026-06-15=110、2026-06-30=120，上海 2026-05-30=0、2026-06-30=80，广州 2026-05-30=60 且缺少 2026-06-30；排名值为 1、2、3。

下文 SlotFrame 只列关键字段，未列字段使用空数组或默认值；Logical DSL 均为 `v=1, task=metric_query`。

## 测试用例

### 1. 单指标最新值

- 用户输入：`查询保费收入最新值`。
- 前置数据：三个机构的 `M_VALUE` 多日期数据。
- 预期 SlotFrame：`metrics=[M_VALUE], time=latest, ops=[]`。
- 预期 Logical DSL：`metrics=[M_VALUE], time.preset=latest`。
- 预期 query_shape：`metric_value`。
- 预期页面：表格显示各机构各自最新日期和值，广州日期为 2026-05-30。
- 状态核对：QueryTask `RUNNING/LOGICAL_DSL → SUCCEEDED/RESULT_FORMATTING`；用户和结果 ChatMessage 各一条；QueryRun `succeeded`。

### 2. 单指标指定日期

- 用户输入：`查询2026年6月30日保费收入`。
- 前置数据：北京 120、上海 80，广州该日缺失。
- 预期 SlotFrame：`metrics=[M_VALUE], time=2026-06-30`。
- 预期 Logical DSL：`time.start=time.end=2026-06-30`。
- 预期 query_shape：`metric_value`。
- 预期页面：仅显示北京和上海的 2026-06-30 数据。
- 状态核对：QueryTask 成功；结果 ChatMessage 的 payload 含结果快照；QueryRun `row_count=2`。

### 3. 多指标查询

- 用户输入：`查询保费收入和保费收入排名最新值`。
- 前置数据：`M_VALUE` 与 `M_RANK`。
- 预期 SlotFrame：`metrics=[M_VALUE,M_RANK], time=latest`。
- 预期 Logical DSL：`metrics=[M_VALUE,M_RANK]`，无隐式聚合。
- 预期 query_shape：`metric_value`。
- 预期页面：同一表格按指标、机构返回，并明确每行 stat_date。
- 状态核对：QueryTask 成功；一条 QueryRun；SQL 参数 `metric_codes` 含两个编码。

### 4. 单机构查询

- 用户输入：`查询北京分公司最新保费收入`。
- 前置数据：北京多日期普通指标。
- 预期 SlotFrame：`metrics=[M_VALUE], orgs=[O_BJ], time=latest`。
- 预期 Logical DSL：`orgs=[O_BJ]`。
- 预期 query_shape：`metric_value`。
- 预期页面：北京 120，日期 2026-06-30。
- 状态核对：QueryRun `sql_params.org_names=[北京分公司]`；QueryTask 成功；消息关联同一 task_id。

### 5. 多机构普通查询

- 用户输入：`查询北京和上海分公司的保费收入`。
- 前置数据：北京、上海同日数据。
- 预期 SlotFrame：`orgs=[O_BJ,O_SH], ops=[]`。
- 预期 Logical DSL：两个 org，无 `entity_compare`。
- 预期 query_shape：`metric_value`。
- 预期页面：显示两行普通值，不显示差额或比例。
- 状态核对：QueryRun 成功且 `result_operations=[]`；QueryTask 成功。

### 6. 明确机构对比

- 用户输入：`比较北京和上海分公司最新保费收入差额`。
- 前置数据：2026-06-30 北京 120、上海 80。
- 预期 SlotFrame：`orgs=[O_BJ,O_SH], ops=[entity_compare/difference]`。
- 预期 Logical DSL：保留明确 entity_compare 操作。
- 预期 query_shape：`metric_value`。
- 预期页面：实体比较表显示差额 40、比例 1.5、北京更高。
- 状态核对：QueryRun SQL 仍为 metric_value；结果消息 `comparisons` 非空；QueryTask 成功。

### 7. 趋势查询

- 用户输入：`查询北京分公司2026年5月至6月保费收入趋势`。
- 前置数据：北京 100、110、120 三个时间点。
- 预期 SlotFrame：`time=2026-05-01..2026-06-30, ops=[trend/month]`。
- 预期 Logical DSL：同一时间区间和 trend 操作。
- 预期 query_shape：`metric_trend`。
- 预期页面：折线图和表格按 stat_date 升序展示，不跨日期 SUM。
- 状态核对：QueryRun 模板 `metric_trend`；QueryTask 成功；结果消息可刷新恢复。

### 8. 环比或自定义期间比较

- 用户输入：`比较上海分公司2026年6月30日保费收入和上月`。
- 前置数据：当前 80、基准 0。
- 预期 SlotFrame：`ops=[period_compare/mom]`。
- 预期 Logical DSL：current=2026-06-30，基准由代码解析为 2026-05-30。
- 预期 query_shape：`metric_period_compare`。
- 预期页面：current=80、base=0、difference=80、change_rate=-、status=base_zero。
- 状态核对：QueryRun 成功；无除零异常；QueryTask 成功。

### 9. 普通指标前十

- 用户输入：`2026年6月30日各机构保费收入前十`。
- 前置数据：普通值北京 120、上海 80，广州缺失。
- 预期 SlotFrame：`ops=[ranking/desc/top_n=10]`。
- 预期 Logical DSL：排序意图结构化，不含用户 ORDER BY 文本。
- 预期 query_shape：`metric_ranking`。
- 预期页面：柱状图/表格，北京在上海之前。
- 状态核对：QueryRun 参数 limit=10；模板为 metric_ranking；Task 成功。

### 10. 复合排名指标前十

- 用户输入：`保费收入排名前十`。
- 前置数据：`M_RANK` 值 1、2、3。
- 预期 SlotFrame：`metrics=[M_RANK], ops=[top_n/n=10/order=asc]`。
- 预期 Logical DSL：保留 top_n，不能重算排名。
- 预期 query_shape：`metric_ranking`。
- 预期页面：北京、上海、广州按 1、2、3 升序。
- 状态核对：QueryRun 参数排序方向由代码决定为 asc；Task 成功。

### 11. 指标名称内部词不重复解析

- 用户输入：`查询保费收入较年初排名最新值`（目录中预置同名复合指标时执行）。
- 前置数据：指标目录包含完整复合指标名称及固定编码。
- 预期 SlotFrame：完整名称只命中一个 metric；不额外添加 period_compare/ranking。
- 预期 Logical DSL：仅该指标编码，`ops=[]`。
- 预期 query_shape：`metric_value`。
- 预期页面：展示指标自身数值，不生成重复比较或二次排名。
- 状态核对：metric match 使用受保护跨度；QueryRun 无额外 result operation。

### 12. 指标歧义澄清

- 用户输入：`查询规模`，且“规模”命中多个指标。
- 前置数据：至少两个指标共享别名“规模”。
- 预期 SlotFrame：`metrics=[]，missing=[metrics]`。
- 预期 Logical DSL：无，禁止 execute。
- 预期 query_shape：无。
- 预期页面：`WAITING_USER`，展示 analyze 返回的候选项；选择后提交结构化 `set.metrics`。
- 状态核对：同一 QueryTask 版本递增；澄清 ChatMessage 与回答 ChatMessage 关联同一 task_id；选择后才生成 DSL/QueryRun。

### 13. 机构歧义澄清

- 用户输入：使用会命中多个机构的简称查询保费收入。
- 前置数据：机构目录存在同简称候选。
- 预期 SlotFrame：`metrics=[M_VALUE], orgs=[]，missing=[orgs]`。
- 预期 Logical DSL：无。
- 预期 query_shape：无。
- 预期页面：展示机构候选，提交 `set.orgs`，不拼接原问题。
- 状态核对：澄清前无 QueryRun；回答后仍是原 QueryTask；最终成功。

### 14. 多轮修改时间

- 用户输入：先完成查询，再输入 `改成上月`。
- 前置数据：已有成功 QueryTask。
- 预期 SlotFrame：当前后端将其作为新 QueryTask 分析；因缺少指标应进入 `missing=[metrics]`，不得继承或猜测旧任务。
- 预期 Logical DSL：无，直到用户结构化确认指标。
- 预期 query_shape：无。
- 预期页面：明确请求补充指标，不静默复用旧结果。
- 状态核对：新 QueryTask `WAITING_USER`；旧 QueryTask 保持 SUCCEEDED；无新 QueryRun。说明：已完成任务原地修改接口不在当前协议内。

### 15. 多轮增加和取消环比

- 用户输入：先完成普通查询，再输入 `增加环比` 或 `取消环比`。
- 前置数据：已有成功 QueryTask。
- 预期 SlotFrame：新任务若缺指标则请求澄清；不能修改旧成功任务。
- 预期 Logical DSL：补全指标前无 DSL。
- 预期 query_shape：无。
- 预期页面：明确澄清/不支持当前上下文修改，不伪造旧任务变更。
- 状态核对：旧 Task/Run 不变；新 Task 独立。后续需新增“任务结构化修订”后端协议才能正式支持。

### 16. 页面刷新后任务恢复

- 用户输入：任一等待澄清或成功查询后刷新。
- 前置数据：浏览器 localStorage 已保存 conversation_id，后端保留消息、Task 和结果 payload。
- 预期 SlotFrame：GET task 返回原 slots。
- 预期 Logical DSL：若已生成则 GET task 返回原 DSL。
- 预期 query_shape：会话 task 快照返回原 shape。
- 预期页面：恢复消息、等待澄清按钮、任务状态及成功结果表格。
- 状态核对：刷新不新增 QueryTask/ChatMessage/QueryRun；LOGICAL_DSL 中断任务使用固定执行请求 ID 恢复执行。

### 17. 重复点击执行

- 用户输入：快速双击同一澄清候选或提交按钮。
- 前置数据：一个可执行 Task。
- 预期 SlotFrame：不变。
- 预期 Logical DSL：不变。
- 预期 query_shape：原 shape。
- 预期页面：发送锁禁用重复操作，最终只显示一份结果。
- 状态核对：同一执行请求 ID `execute:{task_id}`；仅一条 QueryRun；数据源访问一次。

### 18. 旧 clarification_id 提交冲突

- 用户输入：在澄清更新后重放旧候选提交。
- 前置数据：Task 已有新 version 或新 clarification_id。
- 预期 SlotFrame：保持最新状态，不应用旧 patch。
- 预期 Logical DSL：保持最新值。
- 预期 query_shape：保持最新值。
- 预期页面：展示 `TASK_VERSION_CONFLICT` 或 `CLARIFICATION_MISMATCH`，不执行。
- 状态核对：QueryTask 版本不回退；不新增 QueryRun；冲突请求不新增有效回答状态。

### 19. 多个待澄清任务消歧

- 用户输入：同一会话创建两个歧义问题，分别点击各自候选。
- 前置数据：两个 WAITING_USER QueryTask。
- 预期 SlotFrame：每个 Task 各自保存 slots。
- 预期 Logical DSL：只更新被点击消息绑定的 task_id。
- 预期 query_shape：各自独立。
- 预期页面：候选按钮属于具体消息，不依赖“会话中唯一待澄清任务”。
- 状态核对：提交携带明确 task_id/version/clarification_id；另一 Task 保持 WAITING_USER。

### 20. 无数据结果

- 用户输入：`查询不存在日期的保费收入`。
- 前置数据：目标日期无记录。
- 预期 SlotFrame：指标和时间完整。
- 预期 Logical DSL：完整。
- 预期 query_shape：`metric_value`。
- 预期页面：明确“暂无匹配数据”，空表不伪造零值。
- 状态核对：QueryTask SUCCEEDED；QueryRun succeeded、row_count=0；结果 ChatMessage 存在。

### 21. SQL 执行失败

- 用户输入：任一可执行查询；测试环境模拟数据源异常。
- 前置数据：适配器返回受控异常。
- 预期 SlotFrame：完整。
- 预期 Logical DSL：完整。
- 预期 query_shape：对应 shape。
- 预期页面：红色失败消息，展示可理解的 `QUERY_EXECUTION_FAILED` 文案。
- 状态核对：QueryTask FAILED/EXECUTION；QueryRun failed，failed_node=execution；失败 ChatMessage 存在。

### 22. unsupported dimensions

- 用户输入：`按产品类型查询保费收入`。
- 前置数据：metric_values 无产品维度。
- 预期 SlotFrame：`dimensions=[产品类型]`。
- 预期 Logical DSL：保留 dimensions，不静默删除。
- 预期 query_shape：语义 shape 可生成，但规划明确 unsupported。
- 预期页面：显示当前 metric_values 不支持 dimensions。
- 状态核对：QueryTask FAILED；QueryRun `failed_node=planning`、`QUERY_UNSUPPORTED`。

### 23. unsupported filters

- 用户输入：`查询保费收入，只看渠道为线上`。
- 前置数据：metric_values 无渠道字段。
- 预期 SlotFrame：filters 保留渠道条件。
- 预期 Logical DSL：filters 原样结构化。
- 预期 query_shape：基础 shape。
- 预期页面：明确 filters 暂不支持，不返回未过滤结果。
- 状态核对：QueryTask FAILED；QueryRun planning unsupported；无数据源访问。

### 24. unsupported detail

- 用户输入：`查询保费收入客户明细`。
- 前置数据：metric_values 无客户、合同或产品明细。
- 预期 SlotFrame：`ops=[detail]`。
- 预期 Logical DSL：保留 detail 意图。
- 预期 query_shape：`metric_detail`。
- 预期页面：明确 detail unsupported，不显示伪造明细表。
- 状态核对：QueryTask FAILED；QueryRun `failed_node=planning`；无 SQL 执行。

## 数据库影响

无表结构变化，无 Alembic 迁移。刷新结果恢复使用现有 `chat_messages.payload` JSON 字段保存受查询上限约束的结果快照。
