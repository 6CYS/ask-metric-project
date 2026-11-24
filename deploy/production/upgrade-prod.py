#!/usr/bin/env python3
"""沿用包内 upgrade.py，配置 Pi Agent 的原生 Nacos 注册。"""

import argparse
import ipaddress
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile


AGENT_DIST = "agent-service/dist"
AGENT_ENTRY = f"{AGENT_DIST}/server.js"
REGISTRATION_MODULES = {
    f"{AGENT_DIST}/nacosRegistration.js",
    f"{AGENT_DIST}/nacosConnection.js",
}
MISSING_REGISTRATION = "Agent 载荷缺少原生 Nacos 注册，需要包含 2946131 或其后续实现的后端离线包。"


class DeploymentError(Exception):
    pass


def uses_native_registration(source: bytes) -> bool:
    return b"./nacosRegistration.js" in source and b"createNacosRegistration(" in source


def check_archive(payload: Path) -> None:
    found_modules = set()
    entry_wires_registration = False
    with tarfile.open(payload, "r|gz") as archive:
        for member in archive:
            if not member.isfile():
                continue
            name = member.name.removeprefix("./")
            if name in REGISTRATION_MODULES:
                found_modules.add(name)
            elif name == AGENT_ENTRY:
                entry = archive.extractfile(member)
                if entry is not None:
                    with entry:
                        entry_wires_registration = uses_native_registration(entry.read())
            if found_modules == REGISTRATION_MODULES and entry_wires_registration:
                return
    raise DeploymentError(MISSING_REGISTRATION)


def check_installed_agent(base: Path) -> None:
    payload = base / "payload"
    entry = payload / AGENT_ENTRY
    if not entry.is_file():
        raise DeploymentError("安装目录内缺少 Agent，先用本脚本执行 prepare。")
    if not all((payload / module).is_file() for module in REGISTRATION_MODULES):
        raise DeploymentError(MISSING_REGISTRATION)
    if not uses_native_registration(entry.read_bytes()):
        raise DeploymentError(MISSING_REGISTRATION)


def registration_settings(site: dict) -> dict[str, str]:
    name = site.get("agent_service_name", "ask-metric-agent-v2")
    if not isinstance(name, str) or not name.strip() or name.strip() == site["python_service_name"].strip():
        raise DeploymentError("agent_service_name 必须填写有效的服务名，并与 Python 服务名不同。")
    try:
        address = ipaddress.ip_address(site["node_ip"])
    except (KeyError, ValueError):
        raise DeploymentError("node_ip 必须填写 Gateway 可访问的本机 IP。") from None
    if address.is_unspecified:
        raise DeploymentError("node_ip 必须填写 Gateway 可访问的本机 IP。")

    return {
        "NACOS_REGISTER_ENABLED": "true",
        "NACOS_SERVICE_NAME": name.strip(),
        "NACOS_INSTANCE_IP": str(address),
        # 原生成器可能继承一期 Python 的实例端口，Agent 必须按自己的端口注册。
        "NACOS_INSTANCE_PORT": str(site["agent_port"]),
    }


def write_environment(path: Path, values: dict[str, str]) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=".agent.env.", delete=False
        ) as stream:
            temporary = Path(stream.name)
            for key, value in values.items():
                stream.write(f"{key}={json.dumps(value, ensure_ascii=False)}\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="与原升级包的 upgrade.py 放在同一目录。其他参数沿用原升级器。",
        allow_abbrev=False,
    )
    parser.add_argument("action", help="例如 inspect、prepare、configure、validate、start、check、stop")
    parser.add_argument("--site", default="site.json", help="节点参数文件，默认 site.json")
    args, forwarded = parser.parse_known_args()

    original = Path(__file__).resolve().with_name("upgrade.py")
    if not original.is_file():
        parser.exit(1, "请把 upgrade-prod.py 放在解包后的 upgrade.py 同目录。\n")

    command = [sys.executable, str(original), args.action, "--site", args.site, *forwarded]
    if args.action not in {"prepare", "configure", "validate", "start"}:
        return subprocess.run(command, check=False).returncode

    try:
        original_functions = runpy.run_path(str(original))
        site = original_functions["read_site"](args.site)
        desired = registration_settings(site)
        if args.action == "prepare":
            check_archive(original.with_name("backend-payload.tgz"))
            return subprocess.run(command, check=False).returncode

        base = Path(site["install_dir"])
        check_installed_agent(base)
        agent_env = base / "private/agent.env"
        if args.action == "configure":
            result = subprocess.run(command, check=False)
            if result.returncode:
                return result.returncode

        if not agent_env.is_file():
            raise DeploymentError("缺少生成的 agent.env，先用本脚本执行 configure。")
        values = original_functions["env_values"](agent_env)
        expected = {"AGENT_SERVICE_PORT": desired["NACOS_INSTANCE_PORT"]}
        if args.action != "configure":
            expected.update(desired)
        mismatch = [key for key, value in expected.items() if values.get(key) != value]
        if mismatch:
            raise DeploymentError("Agent 环境与 site 不一致，核对后重跑 configure：" + ", ".join(mismatch))

        if args.action == "configure":
            write_environment(agent_env, {**values, **desired})
            print(
                "AGENT_NACOS_CONFIGURED "
                f'{desired["NACOS_SERVICE_NAME"]} '
                f'{desired["NACOS_INSTANCE_IP"]}:{desired["NACOS_INSTANCE_PORT"]}',
                flush=True,
            )
            return 0

        return subprocess.run(command, check=False).returncode
    except DeploymentError as error:
        print(f"upgrade-prod: {error}", file=sys.stderr)
    except Exception as error:
        # 解析 .env 的异常可能携带原值，终端只返回错误类别。
        print(f"upgrade-prod: 请核对包、site 文件和 Agent 环境文件（{type(error).__name__}）。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
