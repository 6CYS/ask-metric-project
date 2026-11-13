"""配置入库维护入口：导出、只读预览、显式建表/导入与回读核对。"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path


class MigrationInputError(Exception):
    """仅包含维护工具自行生成的无敏感说明。"""


def encoded(document: dict) -> str:
    return json.dumps(document, ensure_ascii=False, sort_keys=True, allow_nan=False)


def load_environment(path: Path, root: Path) -> None:
    from dotenv import dotenv_values

    values = dotenv_values(path, interpolate=False)
    os.environ.update({name: value for name, value in values.items() if value is not None})
    # 相对业务路径以源角色目录解释，与原配置加载器保持一致。
    for key in (
        "MODEL_CONFIG_PATH",
        "PROMPT_CONFIG_PATH",
        "SEMANTIC_CONFIG_PATH",
        "BUSINESS_KNOWLEDGE_PATH",
        "ANALYSIS_SEMANTICS_PATH",
        "CONFIG_HISTORY_DIR",
        "MODEL_SECRET_ENV_PATH",
        "ASK_METRIC_CONFIG_SM4_KEY_FILE",
    ):
        if os.environ.get(key):
            os.environ[key] = str((root / os.environ[key]).resolve())
    if "ASK_METRIC_RUNTIME_CONFIG_DIR" not in values and (root / "config").is_dir():
        os.environ["ASK_METRIC_RUNTIME_CONFIG_DIR"] = str(root / "config")
    os.environ.setdefault("ANALYSIS_SEMANTICS_PATH", str(root / "config/analysis-semantics.json"))
    os.environ.setdefault("CONFIG_HISTORY_DIR", str(root / ".runtime/config-history"))


def export_bundle(root: Path, agent_file: Path) -> dict:
    from ask_metric.core.config import get_settings
    from ask_metric.core.runtime_resources import runtime_config_dir
    from ask_metric.infrastructure.model.configuration import (
        ConfigHistoryRepository,
        ModelConfigRepository,
        PromptConfigRepository,
        resolve_config_path,
    )
    from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

    settings = get_settings()
    if settings.business_configuration_storage != "file":
        raise MigrationInputError("源环境已经使用数据库，请勿用旧文件重新覆盖数据库")
    config_dir = runtime_config_dir()
    models = ModelConfigRepository(
        resolve_config_path(root, settings.model_config_path),
        store=settings._config_center,
    ).load()
    prompts = PromptConfigRepository(
        resolve_config_path(root, settings.prompt_config_path),
        store=settings._config_center,
    ).load()
    semantic = SemanticConfigRepository(
        resolve_config_path(root, settings.semantic_config_path),
        store=settings._config_center,
    ).load()
    documents = {
        "backend-models": json.dumps(models.model_dump(mode="json"), ensure_ascii=False),
        "backend-prompts": json.dumps(prompts.model_dump(mode="json"), ensure_ascii=False),
        "semantic-runtime": json.dumps(semantic.model_dump(mode="json"), ensure_ascii=False),
        "business-knowledge": resolve_config_path(root, settings.business_knowledge_path).read_text(
            encoding="utf-8"
        ),
        "analysis-semantics": resolve_config_path(root, settings.analysis_semantics_path).read_text(
            encoding="utf-8"
        ),
        "business-topics": (config_dir / "business-topics.json").read_text(encoding="utf-8"),
    }
    history = ConfigHistoryRepository(resolve_config_path(root, settings.config_history_dir))
    payload = {
        "schema_version": 1,
        "documents": documents,
        "prompt_history": {
            name: [
                version.model_dump(mode="json")
                for version in history.list(
                    resource_type="prompt",
                    resource_key=name,
                )
            ]
            for name in prompts.prompts
        },
        "agent": json.loads(agent_file.read_text(encoding="utf-8")),
    }
    # 先运行全部现有导入校验，再落盘材料；不把环境文件或凭据复制到材料里。
    with prepared(payload):
        pass
    return {**payload, "sha256": hashlib.sha256(encoded(payload).encode()).hexdigest()}


def read_bundle(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise MigrationInputError("迁移材料必须是对象")
    checksum = value.pop("sha256", None)
    if (
        value.get("schema_version") != 1
        or checksum != hashlib.sha256(encoded(value).encode()).hexdigest()
    ):
        raise MigrationInputError("迁移材料格式或校验摘要不一致")
    return value


def import_bundle(repository, bundle: dict, actor: str) -> None:
    from ask_metric.application.agent_runtime_configuration import import_agent_runtime
    from ask_metric.application.business_skills import import_skills
    from ask_metric.application.database_business_knowledge import import_knowledge
    from ask_metric.application.database_metric_semantics import import_metric_semantics
    from ask_metric.application.database_model_configuration import (
        import_model_configuration,
        import_prompt_configuration,
    )
    from ask_metric.application.database_runtime_configuration import import_runtime_configuration
    from ask_metric.infrastructure.model.configuration import ConfigVersion

    documents, agent = bundle["documents"], bundle["agent"]
    import_knowledge(repository, documents["business-knowledge"], actor=actor)
    import_metric_semantics(repository, documents["analysis-semantics"], actor=actor)
    import_model_configuration(repository, documents["backend-models"], actor=actor)
    import_prompt_configuration(
        repository,
        documents["backend-prompts"],
        actor=actor,
        history={
            key: [ConfigVersion.model_validate(item) for item in versions]
            for key, versions in bundle["prompt_history"].items()
        },
    )
    import_skills(repository, agent["skills"], actor=actor, overrides=agent["overrides"])
    for key in ("business-topics", "semantic-runtime"):
        import_runtime_configuration(repository, key, documents[key], actor=actor)
    import_runtime_configuration(
        repository,
        "inquiry-topics",
        json.dumps(agent["topics"], ensure_ascii=False),
        actor=actor,
    )
    import_agent_runtime(repository, json.dumps(agent["runtime"], ensure_ascii=False), actor=actor)


@contextmanager
def prepared(bundle: dict):
    from sqlalchemy import create_engine

    from ask_metric.application.database_configuration_readiness import (
        validate_database_configuration,
    )
    from ask_metric.infrastructure.configuration_repository import DatabaseConfigRepository
    from ask_metric.infrastructure.db.business_knowledge import TABLES as KNOWLEDGE_TABLES
    from ask_metric.infrastructure.db.configuration import TABLES

    engine = create_engine("sqlite://")
    try:
        for table in (*TABLES, *KNOWLEDGE_TABLES):
            table.create(engine)
        repository = DatabaseConfigRepository(engine)
        import_bundle(repository, bundle, "migration-validation")
        validate_database_configuration(repository)
        yield repository
    finally:
        engine.dispose()


def plan_configuration(repository, desired) -> list[dict]:
    from sqlalchemy import inspect, select

    from ask_metric.application.database_model_configuration import same_imported_prompt_history
    from ask_metric.core.errors import ApplicationError
    from ask_metric.infrastructure.db.configuration import config_resources

    with desired.engine.connect() as connection:
        keys = list(connection.scalars(select(config_resources.c.resource_key)))
    initialized = inspect(repository.engine).has_table("app_config_resources")
    rows = []
    for key in sorted(keys):
        expected = desired.read(key)
        actual = None
        if initialized:
            try:
                actual = repository.read(key)
            except ApplicationError as error:
                if error.code != "CONFIG_NOT_INITIALIZED":
                    raise
        same_history = (
            actual is None
            or not key.startswith("backend-prompt:")
            or (
                same_imported_prompt_history(
                    repository.versions(key), list(reversed(desired.versions(key)))
                )
            )
        )
        rows.append(
            {
                "resource": key,
                "sha256": expected.revision,
                "status": "create"
                if actual is None
                else (
                    "unchanged"
                    if expected.content == actual.content and same_history
                    else "conflict"
                ),
            }
        )
    return rows


@contextmanager
def schema_environment(settings, allow_non_test: bool):
    from ask_metric.core.config import get_settings

    old = dict(os.environ)
    try:
        for name, value in settings.model_dump(mode="json").items():
            if value is not None:
                # 两个 NoDecode 字段沿用现有分隔符；其他列表由 Settings 按 JSON 解码。
                separator = {"cors_origins": ",", "query_session_init_statements": "||"}.get(name)
                os.environ[name.upper()] = (
                    (separator.join(value) if separator else json.dumps(value))
                    if isinstance(value, list)
                    else str(value).lower()
                    if isinstance(value, bool)
                    else str(value)
                )
        os.environ.update(
            NACOS_CONFIG_ENABLED="false",
            BUSINESS_CONFIGURATION_STORAGE="file",
            BACKEND_NEXT_ALLOW_SCHEMA_CHANGES="true",
            BACKEND_NEXT_ALLOW_NON_TEST_DATABASE=str(allow_non_test).lower(),
        )
        get_settings.cache_clear()
        yield
    finally:
        os.environ.clear()
        os.environ.update(old)
        get_settings.cache_clear()


def upgrade_schema(
    settings, root: Path, allow_non_test: bool, *, sql_range: str | None = None
) -> str:
    from alembic import command
    from alembic.config import Config

    from ask_metric.infrastructure.db.schema_governance import assert_schema_change_allowed

    assert_schema_change_allowed(
        settings.app_database_url,
        allow_schema_changes=True,
        allow_non_test_database=allow_non_test,
    )
    output = io.StringIO()
    config = Config(str(root / "alembic-goldendb.ini"), output_buffer=output)
    config.set_main_option("script_location", str(root / "alembic_goldendb"))
    with schema_environment(settings, allow_non_test):
        command.upgrade(config, sql_range or "head", sql=sql_range is not None)
    return output.getvalue()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["export", "plan", "schema-sql", "apply", "verify"])
    parser.add_argument("--env", required=True, type=Path, help="源或目标后端环境文件")
    parser.add_argument("--backend-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--bundle", required=True, type=Path, help="不含凭据的迁移材料")
    parser.add_argument("--agent-export", type=Path)
    parser.add_argument("--overlay-env", type=Path, help="当前启动入口的显式路径或开关覆盖")
    parser.add_argument("--schema", action="store_true", help="apply时先执行增量建表")
    parser.add_argument("--allow-non-test-database", action="store_true")
    parser.add_argument("--database-name", help="写入时必须与实际目标库名完全一致")
    parser.add_argument(
        "--from-revision", help="schema-sql的起始版本，例如0006_agent_shared_sessions"
    )
    parser.add_argument("--output", type=Path, help="schema-sql输出路径")
    parser.add_argument("--actor", default="configuration-migration")
    args = parser.parse_args(argv)
    root = args.backend_root.resolve()
    load_environment(args.env.resolve(), root)
    if args.overlay_env:
        load_environment(args.overlay_env.resolve(), root)
    if args.command == "export":
        if args.agent_export is None:
            raise MigrationInputError("export必须提供已验证的Agent配置导出材料")
        value = export_bundle(root, args.agent_export)
        with args.bundle.open("x", encoding="utf-8") as file:
            os.chmod(args.bundle, 0o600)
            file.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"status": "exported", "sha256": value["sha256"]}))
        return 0

    from sqlalchemy import create_engine, inspect, select
    from sqlalchemy.engine import make_url

    from ask_metric.infrastructure.config_center.bootstrap import load_settings
    from ask_metric.infrastructure.configuration_repository import DatabaseConfigRepository
    from ask_metric.infrastructure.db.configuration import config_resources

    # 维护进程可在业务配置尚未导入时连接目标；正式运行仍执行原就绪与鉴权检查。
    os.environ["BUSINESS_CONFIGURATION_STORAGE"] = "database"
    settings = load_settings(validate_business_configuration=False)
    url = make_url(settings.app_database_url)
    if url.get_backend_name() != "mysql":
        raise MigrationInputError("目标必须是GoldenDB/MySQL应用库")
    if args.command in {"apply", "schema-sql"} and args.database_name != url.database:
        raise MigrationInputError("必须明确提供与实际目标一致的--database-name")
    bundle = read_bundle(args.bundle)
    engine = create_engine(url, pool_pre_ping=True)
    try:
        repository = DatabaseConfigRepository(engine)
        with prepared(bundle) as desired:
            rows = plan_configuration(repository, desired)
            print(
                json.dumps(
                    {
                        "target": {"host": url.host, "port": url.port, "database": url.database},
                        "resources": rows,
                    },
                    ensure_ascii=False,
                )
            )
            if args.command == "plan":
                return 2 if any(row["status"] == "conflict" for row in rows) else 0
            if args.command == "schema-sql":
                if not args.output or not args.from_revision:
                    raise MigrationInputError("schema-sql必须提供--output和--from-revision")
                sql = upgrade_schema(
                    settings,
                    root,
                    args.allow_non_test_database,
                    sql_range=f"{args.from_revision}:head",
                )
                with args.output.open("x", encoding="utf-8") as file:
                    os.chmod(args.output, 0o600)
                    file.write(sql)
                return 0
            if any(row["status"] == "conflict" for row in rows):
                raise MigrationInputError("目标存在不同配置，已停止；不会覆盖或恢复旧版本")
            if args.command == "apply":
                if not args.allow_non_test_database:
                    from ask_metric.infrastructure.db.schema_governance import (
                        assert_disposable_test_database,
                    )

                    assert_disposable_test_database(settings.app_database_url)
                if args.schema:
                    upgrade_schema(settings, root, args.allow_non_test_database)
                import_bundle(repository, bundle, args.actor)
            checked = plan_configuration(repository, desired)
            if any(row["status"] != "unchanged" for row in checked):
                raise MigrationInputError("回读核对未通过，保留已导入资源以便幂等重试")
            from ask_metric.application.database_configuration_readiness import (
                validate_database_configuration,
            )

            validate_database_configuration(repository)
            from ask_metric.application.database_business_knowledge import (
                DatabaseBusinessKnowledgeStore,
            )
            from ask_metric.infrastructure.db.business_knowledge import knowledge_metrics

            if (
                DatabaseBusinessKnowledgeStore(repository).read()
                != DatabaseBusinessKnowledgeStore(desired).read()
            ):
                raise MigrationInputError("业务知识条目投影与迁移材料不一致")

            def metric_rows(engine):
                with engine.connect() as connection:
                    return list(
                        connection.execute(
                            select(knowledge_metrics).order_by(
                                knowledge_metrics.c.entry_id,
                                knowledge_metrics.c.sort_order,
                            )
                        )
                    )

            if metric_rows(engine) != metric_rows(desired.engine):
                raise MigrationInputError("知识指标关联投影与迁移材料不一致")
            # 只输出数量、版本与摘要，不打印配置正文、环境文件、连接秘密。
            with engine.connect() as connection:
                count = len(list(connection.scalars(select(config_resources.c.resource_key))))
            print(
                json.dumps(
                    {
                        "status": "verified",
                        "resources": count,
                        "tables": len(inspect(engine).get_table_names()),
                    }
                )
            )
            return 0
    finally:
        engine.dispose()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationInputError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except Exception as error:
        # 库异常可能包含SQL参数/URL/输入正文，不能直接格式化异常或输出traceback。
        code = getattr(error, "code", None)
        print(
            f"配置迁移失败：{code if isinstance(code, str) else type(error).__name__}；"
            "请核对源材料、目标连接、迁移版本和权限。",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
