"""Add newly shipped prompt definitions without overwriting administrator edits."""

import argparse
import json
from pathlib import Path


def merge_prompt_defaults(current_path: Path, defaults_path: Path) -> list[str]:
    current = json.loads(current_path.read_text(encoding="utf-8"))
    defaults = json.loads(defaults_path.read_text(encoding="utf-8"))
    current_prompts = current.setdefault("prompts", {})
    added: list[str] = []
    for name, definition in defaults.get("prompts", {}).items():
        if name in current_prompts:
            continue
        current_prompts[name] = definition
        added.append(name)
    if added:
        temporary = current_path.with_suffix(current_path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(current, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(current_path)
    return added


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("current", type=Path)
    parser.add_argument("defaults", type=Path)
    args = parser.parse_args()
    added = merge_prompt_defaults(args.current, args.defaults)
    if added:
        print(f"Added runtime prompt defaults: {', '.join(added)}")


if __name__ == "__main__":
    main()
