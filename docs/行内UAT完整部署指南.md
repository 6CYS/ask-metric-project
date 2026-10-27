# 行内 UAT 配置与兼容说明

版本：uat-pi-20261009-r1；日期：2026-10-09。新版后端及 Agent 的 Nacos 配置读取、完整离线包和 Docker 模拟联调已经完成。**现场操作统一使用[部署执行手册](行内UAT部署执行手册.md)**；本文件保留配置与旧版差异，不再作为未实施的准备方案。

## 1. 上传资源与新版差异

| 资料 | 核对结果 | 本次使用 |
| --- | --- | --- |
| 问数092902.zip | 完整旧后端 r1；只有 backend，迁移至 0003 | 复用 Linux Python 依赖基线，保留旧版恢复材料 |
| 问数092903.zip | r2 Nacos 3.2.3 修复，包含后端 wheel 与运维程序 | 核对 Nacos 3.x OpenAPI 行为与 SM4 配置方式 |
| 新服务器直接部署-Nacos-20260929.md | 旧 UAT 部署说明 | 核对原 env、密钥引用、配置中心及注册原则 |

旧包附带 SHA-256 均核对通过，完整后端 tar 内 108 项和 r2 内 5 项校验通过。文件完整性不等于实际 UAT 已验证。

新版额外包含 Vue 前端、Pi Agent 的 dist/生产依赖/skills、Node 22.23.2，以及当前 Python wheel 和全量离线依赖。新增 0004/0005 数据库增量，旧包“无需迁移”的结论不适用于当前项目。

## 2. 本次拓扑

```text
浏览器 → 77.6.79.36:8090（独立 appuser Nginx）
           ├─ 静态页面
           ├─ /api/       → 77.16.60.204:8010（Python）
           └─ /agent-api/ → 77.16.60.204:8020（Agent）
                                      └→ 同机 Python 127.0.0.1:8010
Python / Agent → 原 UAT Nacos .204/.40/.91:8848（配置中心）
Python         → 原 UAT Nacos（服务注册，客户端 gRPC 9848）
```

原 8089 Nginx → .91/.40/.204:9000 Gateway 的链路保留。Nacos 管理配置/发现，不承载网页业务请求。新版验收服务名为 ask-metric-python-pi-uat；原 ask-metric-python 服务和旧 Gateway 不会因本包自动切换。

服务器已确认：后端麒麟 x86_64、glibc 2.28、Python 3.12.0；前端 Nginx 1.30.4；普通 appuser、无 sudo。Node 不在现场 PATH，本包提供 Linux x64 Node 22.23.2。Python 与 Nginx 复用现场现有安装。

## 3. 配置中心实际合同

namespace 复用原 public；本次配置组固定 ASK_METRIC_CONFIG_PI_UAT_R1；服务注册组保持 DEFAULT_GROUP。配置组和发现组不混用。

| Data ID | 格式与职责 |
| --- | --- |
| sznsznws_backend_runtime.yaml | 后端标量业务参数 |
| sznsznws_backend_datasource.yaml | 数据源、方言、连接池、表列映射 |
| sznsznws_backend_security.yaml | JWT/SM2/SSO/权限、管理令牌及模型引用凭据 |
| sznsznws_backend_model.json | 后端角色模型 |
| sznsznws_backend_prompts.json | 当前支持的后端提示词 |
| sznsznws_backend_semantic.json | 语义匹配配置 |
| sznsznws_agent_runtime.json | Agent 模型、预算、重试、超时等 |
| sznsznws_agent_security.json | AGENT_MODEL_API_KEY 密文 |

Agent 两项为 JSON，不能沿用准备阶段建议的 YAML 名称。后端兼容指定 prompts_query_only 的加载入口；本包统一导出并选择默认 prompts，不混读两份。

