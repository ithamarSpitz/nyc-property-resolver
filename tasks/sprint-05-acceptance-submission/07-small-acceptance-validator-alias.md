---
id: S5-T7
stage: 2
model_class: worker
timeout_minutes: 30
review: true
allow_protected: false
depends_on:
  - S5-T1
allowed_paths:
  - package.json
context:
  - assignment
  - architecture.testing
  - architecture.implementation_map
environment: docker
verification:
  - node -e "const p=require('./package.json'); if (p.scripts['acceptance:small:validate-evidence'] !== 'node scripts/acceptance/validate-small-evidence.mjs') process.exit(1)"
  - npm run acceptance:small:check
---

# Goal

Close the S5-T1 / S5-T2 command-contract mismatch for the small acceptance
evidence validator.

# Proven failure

S5-T1 exposed `acceptance:small:validate`, while S5-T2 and the roadmap require
`acceptance:small:validate-evidence`.

# Scope

Add this npm-script alias:

```json
"acceptance:small:validate-evidence": "node scripts/acceptance/validate-small-evidence.mjs"
```

Preserve the existing `acceptance:small:validate` alias. Do not alter the
validator implementation.

# Acceptance criteria

1. Both aliases invoke the same validator implementation.
2. `acceptance:small:check` remains green.
3. The validator still requires an explicit evidence-directory argument.
4. No validator behavior changes.
