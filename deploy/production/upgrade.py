"""Ask Metric 普通用户旁路升级。默认不执行 DDL，不停止旧服务。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
RELEASE = '20261120-nacos-final-r1'


class Stop(RuntimeError):
    pass


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    os.replace(temp, path)


def read_site(name):
    site = json.loads(Path(name).read_text(encoding='utf-8-sig'))
    for key in ('backend_port', 'agent_port'):
        if not isinstance(site[key], int) or not 1024 <= site[key] <= 65535:
            raise Stop('Invalid unprivileged port: ' + key)
    if site['backend_port'] == site['agent_port']:
        raise Stop('Backend and Agent ports must differ')
    home = Path(site['install_dir']).expanduser().resolve()
    if not home.is_relative_to(Path.home().resolve()) or home == Path.home().resolve():
        raise Stop('install_dir must be a child of the application user home')
    if home.is_symlink():
        raise Stop('install_dir must not be a symbolic link')
    site['install_dir'] = str(home)
    return site


def facts(site):
    paths = [Path.home() / 'ask-metric-config/backend.env', Path.home() / 'ws/.env',
             Path.home() / 'ws/backend/.env', Path.home() / 'ws/backend-next/.env']
    result = {'host': socket.gethostname(), 'machine': platform.machine(),
              'python': platform.python_version(), 'platform': platform.system(),
              'libc': platform.libc_ver(), 'effective_user': os.getuid() if hasattr(os, 'getuid') else 'windows',
              'config_candidates': [str(p) for p in paths if p.is_file()],
              'install_dir': site['install_dir'], 'ports': {}}
    result['disk_free_bytes'] = shutil.disk_usage(Path.home()).free
    result['known_start_files'] = []
    for p in (Path.home() / 'script/start.sh', Path.home() / 'ws/run.sh', Path.home() / 'ws/manifest.json'):
        if p.is_file():
            item = {'path': str(p), 'sha256': sha(p)}
            if p.name == 'manifest.json':
                try:
                    manifest = json.loads(p.read_text())
                    item['release'] = manifest.get('release')
                except (OSError, ValueError):
                    item['parse_status'] = 'UNREADABLE_OR_INVALID'
            result['known_start_files'].append(item)
    for key in ('backend_port', 'agent_port'):
        with socket.socket() as s:
            result['ports'][key] = {'port': site[key], 'listening_localhost': s.connect_ex(('127.0.0.1', site[key])) == 0}
    old = Path(site.get('old_env', '')).expanduser()
    if old.is_file():
        result['old_env_sha256'] = sha(old)
    return result


def verify_payload():
    file = ROOT / 'backend-payload.tgz'
    expected = (ROOT / 'backend-payload.tgz.sha256').read_text().split()[0]
    if sha(file) != expected:
        raise Stop('PAYLOAD_CHECKSUM_MISMATCH')
    return file


def extract_checked(archive, dest):
    dest = dest.resolve()
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        names = set()
        symlinks = set()
        for m in members:
            p = (dest / m.name).resolve()
            if not p.is_relative_to(dest) or m.name in names or not (m.isfile() or m.isdir() or m.issym() or m.islnk()):
                raise Stop('UNSAFE_ARCHIVE_ENTRY')
            names.add(m.name)
            if m.issym():
                symlinks.add(m.name.rstrip('/'))
            if m.issym() or m.islnk():
                link = (p.parent / m.linkname).resolve() if m.issym() else (dest / m.linkname).resolve()
                if not link.is_relative_to(dest):
                    raise Stop('UNSAFE_ARCHIVE_LINK')
        if any(any(name.startswith(link + '/') for link in symlinks) for name in names):
            raise Stop('ARCHIVE_WRITES_THROUGH_LINK')
        # 仅在校验过的独立目录中解压。3.12 data filter 再检查一次权限和链接。
        tar.extractall(dest, filter='data')
    checks = dest / 'checksums.sha256'
    for line in checks.read_text().splitlines():
        expected, name = line.split(None, 1)
        p = (dest / name.strip().lstrip('*')).resolve()
        if not p.is_relative_to(dest) or sha(p) != expected:
            raise Stop('INNER_CHECKSUM_MISMATCH')


def command(argv, cwd=None, env=None):
    # 子命令不回显完整配置、SQL、DSN 或错误对象，避免错误堆栈泄漏密码。
    result = subprocess.run(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    if result.returncode:
        raise Stop('LOCAL_COMMAND_FAILED:' + Path(argv[0]).name + ':' + str(result.returncode))
    return result.stdout.decode('utf-8', errors='replace')


def prepare(site):
    if sys.version_info[:2] != (3, 12) or platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise Stop('REQUIRES_LINUX_X86_64_PYTHON_3_12')
    if tuple(map(int, (platform.libc_ver()[1] or '0').split('.')[:2])) < (2, 28):
        raise Stop('NODE_REQUIRES_GLIBC_2_28_OR_NEWER')
    file = verify_payload()
    base = Path(site['install_dir'])
    marker = base / 'owner.json'
    if base.exists():
        if not marker.is_file() or json.loads(marker.read_text()).get('release') != RELEASE:
            raise Stop('EXISTING_INSTALL_DIRECTORY_NOT_OWNED')
    else:
        base.mkdir(parents=True, mode=0o700)
        save(marker, {'release': RELEASE, 'payload_sha256': sha(file)})
    if json.loads(marker.read_text()).get('payload_sha256') != sha(file):
        raise Stop('INSTALL_PAYLOAD_CHANGED')
    payload = base / 'payload'
    if not (base / 'extracted.json').exists():
        # 中断后可重新覆盖本工具独立创建的相同载荷；不触碰旧程序。
        payload.mkdir(exist_ok=True)
        extract_checked(file, payload)
        save(base / 'extracted.json', {'ok': True})
    venv = base / 'venv'
    if not (venv / 'bin/python').exists():
        command([sys.executable, '-m', 'venv', str(venv)])
    python = str(venv / 'bin/python')
    command([python, '-m', 'pip', 'install', '--no-index', '--no-cache-dir', '--find-links',
             str(payload / 'backend/wheels'), '-c', str(payload / 'ops/constraints.txt'), 'ask-metric-backend-next'])
    command([python, '-m', 'pip', 'check'])
    command([python, '-c', 'import _sqlite3,sqlalchemy,ask_metric.main'])
    node = payload / 'node-runtime/node/bin/node'
    version = command([str(node), '--version']).strip()
    for name in ('private', 'run', 'logs', 'diagnostics'):
        (base / name).mkdir(mode=0o700, exist_ok=True)
    template = ROOT / 'defaults/prompts.json'
    if not template.is_file() or sha(template) != (ROOT / 'defaults.sha256').read_text().split()[0]:
        raise Stop('MANAGEMENT_SETUP_TEMPLATE_MISSING_OR_CHECKSUM_MISMATCH')
    (base / 'defaults').mkdir(mode=0o700, exist_ok=True)
    shutil.copy2(template, base / 'defaults/prompts.json')
    save(base / 'prepared.json', {'release': RELEASE, 'node': version, 'python': platform.python_version()})
    return {'status': 'PREPARED', 'node': version, 'old_services_changed': False}


def env_values(path):
    # 本工具生成的 env 使用 JSON 字符串值；主入口不依赖尚未安装的 dotenv。
    result = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip() and not line.startswith('#'):
            k, v = line.split('=', 1)
            result[k] = json.loads(v)
    return result


def helper(site, action, extra):
    base = Path(site['install_dir'])
    if not (base / 'prepared.json').is_file():
        raise Stop('RUN_PREPARE_FIRST')
    args = [str(base / 'venv/bin/python'), str(ROOT / 'site_tasks.py'), action,
            '--site', str(Path(extra.site).resolve()), '--root', str(ROOT)]
    for name in ('username', 'org', 'role'):
        if getattr(extra, name, None):
            args += ['--' + name, getattr(extra, name)]
    if action == 'account':
        # 密码由子进程终端交互输入，不经过 argv/日志。
        code = subprocess.call(args)
        if code:
            raise Stop('ACCOUNT_ACTION_FAILED_NO_PASSWORD_LOGGED')
        return {'status': 'ACCOUNT_ACTION_FINISHED'}
    child = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    try:
        value = json.loads(child.stdout.decode('utf-8'))
    except (UnicodeError, ValueError):
        raise Stop('SITE_TASK_DID_NOT_RETURN_JSON:' + str(child.returncode)) from None
    summary = base / 'diagnostics/config-summary.json'
    if summary.is_file():
        value['configuration_summary'] = json.loads(summary.read_text(encoding='utf-8'))
    return value


def process_identity(pid):
    try:
        stat = Path('/proc') / str(pid) / 'stat'
        text = stat.read_text()
        start = text.rsplit(')', 1)[1].split()[19]
        return {'pid': pid, 'start': start, 'uid': stat.stat().st_uid,
                'exe': str((Path('/proc') / str(pid) / 'exe').resolve()),
                'cwd': str((Path('/proc') / str(pid) / 'cwd').resolve())}
    except (OSError, ValueError, IndexError):
        return None


def same_process(saved):
    now = process_identity(saved['pid'])
    return now == saved and now['uid'] == os.getuid() if now else False


def stop_owned(base, role):
    file = base / 'run' / (role + '.json')
    if not file.is_file():
        return 'NOT_MANAGED'
    saved = json.loads(file.read_text())
    if not same_process(saved):
        return 'NOT_RUNNING_OR_IDENTITY_CHANGED_NO_SIGNAL_SENT'
    os.kill(saved['pid'], signal.SIGTERM)
    for _ in range(100):
        if not same_process(saved):
            return 'STOPPED'
        time.sleep(.1)
    return 'STILL_STOPPING_NO_FORCE_KILL'


def http_check(port, path):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:' + str(port) + path, timeout=3) as r:
            return r.status
    except Exception:
        return None


def start(site):
    base = Path(site['install_dir'])
    check = base / 'validated.json'
    if not check.is_file():
        raise Stop('RUN_VALIDATE_AFTER_NACOS_IMPORT_FIRST')
    python = str(base / 'venv/bin/python')
    # site_tasks 再读取当前 Nacos 与数据库，不能拿过期预检凭证启动。
    out = command([python, str(ROOT / 'site_tasks.py'), 'validate', '--site', str(SITE_FILE), '--root', str(ROOT)])
    if json.loads(out).get('status') != 'VALIDATED':
        raise Stop('LIVE_CONFIGURATION_VALIDATION_FAILED')
    specs = [('backend', site['backend_port'], '/health', [python, '-m', 'uvicorn', 'ask_metric.main:app', '--host', '0.0.0.0', '--port', str(site['backend_port'])]),
             ('agent', site['agent_port'], '/health', [str(base / 'payload/node-runtime/node/bin/node'), str(base / 'payload/agent-service/dist/server.js')])]
    started = []
    try:
        for role, port, route, argv in specs:
            file = base / 'run' / (role + '.json')
            if file.exists() and same_process(json.loads(file.read_text())):
                if http_check(port, route) == 200:
                    continue
                raise Stop('MANAGED_PROCESS_UNHEALTHY:' + role)
            with socket.socket() as s:
                try:
                    s.bind(('0.0.0.0', port))
                except OSError:
                    raise Stop('PORT_OCCUPIED_NO_PROCESS_KILLED:' + role) from None
            env = os.environ.copy()
            # 清除旧 shell 中可能影响配置归属的业务变量，只继承系统环境。
            for k in list(env):
                if k.startswith(('NACOS_', 'AGENT_', 'MODEL_', 'APP_', 'SSO_', 'JWT_', 'SM2_', 'QUERY_', 'SIT_', 'BUSINESS_', 'ASK_METRIC_')):
                    env.pop(k, None)
            env.update(env_values(base / 'private' / (role + '.env')))
            env['PYTHONDONTWRITEBYTECODE'] = '1'
            env['ASK_METRIC_RUNTIME_CONFIG_DIR'] = str(base / 'defaults')
            logpath = base / 'logs' / (role + '.log')
            fd = os.open(logpath, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            cwd = base / 'payload/agent-service' if role == 'agent' else base / 'payload/backend/runtime'
            with os.fdopen(fd, 'ab') as stream:
                proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                        stdout=stream, stderr=stream, start_new_session=True)
            identity = None
            for _ in range(20):
                time.sleep(.05)
                identity = process_identity(proc.pid)
                if identity and identity['exe'] == str(Path(argv[0]).resolve()):
                    break
            if not identity:
                raise Stop('PROCESS_EXITED_DURING_START:' + role)
            save(file, identity)
            started.append(role)
            for _ in range(90):
                if proc.poll() is not None:
                    raise Stop('PROCESS_EXITED:' + role)
                if http_check(port, route) == 200:
                    break
                time.sleep(1)
            else:
                raise Stop('START_HEALTH_TIMEOUT:' + role)
    except Exception:
        for role in reversed(started):
            stop_owned(base, role)
        raise
    return {'status': 'SIDE_BY_SIDE_STARTED', 'old_services_changed': False,
            'gateway_switch_automatic': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'prepare', 'configure', 'validate', 'db-plan', 'db-check',
                                          'initialize', 'import-business', 'import-models', 'sync-preview', 'sync-apply',
                                          'account', 'start', 'check', 'stop', 'rollback', 'collect'])
    parser.add_argument('--site', default='site.json')
    parser.add_argument('--username')
    parser.add_argument('--org')
    parser.add_argument('--role', choices=['SYSTEM_ADMIN', 'USER'], default='SYSTEM_ADMIN')
    args = parser.parse_args()
    global SITE_FILE
    SITE_FILE = Path(args.site).resolve()
    report = {'release': RELEASE, 'action': args.action, 'time': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    try:
        if hasattr(os, 'geteuid') and os.geteuid() == 0:
            raise Stop('USE_APPLICATION_USER_NOT_ROOT')
        site = read_site(args.site)
        report['system'] = facts(site)
        if args.action in ('inspect', 'collect'):
            result = {'status': 'READ_ONLY_COLLECTION_OK'}
            summary = Path(site['install_dir']) / 'diagnostics/config-summary.json'
            if summary.is_file():
                result['configuration_summary'] = json.loads(summary.read_text(encoding='utf-8'))
        elif args.action == 'prepare':
            result = prepare(site)
        elif args.action == 'start':
            result = start(site)
        elif args.action in ('stop', 'rollback'):
            base = Path(site['install_dir'])
            result = {'status': 'NEW_SERVICES_STOP_REQUESTED', 'agent': stop_owned(base, 'agent'),
                      'backend': stop_owned(base, 'backend'), 'next': 'Restore the original gateway/static route through the approved operations process'}
        elif args.action == 'check':
            result = {'backend_http': http_check(site['backend_port'], '/health'),
                      'agent_http': http_check(site['agent_port'], '/health'),
                      'readiness_http': http_check(site['backend_port'], '/health/ready'),
                      'agent_readiness_http': http_check(site['agent_port'], '/health/ready')}
            healthy = all(v == 200 for v in result.values())
            managed = {}
            for role in ('backend', 'agent'):
                file = Path(site['install_dir']) / 'run' / (role + '.json')
                managed[role] = bool(file.is_file() and same_process(json.loads(file.read_text())))
            result['process_identity_matches'] = managed
            result['status'] = 'CHECK_OK' if healthy and all(managed.values()) else 'CHECK_FAILED'
        else:
            result = helper(site, args.action, args)
        report.update(result)
    except Exception as exc:
        report.update(status='FAILED', error_type=type(exc).__name__,
                      reason=str(exc) if isinstance(exc, Stop) else 'Unexpected local error; inspect paths, permissions and package checksum')
        if getattr(exc, 'errno', None) is not None:
            report['os_error_number'] = exc.errno
    folder = ROOT / 'reports'
    name = folder / (args.action + '-' + str(time.time_ns()) + '.json')
    save(name, report)
    save(folder / 'latest.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print('REPORT:', name)
    print('Share reports/*.json only. Do not share private/, .env, keys or service logs without redaction.')
    return 1 if report['status'] in ('FAILED', 'CHECK_FAILED', 'STRUCTURE_INCOMPLETE') else 0


if __name__ == '__main__':
    sys.exit(main())
