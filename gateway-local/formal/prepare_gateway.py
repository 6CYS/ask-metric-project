"""从 1104 正式部署包提取并校验本地运行用的 Gateway JAR。"""

import argparse
import hashlib
import io
from pathlib import Path
import tarfile
from zipfile import ZipFile


APP_ARCHIVE = "ask-metric-prod-20261028-r1-bank.zip"
GATEWAY_RELEASE = "ask-metric-intent-gateway-prod-20261028-r1"


def verify_checksum(content: bytes, expected: str, name: str) -> None:
    if hashlib.sha256(content).hexdigest() != expected:
        raise SystemExit(f"SHA-256 校验失败：{name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()

    with ZipFile(args.archive) as delivery:
        (entry,) = [name for name in delivery.namelist() if name.endswith(f"/{APP_ARCHIVE}")]
        app_bundle = delivery.read(entry)
        verify_checksum(app_bundle, delivery.read(f"{entry}.sha256").decode().split()[0], entry)

    with ZipFile(io.BytesIO(app_bundle)) as app:
        gateway_archive = f"{GATEWAY_RELEASE}.tar.gz"
        gateway_bundle = app.read(gateway_archive)
        verify_checksum(
            gateway_bundle, app.read(f"{gateway_archive}.sha256").decode().split()[0], gateway_archive
        )

    with tarfile.open(fileobj=io.BytesIO(gateway_bundle), mode="r:gz") as gateway:
        jar_name = f"{GATEWAY_RELEASE}/app.jar"
        checksum_name = f"{GATEWAY_RELEASE}/checksums.sha256"
        jar = gateway.extractfile(jar_name).read()
        checksums = gateway.extractfile(checksum_name).read().decode()
        (expected,) = [
            digest for digest, name in map(str.split, checksums.splitlines())
            if name in ("app.jar", "./app.jar")
        ]
        verify_checksum(jar, expected, jar_name)

    output = Path(__file__).with_name("app.jar")
    output.write_bytes(jar)
    print(f"{GATEWAY_RELEASE} JAR 已校验：{output}")


if __name__ == "__main__":
    main()
