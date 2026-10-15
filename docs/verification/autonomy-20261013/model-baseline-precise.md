# 自主分析真实模型验收：baseline

模型：deepseek-ai/DeepSeek-V4-Flash。每场景 3 次，temperature=0；保留全部失败。真实模型＋隔离合成机构和值，指标名称和编码来自用户工作簿；未验证真实数据湖、数据库或生产环境。

{
  "turns": 12,
  "passed": 0,
  "failed": 12,
  "by_category": {
    "precise": {
      "total": 3,
      "passed": 0
    },
    "context": {
      "total": 9,
      "passed": 0
    },
    "analysis": {
      "total": 0,
      "passed": 0
    }
  }
}

|重复|场景|回合|结果|说明|
|---|---|---|---|---|
|1|precise_dimension|1|失败|MODEL_TURN_COMPLETED|
|1|precise_multi_turn|1|失败|MODEL_TURN_COMPLETED|
|1|precise_multi_turn|2|失败|MODEL_TURN_COMPLETED|
|1|precise_multi_turn|3|失败|MODEL_TURN_COMPLETED|
|2|precise_dimension|1|失败|MODEL_TURN_COMPLETED|
|2|precise_multi_turn|1|失败|MODEL_TURN_COMPLETED|
|2|precise_multi_turn|2|失败|MODEL_TURN_COMPLETED|
|2|precise_multi_turn|3|失败|MODEL_TURN_COMPLETED|
|3|precise_dimension|1|失败|MODEL_TURN_COMPLETED|
|3|precise_multi_turn|1|失败|MODEL_TURN_COMPLETED|
|3|precise_multi_turn|2|失败|MODEL_TURN_COMPLETED|
|3|precise_multi_turn|3|失败|MODEL_TURN_COMPLETED|

完整原始工具参数、回执、执行条件、Frame 和回答保存在同名 JSON；未重写模型原始调用。分析准备由隔离桩验证固定机构日期、指标范围与正式引用，不代表后端实现已验收。
