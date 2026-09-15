# Context Routing Policy

## Source hierarchy

1. `docs/assignment.md`
2. `ARCHITECTURE.md`
3. Generated exact architecture modules under `docs/architecture/`
4. Current task brief (created later)
5. Existing implementation

The generated modules are routing artifacts, not new specifications. They are checked against `ARCHITECTURE.md` by `scripts/generate-architecture-contexts.py --check`.

## Aliases

- `assignment`
- `architecture.invariants`
- `architecture.foundations`
- `architecture.resolver`
- `architecture.ingestion_strategy`
- `architecture.ingestion_lifecycle`
- `architecture.storage`
- `architecture.data_access_validation`
- `architecture.operations`
- `architecture.api`
- `architecture.testing`
- `architecture.implementation_map`

A future task should normally load `assignment` only when it needs the original evaluator contract, plus 1–3 relevant architecture aliases. It should not load all architecture modules by default.
