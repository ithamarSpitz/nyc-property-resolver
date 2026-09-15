# High-Level Dependency Graph

```text
S0 Foundation
      |
      v
S1 Property Resolution
      |
      v
S2 Ingestion Lifecycle
      |
      v
S3 Ingestion Publication
      |
      v
S4 API & Operations
      |
      v
S5 Acceptance & Submission
```

Within a sprint, the **stage** is the integration barrier. Workstreams explicitly listed as parallel in `plans/sprints.yaml` may later become independent tasks/worktrees only when their concrete `allowed_paths` do not overlap serial hotspots.

Parallelism is allowed by both dependency and file ownership; dependency independence alone is not sufficient.
