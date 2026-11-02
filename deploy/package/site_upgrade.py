"""Non-root r9 upgrade operations for the confirmed appuser / nohup installation."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
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
RUNTIME = STATE / 'runtime-config-r9'
VENV = SITE / 'ask-metric-venv-r9'
LOGS = SITE / 'ask-metric-logs'
SENSITIVE = {
    'APP_DATABASE_URL', 'QUERY_DATABASE_URL', 'METRIC_CATALOG_DATABASE_URL',
    'ORG_CATALOG_DATABASE_URL', 'NACOS_PASSWORD',
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
    from ask_metric.core.config_crypto import (
        decrypt_config_value, encrypt_config_value, is_encrypted_config_value, load_config_sm4_key,
    )
    from ask_metric.core.gm_crypto import generate_sm2_keypair

    if CONFIG.exists() or KEY.exists() or RUNTIME.exists():
        raise SystemExit('r9 configuration already exists: do not overwrite; use check or edit it.')
    if not OLD_CONFIG.is_file():
        raise SystemExit('Original backend.env missing. See fresh-install instructions.')
    source = values(OLD_CONFIG)
    config = source.copy()
    # Decrypt using ONLY the explicitly recorded old key, never inherited shell secrets.
    encrypted = [k for k in SENSITIVE if is_encrypted_config_value(config.get(k))]
    if encrypted:
        old_key = load_config_sm4_key(environ=source)
        for name in encrypted:
            config[name] = decrypt_config_value(config[name], old_key)
    for name in SENSITIVE:
        value = config.get(name, '')
        if '${' in value or (value.startswith('<') and value.endswith('>')):
            raise SystemExit(f'{name}: resolve the placeholder in the original config first.')
    # Preserve configured session secrets; generate only missing private application keys.
    for name in ('JWT_SECRET',):
        if not config.get(name) or config[name].startswith('development-only'):
            config[name] = secrets.token_urlsafe(48)
    if not config.get('SM2_PRIVATE_KEY'):
        config['SM2_PRIVATE_KEY'] = generate_sm2_keypair().private_key
    model_source = Path(source.get('MODEL_CONFIG_PATH') or STATE / 'runtime-config/model-config.json')
    prompt_source = Path(source.get('PROMPT_CONFIG_PATH') or STATE / 'runtime-config/prompts.json')
    if not model_source.is_file() or not prompt_source.is_file():
        raise SystemExit('Existing model/prompts file missing: set absolute paths in backend.env first.')
    if not model_source.is_absolute() or not prompt_source.is_absolute():
        raise SystemExit('MODEL_CONFIG_PATH and PROMPT_CONFIG_PATH must be absolute before prepare.')
    # Only copy known runtime configuration; do not copy backups or unrelated data.
    model = json.loads(model_source.read_text(encoding='utf-8'))
    if 'siliconflow' in json.dumps(model).lower():
        raise SystemExit('Existing model config references SiliconFlow. Configure bank models first.')
    key = secrets.token_bytes(16)
    os.umask(0o077)
    backup = SITE / ('ask-metric-backup-r9-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700)
    shutil.copy2(OLD_CONFIG, backup / 'backend.env')
    (backup / 'backend.env').chmod(0o600)
    startup = SITE / 'ask-metric-startup.sh'
    if startup.exists():
        shutil.copy2(startup, backup / startup.name)
    RUNTIME.mkdir(mode=0o700)
    shutil.copy2(model_source, RUNTIME / 'model-config.json')
    shutil.copy2(prompt_source, RUNTIME / 'prompts.json')
    (RUNTIME / 'model-config.json').chmod(0o600)
    (RUNTIME / 'prompts.json').chmod(0o600)
    runtime = ROOT / 'backend/runtime'
    subprocess.run([
        sys.executable, '-I', str(runtime / 'scripts/merge_runtime_prompt_defaults.py'),
        str(RUNTIME / 'prompts.json'), str(runtime / 'config/prompts.json'),
    ], check=True)
    config.update({
        'APP_ENV': 'production', 'HOST': '0.0.0.0', 'PORT': '8010',
        'ASK_METRIC_CONFIG_SM4_KEY_FILE': str(KEY),
        'MODEL_CONFIG_PATH': str(RUNTIME / 'model-config.json'),
        'MODEL_SECRET_ENV_PATH': str(CONFIG),
        'PROMPT_CONFIG_PATH': str(RUNTIME / 'prompts.json'),
        'SEMANTIC_CONFIG_PATH': str(runtime / 'config/semantic-config.json'),
        'BACKEND_NEXT_ALLOW_SCHEMA_CHANGES': 'false',
        'LOG_FILE_ENABLED': 'true',
    })
    config.setdefault('LOG_DIRECTORY', str(SITE / 'log'))
    config.pop('ASK_METRIC_CONFIG_SM4_KEY', None)
    for name in SENSITIVE:
        if config.get(name):
            config[name] = encrypt_config_value(config[name], key)
    with KEY.open('x', encoding='ascii') as stream:
        stream.write(key.hex() + '\n')
    from dotenv import set_key
    CONFIG.touch(mode=0o600, exist_ok=False)
    for name, value in config.items():
        set_key(CONFIG, name, value, quote_mode='always')
    print(f'Prepared: {CONFIG}\nBackup: {backup}\nOriginal config and venv unchanged.')


def check():
    if Path(sys.prefix).resolve() != VENV.resolve():
        raise SystemExit('Use /home/appuser/ask-metric-venv-r9/bin/python -I to run this command.')
    config = values(CONFIG)
    env = environment(config)
    os.environ.clear()
    os.environ.update(env)
    from ask_metric.core.config import Settings
    from ask_metric.core.gm_crypto import load_sm2_keypair
    settings = Settings(_env_file=None)
    load_sm2_keypair(settings.sm2_private_key, allow_ephemeral=False)
    for name in ('APP_DATABASE_URL', 'QUERY_DATABASE_URL'):
        if not config.get(name, '').startswith('ENC[SM4:v1:'):
            raise SystemExit(f'{name} must be configured and encrypted.')
    for name in ('MODEL_CONFIG_PATH', 'PROMPT_CONFIG_PATH', 'SEMANTIC_CONFIG_PATH'):
        json.loads(Path(config[name]).read_text(encoding='utf-8'))
    model = json.loads(Path(config['MODEL_CONFIG_PATH']).read_text(encoding='utf-8'))
    from ask_metric.infrastructure.model.configuration import ModelConfigRepository
    ModelConfigRepository(Path(config['MODEL_CONFIG_PATH'])).load()
    for role, endpoint in model.get('models', {}).items():
        if not endpoint.get('enabled', True):
            continue
        url = config.get(endpoint.get('base_url_env', ''), '') or endpoint.get('base_url', '')
        if not url.startswith(('http://', 'https://')) or 'siliconflow' in url.lower() or '<' in url:
            raise SystemExit(f'{role}: configure the bank model endpoint.')
    import ask_metric
    print(f'Config and SM4/SM2: OK\nLoaded: {ask_metric.__file__}\nNo database writes performed.')


def model_check():
    import runpy
    check()
    runpy.run_path(str(ROOT / 'backend/runtime/scripts/verify_model_provider.py'),
                   run_name='__main__')


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
        raise SystemExit(f'Expected one owned backend on 8010; found {len(targets)}. No signal sent.')
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
