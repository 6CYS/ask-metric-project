# 固定6轮对照：独立审计

**精准查询和多轮继承在本小集内通过；自主分析未完成，不能宣称整体正常或已打通。** 本审计只读已完成报告和原件，未调用模型、未修改运行时代码。

| 验收项 | 基线 | 候选 |
|---|---:|---:|
| 精准查询＋多轮继承 | 4/4 | 4/4 |
| 两个分析turn | 0/2 | 0/2 |
| direct query总次数 | 6 | 4 |
| 分析场景direct query | 2 | 0 |
| 分析prepare / execute | 0 / 0 | 0 / 0 |
| Provider调用 | 17/24 | 15/24 |

精准四轮的code、机构、日期、exact/value、唯一查询及focus.resultRef均正确，合成facts为5%、1000、1020、1120。多轮仅替换指定日期或机构，指标原文与sourceFrameId链保留。

基线混合分析重复查询两次相同必查指标，补充指标仅停留在建议；缺数场景澄清后结束。候选混合分析第二流124.764秒、缺数场景第五流126.445秒后均idle失败，空回答、零查询。两次analysis_task仅toolcall_start，无结束事件、回执或持久化任务。缺数场景此前另有INVALID_MENTION_REFERENCE、FIELD_INPUT_NOT_CURRENT。两版均未触发缺数fixture，无法证明结果驱动重规划。流失败具体根因尚未归因。

候选混合的**未执行草案**还把“两必查指标”只绑定总量，把“个人占比”绑定总量；不能表述为宿主已经接受。候选精准追问自行回答“增加20亿元”“高出100亿元”，虽算术正确，却没有calculate回执；自动精准评分未覆盖此项计算治理。

公平性核查通过：相同runner/dataset/normalized workbook/model参数、固定6turn各一次；冻结源码62/70文件hash稳定。32条usage与native逐条相同、全部恒等及汇总求和正确；8份native SHA/字节数匹配，工具参数和回执未改写。

首请求prompt按total-output（等于input+缓存）合计**85,476→69,981，减少18.13%，未达40%**。精确18.88%、多轮17.43%、分析18.86%。total tokens268,385→199,056，但分析均失败，不能称等效业务成本改善。总耗时49.540→292.170秒仅为本批观察。

真实模型搭配隔离合成后端，未验证真实湖值、SQL、数据库NULL/哨兵或全部历史功能。缺数fixture表示缺少rows/facts，并非literal null；本批未触发它。

逐轮spec、继承来源、32usage核对、8原件hash及native行号见[审计JSON](/Users/yubobo/Documents/服务项目/江苏农信/ask-metric-intent-goldendb-Harness/docs/verification/autonomy-20261013/fixed-batch-audit.json)；来源为[基线](/Users/yubobo/Documents/服务项目/江苏农信/ask-metric-intent-goldendb-Harness/docs/verification/autonomy-20261013/fixed-baseline.json)、[候选](/Users/yubobo/Documents/服务项目/江苏农信/ask-metric-intent-goldendb-Harness/docs/verification/autonomy-20261013/fixed-candidate.json)。
