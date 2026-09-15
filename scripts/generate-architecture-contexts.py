#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "ARCHITECTURE.md"
OUT = ROOT / "docs" / "architecture"
HEADER = (
    "<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->\n"
    "<!-- Do not edit independently; regenerate from the final architecture if it changes. -->\n\n"
)

MODULES: dict[str, tuple[int, ...]] = {
    "foundations.md": (1, 2, 3, 4),
    "resolver.md": (5,),
    "ingestion-strategy.md": (6,),
    "ingestion-lifecycle.md": (7, 8),
    "storage.md": (9, 10, 11, 12),
    "data-access-validation.md": (13, 14, 15, 16),
    "operations.md": (17, 20, 21, 22, 25),
    "api.md": (18, 19),
    "testing.md": (23, 24),
    "implementation-map.md": (26, 27, 28),
}

SECTION_RE = re.compile(r"(?m)^## (\d+)\.\s")


def parse_sections(text: str) -> dict[int, str]:
    matches = list(SECTION_RE.finditer(text))
    result: dict[int, str] = {}
    for idx, match in enumerate(matches):
        number = int(match.group(1))
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        result[number] = text[start:end].rstrip() + "\n"
    return result


def rendered_modules() -> dict[str, str]:
    sections = parse_sections(SOURCE.read_text(encoding="utf-8"))
    missing = sorted({n for nums in MODULES.values() for n in nums} - sections.keys())
    if missing:
        raise SystemExit(f"ARCHITECTURE.md is missing numbered sections: {missing}")
    rendered: dict[str, str] = {}
    for name, numbers in MODULES.items():
        body = "\n".join(sections[n].rstrip() for n in numbers).rstrip() + "\n"
        rendered[name] = HEADER + body
    return rendered


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate exact architecture context modules")
    parser.add_argument("--check", action="store_true", help="fail if generated modules are stale")
    args = parser.parse_args()

    expected = rendered_modules()
    stale: list[str] = []
    for name, content in expected.items():
        path = OUT / name
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    if args.check:
        if stale:
            print("Stale architecture context modules:")
            for path in stale:
                print(f"  - {path}")
            print("Run: python scripts/generate-architecture-contexts.py")
            return 1
        print(f"Architecture context modules are current ({len(expected)} files).")
    else:
        print(f"Generated {len(expected)} architecture context modules from ARCHITECTURE.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
