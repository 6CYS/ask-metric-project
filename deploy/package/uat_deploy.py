"""无 sudo 的现场入口；配置由 Nacos 提供，凭据不打印。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
from ask_metric.core.config import get_settings
from ask_metric.core.config_crypto import (
    decrypt_config_value,
    encrypt_config_value,
    load_config_sm4_key,
)
from ask_metric.infrastructure.config_center.bootstrap import BootstrapSettings
from ask_metric.infrastructure.config_center.exporter import export_configs
from ask_metric.infrastructure.config_center.nacos import (
    DATA_IDS,
    ConfigCenterError,
    NacosConfigStore,
    decode_document,
)
from dotenv import dotenv_values

RELEASE = Path(os.environ.get("AM_RELEASE_DIR", Path(__file__).resolve().parents[1]))
BASE = Path(os.environ.get("AM_UAT_ROOT", "/home/appuser/ask-metric-pi"))
CONFIG = BASE / "config"
OLD_ENV = Path("/home/appuser/ask-metric-config-uat/backend.env")
GROUP = "ASK_METRIC_CONFIG_PI_UAT_R1"


def env_text(values: dict) -> str:
    if any("'" in str(v) or "\n" in str(v) or "\r" in str(v) for v in values.values()):
        raise ConfigCenterError("引导配置不能包含单引号或换行")
    return "".join(f"{k.upper()}='{v}'\n" for k, v in values.items())


def secure_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)


def prepare(args):
    old = {
        k.lower(): v
        for k, v in dotenv_values(args.old_env, interpolate=False).items()
        if v is not None
    }
    common = {
        k: old[k]
        for k in (
            "nacos_server_addr",
            "nacos_namespace",
            "nacos_username",
            "nacos_password",
            "ask_metric_config_sm4_key_file",
        )
        if k in old
    }
    if not common.get("nacos_username") or not common.get("nacos_password"):
        raise ConfigCenterError("原引导缺少 Nacos 账号；需在现场受控文件中补齐")
    for target in (CONFIG / "nacos", CONFIG / "backend.env", CONFIG / "agent.env"):
        if target.exists():
            raise ConfigCenterError("新版配置已存在，拒绝覆盖；先核对已生成文件")
    if args.context_window < 4:
        raise ConfigCenterError("模型上下文窗口不足以分配输出和压缩预算")
    key = load_config_sm4_key(
        environ={}, key_file=Path(common["ask_metric_config_sm4_key_file"])
    )
    common["nacos_password"] = encrypt_config_value(
        decrypt_config_value(common["nacos_password"], key), key
    )
    export_configs(
        args.old_env,
        RELEASE / "backend/runtime/config",
        CONFIG / "nacos",
        agent_base_url=args.agent_base_url,
        context_window=args.context_window,
    )
    common.update(nacos_config_enabled="true", nacos_config_group=GROUP)
    backend = {
        **common,
        "nacos_enabled": "true",
        "nacos_fail_fast": "true",
        "nacos_group": "DEFAULT_GROUP",
        "nacos_service_name": "ask-metric-python-pi-uat",
        "nacos_instance_ip": args.backend_ip,
        "nacos_instance_port": 8010,
        "nacos_instance_id": "pi-uat-204",
        "host": "0.0.0.0",
        "port": 8010,
        "nacos_cache_dir": str(BASE / "state/nacos/cache"),
        "nacos_log_dir": str(BASE / "logs/nacos"),
        "log_directory": str(BASE / "logs/backend"),
        "config_history_dir": str(BASE / "state/config-history"),
    }
    for k in ("app_node_code", "app_idc", "app_unit"):
        if k in old:
            backend[k] = old[k]
    agent = {
        **common,
        "agent_service_host": "0.0.0.0",
        "agent_service_port": 8020,
        "backend_base_url": "http://127.0.0.1:8010",
        "agent_data_dir": str(BASE / "state/agent"),
    }
    secure_write(CONFIG / "backend.env", env_text(backend))
    secure_write(CONFIG / "agent.env", env_text(agent))
    print(
        "8 个 SM4 配置文档及两个引导文件已生成。先核对模型入口、窗口、机构权限和 export-report.json，再发布。"
    )


def environment(name="backend"):
    values = dotenv_values(CONFIG / f"{name}.env", interpolate=False)
    if not values.get("NACOS_CONFIG_ENABLED"):
        raise ConfigCenterError("引导文件缺少 NACOS_CONFIG_ENABLED")
    env = {**os.environ, **{k: v for k, v in values.items() if v is not None}}
    return env


def load_backend():
    os.environ.update(environment())
    get_settings.cache_clear()
    return get_settings()


def validate_agent_documents():
    # 使用与真实启动相同的 Node 加载入口，校验模型预算、SM4 和全部 Agent 字段。
    script = """
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const {loadRuntimeConfig} = await import(pathToFileURL(process.env.AM_AGENT_LOADER));
await loadRuntimeConfig(process.env, async (url) => {
  if (String(url).includes('/auth/users/login')) {
    return new Response(JSON.stringify({accessToken:'local-validation'}));
  }
  const id = new URL(url).searchParams.get('dataId');
  const content = fs.readFileSync(process.env.AM_NACOS_EXPORT_DIR+'/'+id,'utf8');
  return new Response(JSON.stringify({code:0,data:{content}}));
});
"""
    result = subprocess.run(
        [
            str(RELEASE / "node-runtime/node/bin/node"),
            "--input-type=module",
            "--eval",
            script,
        ],
        env={
            **environment("agent"),
            "AM_AGENT_LOADER": str(RELEASE / "agent-service/dist/nacosConfig.js"),
            "AM_NACOS_EXPORT_DIR": str(CONFIG / "nacos"),
        },
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ConfigCenterError("Agent 配置校验失败，核对模型字段、窗口预算与 SM4 密文")
    print("Agent 配置通过真实启动入口校验。")


def verify_published(store, name, document, *, timeout_seconds=30):
    # Nacos 写入确认与节点缓存可见性分开；等待期间只读，不重复发布。
    deadline = time.monotonic() + timeout_seconds
    waiting = False
    while True:
        try:
            actual = store.read_json(name)
        except ConfigCenterError as exc:
            if "缺少配置" not in str(exc) and "HTTP 404，v1" not in str(exc):
                raise
        else:
            if actual == document:
                return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ConfigCenterError(
                f"Nacos 已确认写入，但回读未在 {timeout_seconds:g} 秒内一致：{name}；"
                "核对节点同步、namespace 和配置组后重试 publish"
            )
        if not waiting:
            print(f"Nacos 已确认写入，等待节点回读：{name}", flush=True)
            waiting = True
        time.sleep(min(1, remaining))


def publish():
    os.environ.update(environment())
    bootstrap = BootstrapSettings(_env_file=None)
    if bootstrap.nacos_config_group != GROUP:
        raise ConfigCenterError("仅允许发布本版本独立配置组，禁止覆盖旧 UAT 配置组")
    key = load_config_sm4_key(
        environ={}, key_file=bootstrap.ask_metric_config_sm4_key_file
    )
    bootstrap.nacos_password = decrypt_config_value(bootstrap.nacos_password, key)
    store = NacosConfigStore(bootstrap)
    # 先校验全批文档再写；新建只在确定缺少该 Data ID 时执行，其他错误一律停止。
    documents = {
        name: decode_document(
            (CONFIG / "nacos" / name).read_text(encoding="utf-8"), name
        )
        for name in DATA_IDS
    }
    from ask_metric.infrastructure.config_center.bootstrap import (
        CenterSettings,
        merge_business_documents,
        validate_resources,
        validate_sensitive_fields,
    )
    from ask_metric.infrastructure.config_center.nacos import (
        DocumentSnapshot,
        encode_document,
    )
    from ask_metric.infrastructure.model.configuration import ModelRuntimeConfig

    snapshot = DocumentSnapshot(documents)
    model = ModelRuntimeConfig.model_validate(documents["sznsznws_backend_model.json"])
    values = merge_business_documents(snapshot, model)
    validate_sensitive_fields(values, model, key)
    values.update(bootstrap.model_dump())
    values.update(
        {
            k.lower(): v
            for k, v in environment().items()
            if k.lower() in {"host", "port", "log_directory", "config_history_dir"}
            or k.startswith("NACOS_")
        }
    )
    settings = CenterSettings(
        **{k: v for k, v in values.items() if k in CenterSettings.model_fields}
    )
    settings._config_center = snapshot
    validate_resources(settings)
    validate_agent_documents()
    for name, document in documents.items():
        try:
            store.read_json(name)
        except ConfigCenterError as exc:
            if "缺少配置" not in str(exc) and "HTTP 404，v1" not in str(exc):
                raise
            print(f"creating: {name}", flush=True)
            store._request("POST", name, encode_document(document, name))
        else:
            print(f"updating with CAS: {name}", flush=True)
            store.publish_json(name, document)
        verify_published(store, name, document)
        print(f"published and verified: {name}", flush=True)
    load_backend()
    print("后端已按与启动相同入口完成 Nacos 配置校验。")


def database(generate_sql=False):
    from ask_metric.infrastructure.db.session import get_app_engine, get_query_engine
    from sqlalchemy import inspect, text

    load_backend()
    app = get_app_engine()
    for label, engine in [("APP", app), ("QUERY", get_query_engine())]:
        with engine.connect() as conn:
            assert conn.execute(text("SELECT 1")).scalar() == 1
        print(f"{label}: SELECT 1 OK")
    required = {
        "metric_values": {"org_code"},
        "org_terms": {"parent_org_code", "hierarchy_level"},
        "metric_terms": {"source_metric_code", "base_name", "value_basis"},
    }
    inspector = inspect(app)
    missing = {
        t: sorted(columns - {c["name"] for c in inspector.get_columns(t)})
        for t, columns in required.items()
    }
    with app.connect() as conn:
        revision = conn.execute(
            text("SELECT version_num FROM backend_next_goldendb_alembic_version")
        ).scalar_one()
    print("APP schema revision:", revision)
    print(
        "missing columns:", json.dumps({t: cols for t, cols in missing.items() if cols})
    )
    if generate_sql:
        known = {
            "0003_analysis_checkpoints",
            "0004_org_hierarchy_and_org_code",
            "0005_metric_source_structure",
        }
        if revision not in known:
            raise ConfigCenterError("版本不在可自动生成增量范围内，请先由 DBA 核对")
        command = [
            sys.executable,
            str(RELEASE / "backend/runtime/scripts/run_goldendb_migration.py"),
            "--config",
            str(CONFIG / "backend.env"),
            "--sql",
            str(BASE / "db-increment.sql"),
            "--from-revision",
            revision,
        ]
        subprocess.run(command, env=environment(), check=True)
        print("只生成审核 SQL，不执行数据库迁移；已存在的列需由 DBA 跳过。")
    elif any(missing.values()):
        raise ConfigCenterError("数据库缺少新字段，请生成增量并交 DBA 审核执行后再启动")


def start():
    database()
    processes = {
        "backend": [
            sys.executable,
            "-I",
            "-m",
            "uvicorn",
            "ask_metric.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            "8010",
            "--no-access-log",
        ],
        "agent": [
            str(RELEASE / "node-runtime/node/bin/node"),
            str(RELEASE / "agent-service/dist/server.js"),
        ],
    }
    for name, command in processes.items():
        pid_file = BASE / "run" / f"{name}.json"
        if pid_file.exists():
            raise ConfigCenterError(f"{name} PID 文件已存在，先 check 或 stop")
        from socket import socket

        with socket() as sock:
            sock.bind(("0.0.0.0", 8010 if name == "backend" else 8020))
        log = (BASE / "logs" / f"{name}-console.log").open("ab")
        proc = subprocess.Popen(
            command,
            cwd=RELEASE / "agent-service" if name == "agent" else RELEASE,
            env=environment(name),
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        log.close()
        time.sleep(2)
        if proc.poll() is not None:
            raise ConfigCenterError(f"{name} 启动失败，请查看本地 console.log")
        marker = Path(f"/proc/{proc.pid}/cmdline").read_bytes()
        secure_write(
            pid_file,
            json.dumps(
                {"pid": proc.pid, "command_sha256": hashlib.sha256(marker).hexdigest()}
            ),
        )
        print(f"started {name}: PID {proc.pid}")
    for _ in range(90):
        try:
            check()
            return
        except (httpx.RequestError, ConfigCenterError):
            time.sleep(2)
    raise ConfigCenterError(
        "启动等待 180 秒仍未就绪；进程与日志已保留，请 check 后核对日志"
    )


def stop():
    for name in ("agent", "backend"):
        path = BASE / "run" / f"{name}.json"
        if not path.exists():
            continue
        saved = json.loads(path.read_text())
        cmdline = Path(f"/proc/{saved['pid']}/cmdline")
        if cmdline.exists() and cmdline.read_bytes():
            if (
                hashlib.sha256(cmdline.read_bytes()).hexdigest()
                != saved["command_sha256"]
            ):
                raise ConfigCenterError(f"{name} PID 已被其他进程复用，拒绝停止")
            os.kill(saved["pid"], signal.SIGTERM)
            for _ in range(50):
                if not cmdline.exists() or not cmdline.read_bytes():
                    break
                time.sleep(0.2)
            else:
                raise ConfigCenterError(f"{name} 尚未退出，保留 PID 文件")
        path.unlink()
        print(f"stopped {name}")


def check():
    for name, url in [
        ("backend", "http://127.0.0.1:8010/health/ready"),
        ("agent", "http://127.0.0.1:8020/health"),
    ]:
        response = httpx.get(url, timeout=10, trust_env=False)
        if response.status_code != 200:
            raise ConfigCenterError(f"{name}: HTTP {response.status_code}，尚未就绪")
        print(f"{name}: HTTP 200")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=["prepare", "publish", "db", "sql", "sync", "start", "stop", "check"],
    )
    parser.add_argument("--old-env", type=Path, default=OLD_ENV)
    parser.add_argument("--backend-ip", default="77.16.60.204")
    parser.add_argument("--agent-base-url")
    parser.add_argument("--context-window", type=int, default=128000)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args)
    elif args.command == "publish":
        publish()
    elif args.command in {"db", "sql"}:
        database(args.command == "sql")
    elif args.command == "start":
        start()
    elif args.command == "stop":
        stop()
    elif args.command == "check":
        check()
    elif args.command == "sync":
        database()
        for command in ["sync-metric-catalog", "sync-org-catalog"]:
            subprocess.run(
                [sys.executable, "-m", "ask_metric", command],
                env=environment(),
                check=True,
            )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 -- 现场入口只报告脱敏错误类型
        if isinstance(exc, ConfigCenterError):
            print(str(exc), file=sys.stderr)
        else:
            print(
                f"部署操作失败（{type(exc).__name__}），请在本机核对配置和日志，不上传凭据。",
                file=sys.stderr,
            )
        raise SystemExit(1) from None
