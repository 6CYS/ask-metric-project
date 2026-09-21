"""Run an accuracy suite without creating tasks or writing database rows."""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from threading import BoundedSemaphore

import httpx

from ask_metric.application.query_execution_service import (
    _resolve_org_names,
    _resolve_source_org_codes,
)
from ask_metric.application.result_enrichment import CatalogResultEnricher
from ask_metric.application.result_processing import process_query_result
from ask_metric.application.semantic_workflow import advance_slot_frame
from ask_metric.core.config import PROJECT_DIR, get_settings
from ask_metric.domain.query_capabilities import capability_error
from ask_metric.domain.query_execution import QueryPlanner, json_safe
from ask_metric.domain.semantic_engine import SemanticEngine
from ask_metric.domain.semantic_normalization import query_shape_for
from ask_metric.infrastructure.db.session import get_app_session_factory, get_query_engine
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.model.configuration import (
    ModelConfigRepository,
    PromptConfigRepository,
    resolve_config_path,
)
from ask_metric.infrastructure.model.provider import (
    ConfigurableModelService,
    credential_resolver_from_env_file,
)
from ask_metric.infrastructure.query.factory import create_data_source_adapter
from ask_metric.infrastructure.query.templates import QueryTemplateRepository
from ask_metric.infrastructure.semantic.configuration import SemanticConfigRepository

QUESTIONS = [
    "江苏农商联合银行2026年3月末信贷客户数量当日数是多少？",
    "省联社2026年4月末信贷客户数量较同期是多少？",
    "紫金农商行2026年3月末个人活期存款余额当日数是多少？",
    "紫金银行2026年4月末个人活期存款余额当日数是多少？",
    "江阴农商行2026年4月末个人活期存款余额较上月是多少？",
    "无锡农商行2026年4月末个人活期存款余额较上月增幅是多少？",
    "张家港农商行2026年3月末个人经营性贷款余额当日数是多少？",
    "常熟银行2026年4月末个人经营性贷款余额较同期是多少？",
    "海门农商行2026年4月末信贷客户数量较年初是多少？",
    "东台农商行2026年3月末信贷客户数量较上季增幅是多少？",
    "4月末紫金农商行信贷客户数量当日数是多少？",
    "3月份紫金农商行个人活期存款余额当日数是多少？",
    "2026年3月份各家农商行信贷客户数量较同期分别是多少？请以表格形式输出。",
    "2026年4月末各家农商行个人活期存款余额当日数分别是多少？",
    "查询2026年4月末各家农商行个人活期存款余额当日数前5名。",
    "查询2026年4月末各家农商行信贷客户数量当日数前3名。",
    "查询2026年4月末各家农商行个人经营性贷款余额当日数前10名。",
    "紫金农商行2026年4月末个人活期存款余额当日数排名是多少？",
    "江阴农商行2026年4月末个人活期存款余额较上月增量排名是多少？",
    "无锡农商行2026年4月末信贷客户数量较同期增幅排名是多少？",
    "江苏农商联合银行2026年4月末个人活期存款余额全省均值是多少？",
    "沭阳农商行2026年3月末个人经营性贷款余额全省均值是多少？",
    "紫金农商行2026年3月末个人经营性贷款余额较全省均值是多少？",
    "江南农商行2026年4月末信贷客户数量较层级均值是多少？",
    "昆山农商行2026年4月末个人活期存款余额层级排名是多少？",
    "苏州农商行2026年3月末个人经营性贷款余额当日数地区排名是多少？",
    "紫金农商行2025年4月末信贷客户数量当日数是多少？",
    "查询农商行2026年4月末个人大额存单余额的机构排名。",
    "火星农商行2026年4月末信贷客户数量当日数是多少？",
    "请筛选出4月末机构个人活期存款余额当日数高于全省均值，且较上月增幅排名前10的机构。",
    "紫金农商行2026年4月末信贷客户数量明细有哪些？",
]
_BASELINE_DIRECTORY = (PROJECT_DIR / "resources" / "testing").resolve()
_MAX_CASE_FILE_BYTES = 5 * 1024 * 1024


def _resolve_case_path(configured_path: str, runtime_directory: Path) -> Path:
    candidate = Path(configured_path)
    if not candidate.is_absolute():
        candidate = _BASELINE_DIRECTORY / candidate
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise ValueError("cases file does not exist or cannot be resolved") from exc
    allowed_directories = (_BASELINE_DIRECTORY, runtime_directory.resolve())
    if not any(
        resolved.parent == directory or directory in resolved.parents
        for directory in allowed_directories
    ):
        raise ValueError("cases file must be located under a governed test-data directory")
    if not resolved.is_file() or resolved.suffix.casefold() != ".json":
        raise ValueError("cases file must be a regular JSON file")
    if resolved.stat().st_size > _MAX_CASE_FILE_BYTES:
        raise ValueError("cases file is too large")
    return resolved


