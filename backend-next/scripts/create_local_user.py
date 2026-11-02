import argparse
import getpass
import os
import sys
from pathlib import Path
from uuid import uuid4

from dotenv import dotenv_values
from sqlalchemy import select

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

from ask_metric.core.security import hash_password  # noqa: E402
from ask_metric.infrastructure.db.models import AppUser, OrgTerm  # noqa: E402
from ask_metric.infrastructure.db.session import get_app_session_factory  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or update a local Ask Metric user")
    parser.add_argument("--username", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--org-code", required=True)
    parser.add_argument("--role-code", choices=["USER", "SYSTEM_ADMIN"], default="USER")
    parser.add_argument("--config", type=Path, help="Load runtime environment from this file")
    parser.add_argument(
        "--password", help="Prefer interactive input; this may remain in shell history"
    )
    args = parser.parse_args()
    if args.config is not None:
        for name, value in dotenv_values(args.config.expanduser().resolve()).items():
            if value is not None:
                os.environ[name] = value
    password = args.password or getpass.getpass("Password: ")
    confirmation = password if args.password else getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise SystemExit("Passwords do not match")
    if len(password) < 8:
        raise SystemExit("Password must contain at least 8 characters")

    session = get_app_session_factory()()
    try:
        org = session.execute(
            select(OrgTerm).where(OrgTerm.org_code == args.org_code, OrgTerm.enabled.is_(True))
        ).scalar_one_or_none()
        if org is None:
            raise SystemExit(f"Enabled org_code does not exist: {args.org_code}")
        user = session.execute(
            select(AppUser).where(AppUser.username == args.username)
        ).scalar_one_or_none()
        action = "updated"
        if user is None:
            action = "created"
            user = AppUser(id=str(uuid4()), username=args.username, session_version=0)
            session.add(user)
        user.password_hash = hash_password(password)
        user.display_name = args.display_name
        user.org_code = args.org_code
        user.role_code = args.role_code
        user.enabled = True
        user.session_version += 1
        session.commit()
        print(
            f"User {action}: username={user.username}, id={user.id}, "
            f"org={org.org_name} ({org.org_code}), role={user.role_code}"
        )
    finally:
        session.close()


if __name__ == "__main__":
    main()
