# SIT business data lake and GoldenDB mode

This deployment mode keeps identity, permissions, tasks, audit data, and the small
metric/organization catalogs in GoldenDB. Business values remain in the read-only
data lake. No runtime SQL joins tables across these two connections.

## Data flow

1. The metric job reads the latest fact catalog (`indcr_no`, `orig_indcr_no`,
   `indcr_nm`), joins it in the application with the current metric configuration,
   removes the leading “机构” from the base name, and upserts the final code/name.
2. The organization job reads the latest organization snapshot. By default it syncs
   only the 61 legal-entity organizations; it can later sync the complete hierarchy.
3. Semantic parsing resolves names and aliases against GoldenDB and stores
   `metric_code` and `org_code` in the logical DSL.
4. The trusted organization permission service restricts `org_code` values before
   query planning. An omitted organization defaults to the authenticated user's code.
5. For Inceptor, the application organization code is resolved to the data-lake
   `org_no`. The planner binds final `metric_codes`, source `org_codes`, and dates to
   a governed template. Templates read only the SIT fact table.
6. The result enricher performs one batched `metric_terms` query and one batched
   `org_terms` query, then adds names and units. Missing catalog entries display codes.

## Source mapping

The physical names below are the names observed in SIT, not names compiled into the
runtime contract. Every source table and every source column in this section has a
`SIT_*` setting. Catalog SQL aliases configured physical columns to stable internal
names, and all 18 Inceptor query templates render the configured fact columns before
execution. A production rename therefore requires an environment change and a
connection/template check, not a source-code edit.

| Source | Internal field | Notes |
| --- | --- | --- |
| fact `indcr_no` | `metric_code` | Runtime filter and stable result field |
| fact `corpt_no` | `corporation_code` | Legal-entity boundary and source metadata |
| fact `org_no` | source organization code | Exact runtime filter; prevents child rows leaking into a legal-entity query |
| fact `data_dt` | `stat_date` | Business date |
| fact `indcvl` | `metric_value` | Numeric checked and decimal cast; invalid/sentinel becomes null |
| fact `indcvl_incrrng` | `metric_increment` | Same normalization; `-999.999` becomes null |
| fact `orig_indcr_no` | source/base metric code | Joins the final fact code to the configuration name during catalog sync |
| fact `indcr_nm` | value-basis suffix | For example “当日数” or “较上月”; catalog sync appends it to the base name |
| fact `etl_date` | load date | Version order only; never used as the requested query date |
| fact `btch_seq_no` | batch sequence | Configured version order |
| fact `indcr_no` | `metric_terms.metric_code` | Final queryable code and idempotent catalog key |
| metric config `indcr_nm` | metric base name | Leading “机构” is removed before the fact suffix is appended |
| metric config version fields | metric source metadata | Current-row selection is configurable |
| organization `corpt_no` | `org_terms.org_code` for legal entities | Preserves the current application/user permission key |
| organization `org_no` | `org_terms.source_org_no` | Actual organization number bound to data-lake SQL |
| organization `spr_org_no` | hierarchy parent | Converted to `parent_org_code` when the parent is in the synchronized scope |
| organization `org_chn_nm` | `org_terms.org_name` | Display name |
| organization `org_abbr` | `org_terms.aliases` | Merged and deduplicated; old aliases retained |
| organization `org_hier_code` | `org_terms.hierarchy_level` | 正式机构层级；默认同步也保存省级根与法人行父子关系，集合解析和授权使用正式层级 |

Runtime templates deliberately do not select fact `indcr_nm`: it is used only by the
catalog job. Runtime result names always come from the synchronized GoldenDB catalog.

## Configuration

```dotenv
APP_DATABASE_DIALECT=mysql
APP_DATABASE_URL=<SM4-encrypted-application-database-URL>
QUERY_DATABASE_DIALECT=inceptor
QUERY_DATABASE_URL=<SM4-encrypted-query-database-URL>
METRIC_CATALOG_DATABASE_URL=<SM4-encrypted-metric-catalog-database-URL>
ORG_CATALOG_DATABASE_URL=<SM4-encrypted-organization-catalog-database-URL>
SIT_FACT_TABLE=rmt.adm_rmt_pub_gnrl_drv_indcr_tab
SIT_METRIC_CONFIG_TABLE=rmt.adm_rmt_pub_drv_indcr_cnfgon_infotab
SIT_ORG_TABLE=fdm.fdm_pub_org_inf_all
SIT_FACT_METRIC_CODE_FIELD=indcr_no
SIT_FACT_SOURCE_METRIC_CODE_FIELD=orig_indcr_no
SIT_FACT_VALUE_BASIS_FIELD=indcr_nm
SIT_FACT_CORPORATION_CODE_FIELD=corpt_no
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
SIT_ORG_CORPORATION_CODE_FIELD=corpt_no
SIT_ORG_CODE_FIELD=org_no
SIT_ORG_NAME_FIELD=org_chn_nm
SIT_ORG_ABBREVIATION_FIELD=org_abbr
SIT_ORG_PARENT_CODE_FIELD=spr_org_no
SIT_ORG_PARENT_NAME_FIELD=spr_org_nm
SIT_ORG_HIERARCHY_FIELD=org_hier_code
SIT_METRIC_FACT_SNAPSHOT_FIELD=etl_date
SIT_ORG_SNAPSHOT_FIELD=data_dt
SIT_ORG_SYNC_SCOPE=legal_entity
SIT_LEGAL_ENTITY_HIER_CODE=3
SIT_HEAD_OFFICE_CORPORATION_CODE=000
SIT_HEAD_OFFICE_HIER_CODE=1
SIT_PARTITION_MODE=none
SIT_BATCH_ORDER=etl_date DESC, btch_seq_no DESC
SIT_METRIC_ACTIVE_ORDER=eff_dt,indcr_ver_no,btch_seq_no
SIT_LATEST_PARTITION_LOOKBACK_DAYS=1095
QUERY_SESSION_INIT_STATEMENTS=
```