本机 backend.env / agent.env 仅保留 Nacos 地址和认证、配置组/命名信息、SM4 密钥文件引用、节点身份、监听及状态路径。中心模式的业务字段不被旧 .env 或进程环境中的业务值覆盖。没有本地业务快照回退。

数据库 URL、JWT、SM2、管理令牌和模型 API key 等敏感项使用 ENC[SM4:v1:...]。原主密钥 /home/appuser/ask-metric-config-uat/config-sm4-uat.key 复用，保持现场 appuser 可读、600 权限，不复制进交付包，不重新生成。

后端校验未知字段、重复字段、敏感明文及节点路径混入共享配置；Agent 校验允许字段、大小写重名、值类型、预算和 SM4 凭据。发布前校验后端整批配置以及 Agent 的实际 Node 启动入口，然后逐项发布回读。配置写入使用 CAS 并发检查；8 项并非一个数据库事务，失败后修正并重试，全部成功才启动。

后端标量及 Agent 配置在启动加载，修改后重启。后端模型/提示词/语义资源沿实际读取入口从 Nacos 加载；模型管理保存写回中心，密钥保持加密，不写回本地业务 env。

Nacos 3.x 配置接口采用 v3；仅确认路由不存在时兼容 v1。已实际验证 3.2.3 三节点集群、认证、读写、服务注册和一个节点停机后的启动切换。2.x 回退由 HTTP 桩测试覆盖，未做真实 2.x 联调。

## 4. 迁移旧现场配置

prepare 读取真实旧 env 及其实际引用文件，不把历史模板当现场事实。路径是绝对路径，必需资源不存在则停止；不会执行 env 内容。旧退役字段名称写入 export-report.json；旧 intent_routing 提示词不迁入当前入口。

Agent 模型从原 Chat 角色的地址、模型名、认证和额外参数生成。标准 Chat Completions 路径自动转换；非标准路径必须给出已确认的兼容入口。默认上下文 128000 只作为导出初值，须核对真实模型窗口，并验证 SSE/tools；不代表行内模型已经兼容。

旧省级权限字段非空时会停止自动迁移，需按当前正式机构目录和权限合同整理。旧 query_templates / SQL 模板配置不接入当前受治理 SQL builder，旧组保留供回退；涉及旧定制口径须结合新版真实取数验收。

## 5. 数据库增量与会话状态

| 迁移 | 新增列 |
| --- | --- |
| 0004_org_hierarchy_and_org_code | metric_values.org_code；org_terms.parent_org_code、hierarchy_level |
| 0005_metric_source_structure | metric_terms.source_metric_code、base_name、value_basis |

sql 命令从真实版本生成审核 SQL；db 命令核对两个连接及上述 6 列，start 不自动迁移。SQL 交 DBA 核对已有列、DDL 方言/锁和备份后执行。应用库现有用户、历史、目录保留，不初始化现有库。sync 读取正式目录并更新应用库，验收机构码必须与事实表一致。

Agent 会话放在 ~/ask-metric-pi/state/agent；升级保留，不能多实例同时写同一目录。Python 后端和 Agent 协议须配套升级。

## 6. 验证与边界

本机后端 Linux 回归 358 项通过，Agent 回归 330 项通过；完整离线安装、独立非 root Nginx、Nacos 三节点读取/注册/切换、加密登录、SSE 工具链、真实数据湖非空 SELECT 和迁移检查均通过。模型为模拟服务，不代表真实行内 LLM 已完成验收。

原模拟应用库保持 0004，本次在独立副本验证 0004→0005 和 0003→0005；原数据湖只读。模拟目录与事实表机构码不一致的测试映射只补入隔离副本，行内需核对正式映射。

Docker Linux 运行时与真实麒麟有版本差异；wheel 标签和 Node 基线满足目标 x86_64/glibc 2.28，但尚未在真实麒麟 Python 3.12.0、GoldenDB/Inceptor 内核、行内模型/SSO/网络策略下执行。详细结果见交付包《部署验证结果.md》。
