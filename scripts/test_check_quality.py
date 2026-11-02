"""检查入口不得吞掉工具失败，也不能因第一项失败跳过其他检查。"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
import venv
from pathlib import Path

from check_quality import Check, run_checks


class QualityRunnerTests(unittest.TestCase):
    def test_failure_remains_failure_after_later_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = run_checks(
                [
                    Check("failed", (sys.executable, "-c", "raise SystemExit(3)"), root),
                    Check("later", (sys.executable, "-c", "open('ran', 'w').close()"), root),
                ]
            )
            self.assertEqual(result, 1)
            self.assertTrue((root / "ran").exists())

    def test_missing_tool_is_failure_and_does_not_skip_later_checks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = run_checks(
                [
                    Check("missing", (str(root / "missing-tool"),), root),
                    Check("later", (sys.executable, "-c", "open('ran', 'w').close()"), root),
                ]
            )
            self.assertEqual(result, 1)
            self.assertTrue((root / "ran").exists())

    def test_success_uses_requested_directory_with_spaces(self) -> None:
        with tempfile.TemporaryDirectory(prefix="quality check ") as directory:
            root = Path(directory)
            result = run_checks(
                [
                    Check("success", (sys.executable, "-c", "open('ran', 'w').close()"), root),
                ]
            )
            self.assertEqual(result, 0)
            self.assertTrue((root / "ran").exists())

    def test_empty_check_list_is_not_success(self) -> None:
        self.assertEqual(run_checks([]), 1)

    def test_relative_backend_interpreter_keeps_its_virtual_environment(self) -> None:
        project = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="quality venv ") as directory:
            environment = Path(directory) / "environment"
            venv.EnvBuilder(with_pip=False, symlinks=os.name != "nt").create(environment)
            interpreter = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            site_path = subprocess.check_output(
                (str(interpreter), "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"),
                text=True,
            ).strip()
            # 只替代外部检查工具，验证入口实际使用指定环境，避免误调系统 Python。
            (Path(site_path) / "ruff.py").write_text("print('requested-venv-tool')\n")
            result = subprocess.run(
                (
                    sys.executable,
                    "scripts/check_quality.py",
                    "--scope",
                    "backend",
                    "--checks",
                    "lint",
                    "--backend-python",
                    os.path.relpath(interpreter, project),
                ),
                cwd=project,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("requested-venv-tool", result.stdout)


if __name__ == "__main__":
    unittest.main()
