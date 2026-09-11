"""生成登录国密传输的 SM2 密钥对。

用法：

    python scripts/generate_sm2_keypair.py --output-dir /protected/path --output sm2.env

密钥只写入新建文件，不输出到终端，也不覆盖已有文件。将文件中的 SM2_PRIVATE_KEY
通过既有配置加密流程导入部署环境；公钥由后端从私钥推导，
通过 /api/v1/auth/sm2-public-key 自动下发，无需单独配置。
"""

import argparse
import os
import re
import stat
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

from ask_metric.core.gm_crypto import generate_sm2_keypair  # noqa: E402


def write_keypair(output: Path, *, output_dir: Path) -> None:
    # A filename is not a filesystem path. The separately selected private
    # directory is the only authorized destination for this invocation.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.env", str(output)):
        raise ValueError("Use a simple .env filename without directories")
    if not output_dir.is_absolute() or ".." in output_dir.parts:
        raise ValueError("An absolute private output directory is required")
    for parent in (output_dir, *output_dir.parents):
        if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
            raise ValueError("Linked output directories are not allowed")
    if not output_dir.is_dir():
        raise ValueError("Output directory must already exist")
    directory_fd = None
    try:
        if os.name == "posix":
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            directory_fd = os.open(output_dir.anchor, flags)
            for part in output_dir.parts[1:]:
                next_fd = os.open(part, flags, dir_fd=directory_fd)
                os.close(directory_fd)
                directory_fd = next_fd
            info = os.fstat(directory_fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise ValueError("Output directory must be owned by this user and private")
        keypair = generate_sm2_keypair()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        if directory_fd is not None:
            descriptor = os.open(output.name, flags, 0o600, dir_fd=directory_fd)
        else:
            descriptor = os.open(output_dir / output.name, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as stream:
            stream.write(f"SM2_PRIVATE_KEY={keypair.private_key}\n")
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 SM2 密钥并写入受保护的新文件")
    parser.add_argument("--output-dir", type=Path, required=True, help="已创建的私有目录，绝对路径")
    parser.add_argument("--output", type=Path, required=True, help="仅文件名，例如 sm2.env")
    args = parser.parse_args()
    try:
        write_keypair(args.output, output_dir=args.output_dir)
    except (OSError, ValueError):
        parser.exit(1, "无法创建密钥文件：使用本人私有目录和未占用的简单 .env 文件名，"
                    "不允许链接或目录跳转。\n")
    print("SM2 密钥文件已生成，请通过配置加密流程导入；勿提交到仓库。")


if __name__ == "__main__":
    main()
