import argparse
import sys
from pathlib import Path

from sqlalchemy import or_, select, update

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

from ask_metric.infrastructure.db.models import AppUser, ChatConversation  # noqa: E402
from ask_metric.infrastructure.db.session import get_app_session_factory  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Assign historical conversations to one user")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--username")
    target.add_argument("--user-id")
    parser.add_argument("--apply", action="store_true", help="Apply changes; default is dry-run")
    args = parser.parse_args()
    session = get_app_session_factory()()
    try:
        user = session.execute(
            select(AppUser).where(
                or_(AppUser.username == args.username, AppUser.id == args.user_id)
            )
        ).scalar_one_or_none()
        if user is None:
            raise SystemExit("Target user was not found")
        count = session.execute(
            select(ChatConversation.id).where(ChatConversation.owner_user_id.is_(None))
        ).all()
        if not args.apply:
            print(f"Dry run: {len(count)} conversations would be assigned to {user.username}")
            return
        result = session.execute(
            update(ChatConversation)
            .where(ChatConversation.owner_user_id.is_(None))
            .values(owner_user_id=user.id)
        )
        session.commit()
        print(f"Assigned {result.rowcount} conversations to {user.username} ({user.id})")
    finally:
        session.close()


if __name__ == "__main__":
    main()
