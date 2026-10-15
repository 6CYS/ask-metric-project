# 自主分析真实模型验收：baseline

模型：deepseek-ai/DeepSeek-V4-Flash。每场景 1 次，temperature=0；保留全部失败。真实模型 API＋隔离合成机构和值，指标名称和编码来自用户工作簿；未验证真实数据湖、数据库或生产环境。没有模型生成的基础设施失败不能计作业务基线失败。

{
  "turns": 1,
  "passed": 1,
  "failed": 0,
  "infrastructure_failures": 0,
  "business_failures": 0,
  "by_category": {
    "precise": {
      "total": 1,
      "passed": 1
    },
    "context": {
      "total": 0,
      "passed": 0
    },
    "analysis": {
      "total": 0,
      "passed": 0
    }
  }
}

|重复|场景|回合|结果|分类与说明|
|---|---|---|---|---|
|1|precise_dimension|1|通过| 目标与正式执行参数一致|

完整原始工具参数、回执、执行条件、Frame 和回答保存在同名 JSON；未重写模型原始调用。分析准备由隔离桩验证固定机构日期、指标范围与正式引用，不代表后端实现已验收。
