-- ============================================================================
-- 问数应用库（GoldenDB/MySQL 方言）本次变更的表结构与数据初始化交付
--
-- 来源：backend-next/alembic_goldendb 迁移链 0003、0004，
-- 由以下命令离线导出，未连接任何数据库：
--   BACKEND_NEXT_ALLOW_SCHEMA_CHANGES=true BACKEND_NEXT_ALLOW_NON_TEST_DATABASE=true \
--     python -m alembic -c alembic-goldendb.ini upgrade 0002_organization_hierarchy:head --sql
--
-- 本文件只含本次变更涉及的表和字段，未改动的表不在此列出。
-- 执行前由 DBA 审核并备份；版本表 backend_next_goldendb_alembic_version
-- 必须与 DDL 同步维护，否则后续 alembic 升级会判断错误。
-- ============================================================================


-- ============================================================================
-- 一、结构变更 DDL
-- ============================================================================

-- ---- 1.1 迁移 0003：新建分析线程与检查点表（保留的历史结构，运行时已退役，仅建表）
CREATE TABLE analysis_threads (
    id VARCHAR(64) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    lease_token VARCHAR(64),
    lease_until FLOAT(53) NOT NULL,
    cancelled BOOL NOT NULL,
    progress JSON NOT NULL,
    `usage` JSON NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (task_id),
    FOREIGN KEY(task_id) REFERENCES query_tasks (id) ON DELETE CASCADE
);

CREATE TABLE analysis_checkpoints (
    id VARCHAR(64) NOT NULL,
    thread_id VARCHAR(64) NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    checkpoint_id VARCHAR(64) NOT NULL,
    payload JSON NOT NULL,
    writes JSON NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY(thread_id) REFERENCES analysis_threads (id) ON DELETE CASCADE
);

CREATE INDEX ix_analysis_checkpoints_thread_id ON analysis_checkpoints (thread_id);

UPDATE backend_next_goldendb_alembic_version
   SET version_num='0003_analysis_checkpoints'
 WHERE version_num = '0002_organization_hierarchy';

-- ---- 1.2 迁移 0004：既有表新增三个列（核心字段变更）
ALTER TABLE metric_values ADD COLUMN org_code VARCHAR(128);
ALTER TABLE org_terms ADD COLUMN parent_org_code VARCHAR(128);
ALTER TABLE org_terms ADD COLUMN hierarchy_level VARCHAR(8);

UPDATE backend_next_goldendb_alembic_version
   SET version_num='0004_org_hierarchy_and_org_code'
 WHERE version_num = '0003_analysis_checkpoints';


-- ============================================================================
-- 二、数据初始化与历史回填
-- ============================================================================

-- ---- 2.1 metric_values.org_code 历史回填（mysql 方言部署必须执行）
-- 0004 只加列不回填；mysql 查询模板的覆盖查询按 org_code 过滤，
-- 历史行为 NULL 会导致这些机构查不到覆盖信息。
-- 前置校验：org_name 在 org_terms 中必须唯一，否则按名称回填会产生错配。
-- 以下查询结果必须为 0 行才能执行回填 UPDATE：
SELECT mv.org_name, COUNT(DISTINCT ot.org_code) AS code_cnt
  FROM metric_values mv
  JOIN org_terms ot ON ot.org_name = mv.org_name
 WHERE mv.org_code IS NULL
 GROUP BY mv.org_name
HAVING code_cnt > 1;

-- 校验通过后执行回填：
UPDATE metric_values mv
  JOIN org_terms ot ON ot.org_name = mv.org_name
   SET mv.org_code = ot.org_code
 WHERE mv.org_code IS NULL;

-- 回填后核对（应均为 0；残留 NULL 多为 org_name 与目录不一致，需人工核对）：
SELECT COUNT(*) AS still_null FROM metric_values WHERE org_code IS NULL;
SELECT COUNT(*) AS unmatched
  FROM metric_values mv
  LEFT JOIN org_terms ot ON ot.org_name = mv.org_name
 WHERE mv.org_code IS NULL AND ot.org_code IS NULL;

-- ---- 2.2 org_terms 机构目录初始化（parent_org_code / hierarchy_level 的数据来源）
-- 新列的层级数据不能手写 INSERT：来源是行内机构目录。
-- 方式一（SIT 数据湖链路）：配置好 SIT_ORG_* 映射后执行目录同步，
--   启用支行层级扩展（SIT_ORG_INCLUDE_BRANCH_LEVEL）时同步会写入
--   parent_org_code / hierarchy_level：
--     python -m ask_metric sync-org-catalog --dry-run   # 先预演
--     python -m ask_metric sync-org-catalog
--   同步前先跑只读核实：python scripts/verify_org_hierarchy.py
-- 方式二（行内 Excel 链路）：python scripts/sync_bank_identity.py
--   同步 org_terms 与 app_users（默认 dry-run，apply 需确认口令；
--   详见 scripts/行内用户机构同步脚本使用说明.txt）。
-- 不启用支行层级扩展时两列保持全 NULL，系统按 v1 规则运行，属正常状态。

-- ---- 2.3 app_users 首个本地管理员（无 Excel 时的最小初始化）
-- 密码不经过 SQL 明文写入，使用交互式工具：
--   python scripts/create_local_user.py --username <登录名> \
--     --display-name <显示名> --org-code <有效机构编码> \
--     --role-code SYSTEM_ADMIN --config .env

-- ---- 2.4 chat_conversations.owner_user_id 历史归属（多用户上线前）
-- 历史会话 owner_user_id 为 NULL，用脚本归并到指定用户（默认 dry-run）：
--   python scripts/backfill_conversation_owners.py --username <登录名>        # 预演
--   python scripts/backfill_conversation_owners.py --username <登录名> --apply


-- ============================================================================
-- 三、执行后核对
-- ============================================================================
SELECT version_num FROM backend_next_goldendb_alembic_version;
-- 期望：0004_org_hierarchy_and_org_code

-- 期望：org_code / parent_org_code / hierarchy_level 三列均存在（返回 3）
SELECT COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'metric_values' AND COLUMN_NAME = 'org_code')
     OR (TABLE_NAME = 'org_terms' AND COLUMN_NAME IN ('parent_org_code', 'hierarchy_level')));
