from __future__ import annotations

import json
from typing import Annotated, Literal
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status

from ask_metric.api.dependencies import require_actor
from ask_metric.application.requests import ActorContext
from ask_metric.application.test_case_import import (
    AccuracyImportConfirm,
    AccuracyImportPreview,
    AccuracyImportResult,
    apply_accuracy_import,
    build_accuracy_import_template,
    preview_accuracy_import,
)
from ask_metric.application.test_center import (
    AccuracyRun,
    AccuracyRunManager,
    AccuracySuite,
    AccuracySuiteInput,
    TestCenterRepository,
)
from ask_metric.core.config import PROJECT_DIR

router = APIRouter(prefix="/api/v1/test-center", tags=["test-center"])


def _require_admin(actor: ActorContext) -> None:
    if actor.role_code != "SYSTEM_ADMIN":
        raise HTTPException(status_code=403, detail="系统管理员权限是必需的")


def _services(request: Request) -> tuple[TestCenterRepository, AccuracyRunManager]:
    settings = request.app.state.settings
    repository = getattr(request.app.state, "test_center_repository", None)
    manager = getattr(request.app.state, "accuracy_run_manager", None)
    if repository is not None and manager is not None:
        return repository, manager

    baseline_path = settings.test_center_baseline_path
    if not baseline_path.exists():
        raise RuntimeError(f"准确率测试基线不存在：{baseline_path}")
    default_cases = json.loads(baseline_path.read_text(encoding="utf-8"))
    repository = TestCenterRepository(settings.test_center_data_dir, default_cases)
    manager = AccuracyRunManager(repository, PROJECT_DIR)
    request.app.state.test_center_repository = repository
    request.app.state.accuracy_run_manager = manager
    return repository, manager


@router.get("/suites", response_model=list[AccuracySuite])
def list_suites(request: Request, actor: Annotated[ActorContext, Depends(require_actor)]):
    _require_admin(actor)
    return _services(request)[0].list_suites()


@router.post("/suites", response_model=AccuracySuite, status_code=status.HTTP_201_CREATED)
def create_suite(
    value: AccuracySuiteInput,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
):
    _require_admin(actor)
    return _services(request)[0].create_suite(value)


@router.put("/suites/{suite_id}", response_model=AccuracySuite)
def update_suite(
    suite_id: str,
    value: AccuracySuiteInput,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
):
    _require_admin(actor)
    suite = _services(request)[0].update_suite(suite_id, value)
    if suite is None:
        raise HTTPException(status_code=404, detail="测试集不存在")
    return suite


@router.delete("/suites/{suite_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_suite(
    suite_id: str,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
):
    _require_admin(actor)
    if not _services(request)[0].delete_suite(suite_id):
        raise HTTPException(status_code=404, detail="测试集不存在")


@router.get("/import-template")
def download_import_template(
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> Response:
    _require_admin(actor)
    filename = "准确率测试案例导入模板.xlsx"
    disposition = (
        "attachment; filename=accuracy-import-template.xlsx; "
        f"filename*=UTF-8''{quote(filename)}"
    )
    return Response(
        content=build_accuracy_import_template(),
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={"Content-Disposition": disposition},
    )


@router.post(
    "/suites/{suite_id}/imports/preview",
    response_model=AccuracyImportPreview,
)
async def preview_suite_import(
    suite_id: str,
    mode: Literal["append", "replace"],
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
    encoded_filename: Annotated[str, Header(alias="X-Filename")] = "cases.xlsx",
) -> AccuracyImportPreview:
    _require_admin(actor)
    suite = _services(request)[0].get_suite(suite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="测试集不存在")
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Excel文件不能超过5MB")
    try:
        return preview_accuracy_import(
            await request.body(),
            filename=unquote(encoded_filename),
            suite=suite,
            mode=mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "/suites/{suite_id}/imports/confirm",
    response_model=AccuracyImportResult,
)
def confirm_suite_import(
    suite_id: str,
    payload: AccuracyImportConfirm,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
) -> AccuracyImportResult:
    _require_admin(actor)
    result = apply_accuracy_import(_services(request)[0], suite_id, payload)
    if result is None:
        raise HTTPException(status_code=404, detail="测试集不存在")
    return result


@router.get("/runs", response_model=list[AccuracyRun])
def list_runs(request: Request, actor: Annotated[ActorContext, Depends(require_actor)]):
    _require_admin(actor)
    return _services(request)[0].list_runs()


@router.get("/runs/{run_id}", response_model=AccuracyRun)
def get_run(run_id: str, request: Request, actor: Annotated[ActorContext, Depends(require_actor)]):
    _require_admin(actor)
    run = _services(request)[0].get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="测试运行不存在")
    return run


@router.post("/runs", response_model=AccuracyRun, status_code=status.HTTP_202_ACCEPTED)
def start_run(
    suite_id: str,
    request: Request,
    actor: Annotated[ActorContext, Depends(require_actor)],
):
    _require_admin(actor)
    repository, manager = _services(request)
    suite = repository.get_suite(suite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="测试集不存在")
    if not suite.cases:
        raise HTTPException(status_code=400, detail="测试集至少需要一条用例")
    try:
        return manager.start(suite)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
