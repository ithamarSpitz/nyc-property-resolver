#!/usr/bin/env bash
set -euo pipefail

git diff --check
# Add stable project-wide checks here after the project setup is finalized, e.g.:
# npm run typecheck
