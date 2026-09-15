#!/usr/bin/env bash
set -euo pipefail

git diff --check
# Later: npm run typecheck && npm test
