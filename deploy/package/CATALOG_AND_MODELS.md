# 主数据、可选别名和模型验收

当前 Nacos 配置中心版本的配置分类、命名、批量加密和升级流程见 [Nacos 配置迁移说明](../../docs/Nacos配置中心迁移与批量加密.md)。旧环境文件路径说明仅用于本地兼容或迁移前版本。

本流程取代旧部署包“机构及别名一起同步、别名全部通过才启动”的流程。使用新发布包的
`ops/` 工具和已安装的同版后端；旧 r2 包不包含这些新工具，不能只更新文档后直接运行旧包。
已有 r2 环境可使用独立部署工具包，解压与校验见仓库 `deploy/README.md`；工具包内直接在
解压目录执行，无需进入旧包的 `ops/`。完整新包继续采用下文 `ops/` 路径。
不执行建表、清理目录、删除别名或写入数据湖事实值；数据库迁移仍按独立 DBA 流程执行。

## 1. 模型与持久配置

先明确本节点实际路径，下面以普通账号 UAT 安装为例：

```bash
PY=/home/appuser/ask-metric-venv-uat/bin/python
CF=/home/appuser/ask-metric-config-uat/backend.env
cd "$RELEASE_ROOT/ops"
```

`RELEASE_ROOT` 必须是本次已校验的新包目录。自带 Python 的离线包，将 `PY` 换成包内
`python-runtime/python/bin/python3.12` 的绝对路径，不使用系统 Python。后续命令较短，方便手输。

生产配置启用 `NACOS_CONFIG_ENABLED=true` 后，模型、提示词和语义配置填写到对应 Nacos
Data ID；SQL 模板也由 Nacos 管理。`MODEL_SECRET_ENV_PATH` 仅作为本地兼容模式的回退路径。
每个启用模型的 `MODEL_CHAT_BASE_URL`、`MODEL_EMBEDDING_BASE_URL`、`MODEL_RERANK_BASE_URL`
分别填写模型平台确认的地址，不能用 Chat 成功替代 Embedding 验证。地址只放 Nacos 运行配置；
`base_url` 与 `path` 不得重复拼接 `/v1`。密钥先用 `encrypt-nacos-config` 批量加密，再复制到 Nacos。

持久化 `model-config.json` 的 `models.chat` 关键项必须为：

```json
{
  "enabled": true,
  "base_url": "",
  "base_url_env": "MODEL_CHAT_BASE_URL",
  "path": "/v1/chat/completions",
  "model": "Qwen3.6-35B-A3B",
  "send_model": true,
  "response_format": "json_object",
  "send_response_format": false,
  "enable_thinking": false,
  "send_enable_thinking": false,
  "user_message_suffix": "\n/no_think",
  "chat_template_kwargs": {"enable_thinking": false}
}
```

这是关键字段片段，不用于覆盖整个文件；保留已确认的鉴权、超时及其他模型配置。
模型名以现场实际服务为准。Chat 默认使用 `accessKey` 鉴权，须与平台核对；不得从 HTTP 200
推断无需鉴权。内网请求不发送 `response_format`，仍包含：

```json
{
  "chat_template_kwargs": {"enable_thinking": false}
}
```

应用配置中的 `response_format` 保持字符串 `json_object`，不能改为 `text`，也不能将它移入
`extra_body`。内网 `send_response_format=false` 是有效配置，检查不得因此失败；此时由提示词
要求 JSON 输出，应用继续解析 JSON，`--live` 继续验证意图结构。实际配置以 Nacos Data ID
`sznsznws_backend_model.json` 为准，不要修改发布包中的默认模板。

```bash
"$PY" check_models.py --config "$CF"
"$PY" check_models.py --config "$CF" --live
```

第一条只检查配置和路径，不调用模型或数据库；第二条实际调用 Chat、启用的 Embedding 和
Reranker。Chat 使用应用实际意图提示词，校验 `choices[0].message.content` 中的 JSON 和
意图字段；Embedding 按语义配置的批量条数调用并检查向量；不会读取业务目录或写数据库。
输出安全诊断，不打印密钥、连接字符串或完整模型正文。若返回 HTTP 400/422、正文解析失败，
需定位实际协议和响应，不能只凭接口 HTTP 200 判定成功。

工具会拒绝继承环境与 `$CF` 冲突，防止检查与 Uvicorn 启动取到不同值；按报出的变量名核对
启动脚本、systemd 或当前终端，不能盲目清除所有环境变量。Nacos 模式下模型配置由应用启动
阶段读取和校验；上述检查失败时修正 Nacos Data ID 内容后再重启各后端节点。

## 2. 主数据同步：不要求别名

