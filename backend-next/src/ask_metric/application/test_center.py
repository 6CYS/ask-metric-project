from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock, Thread
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator


def _now() -> str:
    return datetime.now(UTC).isoformat()


class AccuracyCase(BaseModel):
    id: int
    question: str = Field(min_length=1, max_length=2000)
    category: str = ""
    expected_status: str | None = None
    expected_shape: str | None = None
    expected_metric_codes: list[str] = Field(default_factory=list)
    expected_metric_names: list[str] = Field(default_factory=list)
    expected_orgs: list[str] = Field(default_factory=list)
    expected_org_names: list[str] = Field(default_factory=list)
    expected_missing: list[str] = Field(default_factory=list)
    expected_row_count: int | None = Field(default=None, ge=0)
    expected_value: float | None = None
    value_tolerance: float = Field(default=0.01, ge=0)

    @field_validator("expected_status", "expected_shape", mode="before")
    @classmethod
    def normalize_optional_text(cls, value: object) -> object:
        return value.strip() or None if isinstance(value, str) else value

    @field_validator(
        "expected_metric_codes",
        "expected_metric_names",
        "expected_orgs",
        "expected_org_names",
        "expected_missing",
        mode="before",
    )
    @classmethod
    def normalize_expected_lists(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        return list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))


class AccuracySuite(BaseModel):
    id: str
    name: str
    description: str = ""
    cases: list[AccuracyCase] = Field(default_factory=list)
    created_at: str
    updated_at: str


class AccuracySuiteInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    cases: list[AccuracyCase] = Field(default_factory=list)


class AccuracyRun(BaseModel):
    id: str
    suite_id: str
    suite_name: str
    status: str
    total: int
    completed: int = 0
    passed: int = 0
    failed: int = 0
    needs_review: int = 0
    started_at: str
    finished_at: str | None = None
    results: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None


