import contextlib, os, runpy, socket, sys
from pathlib import Path
out = Path("/private/tmp/harness-typo-recovery-20261014")
for key in ("APP_DATABASE_URL", "QUERY_DATABASE_URL", "METRIC_CATALOG_DATABASE_URL", "ORG_CATALOG_DATABASE_URL"):
    os.environ[key] = "sqlite:////private/tmp/harness-typo-recovery-20261014/offline-unused.db"
os.environ.update(APP_ENV="test", NACOS_ENABLED="false", SSO_ENABLED="false", LOG_FILE_ENABLED="false", LOG_CONSOLE_ENABLED="false", PYTHONDONTWRITEBYTECODE="1")
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path.cwd() / "src"))
from ask_metric.core.config import Settings, get_settings
Settings.model_config["env_file"] = None
get_settings.cache_clear()
original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex
def offline_connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6): raise AssertionError("OFFLINE_TEST_NETWORK_BLOCKED")
    return original_connect(self, address)
def offline_connect_ex(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6): raise AssertionError("OFFLINE_TEST_NETWORK_BLOCKED")
    return original_connect_ex(self, address)
socket.socket.connect, socket.socket.connect_ex = offline_connect, offline_connect_ex
code = 1
with (out / "backend-tests.log").open("w", encoding="utf-8") as stream, contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
    print("Offline isolation: dotenv disabled; APP_ENV=test; Nacos/SSO disabled; SQLite URLs in this disposable output directory; INET connect blocked.")
    print('Equivalent command: .venv/bin/python -m pytest tests verification -q -m "not database" -p no:cacheprovider')
    sys.argv = ["pytest", "tests", "verification", "-q", "-m", "not database", "-p", "no:cacheprovider"]
    try: runpy.run_module("pytest", run_name="__main__", alter_sys=True)
    except SystemExit as error: code = error.code if isinstance(error.code, int) else 1
    finally: print(f"OFFLINE_VALIDATION_EXIT_CODE={code}")
print(f"backend test exit_code={code}")
raise SystemExit(code)
