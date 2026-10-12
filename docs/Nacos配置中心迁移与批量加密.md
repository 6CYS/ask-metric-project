# Nacos 配置中心迁移与批量加密

本说明适用于本次配置抽离后的版本，替代旧部署步骤中的业务配置复制、固定目录初始化和逐项手工加密步骤。查询能力、提示词内容、SQL 参数绑定、目录权限、管理员入口和配置版本记录保持原有职责；不执行数据库迁移。

## 分类与命名

依据《信息科技部生产环境应用系统配置文件管理规范》，采用“系统缩写_组件名称_标签.后缀”。本项目使用系统缩写 `sznsznws`、组件名称 `backend`；当前没有多个组件共同使用的配置，不额外创建空的 `common` 文件。业务配置由 Nacos 管理，不要求放到 `/home/appuser/config/dir_$App_IDC/`。

配置模板独立放在 `configuration/nacos-templates/`，不进入程序 wheel、Docker 镜像或应用 tar 包。离线构建另行输出 `sznsznws-config-templates-<version>.zip`。模板目录只存示例；实际填写的配置放在受保护工作目录，不提交 Git。

| 分类 | Data ID | 迁移来源与内容 |
| --- | --- | --- |
| 运行参数 | `sznsznws_backend_runtime.yaml` | 环境文件中的应用、日志策略、模型地址、并发、缓存、查询限制等 |
| 数据源通信 | `sznsznws_backend_datasource.yaml` | 应用库、只读查询库、连接池、数据湖表名和字段映射 |
| 安全与认证 | `sznsznws_backend_security.yaml` | JWT、SM2、SSO、权限机构编码、模型 API Key、管理员令牌等 |
| 模型协议 | `sznsznws_backend_model.json` | `MODEL_CONFIG_PATH` 实际文件；保留模型名、协议、超时与请求参数 |
| 提示词 | `sznsznws_backend_prompts.json` | `PROMPT_CONFIG_PATH` 实际文件 |
| 兼容提示词 | `sznsznws_backend_prompts_query_only.json` | 兼容已有 query-only 路径；只使用选定的一个提示词 Data ID |
| 语义配置 | `sznsznws_backend_semantic.json` | `SEMANTIC_CONFIG_PATH` 实际文件；澄清文案和检索参数 |
| 查询模板注册 | `sznsznws_backend_query_templates.json` | `QUERY_TEMPLATE_CONFIG_PATH` 实际文件；注册和启停属性 |
| MySQL 模板 | `sznsznws_backend_sql_mysql.json` | SQL 注册表引用的 MySQL SQL 文本，按模板名归并 |
| Inceptor 模板 | `sznsznws_backend_sql_inceptor.json` | SQL 注册表引用的 Inceptor SQL 文本，按模板名归并 |

Nacos 使用现有环境的 namespace **ID**，配置分组默认 `ASK_METRIC_CONFIG`；服务发现继续使用原 `NACOS_GROUP`，两者独立。环境通过 namespace 隔离。当前环境为 Nacos **3.2.3**，应用连接 **8848**；**8080** 为控制台端口。

配置读取优先使用 `/nacos/v3/client/cs/config`，发布使用 `/nacos/v3/admin/cs/config`，参数为 `namespaceId`、`groupName` 和 `dataId`，并解析 v3 响应。仅首次只读探测确认 v3 路由不存在时兼容 Nacos 2.x `/nacos/v1/cs/configs`；配置缺失不回退。更新使用 HTTP 请求头 `casMd5` 防止覆盖他人修改，发布失败不自动重发。用户名密码鉴权仍使用 `/nacos/v1/auth/users/login`。配置客户端复用连接和有效令牌；只读请求遇到认证失效时重新认证并重试一次，持续拒绝则报错。服务发现继续使用现有 SDK，需保留其 gRPC 网络规则。地址可填写多个逗号分隔节点；发布出现网络错误时结果可能不确定，需要核对 Nacos 后再重试。

已安装 20260929-r1 的节点按 [Nacos 3.2.3 修复步骤](../deploy/Nacos323修复包操作步骤-20260929-r2.md) 更新，无需重新导出、加密或发布原有配置。

`sznsznws_backend_bootstrap.env` 是节点引导文件，**不复制到 Nacos**：包括 Nacos 地址/认证/namespace/group、SM4 主密钥文件引用、监听地址、节点标识、服务发现信息、日志及审计数据目录。通过进程环境或 Uvicorn 的 `--env-file` 注入，位置由现场指定，没有新增固定存储目录要求。Nacos 自身连接凭据不能依赖先读取 Nacos 才获得。

## 先填写，再整批加密

### 模型配置缓存与指标预热

0.1.6 起，模型定义、模型地址和凭据依赖的 `model.json`、`security.yaml`、`runtime.yaml` 三份 Data ID 按组读入进程内快照；此处简称对应表中的完整 `sznsznws_backend_*` 名称。节点引导项 `NACOS_CONFIG_REFRESH_INTERVAL_SECONDS` 控制刷新间隔，默认 5 秒，允许大于 0 且不超过 60 秒；不填写即可使用默认值。它不属于业务 Data ID，修改引导项需重启。

首次访问或缓存过期后由一个线程读取并校验整组，成功后一次替换，其他线程共用结果。没有后台轮询线程；有模型访问时才检查是否到期。读取/校验失败不会返回过期快照，也不会使用部分新文档和部分旧文档拼装的快照。Nacos 不提供这些 Data ID 的跨文档事务，运维仍应协调关联配置的发布顺序。