class TestCenterRepository:
    def __init__(self, data_dir: Path, default_cases: list[dict[str, Any]]) -> None:
        self.data_dir = data_dir
        self.suites_path = data_dir / "suites.json"
        self.runs_path = data_dir / "runs.json"
        self._lock = Lock()
        data_dir.mkdir(parents=True, exist_ok=True)
        if not self.suites_path.exists():
            now = _now()
            suite = AccuracySuite(
                id="phase-one-baseline",
                name="一期只读问数基线",
                description="项目内置的准确率基线，包含执行状态、语义和结果预期。",
                cases=[AccuracyCase.model_validate(item) for item in default_cases],
                created_at=now,
                updated_at=now,
            )
            self._write(self.suites_path, [suite.model_dump(mode="json")])
        else:
            suites = self._read(self.suites_path)
            for index, item in enumerate(suites):
                if item.get("id") != "phase-one-baseline":
                    continue
                cases = item.get("cases") if isinstance(item.get("cases"), list) else []
                has_expectations = any(_case_has_expectation(case) for case in cases)
                if has_expectations and not _contains_mojibake(cases):
                    break
                item["cases"] = [
                    AccuracyCase.model_validate(case).model_dump(mode="json")
                    for case in default_cases
                ]
                item["description"] = "项目内置的准确率基线，包含执行状态、语义和结果预期。"
                item["updated_at"] = _now()
                suites[index] = item
                self._write(self.suites_path, suites)
                break
        if not self.runs_path.exists():
            self._write(self.runs_path, [])
        else:
            runs = self._read(self.runs_path)
            changed = False
            suite_cases = {
                str(suite.get("id")): {
                    int(case.get("id", 0)): str(case.get("question", ""))
                    for case in suite.get("cases", [])
                    if isinstance(case, dict)
                }
                for suite in self._read(self.suites_path)
                if isinstance(suite, dict)
            }
            for run in runs:
                had_mojibake = _contains_mojibake(run.get("results"))
                questions = suite_cases.get(str(run.get("suite_id")), {})
                for result in run.get("results", []):
                    if isinstance(result, dict) and int(result.get("id", 0)) in questions:
                        question = questions[int(result["id"])]
                        if result.get("question") != question:
                            result["question"] = question
                            changed = True
                if had_mojibake:
                    run["status"] = "failed"
                    run["finished_at"] = run.get("finished_at") or _now()
                    run["error"] = "该历史报告存在字符编码异常，请重新运行测试。"
                    changed = True
                    continue
                if run.get("status") not in {"queued", "running"}:
                    continue
                run["status"] = "failed"
                run["finished_at"] = _now()
                run["error"] = "服务重启导致测试中断，请重新运行。"
                changed = True
            if changed:
                self._write(self.runs_path, runs)

    def _read(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        return json.loads(path.read_text(encoding="utf-8"))

    def _write(self, path: Path, value: list[dict[str, Any]]) -> None:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)

    def list_suites(self) -> list[AccuracySuite]:
        with self._lock:
            return [AccuracySuite.model_validate(item) for item in self._read(self.suites_path)]

    def get_suite(self, suite_id: str) -> AccuracySuite | None:
        return next((item for item in self.list_suites() if item.id == suite_id), None)

    def create_suite(self, value: AccuracySuiteInput) -> AccuracySuite:
        with self._lock:
            items = self._read(self.suites_path)
            now = _now()
            suite = AccuracySuite(
                id=str(uuid4()), created_at=now, updated_at=now, **value.model_dump()
            )
            items.insert(0, suite.model_dump(mode="json"))
            self._write(self.suites_path, items)
            return suite

    def update_suite(self, suite_id: str, value: AccuracySuiteInput) -> AccuracySuite | None:
        with self._lock:
            items = self._read(self.suites_path)
            for index, item in enumerate(items):
                if item.get("id") != suite_id:
                    continue
                suite = AccuracySuite(
                    id=suite_id,
                    created_at=str(item["created_at"]),
                    updated_at=_now(),
                    **value.model_dump(),
                )
                items[index] = suite.model_dump(mode="json")
                self._write(self.suites_path, items)
                return suite
        return None

    def delete_suite(self, suite_id: str) -> bool:
        with self._lock:
            items = self._read(self.suites_path)
            remaining = [item for item in items if item.get("id") != suite_id]
            if len(remaining) == len(items):
                return False
            self._write(self.suites_path, remaining)
            return True

    def list_runs(self) -> list[AccuracyRun]:
        with self._lock:
            return [AccuracyRun.model_validate(item) for item in self._read(self.runs_path)]

    def get_run(self, run_id: str) -> AccuracyRun | None:
        return next((item for item in self.list_runs() if item.id == run_id), None)

    def save_run(self, run: AccuracyRun) -> None:
        with self._lock:
            items = self._read(self.runs_path)
            payload = run.model_dump(mode="json")
            for index, item in enumerate(items):
                if item.get("id") == run.id:
                    items[index] = payload
                    break
            else:
                items.insert(0, payload)
            self._write(self.runs_path, items[:100])


def _case_has_expectation(case: object) -> bool:
    if not isinstance(case, dict):
        return False
    return any(
        case.get(key) not in {None, "", ()}
        for key in (
            "expected_status",
            "expected_shape",
            "expected_row_count",
            "expected_value",
        )
    ) or any(
        case.get(key)
        for key in (
            "expected_metric_codes",
            "expected_metric_names",
            "expected_orgs",
            "expected_org_names",
            "expected_missing",
        )
    )


def _contains_mojibake(value: object) -> bool:
    if isinstance(value, str):
        return "�" in value
    if isinstance(value, list):
        return any(_contains_mojibake(item) for item in value)
    if isinstance(value, dict):
        return any(_contains_mojibake(item) for item in value.values())
    return False


