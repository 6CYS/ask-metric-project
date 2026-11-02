"""运行现有质量工具，保留每项结果和失败退出码。"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path
from typing import NamedTuple


class Check(NamedTuple):
    name: str
    command: tuple[str, ...]
    cwd: Path


def run_checks(checks: list[Check]) -> int:
    if not checks:
        print("未选择任何检查。", flush=True)
        return 1
    results: list[tuple[str, int]] = []
    for check in checks:
        print(f"\n[{check.name}] {' '.join(check.command)}", flush=True)
        try:
            result = subprocess.run(check.command, cwd=check.cwd, check=False)
            code = result.returncode
        except OSError as error:
            print(f"无法执行检查：{error}。请确认工具已安装及目录正确。", flush=True)
            code = 1
        results.append((check.name, code))
    print("\n检查结果：", flush=True)
    for name, code in results:
        print(f"  {name}: {'通过' if code == 0 else f'未通过（退出码 {code}）'}", flush=True)
    return int(any(code != 0 for _, code in results))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scope",
        nargs="+",
        choices=("agent", "frontend", "backend"),
        default=("agent", "frontend", "backend"),
        help="检查模块，默认全部",
    )
    parser.add_argument(
        "--checks",
        nargs="+",
        choices=("lint", "typecheck", "format"),
        default=("lint", "typecheck", "format"),
        help="检查类别，默认全部",
    )
    parser.add_argument("--backend-python", type=Path, help="覆盖 backend-next/.venv 的解释器路径")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    backend = root / "backend-next"
    python = args.backend_python or backend / ".venv" / (
        "Scripts/python.exe" if os.name == "nt" else "bin/python"
    )
    # 保留虚拟环境内的解释器路径，解析符号链接会绕过 pyvenv.cfg。
    python = python.expanduser().absolute()
    npm = shutil.which("npm") or ("npm.cmd" if os.name == "nt" else "npm")
    python_paths = (
        "src",
        "scripts",
        "verification",
        "alembic_goldendb",
        "conftest.py",
        "../scripts/check_quality.py",
        "../scripts/test_check_quality.py",
    )
    backend_commands = {
        "lint": (str(python), "-m", "ruff", "check", "--config", "pyproject.toml", *python_paths),
        "typecheck": (str(python), "-m", "mypy", "--config-file", "pyproject.toml"),
        "format": (
            str(python),
            "-m",
            "ruff",
            "format",
            "--check",
            "--config",
            "pyproject.toml",
            *python_paths,
        ),
    }
    directories = {"agent": root / "agent-service", "frontend": root / "frontend-vue"}
    checks = []
    for scope in dict.fromkeys(args.scope):
        for kind in dict.fromkeys(args.checks):
            command = (
                backend_commands[kind]
                if scope == "backend"
                else (
                    npm,
                    "run",
                    "format:check" if kind == "format" else kind,
                )
            )
            checks.append(
                Check(
                    f"{scope}/{kind}",
                    command,
                    backend if scope == "backend" else directories[scope],
                )
            )
    try:
        return run_checks(checks)
    except KeyboardInterrupt:
        print("\n检查已取消。", flush=True)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
