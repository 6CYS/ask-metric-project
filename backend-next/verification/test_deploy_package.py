"""离线部署包构建与迁移脚本验证；用假 alembic 模块替代真实迁移，不连接数据库。"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend-next"
PACKAGE_DIR = PROJECT_ROOT / "deploy" / "package"

FAKE_ALEMBIC = """
import json
import os
import sys

keys = ["SIT_BATCH_ORDER", "COMMAND_TEXT", "LITERAL", "APP_ENV",
        "BACKEND_NEXT_ALLOW_SCHEMA_CHANGES", "BACKEND_NEXT_ALLOW_NON_TEST_DATABASE"]
print(json.dumps({"argv": sys.argv[1:], "env": {key: os.environ.get(key) for key in keys}}))
"""


def _load_build_bundle():
    spec = importlib.util.spec_from_file_location("build_bundle", PACKAGE_DIR / "build_bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_bundle_copies_backend_runtime_from_current_tree(tmp_path):
    target = tmp_path / "backend"
    _load_build_bundle()._copy_backend_runtime(target)
    assert sorted(path.name for path in target.iterdir()) == [
        "README.md", "alembic-goldendb.ini", "alembic_goldendb", "config", "scripts",
    ]


def test_dockerfile_copy_sources_exist():
    dockerfile = (BACKEND_ROOT / "Dockerfile").read_text(encoding="utf-8")
    sources = [
        source
        for line in dockerfile.splitlines()
        if (match := re.match(r"COPY\s+(?!--)(.+)", line))
        for source in match.group(1).split()[:-1]
    ]
    assert sources
    assert [source for source in sources if not (BACKEND_ROOT / source).exists()] == []


@pytest.fixture
def release_root(tmp_path):
    if shutil.which("bash") is None:
        pytest.skip("bash is required")
    release = tmp_path / "release"
    (release / "ops").mkdir(parents=True)
    (release / "venv" / "bin").mkdir(parents=True)
    (release / "venv" / "bin" / "python").symlink_to(sys.executable)
    # python -m 优先从当前目录导入，假模块遮蔽真实 alembic。
    (release / "backend" / "alembic").mkdir(parents=True)
    (release / "backend" / "alembic" / "__main__.py").write_text(FAKE_ALEMBIC, encoding="utf-8")
    shutil.copy2(PACKAGE_DIR / "runtime" / "migrate.sh", release / "ops" / "migrate.sh")
    return release


def _run_migrate(release: Path, cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(release / "ops" / "migrate.sh"), *args],
        cwd=cwd, capture_output=True, text=True, timeout=60, check=False,
        env={**os.environ, "APP_ENV": "inherited"},
    )


def _fake_alembic_output(stdout: str) -> dict:
    return json.loads(next(line for line in stdout.splitlines() if line.startswith("{")))


def test_migrate_reads_environment_file_as_values_not_shell(release_root, tmp_path):
    marker = tmp_path / "executed"
    (tmp_path / "backend.env").write_text(
        "# systemd EnvironmentFile\n"
        "APP_ENV=production\n"
        "SIT_BATCH_ORDER=etl_date DESC, btch_seq_no DESC\n"
        f"COMMAND_TEXT=$(touch {marker})\n"
        "LITERAL=${HOME}/x\n"
        "BACKEND_NEXT_ALLOW_SCHEMA_CHANGES=false\n",
        encoding="utf-8",
    )

    applied = _run_migrate(release_root, tmp_path, "--config", "backend.env", "--apply")

    assert applied.returncode == 0, applied.stderr
    output = _fake_alembic_output(applied.stdout)
    assert output["argv"] == ["-c", "alembic-goldendb.ini", "upgrade", "head"]
    assert output["env"] == {
        "SIT_BATCH_ORDER": "etl_date DESC, btch_seq_no DESC",
        "COMMAND_TEXT": f"$(touch {marker})",
        "LITERAL": "${HOME}/x",
        "APP_ENV": "production",
        "BACKEND_NEXT_ALLOW_SCHEMA_CHANGES": "true",
        "BACKEND_NEXT_ALLOW_NON_TEST_DATABASE": "true",
    }
    assert not marker.exists()


def test_migrate_sql_mode_accepts_shipped_template_value(release_root, tmp_path):
    template = (PACKAGE_DIR / "runtime" / "backend.env.example").read_text(encoding="utf-8")
    batch_order = next(
        line for line in template.splitlines() if line.startswith("SIT_BATCH_ORDER=")
    )
    (tmp_path / "backend.env").write_text(batch_order + "\n", encoding="utf-8")

    generated = _run_migrate(release_root, tmp_path, "--config", "backend.env", "--sql")

    assert generated.returncode == 0, generated.stderr
    sql_file = release_root / "backend" / "goldendb-migration.sql"
    output = _fake_alembic_output(sql_file.read_text(encoding="utf-8"))
    assert output["argv"][-1] == "--sql"
    assert output["env"]["SIT_BATCH_ORDER"] == "etl_date DESC, btch_seq_no DESC"
    assert sql_file.stat().st_mode & 0o777 == 0o600


def test_migrate_rejects_unresolved_placeholders(release_root, tmp_path):
    (tmp_path / "backend.env").write_text("APP_DATABASE_URL=<待填写>\n", encoding="utf-8")

    rejected = _run_migrate(release_root, tmp_path, "--config", "backend.env", "--apply")

    assert rejected.returncode == 1
    assert "unresolved placeholders" in rejected.stderr
