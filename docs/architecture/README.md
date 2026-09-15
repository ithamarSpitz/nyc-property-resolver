# Architecture Context Map

`/ARCHITECTURE.md` is the authoritative architecture document. The generated files in this directory are exact numbered-section extracts for agent context routing; they are not independent specifications.

Regenerate/check exact extracts:

```bash
python scripts/generate-architecture-contexts.py
python scripts/generate-architecture-contexts.py --check
```

| Alias | File | Source sections | Use for |
|---|---|---|---|
| `architecture.invariants` | `invariants.md` | derived router/checklist | compact cross-domain routing only; load exact modules before implementation |
| `architecture.foundations` | `foundations.md` | §§1–4 | stack, component boundaries, global shape |
| `architecture.resolver` | `resolver.md` | §5 | property resolution, identity, condo, identifier versioning, footprint cross-checks |
| `architecture.ingestion_strategy` | `ingestion-strategy.md` | §6 | watchlist choice, scale arithmetic, top-level ingestion flow, bounds |
| `architecture.ingestion_lifecycle` | `ingestion-lifecycle.md` | §§7–8 | run lifecycle, lock authority, initialization, snapshots, immutable batches, resume |
| `architecture.storage` | `storage.md` | §§9–12 | raw/staging/live, idempotency, coverage, PostgreSQL model |
| `architecture.data_access_validation` | `data-access-validation.md` | §§13–16 | Prisma, Zod, source clients, Socrata query contract, Bottleneck |
| `architecture.operations` | `operations.md` | §§17, 20–22, 25 | scheduling, logging, security, configuration, Docker/migrations |
| `architecture.api` | `api.md` | §§18–19 | endpoints, portfolio membership, filters, NULL-aware cursor pagination |
| `architecture.testing` | `testing.md` | §§23–24 | automated behavior tests, acceptance, scale verification |
| `architecture.implementation_map` | `implementation-map.md` | §§26–28 | source layout and end-to-end flows |

Agents start from the current task brief (created later) and load only its named aliases. Do not use `invariants.md` as a substitute for the exact source section when implementing behavior.
