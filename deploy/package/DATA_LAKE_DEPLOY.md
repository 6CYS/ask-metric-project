# SIT 数据湖 + GoldenDB 简化部署说明

本版只完成指标目录同步、机构目录同步、按指标码和机构码直查数据湖事实表。不处理法人范围、机构层级、上级机构、机构简称和别名自动生成。

## 数据链路

指标目录：从事实表最新快照读取最终 `indcr_no`、`orig_indcr_no` 和口径 `indcr_nm`；用 `orig_indcr_no` 关联配置表 `indcr_no`；配置名称去掉开头“机构”，再拼接口径。最终 `indcr_no` 写入 `znws.metric_terms.metric_code`，完整名称写入 `metric_name`。`metric_synonyms` 不自动修改。

机构目录：从机构表最新 `etl_date` 快照中严格按现场 SQL 的范围筛选 61 家机构：`corpt_no <= '134'`、排除 `086`，并满足 `((org_hier_code = '3' AND corpt_no <> '000') OR org_hier_code = '1')`。`corpt_no` 和 `org_hier_code` 只参与筛选，不写应用库；最终仅将 `org_no`、`org_chn_nm` 写入 `znws.org_terms.org_code`、`org_name`。已有别名保留，新机构别名为空。

业务查询：用应用目录解析出的 `org_code` 和 `metric_code` 直接过滤事实表 `org_no` 和 `indcr_no`，返回后再用 GoldenDB 目录补齐显示名称。

## 不执行 2.5

不要执行原文档 2.5 或 `0003_sit_catalog_metadata`。本版不增加 `source_org_no`、`corporation_code`、`org_hier_code`、`source_metadata` 等字段，直接使用现有应用表。如果旧 0003 已执行，不要自行回滚，先让 DBA 核对。

## backend.env 最小映射

先将完整数据库 URL 作为隐藏输入交给
`python -m ask_metric encrypt-config --key-file /etc/ask-metric/config-sm4.key`，再把命令输出的
`ENC[SM4:v1:...]` 写入下列配置。主密钥文件须由运行用户读取，且不得提交到 Git。

```dotenv
APP_DATABASE_DIALECT=mysql
ASK_METRIC_CONFIG_SM4_KEY_FILE=/etc/ask-metric/config-sm4.key
APP_DATABASE_URL=ENC[SM4:v1:...]
QUERY_DATABASE_DIALECT=inceptor
QUERY_DATABASE_URL=ENC[SM4:v1:...]
SIT_FACT_TABLE=ads_lake.adm_rmt_pub_gnrl_drv_indcr_tab
SIT_METRIC_CONFIG_TABLE=ads_lake.adm_rmt_pub_drv_indcr_cnfgon_infotab
SIT_ORG_TABLE=ads_lake.fdm_pub_org_inf_all
SIT_FACT_METRIC_CODE_FIELD=indcr_no
SIT_FACT_SOURCE_METRIC_CODE_FIELD=orig_indcr_no
SIT_FACT_VALUE_BASIS_FIELD=indcr_nm
SIT_FACT_ORG_CODE_FIELD=org_no
SIT_FACT_DATA_DATE_FIELD=data_dt
SIT_FACT_VALUE_FIELD=indcvl
SIT_FACT_INCREMENT_FIELD=indcvl_incrrng
SIT_FACT_BATCH_SEQUENCE_FIELD=btch_seq_no
SIT_METRIC_CONFIG_CODE_FIELD=indcr_no
SIT_METRIC_CONFIG_NAME_FIELD=indcr_nm
SIT_METRIC_CONFIG_EFFECTIVE_DATE_FIELD=eff_dt
SIT_METRIC_CONFIG_VERSION_FIELD=indcr_ver_no
SIT_METRIC_CONFIG_BATCH_FIELD=btch_seq_no
SIT_METRIC_FACT_SNAPSHOT_FIELD=etl_date
SIT_ORG_CODE_FIELD=org_no
SIT_ORG_NAME_FIELD=org_chn_nm
SIT_ORG_CORPORATION_CODE_FIELD=corpt_no
SIT_ORG_HIERARCHY_FIELD=org_hier_code
SIT_ORG_SNAPSHOT_FIELD=etl_date
SIT_ORG_CORPORATION_CODE_MAX=134
SIT_ORG_EXCLUDED_CORPORATION_CODE=086
SIT_ORG_HEAD_OFFICE_CORPORATION_CODE=000
SIT_ORG_LEGAL_ENTITY_HIER_CODE=3
SIT_ORG_HEAD_OFFICE_HIER_CODE=1
SIT_ORG_EXPECTED_COUNT=61
SIT_PARTITION_MODE=none
SIT_BATCH_ORDER=etl_date DESC, btch_seq_no DESC
SIT_METRIC_ACTIVE_ORDER=eff_dt,indcr_ver_no,btch_seq_no
SIT_LATEST_PARTITION_LOOKBACK_DAYS=1095
```

问数日期只使用 `SIT_FACT_DATA_DATE_FIELD`（默认 `data_dt`）。`etl_date` 仅用于同一
机构、指标、数据日期存在多批记录时的版本排序，不会按用户查询日期过滤；因此
`SIT_PARTITION_MODE` 必须保持 `none`，历史兼容配置中的 `data_date` 也不会再生成
切片日期条件。

三张源表共用 `QUERY_DATABASE_URL`，不需要 `METRIC_CATALOG_DATABASE_URL` 和 `ORG_CATALOG_DATABASE_URL`。

## 后续顺序

映射检查通过后，使用 [主数据、可选别名和模型验收](CATALOG_AND_MODELS.md) 的新流程：

1. 校验应用配置及实际模型协议，确认 JSON 输出约束与关闭思考参数已发送。
2. `sync_catalog_data.py organizations` 预览及同步审核快照中的 61 家机构。
3. `sync_catalog_data.py metrics` 预览及同步完整历史正式指标编码、名称、启用状态及审核单位。
4. 等待目录向量就绪，用正式机构和指标名称验收。没有别名不阻断启动，但模型或主数据错误仍须处理。
5. 指标、机构别名使用 `sync_catalog_aliases.py` 分别作为可选步骤审核和补录。

两个主数据阶段分别提交；正式同步前备份应用目录表，报告采用新文件名保留。主流程不覆盖已有别名、不删除未同步目录、不修改事实值。不得以初始化或修复启动为由执行清库；历史模拟数据治理必须单独确认范围、引用、备份和授权。
