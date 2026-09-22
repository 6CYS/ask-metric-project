# 指标算法匹配与离线部署

智能助手沿用原入口和 Pi 会话。指标提取、名称匹配和相似候选由 Python 后端算法处理；Pi 负责用户目标、历史引用、排除/替换语义、候选确认和回答。自动采用由服务端统一判断，Pi 不自行根据候选分数改写解析状态。

## 选型

| 组件 | 用途 | 运行依赖 |
| --- | --- | --- |
| `hanlp-trie==0.0.5` | 直接从完整原文匹配目录名称和别名，保留跨度与一词多码 | 纯 Python；依赖 hanlp-common、phrasetree，不下载模型 |
| `pypinyin==0.55.0` | 目录词条和问题的无声调拼音，召回同音错字 | 自带词典，不请求外部服务 |
| `rapidfuzz==3.13.0` | 字符/拼音局部相似度排序 | 使用目标架构 wheel；无需 GPU |
| 字符二元组倒排 | 名称、别名、目录描述与解释召回 | 内存索引 |

单独分词或 Trie 不能完成错字、同音、描述检索。完整 HanLP 的神经模型也不会自动知道业务指标编码；本次没有加载或测试这些模型，不宣称比它们更准确。
官方资料：[安装与离线说明](https://hanlp.hankcs.com/docs/install.html)、[Trie/词典](https://hanlp.hankcs.com/docs/api/trie/dictionary.html)。

## 调用链

1. 宿主以经过鉴权的 BackendClient 将完整本轮原文发送到 `POST /api/v1/business-context/metric-mentions`，模型不能替换这段输入。
2. 后端从启用目录构建/复用不可变索引。目录内容变化即使用新快照；最多缓存两个版本，不缓存业务查询结果。
3. Trie 最大跨度匹配保护完整名称，同名/同别名保留全部编码。字符和拼音二元组倒排召回至多 200 个词条后排序；目录解释文本补充描述候选。
4. 服务端提供带明确序号的片段。Pi 的指标字段使用 `{fromQuestion:true}`，或用 `mentionIndexes` 选择所指片段，避免把用户明确排除的指标一起查询。兼容旧字符串参数时也使用完整原文算法结果，不再信任模型截取名称。
5. 唯一完整名称/受控别名命中直接 resolved。近似指标按完整片段与名称/别名的字符、拼音相似度重新评分，唯一最高分达到 0.95（含）也直接 resolved；不同编码并列最高或低于阈值仍需确认。同码别名合并，不将短子串的局部满分当作整体满分。描述召回分数低于阈值，不自动采用。多指标逐项判断，不丢弃不确定项。此阈值不改变机构解析规则。
6. 用户下一轮选择候选后按候选编码重新查目录，合并到原 Frame；日期与机构继承。执行层再次校验目录和权限。

候选 score 是算法相似度，不代表正确率或概率。完整名称已命中时，不因“是多少”等问句尾文被模糊对齐而扩大指标跨度；只有原文相邻文字确实支持更长词条时，才进入更长候选判断。目录未登记的俗称如果与名称、拼音、描述均无可检索联系，算法可能找不到；返回未匹配，不凭空猜指标。需要用脱敏真实问句评估并维护别名/解释。多音字依赖拼音词典，也需要真实样本验收。

## 可复现验证

在 `backend-next` 执行：

```sh
.venv/bin/python -m pytest -q verification tests
PYTHONPATH=src .venv/bin/python verification/benchmark_metric_candidates.py /tmp/metric-matching.json
```

在 `agent-service` 执行：

```sh
npm run typecheck
npm test -- --silent
npm run build
node --env-file=.env --import tsx scripts/check-metric-name-model.ts --live
node --env-file=.env --import tsx scripts/check-metric-typo-model.ts --live
```

真实模型脚本使用配置模型、真实 Python 算法、隔离合成目录和取数桩；不连接业务数据库。无 `--live` 时不调用模型。

一万条合成目录、8 个词法/错字/同音/描述样本：旧整句 SequenceMatcher 的 Top-5 命中 2/8，单独 Trie 2/8，组合算法 8/8。固定 RapidFuzz 3.13.0 的本机热索引 p50 约 0.73 ms、p95 约 3.11 ms，冷构建约 527 ms。详见 [基准记录](verification/metric-matching-benchmark-2026-09-21.json)。

这些延迟不包含数据库加载、快照指纹、HTTP、Pi 模型推理；合成小样本不能代表真实目录准确率，也不能证明整体问答已达到毫秒级。

2026-09-21 版本离线检查：Agent 210 项、后端 301 项通过；类型检查、构建、修改文件 Ruff 和 `git diff --check` 通过。当日真实模型专项：4 种完整指标名各一次取数；2 种同音错字按当时的强制确认策略，确认前零取数、确认后一次取数。2026-09-22 起改为上述 95% 自动采用策略，错字模型脚本同步覆盖高分直接查询和低分确认后查询；旧报告不代表新策略的验证结果。

2026-09-22 的阈值改造验证：后端 314 项、Agent 212 项通过；类型检查、构建、修改 Python 文件 Ruff、`git diff --check` 通过。新增回归覆盖 95% 边界、低于阈值、同分不同码、同码别名、完整名称与问句尾文、混合多指标，以及已确定指标不随机构候选重复澄清。验证使用合成目录和取数桩；本次没有重新调用真实模型或执行真实业务取数。当前项目后端与 Agent 已重启，后端健康/就绪、Agent 健康及前端 Agent 代理均返回 HTTP 200。

额外七轮连续回归没有全部通过：出现模型请求超时、无效工具格式，以及历史复用时模型夹带 clear 参数。后一项已改为 `ARGUMENT_ERROR` 并保留焦点，补充同轮纠正单测；没有把本次七轮失败写成通过。模型回答环节的延迟和稳定性仍需处理。[完整记录与先前失败](verification/metric-matching-model-2026-09-21.json)。

## 内网交付

沿用现有无 Docker 离线包，不新增入口、Java 服务或外部 HanLP REST 调用，不携带神经模型权重。构建机需访问经过批准的依赖源；目标机无外网。

- 依赖版本写入 `pyproject.toml` 与 `deploy/package/constraints.txt`。HanLP 间接依赖锁定为 hanlp-common 0.0.23、phrasetree 0.0.9。
- 上游 HanLP 轻量包只提供源码分发时，`build_bundle.py` 在构建机生成 `*-none-any.whl`，验证是纯 Python wheel，再与目标平台依赖一起打包。目标机不编译、不下载。
- RapidFuzz 3.14.6 缺少当前 manylinux2014 基线的匹配 wheel，因此选择并验证 3.13.0。已下载验证 CPython 3.12/Linux x86_64 和 aarch64 wheel；纯 Python 依赖已执行 `--no-index` 安装及独立导入。未在真实麒麟服务器运行，也未本次重新构建全部生产包。
- 整包沿用 SHA-256 清单、固定运行时、systemd 启停与既有回滚工具。使用 `--dependency-wheelhouse` 时必须更新已验收的 wheel 集合，不能复用缺少新增依赖的旧集合。
- 先升级后端依赖与服务，再切换 Agent。没有数据库迁移；回退须配套恢复两个服务版本并保留原生会话目录。
