from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from dotenv import dotenv_values

BACKEND_ROOT = Path(__file__).resolve().parents[1]
UNSAFE_VALUE = re.compile(r"<[^>]+>|@[A-Z_]+@|development-only-change-me")
APPLY_CONFIRMATION = "APP_DATABASE_SCHEMA_APPROVED"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate or explicitly apply the GoldenDB APP schema migration"
    )
    parser.add_argument("--config", type=Path, required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--sql", type=Path, help="Write SQL for DBA review without connecting")
    modes.add_argument("--apply", action="store_true", help="Apply the reviewed migration")
    parser.add_argument(
        "--from-revision",
        help="Offline SQL start revision, for example 0002 for an existing r3 database",
    )
    parser.add_argument("--confirm", help=f"Required with --apply: {APPLY_CONFIRMATION}")
    return parser.parse_args()


def load_environment(path: Path) -> None:
    if not path.is_file():
        raise RuntimeError(f"Configuration file not found: {path}")
    text = path.read_text(encoding="utf-8")
    if UNSAFE_VALUE.search(text):
        raise RuntimeError(f"Unresolved placeholders or development secrets remain in {path}")
    for name, value in dotenv_values(path).items():
        if value is not None:
            os.environ[name] = value
    os.environ["BACKEND_NEXT_ALLOW_SCHEMA_CHANGES"] = "true"
    os.environ["BACKEND_NEXT_ALLOW_NON_TEST_DATABASE"] = "true"


def make_config(output_buffer=None) -> Config:
    config = Config(str(BACKEND_ROOT / "alembic-goldendb.ini"), output_buffer=output_buffer)
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic_goldendb"))
    return config


def main() -> int:
    args = parse_args()
    config_file = args.config.expanduser().resolve()
    load_environment(config_file)
    old_argv = sys.argv[:]
    sys.argv = ["alembic", "upgrade", "head"]
    try:
        if args.apply:
            if args.confirm != APPLY_CONFIRMATION:
                raise RuntimeError(
                    "Database write refused. Apply only after DBA review and backup, using "
                    f"--confirm {APPLY_CONFIRMATION}"
                )
            command.upgrade(make_config(), "head")
            print("GoldenDB APP schema migration completed")
            return 0

        output = args.sql.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("w", encoding="utf-8", newline="\n") as stream:
            target = f"{args.from_revision}:head" if args.from_revision else "head"
            command.upgrade(make_config(stream), target, sql=True)
        output.chmod(0o600)
        print(f"Offline migration SQL written for DBA review: {output}")
        return 0
    finally:
        sys.argv = old_argv


if __name__ == "__main__":
    raise SystemExit(main())