由 DBA 确认应用库、必需表及当前迁移版本，并备份 `metric_terms`、`org_terms`。
新同步脚本不自动迁移，不删除历史目录或事实值。对同一应用库只执行一次；机构及指标分别
提交，后一阶段失败不会撤销前一阶段。同步期间停止相关后端或进入维护窗口，完成后重启预热。

先运行部署入口的 `database-check` 和 `catalog-mapping-check`，确认目标应用库与数据湖。
机构快照日期由数据负责人确认，不能照抄示例日期。预览默认不写库：

```bash
mkdir -p reports
SNAPSHOT=YYYY-MM-DD
"$PY" sync_catalog_data.py organizations --config "$CF" --snapshot-date "$SNAPSHOT" --report reports/org-preview.json
"$PY" sync_catalog_data.py metrics --config "$CF" --report reports/metric-preview.json
```

机构必须 `selected_rows=61`、`errors=0`；指标 `selected_rows>0`、`errors=0`。
指标读取完整历史正式编码，单位从 `ops/catalog-data/metric-units.json` 按正式名称匹配；
这份文件来源于已准备的存量目录映射，不是数据库数据导入。未知单位报告 `unresolved_units`，
经负责人确认后可用 `--units /绝对路径/审核后的单位映射.json`，禁止批量猜成“元”。
启用机构范围外的已有编码会阻断，须核对权限引用，不自动清理或扩大范围。

审核预览后执行正式同步：

```bash
"$PY" sync_catalog_data.py organizations --config "$CF" --snapshot-date "$SNAPSHOT" --report reports/org-apply.json --apply
"$PY" sync_catalog_data.py metrics --config "$CF" --report reports/metric-apply.json --apply
```

主流程保留已有别名，新目录允许无别名。以上命令不读取别名文件，也不要求别名数量大于零。
用新的报告名再次预览，预期 `created=0`、`updated=0`。报告排他创建，已有报告不能覆盖，
重跑时改为 `-r2.json` 等新名称。退出码 0 为通过，2 为阻断/失败，其他非零退出也不能继续。

## 3. 启动验收

按对应安装方式启动当前版本，分别查看：

```bash
curl -sS http://127.0.0.1:8010/health
curl -sS http://127.0.0.1:8010/api/v1/query-readiness
curl -sS -i http://127.0.0.1:8010/health/ready
tail -n 60 /home/appuser/log/alert.log
```

先等 `query-readiness` 正文为 `ready`，再确认 `/health/ready` HTTP 200；单独 `/health`
为 200 只代表存活。缺别名不影响目录向量初始化，但模型地址、协议、向量失败仍会阻止问数。
日志关闭控制台输出时查看实际 `LOG_DIRECTORY` 的 `app.log`、`alert.log`。使用已知日期、
正式机构名称和正式指标名称验收查询及原始单位，主流程不使用别名测试作为启动前置条件。

## 4. 可选：指标别名补录

主流程完成后再安排独立窗口。复用数据负责人审核的 `metric-synonyms.prepared.json`，格式：

```json
{"format": 1, "entries": [{"metric_name": "正式指标名称", "synonym": "审核后的别名"}]}
```

```bash
"$PY" sync_metric_aliases.py --config "$CF" --aliases /路径/metric-synonyms.prepared.json --report reports/metric-alias-preview.json
"$PY" sync_metric_aliases.py --config "$CF" --aliases /路径/metric-synonyms.prepared.json --report reports/metric-alias-apply.json --apply
```

第二条必须在第一条 `PASS`、`blocked=false` 且审核、备份通过后执行。脚本按启用目录的
正式名称精确匹配；`unmatched`、`ambiguous`、`disabled_existing` 非空时整批不写，允许
共享别名一对多且追加去重。已有停用关系不自动启用，必须独立审核。别名失败保留原主数据，
继续使用正式名称，不强制重新部署。

## 5. 可选：机构别名补录

独立审核机构编码到别名数组的映射：

```json
{"正式机构编码": ["审核后的机构简称", "审核后的机构别名"]}
```

```bash
"$PY" sync_org_aliases.py --config "$CF" --aliases /路径/org-aliases.json --report reports/org-alias-preview.json
"$PY" sync_org_aliases.py --config "$CF" --aliases /路径/org-aliases.json --report reports/org-alias-apply.json --apply
```

未知或停用机构编码记录为 `unmatched_codes`，整批不写；不能将旧文件中的历史/模拟编码
自动对应到正式机构。第二条同样需要预览通过、审核和备份。脚本只追加去重，不修改机构名称、
编码、启用状态或已有别名，不查询数据湖、不更新用户归属。

两类别名补录成功后，用新报告名再次预览，确认 `would_create=0`；再安排相关后端节点重启、
等待向量就绪，用已审核别名与正式名称对照验收。不要求为同一窗口之外的失败别名阻塞主流程。
