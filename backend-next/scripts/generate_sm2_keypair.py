"""生成登录国密传输的 SM2 密钥对。

用法：

    python scripts/generate_sm2_keypair.py --output /protected/path/sm2.env

密钥只写入新建文件，不输出到终端，也不覆盖已有文件。将文件中的 SM2_PRIVATE_KEY
通过既有配置加密流程导入部署环境；公钥由后端从私钥推导，
通过 /api/v1/auth/sm2-public-key 自动下发，无需单独配置。
"""

import argparse
import os
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

from ask_metric.core.gm_crypto import generate_sm2_keypair  # noqa: E402


def write_keypair(output: Path) -> None:
    keypair = generate_sm2_keypair()
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii") as stream:
        stream.write(f"SM2_PRIVATE_KEY={keypair.private_key}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 SM2 密钥并写入受保护的新文件")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        write_keypair(args.output)
    except OSError:
        parser.exit(1, "无法创建密钥文件，请检查目录权限并使用尚不存在的文件名。\n")
    print("SM2 密钥文件已生成，请通过配置加密流程导入；勿提交到仓库。")


if __name__ == "__main__":
    main()
