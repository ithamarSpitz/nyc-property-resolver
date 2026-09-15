# Planning Artifacts

These files define the project execution policy and sprint/stage blueprint independently of concrete coding tasks.

- `sprints.yaml` — non-runnable sprint/stage blueprint. S0 through S4 now have executable task briefs in `tasks/`; S5 remains blueprint-only.
- `task-generation-policy.yaml` — deterministic rules for later task decomposition.
- `verification-matrix.yaml` — required test/verification layers and behavior coverage.
- `environment-contract.yaml` — runtime/config/Docker contract.
- `path-policy.yaml` — protected/review-required/serial-hotspot policy.
- `model-routing.yaml` — model-class policy without provider model names.
- `risk-register.yaml` — high-risk invariants that later tasks/reviews must explicitly cover.
- `change-control.yaml` — post-start plan revision and revalidation policy.
- `quota-policy.yaml` — included-usage pause/resume policy; on-demand remains disabled.

`ARCHITECTURE.md` and `docs/assignment.md` remain authoritative. Planning files may organize work but may not redefine behavior.