每次模型调用固定同一份模型/地址/凭据快照。向量预热在批次间核对 Embedding 配置指纹，完成前再强制读取中心；变化或失败时不宣布就绪。Chat 单独变化不重建 Embedding 向量。进程内管理员发布模型相关配置后立即使该组缓存失效；其他节点在下次到期访问时读取更新。通用应用、数据库、安全策略仍按启动配置生效，这项优化不扩大热更新范围。

首次应用启动依然完整读取并校验全部必需配置。HTTP 连接和令牌只在当前进程内复用，令牌根据服务端有效期提前更新；没有有效 TTL 时不缓存。程序停止或启动校验失败会关闭连接，不保存磁盘兜底配置。新增日志 `query_catalog_loaded`、`nacos_snapshot_refreshed` 和 `catalog_vectors` 的模型调用/配置检查耗时可用于比较现场性能；模型耗时字段统计固定快照下的模型调用及向量响应校验，配置检查耗时包括初始快照和后续指纹复核；快照刷新日志用于定位其中的网络等待，不能与总体耗时重复相加。

已有 Nacos r2 节点的增量部署及回滚见 [预热优化部署命令](../deploy/Nacos预热优化部署命令-20260930-r3.md)。

### 配置填写与加密

新环境从模板目录复制到受保护的工作目录，填写全部内容。已有环境先导出**实际正在使用**的配置，不能用仓库默认模型/提示词覆盖现场版本。以下在仓库根目录执行，Python 必须安装本项目当前版本：

```powershell
$py = '.\backend-next\.venv\Scripts\python.exe'
& $py -m ask_metric export-nacos-config --source-root .\backend-next `
  --env-file <原backend.env绝对路径> --output-dir .\.runtime\nacos-filled
```

该命令读取旧环境文件明确配置的模型、提示词、语义和 SQL 路径；同时读取 `MODEL_SECRET_ENV_PATH` 指向的独立凭据文件，补齐模型引用的地址和密钥，旧环境文件中已有的非空值优先。相对路径沿用后端资源目录作为基准。目标目录必须不存在。没有 `--env-file` 时仅导出源码开发示例，不读取本机凭据文件，也不表示现场配置。旧文件若在另一台服务器，需在能读取这些路径的主机上运行，或先受控复制并核对路径。

填完之后，把明文目录和本环境**原 SM4 主密钥文件路径**告知执行人员/助手，由其运行一条命令：

```powershell
& $py -m ask_metric encrypt-nacos-config --input-dir .\.runtime\nacos-filled `
  --output-dir .\.runtime\nacos-encrypted --key-file <原SM4主密钥文件绝对路径>
```

Linux 同样执行 `python -m ask_metric encrypt-nacos-config`，参数不变。这是本地文件操作，不发布 Nacos、不调用模型、不访问数据库，也不生成或轮换 SM4、SM2、JWT 等密钥。

命令按明确字段及模型 `api_key_env` 引用进行加密：数据库完整 URL、Nacos 密码、模型 API Key、JWT/当前任务续澄清签名密钥、SM2 私钥、管理员和代理令牌。SSO 地址、机构映射、布尔开关、提示词、SQL 等保持原值。当前 SSO 没有独立密码字段，不臆造需要填写的 SSO 密钥。

每个新密文都解密回验；已有 `ENC[SM4:v1:...]` 只做完整性和主密钥匹配校验，不重复加密。整批校验成功后写入新目录，不覆盖原文件或已有输出目录。命令仅报告文件名与处理数量，不打印明文、密文或主密钥。密钥错误、损坏的密文、缺少配置或校验失败会中止，不输出成功提示。

YAML 中机构编码、版本号等字符串须保留引号，例如 `'000'`；数组和映射使用 YAML 原生结构。空白可选 API Key 不自动填充；启用的模型仍须配置可用地址和鉴权。按现场权限流程保护两个目录，完成导入验证后再清理临时明文。

## 发布与验证

1. 备份已有 Nacos 配置和原节点引导配置。按表中 Data ID、类型和分组，把输出的 YAML/JSON **完整内容**复制到对应配置项；引导 `.env` 留在节点，SM4 主密钥只存于独立受保护文件。
2. 设置 `NACOS_CONFIG_ENABLED=true`。默认使用 `sznsznws_backend_prompts.json`；旧 query-only 部署设置 `NACOS_PROMPT_DATA_ID=sznsznws_backend_prompts_query_only.json`。无需创建业务配置固定目录或设置 `MODEL_CONFIG_PATH` 等旧业务路径。
3. `python ops/check_models.py --config <节点引导文件>`：实际读取 Nacos，检查完整配置、模型参数、地址、鉴权及提示词结构，不调用模型/数据库。`--live` 再验证真实 Chat JSON/意图、Embedding 批量响应和 Reranker，不能以 HTTP 200 替代。
4. `ops/intranet_deploy.py validate-config --config <节点引导文件>` 仍执行模型配置检查。启动时先拉取并完整校验 Nacos，再创建日志、CORS、数据库连接、并发控制和向量预热。Nacos 缺失/不可达/无效时不回退包内默认文件。
5. 保留原模型就绪、注册、Gateway 转发和目录预热验收；别名缺失仍不代替模型失败。配置中心接入不绕过数据库写入/迁移开关。

运行、安全和数据源参数按进程启动快照生效，发布后重启节点；模型、提示词、语义、SQL 仓储按原读取入口取 Nacos 内容。管理员界面继续向 Nacos 发布，保留原权限、校验及历史/回滚记录。配置历史是运行数据，仍位于 `CONFIG_HISTORY_DIR`，不是业务配置回退来源。多节点仍应按已有流程维护历史目录。

升级程序包不覆盖 Nacos 或重新生成共享密钥。回滚时按兼容性恢复应用版本及相应 Nacos 配置；若回退到旧本地文件版程序，使用迁移前备份的原环境文件和原业务配置。已发布 Alembic 历史不改写。
