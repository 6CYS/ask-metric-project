from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from copy import copy
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = PROJECT_ROOT / "deploy"
PACKAGE_DIR = DEPLOY_DIR / "package"
PLATFORMS = {
    "linux-x86_64": "manylinux2014_x86_64",
    "linux-aarch64": "manylinux2014_aarch64",
}
SAFE_VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
FORBIDDEN_FRONTEND_BACKEND_URL = re.compile(
    rb"https?://(?:127\.0\.0\.1|localhost)(?::\d+)?",
    re.IGNORECASE,
)


def _run(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, env=env, check=True)


def _copy_tree(source: Path, target: Path) -> None:
    if not source.is_dir():
        raise FileNotFoundError(f"Required directory does not exist: {source}")
    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_checksums(bundle_root: Path, extra_entries: list[str] | None = None) -> None:
    entries = []
    for path in sorted(bundle_root.rglob("*")):
        if path.is_file() and path.name != "checksums.sha256":
            relative = path.relative_to(bundle_root).as_posix()
            entries.append(f"{_sha256(path)}  {relative}")
    entries.extend(extra_entries or [])
    entries.sort(key=lambda value: value.split("  ", 1)[1])
    (bundle_root / "checksums.sha256").write_text(
        "\n".join(entries) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _linux_tar_metadata(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """Make archives built on Windows extract with safe Linux permissions."""
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    if info.isdir():
        info.mode = 0o755
    elif info.name.endswith(".sh") or info.mode & 0o111:
        info.mode = 0o755
    else:
        info.mode = 0o644
    return info


def _validate_frontend_bundle(dist: Path) -> None:
    if not (dist / "index.html").is_file():
        raise FileNotFoundError(f"Frontend bundle is missing index.html: {dist}")
    offenders: list[str] = []
    for path in sorted(dist.rglob("*")):
        if path.is_file() and FORBIDDEN_FRONTEND_BACKEND_URL.search(path.read_bytes()):
            offenders.append(path.relative_to(dist).as_posix())
    if offenders:
        joined = ", ".join(offenders)
        raise RuntimeError(
            "Frontend bundle contains a loopback backend URL; native deployments "
            f"must use same-origin /api routes. Offending files: {joined}"
        )


def _build_agent_service(target: Path, build_root: Path, *, skip_build: bool) -> None:
    """构建 pi agent 服务并打包生产依赖（纯 JS，无原生扩展）。

    在构建暂存副本上执行 npm ci/build/prune，避免改动开发检出的 node_modules。
    """
    agent = PROJECT_ROOT / "agent-service"
    work = build_root / "agent-service-work"
    if not skip_build:
        npm = shutil.which("npm")
        if npm is None:
            raise RuntimeError("npm is required to build the agent service")
        _copy_tree(agent / "src", work / "src")
        for filename in ("package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"):
            shutil.copy2(agent / filename, work / filename)
        _run([npm, "ci"], cwd=work)
        _run([npm, "run", "build"], cwd=work)
        # 裁剪为生产依赖后随包携带 node_modules，目标机离线运行
        _run([npm, "prune", "--omit=dev"], cwd=work)
        agent = work
    if not (agent / "dist" / "server.js").is_file():
        raise FileNotFoundError(f"Agent service bundle is missing dist/server.js: {agent}")
    target.mkdir(parents=True)
    shutil.copy2(agent / "package.json", target / "package.json")
    _copy_tree(agent / "dist", target / "dist")
    _copy_tree(agent / "skills", target / "skills")
    _copy_tree(agent / "node_modules", target / "node_modules")


def _build_frontend(target: Path, *, skip_build: bool) -> None:
    frontend = PROJECT_ROOT / "frontend-vue"
    if not skip_build:
        npm = shutil.which("npm")
        if npm is None:
            raise RuntimeError("npm is required to build the frontend")
        env = os.environ.copy()
        # Vite loads .env.local for every mode. An explicit process value takes
        # precedence and keeps native bundles on the Nginx same-origin /api path.
        env["VITE_BACKEND_NEXT_BASE_URL"] = ""
        _run([npm, "ci"], cwd=frontend, env=env)
        _run([npm, "run", "build", "--", "--mode", "production"], cwd=frontend, env=env)
    dist = frontend / "dist"
    _validate_frontend_bundle(dist)
    _copy_tree(dist, target)
    _validate_frontend_bundle(target)


def _build_backend_wheelhouse(
    target: Path,
    build_root: Path,
    *,
    platform: str,
    python_version: str,
    dependency_wheelhouse: Path | None = None,
) -> None:
    # Build from a minimal clean source tree. Setuptools otherwise reuses the
    # developer checkout's ignored build/ directory and can package files that
    # were already deleted from src/. It also keeps local .env files entirely
    # outside the PEP 517 build context.
    backend = PROJECT_ROOT / "backend-next"
    source_build = build_root / "backend-source"
    source_build.mkdir()
    shutil.copy2(backend / "pyproject.toml", source_build / "pyproject.toml")
    shutil.copy2(backend / "README.md", source_build / "README.md")
    _copy_tree(backend / "src", source_build / "src")
    wheel_build = build_root / "project-wheel"
    wheel_build.mkdir(parents=True)
    _run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            str(source_build),
            "--no-deps",
            "--wheel-dir",
            str(wheel_build),
        ],
        cwd=PROJECT_ROOT,
    )
    project_wheels = list(wheel_build.glob("ask_metric_backend_next-*.whl"))
    if len(project_wheels) != 1:
        raise RuntimeError("Expected exactly one backend project wheel")
    target.mkdir(parents=True)
    if dependency_wheelhouse is not None:
        # Reuse the bank-tested wheel set. Validate on native target Python with
        # offline pip install and pip check before delivering this bundle.
        for wheel in dependency_wheelhouse.glob("*.whl"):
            if not wheel.name.startswith("ask_metric_backend_next-"):
                shutil.copy2(wheel, target / wheel.name)
        shutil.copy2(project_wheels[0], target / project_wheels[0].name)
        return
    py_tag = python_version.replace(".", "")
    # HanLP 轻量 Trie 的几个上游只发布 sdist；在构建机预制纯 Python wheel，
    # 目标内网机只离线安装，不能依赖现场编译或自动下载。
    _run([
        sys.executable, "-m", "pip", "wheel", "--no-deps",
        "--wheel-dir", str(target), "--constraint", str(PACKAGE_DIR / "constraints.txt"),
        "hanlp-trie", "hanlp-common", "phrasetree",
    ], cwd=PROJECT_ROOT)
    for wheel in target.glob("*.whl"):
        if not wheel.name.endswith("-none-any.whl"):
            raise RuntimeError(f"Prebuilt dictionary wheel must be platform-independent: {wheel.name}")
    _run(
        [
            sys.executable,
            "-m",
            "pip",
            "download",
            str(project_wheels[0]),
            # pip evaluates environment markers on the Windows build host even
            # with --platform. Download the Linux-only uvicorn extra explicitly.
            "uvloop==0.22.1",
            "--dest",
            str(target),
            "--only-binary=:all:",
            "--find-links",
            str(target),
            "--platform",
            PLATFORMS[platform],
            "--implementation",
            "cp",
            "--python-version",
            py_tag,
            "--abi",
            f"cp{py_tag}",
            "--constraint",
            str(PACKAGE_DIR / "constraints.txt"),
        ],
        cwd=PROJECT_ROOT,
    )


