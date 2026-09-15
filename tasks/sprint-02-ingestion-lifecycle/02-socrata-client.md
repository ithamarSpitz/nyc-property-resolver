---
id: S2-T2
stage: 2
model_class: worker
timeout_minutes: 40
review: true
allow_protected: false
depends_on:
  - S2-T1
allowed_paths:
  - src/clients/socrata.client.ts
  - tests/unit/clients/socrata.client.test.ts
context:
  - architecture.ingestion_strategy
  - architecture.data_access_validation
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/socrata.client.test.ts
---

# Goal

Implement the DOB ECB Socrata HTTP/query client contract with explicit system-field selection, stable pagination ordering, metadata-watermark access, and bounded page-request construction while leaving concurrency/retry policy to the separate request executor.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the S2-T1 config/source-contract types.

# Scope

Implement `SocrataClient` using native `fetch` through an injected/request-executor boundary so this client owns source/query semantics rather than retry scheduling.

The client must provide typed operations for:

- dataset metadata lookup exposing `rowsUpdatedAt`;
- one ordered ECB data page for a supplied immutable BIN batch and page offset/size;
- source-contract aggregate/duplicate-group queries required by S2-T1's verification service;
- explicit `$select=:id,:updated_at,*` for every ECB data page;
- stable `$order=:updated_at,:id` for page traversal;
- bounded bulk `BIN IN (...)` query construction with proper URL/query encoding;
- minimal transport/JSON shape validation sufficient for downstream raw persistence;
- HTTP status/error classification data needed by the retry executor;
- no business-domain normalization inside the HTTP client.

Automated tests mock `fetch`/transport; no live NYC call is part of this task.

# Out of scope

Do not implement:

- Bottleneck scheduling or retry loops;
- logical batch-attempt accounting;
- raw/staging persistence;
- strict ECB Zod domain validation;
- run state changes;
- durable resume offsets;
- live source-contract acceptance against NYC.

# Invariants

- ECB data queries explicitly select `:id` and `:updated_at`; their presence is never assumed implicitly.
- Page ordering is exactly stable on `:updated_at,:id`.
- `$offset` is only a within-attempt page position and is never presented as a durable resume cursor.
- The client receives an immutable logical BIN set; it does not reload the watchlist.
- Source payloads/tokens are not dumped wholesale to logs.

# Acceptance criteria

1. Tests assert every ECB page request contains `$select=:id,:updated_at,*` and `$order=:updated_at,:id`.
2. Metadata responses produce a typed `rowsUpdatedAt` watermark and malformed/missing metadata fails explicitly.
3. BIN batch queries are encoded deterministically and page size/offset are explicit.
4. Non-2xx, timeout/abort, malformed JSON, and malformed transport shapes surface explicit typed errors/classification data.
5. Source-contract aggregate and duplicate-group operations can be consumed by S2-T1 without a second ad-hoc HTTP implementation.
6. No retry loop, database write, or domain normalization is hidden inside the client.

# Verification

The mocked-network suite is authoritative for this task; live source verification is a later explicit operational/acceptance action.
