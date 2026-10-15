"""保存当前源码白名单；仅用于阶段对照，不读取运行环境或 Session。"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs/verification/pi-semantic-task-phase1-20261014"
MANIFEST = OUTPUT / "baseline-manifest.json"
ARCHIVE = OUTPUT / "baseline-source.tar.gz"
DIRECTORIES = (
    "agent-service/src", "agent-service/specs", "agent-service/skills",
    "backend-next/src", "backend-next/tests", "backend-next/verification",
    "frontend-vue/src", "frontend-vue/specs",
)
CONFIGS = (
    "agent-service/package.json", "agent-service/package-lock.json",
    "agent-service/tsconfig.json", "agent-service/tsconfig.build.json",
    "agent-service/tsconfig.spec.json", "backend-next/pyproject.toml",
    "backend-next/uv.lock", "frontend-vue/package.json",
    "frontend-vue/package-lock.json", "frontend-vue/tsconfig.json",
    "frontend-vue/tsconfig.app.json", "frontend-vue/tsconfig.node.json",
    "frontend-vue/tsconfig.specs.json",
)
EXTENSIONS = {".ts", ".tsx", ".js", ".mjs", ".py", ".vue", ".css", ".scss", ".md", ".json"}
# 发现可能的字面量秘密时只报告路径并拒绝归档，不打印内容。
SECRET = re.compile(
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    rb"\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b|"
    rb"(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*['\"][A-Za-z0-9_+/=-]{24,}['\"]",
    re.IGNORECASE,
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_paths() -> list[str]:
    found = subprocess.check_output(["rg", "--files", *DIRECTORIES], cwd=ROOT).decode().splitlines()
    paths = set(CONFIGS)
    for name in found:
        path = Path(name)
        if path.suffix in EXTENSIONS and not any(
            part.startswith(".") or part in {"node_modules", "__pycache__", "data", "fixtures"}
            for part in path.parts
        ):
            paths.add(name)
    return sorted(name for name in paths if (ROOT / name).is_file())


def capture() -> None:
    if MANIFEST.exists() or ARCHIVE.exists():
        raise SystemExit("基线已存在；拒绝覆盖。使用 --verify 核对。")
    sources = {name: (ROOT / name).read_bytes() for name in source_paths()}
    flagged = [name for name, data in sources.items() if SECRET.search(data)]
    if flagged:
        raise SystemExit("归档停止：需检查可能的字面量秘密，仅列路径：" + ", ".join(flagged))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip()
    # 只保留路径与索引状态，不读取差异正文、环境变量或远程地址。
    git_status = subprocess.check_output(["git", "status", "--porcelain=v1", "-z"], cwd=ROOT).decode().split("\0")
    with tarfile.open(ARCHIVE, "w:gz") as archive:
        for name, data in sources.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o600
            info.mtime = 0
            archive.addfile(info, io.BytesIO(data))
    manifest = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "kind": "current_worktree_source_baseline",
        "git_head": git_head,
        "git_status_entries": [item for item in git_status if item],
        "scope": list(DIRECTORIES),
        "excludes": ["environment files", "runtime credentials", "Session and business data", "dependency directories", "Git data", "binary fixtures"],
        "archive": ARCHIVE.name,
        "archive_sha256": sha(ARCHIVE.read_bytes()),
        "files": [{"path": name, "sha256": sha(data), "bytes": len(data)} for name, data in sources.items()],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"files": len(sources), "archive_bytes": ARCHIVE.stat().st_size, "manifest": str(MANIFEST.relative_to(ROOT))}, ensure_ascii=False))


def verify() -> None:
    manifest = json.loads(MANIFEST.read_text())
    if sha(ARCHIVE.read_bytes()) != manifest["archive_sha256"]:
        raise SystemExit("归档摘要不匹配")
    expected = {entry["path"]: entry for entry in manifest["files"]}
    with tarfile.open(ARCHIVE, "r:gz") as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {item.name for item in members} != set(expected):
            raise SystemExit("归档文件列表不匹配")
        for member in members:
            stream = archive.extractfile(member)
            if not member.isfile() or stream is None or sha(stream.read()) != expected[member.name]["sha256"]:
                raise SystemExit("归档成员摘要不匹配：" + member.name)
    changed = [name for name, entry in expected.items() if not (ROOT / name).exists() or sha((ROOT / name).read_bytes()) != entry["sha256"]]
    added = sorted(set(source_paths()) - set(expected))
    report = {"archive_verified": True, "files": len(expected), "current_source_changed": changed, "current_source_added": added}
    (OUTPUT / "baseline-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))
    if changed or added:
        raise SystemExit("当前源码与基线不同；请区分本阶段改动与其他已有工作，不自动还原。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true")
    options = parser.parse_args()
    verify() if options.verify else capture()
