from __future__ import annotations

from pathlib import Path


def update_env_file(path: Path, updates: dict[str, str]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    seen: set[str] = set()
    next_lines: list[str] = []
    for line in lines:
        key = _parse_key(line)
        if key is None or key not in updates:
            next_lines.append(line)
            continue
        next_lines.append(f"{key}={_format_value(updates[key])}")
        seen.add(key)
    for key, value in updates.items():
        if key not in seen:
            next_lines.append(f"{key}={_format_value(value)}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text("\n".join(next_lines).rstrip() + "\n", encoding="utf-8")
    temporary_path.replace(path)


def _parse_key(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key = stripped.split("=", 1)[0].strip()
    return key or None


def _format_value(value: str) -> str:
    if not value:
        return ""
    if any(character.isspace() or character in {'"', "'", "#", "="} for character in value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value
