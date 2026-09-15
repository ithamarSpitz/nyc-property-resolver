---
id: S5-T1
stage: 1
model_class: hard_worker
timeout_minutes: 75
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - package.json
  - seed/acceptance-properties.json
  - seed/README.md
  - scripts/acceptance/small-acceptance.mjs
  - scripts/acceptance/validate-small-evidence.mjs
  - scripts/acceptance/lib/**
  - evidence/README.md
context:
  - assignment
  - architecture.testing
  - architecture.operations
  - architecture.implementation_map
environment: docker
verification:
  - npm run typecheck
  - docker compose config --quiet
  - npm run acceptance:small:check
---

# Goal

Create the reproducible small real-data acceptance path and the exact 5–8-property seed required by the take-home, without yet claiming that a live acceptance run passed.

# Required context

Read only the context aliases listed in frontmatter plus `AGENTS.md` and the integrated S0–S4 runtime contracts.

# Scope

Create a checked-in real-property seed file and cross-platform acceptance tooling that an evaluator or later S5 task can run without hand-editing source code.

The seed must contain 5–8 real NYC properties and explicitly label which requirement each entry covers. It must include:

- `350 5th Avenue, Manhattan` / Empire State Building as the shared reference case;
- one Queens address whose real house number uses the hyphenated `37-15` form and preserves that form in the seed;
- one real condominium **unit** input, not only a condo building address;
- one real small 2–3 family property;
- at least one real property selected because it has an unpaid DOB ECB balance at acceptance-preparation time.

For every seed entry, retain enough provenance to audit why it was selected (human-readable label, original input, input type, requirement tags, and public-source note/URL where appropriate). Do not hard-code resolved BBL/BIN values as implementation truth when the resolver is supposed to discover them; expected identifiers may be kept only as acceptance notes when independently verified.

Add a `small-acceptance` script that can, against the running Compose service:

1. verify the explicit ECB source-key contract probe is available before production-style ingestion;
2. resolve/register the small seed through the public property API or supported bulk path;
3. save exact request/response evidence and property IDs/BBLs/BINs;
4. trigger the manual ECB ingestion through the worker's documented CLI path;
5. query the property ECB endpoints from the local store and save coverage/freshness/results;
6. capture a duplicate/idempotency audit before and after a second immediate ingestion run;
7. save baseline and second-run console logs separately;
8. emit a machine-readable summary containing timestamps, run IDs, source watermarks, row/count deltas, and the commands actually used.

The script must support a non-network `--check`/dry validation mode used by task verification. It must **not** silently manufacture BIS verification; BIS is a separate evidence step in S5-T2.

Add a strict evidence validator for S5-T2. It should reject missing/empty logs, missing seed coverage, absent baseline/second run IDs, absent source-contract evidence, absent API snapshots, absent duplicate audit, or fewer than two BIS spot-check records.

# Out of scope

Do not:

- claim that the small live acceptance run has passed;
- write README.md or DESIGN.md submission prose;
- run the 10,000-property benchmark;
- change resolver/ingestion/API behavior to make a chosen fixture pass;
- scrape BIS and pre-fill spot-check conclusions in this task;
- commit secrets, `.env`, or a Socrata app token.

If a candidate seed exposes a real earlier implementation defect, preserve the evidence and fail/plan-repair the owning earlier task rather than selecting a different fixture merely to hide the defect.

# Invariants

- The assignment's required fixture categories are explicit and mechanically checkable.
- The acceptance runner uses the same public API and manual worker command documented for evaluators; it does not call internal service methods directly.
- Query evidence after ingestion comes from the local API/store, never by substituting a direct Socrata response.
- Secrets are provided only through runtime environment/config.
- `--check` performs no real NYC network activity.

# Acceptance criteria

1. `seed/acceptance-properties.json` contains 5–8 auditable real-property inputs covering every assignment category exactly enough for the later live walkthrough.
2. The Queens fixture retains the real hyphenated house number and the condo fixture contains a unit designator.
3. `npm run acceptance:small:check` validates the seed/tooling without external NYC calls.
4. A live invocation has a documented evidence directory contract and captures baseline plus second-run data without overwriting the first run.
5. The evidence validator can mechanically distinguish complete evidence from a partial/fabricated-by-omission directory structure.
6. No production behavior or architecture is changed in this task.

# Verification

The Harness only executes the non-network check here. The actual real NYC run is deliberately S5-T2 so ordinary implementation retries do not repeatedly hit external sources.
