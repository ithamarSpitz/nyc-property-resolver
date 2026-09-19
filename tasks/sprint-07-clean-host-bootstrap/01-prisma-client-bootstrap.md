---
id: S7-T1
stage: 1
model_class: worker
timeout_minutes: 30
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - package.json
context:
  - assignment
  - architecture.testing
  - architecture.operations
environment: null
verification:
  - node -e "const p=require('./package.json'); if (p.scripts.pretypecheck !== 'prisma generate') { console.error('pretypecheck must run prisma generate'); process.exit(1) }"
  - npm run typecheck
---

# Goal

Make a clean host checkout self-bootstrap the generated Prisma Client before TypeScript typechecking, without changing the Docker build flow.

The clean-machine walkthrough proved that a fresh host-side `npm ci` can leave `@prisma/client` without the schema-generated models/enums. The current stage/property-resolution verification starts with `npm run typecheck`, so it can fail before the later explicit `npx prisma generate` step runs.

# Proven failure

On the clean Windows checkout:

```text
npm ci
npm run typecheck
```

failed with missing Prisma exports such as `IngestionTriggerType`, `EcbViolation`, `Dataset`, `Prisma.sql`, and related generated types.

Running:

```text
npx prisma generate
npm run typecheck
```

then passed.

The Docker build is already correct because the Dockerfile copies `prisma/` before its explicit `RUN npx prisma generate`. Do not replace that behavior with an install hook that runs too early in the Dockerfile.

# Scope

Add the smallest host bootstrap fix in `package.json`:

```json
"pretypecheck": "prisma generate"
```

This relies on npm lifecycle ordering so every `npm run typecheck` first generates the Prisma Client from the checked-out schema.

# Out of scope

Do not:

- add `postinstall` or `prepare` Prisma generation;
- change the Dockerfile or Compose files;
- change Prisma schema or migrations;
- change application source code;
- change tests, evidence, README, or acceptance fixtures;
- upgrade dependencies or run `npm audit fix`;
- add unrelated package scripts.

# Invariants

- `npm run typecheck` remains the public typecheck command.
- Docker keeps its explicit `npx prisma generate` after `COPY prisma ./prisma`.
- A clean host install no longer requires a human to remember a separate Prisma generation command before typecheck.
- No dependency versions change.

# Acceptance criteria

1. `package.json` contains exactly the host bootstrap needed for typecheck: `pretypecheck: prisma generate`.
2. No `postinstall` or `prepare` hook is introduced.
3. `npm run typecheck` passes.
4. Only `package.json` changes.

# Verification

The frontmatter commands are authoritative. The stage barrier additionally performs a fresh `npm ci` before `npm run typecheck` to prove the clean-host path.