def _score(result: dict[str, Any], case: AccuracyCase) -> dict[str, Any]:
    assertions: list[dict[str, Any]] = []

    def check(name: str, expected: Any, actual: Any) -> None:
        if expected is None or expected == []:
            return
        passed = (
            set(expected) == set(actual or [])
            if isinstance(expected, list)
            else expected == actual
        )
        assertions.append({"name": name, "expected": expected, "actual": actual, "passed": passed})

    check("执行状态", case.expected_status, result.get("status"))
    check("查询类型", case.expected_shape, result.get("shape"))
    check("指标识别", case.expected_metric_codes, result.get("metric_codes"))
    check("指标名称", case.expected_metric_names, result.get("metric_names"))
    check("机构识别", case.expected_orgs, result.get("orgs"))
    check("机构名称", case.expected_org_names, result.get("org_names"))
    check("待澄清字段", case.expected_missing, result.get("missing"))
    check("结果行数", case.expected_row_count, result.get("row_count"))
    if case.expected_value is not None:
        actual_value = _first_result_value(result)
        assertions.append(
            {
                "name": "结果值",
                "expected": case.expected_value,
                "actual": actual_value,
                "passed": actual_value is not None
                and abs(actual_value - case.expected_value) <= case.value_tolerance,
            }
        )
    verdict = (
        "needs_review"
        if not assertions
        else "passed"
        if all(item["passed"] for item in assertions)
        else "failed"
    )
    semantic_names = {
        "查询类型",
        "指标识别",
        "指标名称",
        "机构识别",
        "机构名称",
        "待澄清字段",
    }
    semantic_items = [item for item in assertions if item["name"] in semantic_names]
    result_items = [
        item
        for item in assertions
        if item["name"] in {"执行状态", "结果行数", "结果值"}
    ]
    return {
        **result,
        "question": case.question,
        "assertions": assertions,
        "verdict": verdict,
        "semantic_passed": bool(semantic_items) and all(item["passed"] for item in semantic_items),
        "result_passed": bool(result_items) and all(item["passed"] for item in result_items),
    }


def _first_result_value(result: dict[str, Any]) -> float | None:
    rows = result.get("rows")
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        return None
    for column in (
        "metric_value",
        "current_value",
        "difference",
        "change_rate",
        "ratio",
        "rank",
    ):
        value = rows[0].get(column)
        try:
            return float(str(value).replace(",", ""))
        except (TypeError, ValueError):
            continue
    return None


class AccuracyRunManager:
    def __init__(self, repository: TestCenterRepository, project_dir: Path) -> None:
        self.repository = repository
        self.project_dir = project_dir
        self._run_lock = Lock()

    def start(self, suite: AccuracySuite) -> AccuracyRun:
        with self._run_lock:
            if any(item.status in {"queued", "running"} for item in self.repository.list_runs()):
                raise RuntimeError("已有准确率测试正在运行，请等待完成后再试")
            run = AccuracyRun(
                id=str(uuid4()), suite_id=suite.id, suite_name=suite.name,
                status="queued", total=len(suite.cases), started_at=_now(),
            )
            self.repository.save_run(run)
            Thread(
                target=self._execute,
                args=(run.id, suite),
                daemon=True,
                name=f"accuracy-{run.id[:8]}",
            ).start()
            return run

    def _execute(self, run_id: str, suite: AccuracySuite) -> None:
        run = self.repository.get_run(run_id)
        if run is None:
            return
        cases_path = self.repository.data_dir / f"{run_id}-cases.json"
        cases_path.write_text(
            json.dumps(
                [item.model_dump(exclude_none=True) for item in suite.cases],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        run.status = "running"
        self.repository.save_run(run)
        cases_by_id = {item.id: item for item in suite.cases}
        command = [
            sys.executable,
            "-X",
            "utf8",
            str(self.project_dir / "scripts" / "run_accuracy_suite.py"),
            "--cases",
            str(cases_path),
        ]
        try:
            environment = os.environ.copy()
            environment["PYTHONIOENCODING"] = "utf-8"
            environment["PYTHONUTF8"] = "1"
            process = subprocess.Popen(
                command, cwd=self.project_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="strict", env=environment,
            )
            assert process.stdout is not None
            for line in process.stdout:
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                case = cases_by_id.get(int(raw.get("id", 0)))
                if case is None:
                    continue
                scored = _score(raw, case)
                run.results.append(scored)
                run.completed = len(run.results)
                run.passed = sum(item["verdict"] == "passed" for item in run.results)
                run.failed = sum(item["verdict"] == "failed" for item in run.results)
                run.needs_review = sum(item["verdict"] == "needs_review" for item in run.results)
                self.repository.save_run(run)
            if process.stderr:
                process.stderr.read()  # Drain output without persisting internal diagnostics.
            return_code = process.wait()
            if return_code != 0:
                raise RuntimeError("测试进程执行失败")
            run.status = "completed"
        except Exception as exc:  # noqa: BLE001 - background task must persist failure
            run.status = "failed"
            run.error = f"测试执行失败（{type(exc).__name__}），请通过运行编号排查。"
        finally:
            run.finished_at = _now()
            self.repository.save_run(run)
            cases_path.unlink(missing_ok=True)
