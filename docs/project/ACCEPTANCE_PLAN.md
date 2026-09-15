# Acceptance and Submission Plan

Acceptance is intentionally separated from normal implementation retries. The S5 graph owns live NYC/BIS traffic, scale evidence, documentation from measured results, and the final clean-repository gate.

## Small real-data set

Check in 5–8 real properties covering the required Empire State Building reference, Queens hyphenated house number, condo unit, 2–3 family property and at least one unpaid ECB balance case. Keep fixture provenance auditable; do not replace a fixture merely because it exposes an implementation defect.

## Evidence sequence

1. Validate the small acceptance seed/tooling without network traffic.
2. Start from the documented clean Docker path.
3. Run the explicit ECB source-key contract probe.
4. Resolve/import the small seed set.
5. Run ECB ingestion manually through the worker command and save the baseline log.
6. Query required API behaviors from local storage.
7. Spot-check at least two properties against BIS and record exact property/page/timestamp/local-vs-BIS values.
8. Run ingestion again without resetting the watchlist/database and prove no duplicate logical rows.
9. Save the idempotent second-run log and duplicate audit.
10. Select exactly 10,000 deterministic PLUTO BBLs and persist the sample/provenance.
11. Register them through the bulk BBL path and run ingestion.
12. Record wall time, unique properties/BINs, Socrata data/metadata/retry/total calls, rows fetched/promoted, failures and final status.
13. Build README/DESIGN/RUN_LOG only from the committed evidence.
14. Perform a final clean-repository Docker verification and the Empire State resolve → manual ingest → local query walkthrough.

## Evidence policy

Live acceptance tasks commit raw logs plus machine-readable summaries. Harness verification validates the evidence rather than automatically repeating expensive live runs. If BIS is inaccessible or a real run exposes a product defect, the task blocks with preserved diagnostics instead of fabricating a pass.

## Walkthrough readiness

The final README should make the evaluator's first 10 minutes deterministic: one-command startup, manual ingestion trigger, reference-property request, ECB query and coverage/freshness explanation. DESIGN should distinguish measured 10k results from 20k extrapolation and explain the watchlist-vs-mirror switch point using one versus ten NYC data points.
