# Architecture Invariant Router

This file is a compact routing/checklist aid for agents. It is **not** an independent specification. `/ARCHITECTURE.md` remains authoritative, and the exact generated section modules under `docs/architecture/` should be loaded for implementation work.

## Property identity

- Resolve once; persist canonical property identifiers; recurring ECB scans use stored identifiers.
- BBL is canonical parcel identity; BIN is the preferred DOB/ECB join key; one property may have multiple valid BINs.
- Placeholder BINs ending in `000000` are not scan targets.
- Effective BIN-set mutation goes through one transactional boundary: mutate `property_bins`, increment `identifier_version` exactly once when the effective set changes, and invalidate current ECB coverage atomically.
- Alias-only additions and identical re-resolution do not increment `identifier_version` or invalidate coverage.
- Condo-unit resolution uses the explicit unit -> condo base -> billing/building flow and must not silently guess ambiguous unit mappings.
- Non-condo footprint candidates are cross-checked against canonical parcel identifiers; source contradictions fail explicitly.

Load: `architecture.resolver`, `architecture.storage`.

## Ingestion execution

- Watchlist pull is the implemented ECB strategy; batches are built from deduplicated valid BINs.
- A new run creates a durable `QUEUED` record, then atomically snapshots Property<->BIN associations and immutable batch definitions before fetching the start source watermark.
- `source_watermark_at_start` transitions only once from `NULL` to the observed value and is immutable afterward.
- Resume uses persisted snapshot/batch definitions only; it never reloads/repartitions the current watchlist.
- A partially completed Socrata batch restarts from its first page; raw/staging writes must therefore be replay-safe.
- HTTP retry limits, logical batch-attempt limits, page limits, timeouts, and concurrency are independently bounded.
- The dedicated PostgreSQL advisory-lock session is execution authority. If that session is lost, the worker aborts and must not continue through surviving Prisma connections.

Load: `architecture.ingestion_strategy`, `architecture.ingestion_lifecycle`, `architecture.data_access_validation`.

## Raw, staging and live state

- Raw source versions are persisted before strict domain normalization.
- Normalized candidates are run-scoped staging and are never served directly.
- Live `ecb_violations` changes only after an accepted run.
- Promotion, negative reconciliation, successful coverage publication and `COMPLETED` transition are one short accepted-state publication transaction.
- Failed or `SOURCE_CHANGED` runs do not promote staging and do not perform negative reconciliation.

Load: `architecture.storage`, `architecture.ingestion_lifecycle`.

## Coverage and failure semantics

- Coverage is explicit persisted state; missing coverage rows do not stand for `NOT_CHECKED`.
- New properties initialize `NOT_CHECKED` with `NEVER_INGESTED` or `NO_VALID_BIN` as appropriate.
- Coverage for run `R` derives from `ingestion_run_property_bins` for `R`, not current live `property_bins`.
- Successful or failed property-level coverage publication is guarded by the snapshotted `property_identifier_version`.
- Failure before a committed run property scope is run/dataset-level only; it must not falsely mark every property `FAILED`.
- Failure after committed scope may publish property-level attempt failure while preserving prior `last_success_*`.
- Terminal run failure and eligible failed-coverage publication are atomic.

Load: `architecture.storage`, `architecture.resolver`.

## Query/API semantics

- Stored-property and ECB query endpoints read PostgreSQL; ECB query requests never call Socrata.
- `openOnly=true` means `ecb_violation_status = 'ACTIVE'`; `unpaidOnly=true` means `balance_due > 0`.
- Property ECB ordering is `issue_date DESC NULLS LAST, source_id DESC` and keyset pagination must implement the explicit NULL-aware branches.
- Portfolio ECB output requires both source-current state (`is_current = true`) and current tracked membership through `property_bins`.
- `updatedSince` compares against Socrata `source_row_updated_at`, not issue date or local write time.

Load: `architecture.api`.

## Runtime and delivery

- Node 22 + TypeScript, Express, PostgreSQL, Prisma, `pg` for lock ownership, Zod, Bottleneck, Pino, Jest/Supertest.
- Runtime is API + worker + PostgreSQL; clean-machine startup is Docker Compose.
- Compose migration order is `postgres healthy -> migrate completed -> api/worker` and the migrate service runs `npx prisma migrate deploy`.
- Scheduled and manual ingestion call the same ingestion service.
- Operational settings come from validated configuration/environment; secrets are never committed.

Load: `architecture.foundations`, `architecture.operations`, `architecture.implementation_map`.

## Testing

- Automated tests mock external NYC APIs so correctness does not depend on network availability.
- Tests target behavior/invariants, especially identity, crash/retry/resume, atomic publication, coverage/version guards, and NULL-aware pagination.
- Real-data acceptance is a separate final layer: required seed set, BIS spot checks, baseline + idempotent second run, and 10,000-property scale evidence.

Load: `architecture.testing`.
