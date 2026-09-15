# Environment and Docker Plan

Machine-readable contract: `plans/environment-contract.yaml`.

## Ownership

- `harness.yaml`: agent/worktree/retry/review/environment-isolation behavior.
- `.env.example` (created during foundation implementation): application environment contract, no secrets.
- `.env`: local operator values, ignored by Git.
- `src/config/env.ts`: single validated application config boundary and canonical defaults.
- `Dockerfile` / `docker-compose.yml`: reproducible runtime.

Do not duplicate conflicting defaults across TypeScript, Compose, README and shell scripts.

## Compose startup contract

```text
postgres --service_healthy--> migrate (prisma migrate deploy)
                                  |
                                  +--> api
                                  +--> worker
```

API and worker use the same application image and do not race to apply migrations.

## Harness isolation

Tasks that need PostgreSQL/integration Docker opt into `environment: docker`. The harness assigns a unique `COMPOSE_PROJECT_NAME` per task/stage so parallel workers do not share containers, networks or named volumes. Prefer internal Compose networking for task tests rather than fixed host ports.

Unit/pure tests should run without booting the whole Compose stack. Database/integration tests use real PostgreSQL where database behavior is part of correctness. Final acceptance uses the same Docker-only startup shape the evaluator will use.
