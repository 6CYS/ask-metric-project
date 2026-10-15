# 自主分析真实模型验收：baseline

模型：deepseek-ai/DeepSeek-V4-Flash。每场景 1 次，temperature=0；保留全部失败。真实模型 API＋隔离合成机构和值，指标名称和编码来自用户工作簿；未验证真实数据湖、数据库或生产环境。没有模型生成的基础设施失败不能计作业务基线失败。

{
  "planned_turns": 6,
  "turns": 6,
  "passed": 4,
  "failed": 2,
  "budget_errors": 0,
  "infrastructure_failures": 0,
  "business_failures": 2,
  "token_usage": {
    "input": 204850,
    "output": 3375,
    "cacheRead": 60160,
    "cacheWrite": 0,
    "totalTokens": 268385
  },
  "usage_reported_generations": 17,
  "usage_unavailable_generations": 0,
  "by_category": {
    "precise": {
      "total": 1,
      "passed": 1
    },
    "context": {
      "total": 3,
      "passed": 3
    },
    "analysis": {
      "total": 2,
      "passed": 0
    }
  }
}

|重复|场景|回合|结果|分类与说明|
|---|---|---|---|---|
|1|precise_dimension|1|通过| 目标与正式执行参数一致|
|1|precise_multi_turn|1|通过| 目标与正式执行参数一致|
|1|precise_multi_turn|2|通过| 目标与正式执行参数一致|
|1|precise_multi_turn|3|通过| 目标与正式执行参数一致|
|1|explicit_and_selected_metrics|1|失败|business_or_runtime ANALYSIS_SELECTED_ADDITIONAL_METRICS|
|1|result_driven_missing_data|1|失败|business_or_runtime ANALYSIS_ACTUALLY_QUERIED|

完整原始工具参数、回执、执行条件、Frame 和回答保存在同名 JSON；未重写模型原始调用。分析准备由隔离桩验证固定机构日期、指标范围与正式引用，不代表后端实现已验收。
