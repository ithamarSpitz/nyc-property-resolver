---
id: S6-T2
stage: 2
model_class: worker
timeout_minutes: 40
review: true
allow_protected: false
depends_on:
  - S6-T1
allowed_paths:
  - README.md
context:
  - assignment
  - architecture.operations
  - architecture.testing
environment: null
verification:
  - >-
    node -e "const fs=require('fs'); const s=fs.readFileSync('README.md','utf8'); for (const x of ['Linux / macOS','Windows PowerShell','Invoke-RestMethod','docker compose up --build','docker compose run --rm worker npm run ingest:ecb','npm run acceptance:small']) if (!s.includes(x)) { console.error('README missing: '+x); process.exit(1) }"
---

# Goal

Make the README command examples unambiguous and copy/pasteable for both POSIX shells and Windows PowerShell.

The clean-machine walkthrough exposed that the existing `bash` examples are valid POSIX-shell examples, but a Windows PowerShell user can easily assume they are directly copy/pasteable there. In particular, PowerShell 5.1 can mangle JSON passed to `curl.exe`, causing valid API examples to fail with `INVALID_JSON`.

This task is documentation-only.

# Proven walkthrough findings

The following application commands were exercised successfully during the clean-machine walkthrough:

```text
docker compose up --build
docker compose run --rm worker npm run ingest:ecb
POST /properties
GET /properties/<property-id>
GET /properties/<property-id>/ecb-violations
POST /properties/bulk
GET /ecb-violations
```

For JSON POST bodies, the reliable Windows PowerShell form is `Invoke-RestMethod`, not POSIX-style single-quoted `curl` JSON.

The README already contains POSIX `curl` examples and partial PowerShell equivalents. The remaining problem is presentation: readers must not have to infer which shell a command targets.

# Scope

Restructure the README command examples so shell targeting is explicit.

1. Clearly label the POSIX examples as:
   - Linux / macOS
   - shell: Bash/zsh (or equivalent POSIX shell)

2. Clearly label Windows examples as:
   - Windows PowerShell

3. Preserve the existing POSIX/Bash commands. Do not replace them with PowerShell-only documentation.

4. For every API example where syntax differs or ambiguity is likely, provide a Windows PowerShell equivalent immediately adjacent to the POSIX example.

5. For JSON POST examples, use `Invoke-RestMethod` with `-ContentType "application/json"` and a valid JSON body.

6. For GET examples, use an explicitly Windows-safe form such as `curl.exe` or `Invoke-RestMethod`; do not rely on the historical PowerShell `curl` alias.

7. Keep truly cross-platform commands identified as such where useful, including:
   - `docker compose up --build`
   - `docker compose run --rm worker npm run ingest:ecb`
   - `npm run acceptance:small`

8. Keep placeholders such as `<property-id>` and `<cursor>` obvious and preserve the logical walkthrough order.

# Required command coverage

The README must leave no shell ambiguity for these examples:

- clean Docker startup;
- one manual ECB ingestion run;
- POST one property;
- GET one stored property;
- GET property ECB violations;
- POST bulk BBL registration;
- GET global ECB violations;
- optional `npm run acceptance:small`.

# Out of scope

Do not:

- change application source code;
- change tests or acceptance tooling;
- change seed fixtures or evidence;
- alter API behavior or sample semantics;
- remove Linux/macOS examples;
- claim that PowerShell syntax is Bash-compatible or vice versa;
- add unrelated documentation cleanup.

# Invariants

- The README remains useful on Linux/macOS and Windows.
- A reader never has to guess which shell a fenced command targets.
- JSON examples remain syntactically valid JSON.
- Existing endpoint paths, request bodies, and documented behavior remain unchanged unless a command was previously shell-invalid.
- The documentation must not hide or work around application failures; S6-T1 owns the resolver repair.

# Acceptance criteria

1. Linux/macOS/POSIX commands are explicitly labeled.
2. Windows PowerShell commands are explicitly labeled.
3. All API examples have an unambiguous command path for Windows PowerShell.
4. JSON POST examples use a PowerShell-safe invocation.
5. Cross-platform Docker/Node commands are not needlessly duplicated or mis-labeled.
6. README-only diff; no source/test/evidence changes.
7. The verification command passes.

# Verification

The YAML verification command is authoritative. Reviewer inspection must also verify that the resulting README can be followed without inferring shell semantics.
