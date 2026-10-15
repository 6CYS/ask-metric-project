# 自主分析基线对照

真实模型 API＋隔离合成业务数据；未验证真实湖值。相同模型参数、provider硬预算和数据集。基础设施/预算失败单列，不据此判断功能退化或能力改善。全部计划样本完成：true。

{
  "shared_pass": 4,
  "candidate_only_failure": 0,
  "baseline_only_failure": 0,
  "shared_failure": 2,
  "infrastructure_incomparable": 0,
  "budget_incomparable": 0,
  "unpaired": 0
}

首个模型请求prompt token采用provider上报的pi-ai usage input+cacheRead+cacheWrite，保留raw usage，不用字符数估计。无usage为null。精确/上下文与新增分析分别计量；分析新增执行步骤导致总消耗变化，应与单请求上下文减少分开解读。

|类别|有计量配对|基线首请求prompt tokens|候选首请求prompt tokens|加权减少|达到40%|
|---|---|---|---|---|---|
|precise|1|13785|11182|18.9%|false|
|context|3|44089|36403|17.4%|false|
|analysis|2|27602|22396|18.9%|false|
|all|6|85476|69981|18.1%|false|

|样本|分类|基线|候选|首请求prompt减少|
|---|---|---|---|---|
|1:precise_dimension:1|shared_pass|true |true |18.9%|
|1:precise_multi_turn:1|shared_pass|true |true |18.9%|
|1:precise_multi_turn:2|shared_pass|true |true |17.3%|
|1:precise_multi_turn:3|shared_pass|true |true |16.3%|
|1:explicit_and_selected_metrics:1|shared_failure|false |false MODEL_STREAM_IDLE_EXCEEDED: 模型输出长时间没有有效进展，本轮未正常完成。|18.8%|
|1:result_driven_missing_data:1|shared_failure|false |false MODEL_STREAM_IDLE_EXCEEDED: 模型输出长时间没有有效进展，本轮未正常完成。|18.9%|
