#!/usr/bin/env sh
set -eu
python -m compileall -q harness harness.py tests/harness
if command -v ruff >/dev/null 2>&1; then
  ruff check harness harness.py tests/harness
else
  echo "SKIP  ruff not installed (install requirements-harness-dev.txt for local lint)"
fi
if python -c 'import mypy' >/dev/null 2>&1; then
  python -m mypy harness harness.py
else
  echo "SKIP  mypy not installed (install requirements-harness-dev.txt for local type-check)"
fi
python scripts/generate-architecture-contexts.py --check
python scripts/check-project-blueprint.py
python harness.py validate
python -m pytest -q tests/harness
