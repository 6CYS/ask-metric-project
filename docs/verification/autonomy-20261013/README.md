# 自主理解与动态规划验收资源

> 2026-10-14：已按用户要求回退本轮自主分析研发代码，恢复实施前冻结基线。本文以下内容及测试记录仅作历史存档，相关新接口、Skill、配置、迁移和运行脚本已移出当前代码。回退范围和离线验证见 [回退记录](rollback-20261014.md)。

最新交付状态、实际取数值、回归对照及剩余验收边界见 [改造与实际验证](implementation-and-validation.md)。源码快照存于 `source-snapshots/`，不含 `.env` 或依赖；实际运行仍使用当前受控环境配置。

2026-10-14 已按确认范围完成基线/候选各 6 轮真实模型测试，各执行一次：两版均通过 4/6，精准查询与追问 4/4 通过，自主分析 0/2。基线实际请求 17 次，候选 15 次，无追加重跑。候选两项分析均出现模型流超时并且没有实际取数，自主规划未验收通过。逐项比较见 [本批对照](comparison.md)，失败原因和证据边界见上面的改造报告。以下命令用于复现说明，不表示已自动安排下一批调用。

用户工作簿只读提取为 `workbook-normalized.json`，带源文件 SHA256 和逐项单元格来源。原始工作簿未改写。它提供指标树展示分组、同义词与编码映射，没有数据湖指标值。

- 29 个业务行，其中 21 个有编码、8 个计算项无编码也无公式。
- 22 个维度，共 462 个编码单元格、440 个唯一编码。
- 工作簿第 29/30 行“不含协定”和“含协定”复用同一组 22 个编码，不能把“不含协定”别名直接导入正式目录。
- 展示树没有声明可加总、互斥、穷尽等业务关系；不能仅凭父子排列推导贡献分解。
- `unit` 是工作簿展示单位，不是已核验的数据湖存储单位。正式后端必须重新校验目录、单位和权限。

`model-dataset.json` 是固定的 7 场景 / 13 回合。覆盖精准维度查询、多轮日期与机构继承、历史事实计算、历史查询切回、自主选择指标、明确指标与新增指标混合、缺值后的结果驱动调整。机构和值均为隔离合成样本，绝不冒充数据湖事实。

在当前 `agent-service` 目录执行；鉴权从当前 `.env` 读取，不复制到基线快照或报告。

```sh
node --import tsx --env-file-if-exists=.env scripts/check-autonomy-model.ts
```

这是本地桩自检，不调用模型。正式模型验收命令：

```sh
node --import tsx --env-file-if-exists=.env scripts/check-autonomy-model.ts --live --phase=baseline --source-root=/private/tmp/harness-autonomy-01a135ad/baseline --scenarios=precise_dimension,precise_multi_turn,explicit_and_selected_metrics,result_driven_missing_data --repetitions=1 --max-model-calls=24 --report-base=../docs/verification/autonomy-20261013/fixed-baseline
```

候选需使用冻结后的源码目录，并启用新契约与自主分析：

```sh
AGENT_TURN_CONTRACT_V2=true AGENT_ANALYSIS_PLANNING=true node --import tsx --env-file-if-exists=.env scripts/check-autonomy-model.ts --live --phase=candidate --source-root=/private/tmp/harness-autonomy-01a135ad/candidate-v1 --scenarios=precise_dimension,precise_multi_turn,explicit_and_selected_metrics,result_driven_missing_data --repetitions=1 --max-model-calls=24 --report-base=../docs/verification/autonomy-20261013/fixed-candidate
```

两版本使用相同数据集、当前模型、`temperature=0`、输出预算与重试配置。按用户最新要求控制调用，默认每场景一次，最终必要小集为精准维度、多轮、混合指标分析、缺值重规划，共 6 回合 / 版本。本批即使失败也未追加重跑，保留全部失败样本。`--categories=precise,context` 可选功能组；`--repetitions` 仍支持配置但不自行扩大调用。若后续改了脚本、数据集或模型配置，应记录新实验批次。

```sh
node --import tsx scripts/compare-autonomy-model.ts --baseline=../docs/verification/autonomy-20261013/fixed-baseline.json --candidate=../docs/verification/autonomy-20261013/fixed-candidate.json --output=../docs/verification/autonomy-20261013/comparison
```

比较按“共同通过、仅候选失败、仅基线失败、共同失败”分类。API 连接错误、配额错误且未产生模型输出时单列不可比较；源码运行中变化拒绝作为可验收对照。原始工具调用不改写；JSON 报告保留回执、执行条件、Frame、准备记录和答案，原生 JSONL 另存并登记 SHA256。

历史环境问题：普通沙箱首次模型连接失败；一次提权请求获准到达现有 API 后返回 HTTP 402；随后单次诊断恢复，精准维度查询真实模型 1/1 通过。整组调用曾被自动审批以“内部提示词/契约发送到未明确受信目的地”为由拒绝。用户随后回答了向当前 `https://api.siliconflow.cn` 发送内部契约并各跑 6 轮的具体授权问题，本批获准执行，授权阻塞已解除。历史诊断没有并入本批准确率，也没有用替换执行方式绕过拒绝。

以上仅是 Agent 模型＋隔离桩验收。正式后端契约测试、真实目录复核、只读数据湖验证及浏览器交互验收必须分别报告。