def _load_cases(path: str | None, runtime_directory: Path) -> list[dict[str, object]]:
    if path is None:
        return [
            {"id": index, "question": question, "expected_status": None}
            for index, question in enumerate(QUESTIONS, start=1)
        ]
    case_path = _resolve_case_path(path, runtime_directory)
    payload = json.loads(case_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("cases file must contain a JSON array")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cases",
        help="JSON filename under resources/testing; defaults to the governed baseline",
    )
    parser.add_argument("--ids", help="Optional comma-separated case ids")
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Parallel case workers; defaults to 1 so model rate limits do not distort accuracy",
    )
    args = parser.parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    settings = get_settings()
    cases = _load_cases(args.cases, settings.test_center_data_dir)
    if args.ids:
        selected_ids = {int(value.strip()) for value in args.ids.split(",") if value.strip()}
        cases = [case for case in cases if int(case["id"]) in selected_ids]
    semantic_config = SemanticConfigRepository(
        resolve_config_path(PROJECT_DIR, settings.semantic_config_path)
    ).load()
    with SqlAlchemyUnitOfWork() as uow:
        metrics = uow.metric_catalog.list_enabled()
        organizations = uow.organization_catalog.list_enabled()
    model_configs = ModelConfigRepository(
        resolve_config_path(PROJECT_DIR, settings.model_config_path)
    )
    prompt_configs = PromptConfigRepository(
        resolve_config_path(PROJECT_DIR, settings.prompt_config_path)
    )
    limits = httpx.Limits(
        max_connections=settings.model_max_connections,
        max_keepalive_connections=settings.model_max_keepalive_connections,
    )
    with httpx.Client(limits=limits) as client:
        model = ConfigurableModelService(
            model_config_repository=model_configs,
            prompt_config_repository=prompt_configs,
            credential_resolver=credential_resolver_from_env_file(
                resolve_config_path(PROJECT_DIR, settings.model_secret_env_path)
            ),
            client=client,
            max_concurrency=settings.model_max_concurrency,
            concurrency_wait_seconds=settings.model_concurrency_wait_seconds,
            semaphore=BoundedSemaphore(settings.model_max_concurrency),
        )
        engine = SemanticEngine(model)
        planner = QueryPlanner(
            dialect=settings.query_database_dialect,
            max_limit=settings.query_result_limit,
        )
        templates = QueryTemplateRepository(
            resolve_config_path(PROJECT_DIR, settings.query_template_config_path),
            resolve_config_path(PROJECT_DIR, settings.sql_resource_dir),
        )
        data_source = create_data_source_adapter(
            settings.query_database_dialect,
            get_query_engine(),
            statement_timeout_ms=settings.query_statement_timeout_ms,
        )
        result_enricher = CatalogResultEnricher(get_app_session_factory())
        current_date = date.today()

        def run(case: dict[str, object]) -> dict[str, object]:
            index = int(case["id"])
            question = str(case["question"])
            expected = {
                key: value
                for key, value in case.items()
                if key not in {"id", "question"}
            }
            analysis = engine.analyze(
                question,
                metrics=metrics,
                organizations=organizations,
                config=semantic_config,
                current_date=current_date,
            )
            unsupported = capability_error(
                analysis.slot_frame, query_shape_for(analysis.slot_frame)
            )
            if unsupported:
                return {
                    "id": index,
                    "status": "out_of_scope",
                    "question": question,
                    "expected": expected,
                    "message": unsupported,
                }
            advanced = advance_slot_frame(
                analysis.slot_frame,
                metrics=metrics,
                organizations=organizations,
                config=semantic_config,
                today=current_date,
                metric_candidates=analysis.metric_candidates,
            )
            source_org_codes = _resolve_source_org_codes(
                advanced.slot_frame.orgs,
                organizations,
            )
            display_org_names = _resolve_org_names(
                advanced.slot_frame.orgs,
                organizations,
            )
            common = {
                "id": index,
                "question": question,
                "expected": expected,
                "metric_codes": [item.code for item in advanced.slot_frame.metrics],
                "metric_names": [item.name for item in advanced.slot_frame.metrics],
                "orgs": source_org_codes,
                "org_names": display_org_names,
                "time": advanced.slot_frame.time,
                "ops": [item.model_dump(mode="json") for item in advanced.slot_frame.ops],
            }
            if advanced.logical_dsl is None:
                return {
                    **common,
                    "status": "clarification",
                    "missing": advanced.slot_frame.missing,
                    "fields": [item.get("field") for item in advanced.clarification_fields],
                    "prompt": advanced.clarification_prompt,
                }
            # SQL 机构条件统一传机构编码：metric_values.org_code 与目录同源，
            # mysql/inceptor 一致；显示名仅用于展示（与 query_execution_service 对齐）。
            plan = planner.build(
                advanced.logical_dsl,
                advanced.query_shape or "",
                org_names=source_org_codes,
                display_org_names=display_org_names,
            )
            sql = templates.load(dialect=plan.dialect, template=plan.template)
            execution = data_source.execute_readonly(sql=sql, parameters=plan.parameters)
            enriched_rows = result_enricher.enrich(execution.rows)
            rows, comparisons = process_query_result(plan, enriched_rows)
            display_rows = comparisons or rows
            return {
                **common,
                "status": "succeeded" if display_rows else "no_data",
                "shape": advanced.query_shape,
                "template": plan.template.value,
                "row_count": len(display_rows),
                "rows": json_safe(display_rows[:10]),
            }

        results: dict[int, dict[str, object]] = {}
        with ThreadPoolExecutor(
            max_workers=min(args.workers, settings.model_max_concurrency)
        ) as pool:
            futures = {
                pool.submit(run, case): int(case["id"])
                for case in cases
            }
            for future in as_completed(futures):
                index = futures[future]
                try:
                    results[index] = future.result()
                except Exception as exc:  # noqa: BLE001 - each baseline case must continue
                    results[index] = {
                        "id": index,
                        "question": next(
                            str(case["question"])
                            for case in cases
                            if int(case["id"]) == index
                        ),
                        "status": "error",
                        "error_type": type(exc).__name__,
                        "error": type(exc).__name__,
                    }
        for index in sorted(results):
            print(json.dumps(results[index], ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
