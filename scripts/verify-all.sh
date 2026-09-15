#!/usr/bin/env bash
set -euo pipefail

git diff --check
# Populate after the application foundation exists. Typical final checks:
# npm ci
# npx prisma validate
# npm run typecheck
# npm test
# docker compose build
# docker compose up -d
# smoke tests