def _copy_backend_runtime(target: Path) -> None:
    backend = PROJECT_ROOT / "backend-next"
    for directory in ("config", "resources", "alembic_goldendb", "scripts"):
        _copy_tree(backend / directory, target / directory)
    for filename in ("alembic-goldendb.ini", "README.md"):
        shutil.copy2(backend / filename, target / filename)


def _install_backend_site_packages(
    wheelhouse: Path,
    target: Path,
    *,
    platform: str,
    python_version: str,
) -> None:
    """Pre-install Linux wheels without executing the target interpreter."""
    target.mkdir(parents=True)
    py_tag = python_version.replace(".", "")
    _run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "ask-metric-backend-next",
            "uvloop==0.22.1",
            "--no-index",
            "--find-links",
            str(wheelhouse),
            "--target",
            str(target),
            "--ignore-installed",
            "--only-binary=:all:",
            "--platform",
            PLATFORMS[platform],
            "--implementation",
            "cp",
            "--python-version",
            py_tag,
            "--abi",
            f"cp{py_tag}",
        ],
        cwd=PROJECT_ROOT,
    )


def _validate_runtime_member(member: tarfile.TarInfo, *, top_level: str = "python") -> None:
    path = Path(member.name.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != top_level:
        raise RuntimeError(f"Unsafe runtime archive member: {member.name}")
    if member.issym() or member.islnk():
        link = Path(member.linkname.replace("\\", "/"))
        if link.is_absolute():
            raise RuntimeError(f"Unsafe absolute runtime link: {member.name} -> {member.linkname}")


def _runtime_checksums(runtime_archive: Path, *, top_level: str = "python", prefix: str = "python-runtime") -> list[str]:
    entries: list[str] = []
    with tarfile.open(runtime_archive, "r:gz") as source:
        for member in source:
            _validate_runtime_member(member, top_level=top_level)
            if not member.isfile():
                continue
            stream = source.extractfile(member)
            if stream is None:
                raise RuntimeError(f"Cannot read runtime member: {member.name}")
            digest = hashlib.sha256()
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            entries.append(
                f"{digest.hexdigest()}  {prefix}/{Path(member.name).as_posix()}"
            )
    return entries


def _append_python_runtime(
    target: tarfile.TarFile,
    runtime_archive: Path,
    *,
    bundle_name: str,
) -> None:
    with tarfile.open(runtime_archive, "r:gz") as source:
        for source_member in source:
            _validate_runtime_member(source_member)
            member = copy(source_member)
            member.name = f"{bundle_name}/python-runtime/{Path(member.name).as_posix()}"
            member = _linux_tar_metadata(member)
            stream = source.extractfile(source_member) if source_member.isfile() else None
            target.addfile(member, stream)


def _append_node_runtime(
    target: tarfile.TarFile,
    runtime_archive: Path,
    *,
    bundle_name: str,
) -> None:
    """内嵌官方 Node 发行包：剥掉 node-v<version>-<platform>/ 顶层目录，落到 node-runtime/node/。"""
    with tarfile.open(runtime_archive, "r:gz") as source:
        top_levels: set[str] = set()
        members = list(source)
        for source_member in members:
            path = Path(source_member.name.replace("\\", "/"))
            if path.is_absolute() or ".." in path.parts or not path.parts:
                raise RuntimeError(f"Unsafe Node runtime archive member: {source_member.name}")
            top_levels.add(path.parts[0])
        if len(top_levels) != 1 or not next(iter(top_levels)).startswith("node-v"):
            raise RuntimeError("Node runtime archive must contain a single node-v* top-level directory")
        for source_member in members:
            relative = Path(*Path(source_member.name.replace("\\", "/")).parts[1:])
            if not relative.parts:
                continue
            member = copy(source_member)
            member.name = f"{bundle_name}/node-runtime/node/{relative.as_posix()}"
            member = _linux_tar_metadata(member)
            stream = source.extractfile(source_member) if source_member.isfile() else None
            target.addfile(member, stream)


def _node_runtime_checksums(runtime_archive: Path) -> list[str]:
    entries: list[str] = []
    with tarfile.open(runtime_archive, "r:gz") as source:
        for member in source:
            path = Path(member.name.replace("\\", "/"))
            if path.is_absolute() or ".." in path.parts or not path.parts:
                raise RuntimeError(f"Unsafe Node runtime archive member: {member.name}")
            if len(path.parts) < 2 or not member.isfile():
                continue
            stream = source.extractfile(member)
            if stream is None:
                raise RuntimeError(f"Cannot read Node runtime member: {member.name}")
            digest = hashlib.sha256()
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            relative = Path(*path.parts[1:])
            entries.append(f"{digest.hexdigest()}  node-runtime/node/{relative.as_posix()}")
    return entries


def _copy_operations(target: Path, *, payload_only: bool = False) -> None:
    runtime = PACKAGE_DIR / "runtime"
    if payload_only:
        target.mkdir(parents=True)
        for filename in ("backend.env.example", "agent.env.example", "nginx.conf.template"):
            shutil.copy2(runtime / filename, target / filename)
        shutil.copy2(PACKAGE_DIR / "intranet_deploy.py", target / "intranet_deploy.py")
        shutil.copy2(PACKAGE_DIR / "constraints.txt", target / "constraints.txt")
        shutil.copy2(PACKAGE_DIR / "site_upgrade.py", target / "site_upgrade.py")
        return
    _copy_tree(runtime, target)
    for script in target.glob("*.sh"):
        script.chmod(0o755)
    shutil.copy2(PACKAGE_DIR / "intranet_deploy.py", target / "intranet_deploy.py")
    shutil.copy2(PACKAGE_DIR / "constraints.txt", target / "constraints.txt")
    shutil.copy2(PACKAGE_DIR / "site_upgrade.py", target / "site_upgrade.py")


def build_bundle(args: argparse.Namespace) -> Path:
    if not SAFE_VERSION.fullmatch(args.version):
        raise ValueError("version must contain only letters, numbers, dot, underscore, or dash")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    build_parent = (DEPLOY_DIR / ".build-package").resolve()
    build_key = hashlib.sha256(
        f"{args.version}:{args.platform}:{args.python_version}".encode()
    ).hexdigest()[:12]
    build_root = (build_parent / build_key).resolve()
    if build_root.parent != build_parent:
        raise RuntimeError("Unsafe build directory")
    if build_root.exists():
        shutil.rmtree(build_root)
    build_root.mkdir(parents=True)

    bundle_name = f"ask-metric-{args.version}-{args.platform}-py{args.python_version}"
    # Keep the physical staging path short for Windows builders. The archive
    # still exposes the descriptive bundle name through arcname below.
    bundle_root = build_root / "bundle"
    bundle_root.mkdir()
    _build_frontend(bundle_root / "frontend", skip_build=args.skip_frontend_build)
    _build_agent_service(bundle_root / "agent-service", build_root, skip_build=args.skip_agent_build)
    _build_backend_wheelhouse(
        bundle_root / "backend" / "wheels",
        build_root,
        platform=args.platform,
        python_version=args.python_version,
        dependency_wheelhouse=args.dependency_wheelhouse,
    )
    runtime_checksums: list[str] = []
    runtime_metadata: dict[str, object] = {"included": False}
    if args.python_runtime_archive is not None:
        runtime_archive = args.python_runtime_archive.resolve()
        if not runtime_archive.is_file():
            raise FileNotFoundError(f"Python runtime archive not found: {runtime_archive}")
        if not args.python_runtime_sha256:
            raise ValueError("--python-runtime-sha256 is required with --python-runtime-archive")
        runtime_digest = _sha256(runtime_archive)
        if args.python_runtime_sha256 and runtime_digest != args.python_runtime_sha256.lower():
            raise RuntimeError(
                "Python runtime SHA-256 mismatch: "
                f"expected {args.python_runtime_sha256.lower()}, got {runtime_digest}"
            )
        site_packages = (
            bundle_root
            / "python-runtime"
            / "python"
            / "lib"
            / f"python{args.python_version}"
            / "site-packages"
        )
        _install_backend_site_packages(
            bundle_root / "backend" / "wheels",
            site_packages,
            platform=args.platform,
            python_version=args.python_version,
        )
        runtime_checksums = _runtime_checksums(runtime_archive)
        runtime_metadata = {
            "included": True,
            "archive_source": runtime_archive.name,
            "archive_sha256": runtime_digest,
            "executable": "python-runtime/python/bin/python3.12",
            "dependencies_preinstalled": True,
        }
    node_runtime_metadata: dict[str, object] = {"included": False}
    if args.node_runtime_archive is not None:
        node_archive = args.node_runtime_archive.resolve()
        if not node_archive.is_file():
            raise FileNotFoundError(f"Node runtime archive not found: {node_archive}")
        if not args.node_runtime_sha256:
            raise ValueError("--node-runtime-sha256 is required with --node-runtime-archive")
        node_digest = _sha256(node_archive)
        if node_digest != args.node_runtime_sha256.lower():
            raise RuntimeError(
                "Node runtime SHA-256 mismatch: "
                f"expected {args.node_runtime_sha256.lower()}, got {node_digest}"
            )
        runtime_checksums += _node_runtime_checksums(node_archive)
        node_runtime_metadata = {
            "included": True,
            "archive_source": node_archive.name,
            "archive_sha256": node_digest,
            "executable": "node-runtime/node/bin/node",
        }
    _copy_backend_runtime(bundle_root / "backend" / "runtime")
    _copy_operations(bundle_root / "ops", payload_only=args.payload_only)
    manifest = {
        "format_version": 2,
        "application": "ask-metric",
        "release": args.version,
        "target_platform": args.platform,
        "target_python": args.python_version,
        "created_at": datetime.now(UTC).isoformat(),
        "database": "GoldenDB/MySQL",
        "deployment_mode": (
            "native-linux-offline-payload"
            if args.payload_only
            else "native-linux-offline"
        ),
        "target_operations_require_bash": not args.payload_only,
        "database_migration_automatic": False,
        "python_constraints": "ops/constraints.txt",
        "python_runtime": runtime_metadata,
        "node_runtime": node_runtime_metadata,
        "agent_service": {"included": True, "source": "agent-service"},
        "source_commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT, text=True,
        ).strip(),
        "source_worktree_changes": subprocess.check_output(
            ["git", "status", "--short"], cwd=PROJECT_ROOT, text=True,
        ).splitlines(),
        "model_provider": "bank_intranet_openai_compatible",
        "model_network": "bank-intranet-only",
    }
    (bundle_root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    _write_checksums(bundle_root, runtime_checksums)

    archive = output_dir / f"{bundle_name}.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(bundle_root, arcname=bundle_name, filter=_linux_tar_metadata)
        if args.python_runtime_archive is not None:
            _append_python_runtime(
                tar,
                args.python_runtime_archive.resolve(),
                bundle_name=bundle_name,
            )
        if args.node_runtime_archive is not None:
            _append_node_runtime(
                tar,
                args.node_runtime_archive.resolve(),
                bundle_name=bundle_name,
            )
    archive.with_suffix(archive.suffix + ".sha256").write_text(
        f"{_sha256(archive)}  {archive.name}\n",
        encoding="utf-8",
        newline="\n",
    )
    if args.keep_staging:
        print(f"Staging directory: {bundle_root}")
    else:
        shutil.rmtree(build_root)
    return archive


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build an offline native Linux deployment bundle")
    parser.add_argument(
        "--version", required=True, help="Release identifier, for example 20260824.1"
    )
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    parser.add_argument("--python-version", default="3.12", choices=["3.11", "3.12", "3.13"])
    parser.add_argument("--output-dir", type=Path, default=DEPLOY_DIR / "artifacts")
    parser.add_argument("--skip-frontend-build", action="store_true")
    parser.add_argument("--skip-agent-build", action="store_true")
    parser.add_argument(
        "--payload-only",
        action="store_true",
        help="Exclude shell operations for restricted target hosts",
    )
    parser.add_argument("--keep-staging", action="store_true")
    parser.add_argument("--dependency-wheelhouse", type=Path,
                        help="Reuse verified Linux dependency wheels; requires target install QA")
    parser.add_argument(
        "--python-runtime-archive",
        type=Path,
        help=(
            "python-build-standalone install_only .tar.gz; embeds the interpreter and "
            "pre-installs all backend dependencies"
        ),
    )
    parser.add_argument(
        "--python-runtime-sha256",
        help="Required expected SHA-256 for --python-runtime-archive",
    )
    parser.add_argument(
        "--node-runtime-archive",
        type=Path,
        help=(
            "Official node-v*-linux-*.tar.gz; embeds the Node runtime for agent-service "
            "(see node-runtime-lock.json for reviewed URLs and SHA-256)"
        ),
    )
    parser.add_argument(
        "--node-runtime-sha256",
        help="Required expected SHA-256 for --node-runtime-archive",
    )
    return parser.parse_args()


def main() -> None:
    archive = build_bundle(parse_args())
    print(f"Created {archive}")


if __name__ == "__main__":
    main()