The four URL placeholders above must be replaced with values produced by
`python -m ask_metric encrypt-config --key-file <key-file>`. Never put a plaintext
database password in this document or in a committed environment file.

Catalog URLs default to `QUERY_DATABASE_URL`, but can point to separate endpoints.
Table settings accept one-, two-, or three-part SQL identifiers; column settings
accept one safe identifier. Invalid identifiers fail application startup rather than
being interpolated into SQL. `SIT_BATCH_ORDER` must reference the configured fact
snapshot and batch-sequence columns in that order. `SIT_METRIC_ACTIVE_ORDER` uses the
stable catalog aliases `eff_dt,indcr_ver_no,btch_seq_no`, even when their physical
source columns are renamed.
Session initialization is empty by default. Administrator-controlled `SET`/`USE`
statements may be separated with `||` only when the deployment requires them.
Runtime metric SQL always filters dates through `SIT_FACT_DATA_DATE_FIELD` (`data_dt`
by default). `SIT_PARTITION_MODE` and `SIT_LATEST_PARTITION_LOOKBACK_DAYS` remain in
environment files for upgrade compatibility but do not add an `etl_date` predicate.
`etl_date` may still appear in `SIT_BATCH_ORDER` solely to select the latest loaded
version when the same organization, metric, and business date has multiple rows.

## Operations

```powershell
python scripts/run_goldendb_migration.py --config .env --sql sit-catalog-migration.sql
# After DBA review:
python scripts/run_goldendb_migration.py --config .env --apply --confirm APP_DATABASE_SCHEMA_APPROVED
python -m ask_metric sync-metric-catalog --dry-run
python -m ask_metric sync-org-catalog --dry-run
python -m ask_metric sync-metric-catalog
python -m ask_metric sync-org-catalog
python -m ask_metric check-data-lake
```

The module commands assume the backend package has been installed (for example,
`python -m pip install -e .`). In a source-only checkout, set `PYTHONPATH=src` first.

Add `--full` only for a complete source snapshot. Full mode disables missing rows
previously owned by that source table; it does not disable manually created rows.
Metric synonyms are never changed by synchronization.

`SIT_ORG_SYNC_SCOPE=legal_entity` keeps the current external-test behavior: the
provincial head office uses hierarchy `1`, and non-`000` legal entities use hierarchy
`3`. Their application code remains `corpt_no`, while `source_org_no` stores the exact
fact-table organization number. After lower-level querying and permissions are
approved, set the scope to `all`; child rows use `org_no` as their application code and
retain the synchronized parent relationship.

## Governed SQL builder

All value, comparison, trend, ranking and data-availability queries use the shared
SQLGlot builder. Time modes and ordering are registered scenarios; MySQL/Inceptor
adapters own field mappings and dialect differences. There are no runtime SQL files,
template registry, or template fallback engine.

MySQL retains the local/external `metric_values` contract. Inceptor returns stable
code/value/date fields and the application adds names and units afterward. Fact-table
and field identifiers come only from validated `SIT_*` settings; business values remain
bound parameters. Line-side execution selects this dialect only when
`QUERY_DATABASE_DIALECT=inceptor`. Coverage queries retain record-existence semantics;
they do not silently inherit value cleaning or latest-batch ranking rules.

## Rules requiring bank confirmation

- whether the `etl_date, btch_seq_no` ordering is the authoritative latest-version
  rule when one `data_dt` has multiple loaded rows; equality between `etl_date` and
  `data_dt` is not required for metric queries;
- semantic/type ordering of `btch_seq_no` and the valid ETL-version rule;
- exact active-version and expiry rule for metric configuration records;
- exact meaning of `-999.999` and any other nonnumeric markers;
- confirmation that hierarchy `1`/`3` identifies the legal-entity organization rows;
- whether and when lower-level organizations may be exposed to users;
- Inceptor support for `RLIKE`, `DECIMAL(38,10)`, windows, date casts, and null ordering;
- whether `rmt` and `fdm` are reachable through one endpoint;
- synchronization frequency and incremental watermark;
- authoritative metric-unit field;
- whether the governed maximum of 12 arbitrary time windows matches business demand.
  The Inceptor template uses only fixed bound parameters and does not require MySQL
  `JSON_TABLE` or dynamically assembled SQL.

## 查询集合所需的机构层级

默认同步保留原有省级/法人行选择范围，并保存 hierarchy_level 与 parent_org_code；SIT_ORG_INCLUDE_BRANCH_LEVEL 只控制是否纳入支行。
关闭支行时，依据正式层级字段确认唯一省级根与法人行，建立直属关系；开启支行时要求配置并校验真实上级字段。缺根、多根、循环或孤儿整批拒绝，dry-run同样校验，不按名称猜测。

已有目录需在获授权的环境先执行现有机构同步 dry-run，核对启用目录、正式层级和账号可见范围后再同步。无需新增表或迁移历史。未同步层级的集合查询会明确返回 CONFIGURATION_ERROR，具体机构取值仍可使用。

保存父子关系后权限按既有规则计算本人及后代，省级账号应核对原全机构配置；普通法人账号不因此取得其他法人行权限。升级不会自动连接或同步业务数据库。
