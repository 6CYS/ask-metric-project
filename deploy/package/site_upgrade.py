"""Non-root r9 upgrade operations for the confirmed appuser / nohup installation."""
from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = Path('/home/appuser')
OLD_CONFIG = SITE / 'ask-metric-config/backend.env'
CONFIG = SITE / 'ask-metric-config/backend-r9.env'
KEY = SITE / 'ask-metric-config/config-sm4-r9.key'
STATE = SITE / 'ask-metric-state'
VENV = SITE / 'ask-metric-venv-r9'
LOGS = SITE / 'ask-metric-logs'
SENSITIVE = {
    'APP_DATABASE_URL', 'QUERY_DATABASE_URL', 'METRIC_CATALOG_DATABASE_URL',
    'ORG_CATALOG_DATABASE_URL', 'NACOS_PASSWORD', 'CONTINUATION_TOKEN_SECRET',
    'JWT_SECRET', 'SM2_PRIVATE_KEY', 'MODEL_ADMIN_TOKEN', 'TRUSTED_PROXY_TOKEN',
    'MODEL_CHAT_API_KEY', 'MODEL_EMBEDDING_API_KEY', 'MODEL_RERANK_API_KEY',
}


def values(path):
    from dotenv import dotenv_values
    return {k: v for k, v in dotenv_values(path, interpolate=False).items() if v is not None}


def environment(config):
    from ask_metric.core.config import Settings
    env = os.environ.copy()
    for name in set(k.upper() for k in Settings.model_fields) | set(config) | {
        'ASK_METRIC_CONFIG_SM4_KEY', 'ASK_METRIC_CONFIG_SM4_KEY_FILE', 'PYTHONPATH',
    }:
        env.pop(name, None)
    env.update(config)
    return env


def prepare():
    from dotenv import set_key

    if CONFIG.exists():
        raise SystemExit('目标引导配置已存在，不覆盖。')
    source = values(OLD_CONFIG)
    if source.get('NACOS_CONFIG_ENABLED', '').lower() not in {'true', '1', 'yes'}:
        raise SystemExit('先按 Nacos 配置迁移文档完成导出、加密和发布，再执行升级。')
    if not source.get('ASK_METRIC_CONFIG_SM4_KEY_FILE'):
        raise SystemExit('升级必须复用原 SM4 主密钥文件引用。')
    os.umask(0o077)
    CONFIG.touch(mode=0o600, exist_ok=False)
    for name, value in source.items():
        set_key(CONFIG, name, value, quote_mode='always')
    print(f'已复用原密文、主密钥引用和节点参数：{CONFIG}')


def check():
    from check_models import validate_models

    if Path(sys.prefix).resolve() != VENV.resolve():
        raise SystemExit('Use /home/appuser/ask-metric-venv-r9/bin/python -I to run this command.')
    config = values(CONFIG)
    env = environment(config)
    os.environ.clear()
    os.environ.update(env)
    validate_models(CONFIG)
    from ask_metric.core.config import get_settings
    from ask_metric.core.gm_crypto import load_sm2_keypair

    load_sm2_keypair(get_settings().sm2_private_key, allow_ephemeral=False)
    print('配置、模型协议及 SM4/SM2 检查通过；未写数据库。')


def model_check():
    from check_models import check_live, validate_models

    check()
    check_live(*validate_models(CONFIG))


def processes():
    result = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            args = path.joinpath('cmdline').read_bytes().split(b'\0')
            if (b'uvicorn' in args and b'ask_metric.main:app' in args
                    and b'--port' in args and args[args.index(b'--port') + 1] == b'8010'):
                result.append(int(path.name))
        except (OSError, IndexError):
            continue
    return result


def stop():
    targets = processes()
    if len(targets) != 1:
        raise SystemExit(
            f'Expected one owned backend on 8010; found {len(targets)}. No signal sent.'
        )
    pid = targets[0]
    os.kill(pid, signal.SIGTERM)
    for _ in range(45):
        if pid not in processes():
            print('Backend stopped. Gateway untouched.')
            return
        time.sleep(1)
    raise SystemExit('Backend still stopping. Do not start another instance; inspect the log.')


def start():
    check()
    if processes():
        raise SystemExit('Backend already running. Stop it before starting r9.')
    with socket.socket() as probe:
        # Match the server's reusable bind: closed TCP connections in TIME_WAIT
        # must not block an immediate graceful restart. Active listeners still fail.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('0.0.0.0', 8010))
    os.umask(0o077)
    LOGS.mkdir(exist_ok=True)
    with (LOGS / 'backend-r9.log').open('ab') as log:
        child = subprocess.Popen(
            [str(VENV / 'bin/python'), '-I', '-m', 'uvicorn', 'ask_metric.main:app',
             '--env-file', str(CONFIG), '--host', '0.0.0.0', '--port', '8010'],
            cwd=ROOT / 'backend/runtime', env=environment(values(CONFIG)),
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    (LOGS / 'backend-r9.pid').write_text(str(child.pid) + '\n', encoding='ascii')
    print(f'Start requested: PID {child.pid}. Verify curl /health and /health/ready.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=[
        'prepare', 'check', 'model-check', 'stop', 'start', 'status',
    ])
    command = parser.parse_args().command
    try:
        if command == 'status':
            print('Backend PIDs:', processes())
        else:
            globals()[command.replace('-', '_')]()
    except Exception as error:
        # Exception repr may contain configuration values; display field names only.
        if type(error).__name__ == 'ValidationError' and hasattr(error, 'errors'):
            print('Invalid config fields:', ', '.join(
                '.'.join(str(p) for p in e['loc']) or '(cross-field validation)'
                for e in error.errors(include_input=False, include_context=False)
            ), file=sys.stderr)
        raise SystemExit('Operation failed (' + type(error).__name__ + '). '
                         'Check config/paths/permissions locally; do not share secrets.') from None


if __name__ == '__main__':
    main()
