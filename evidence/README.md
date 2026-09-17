# Acceptance evidence contract

Run the small real-data workflow while the Compose API is available on `http://localhost:3000`:

```bash
npm run acceptance:small -- --evidence-dir evidence/runs/small-YYYYMMDD-HHMMSS
```

Optional environment/configuration:

- `SOCRATA_APP_TOKEN` is passed to Compose by its existing environment contract; it is never written to evidence.
- `ACCEPTANCE_API_BASE_URL` changes the API base URL when necessary.
- `--api-base-url URL` overrides the environment value.

The target directory must be new or empty, preventing a new run from overwriting baseline evidence. The runner writes:

```text
seed.json
registration/api-health.json
registration/requests-responses.json
source-contract/command.json
source-contract/output.log
source-contract/result.json
baseline/command.json
baseline/ingestion.log
baseline/run.json
baseline/api/properties.json
baseline/api/portfolio.json
second-run/command.json
second-run/ingestion.log
second-run/run.json
second-run/api/properties.json
second-run/api/portfolio.json
duplicate-audit.json
summary.json
bis/spot-checks.json                 # added manually in S5-T2
```

`summary.json` records timestamps, commands, run IDs, source watermarks, fixed ingestion counters, and baseline-to-second-run row deltas. API snapshots are fetched from the local service after ingestion; the runner never substitutes Socrata query results for stored results.

The runner does not create BIS conclusions. In S5-T2, perform at least two human BIS Property Profile comparisons and add `bis/spot-checks.json` in this shape:

```json
{
  "checks": [
    {
      "fixtureId": "empire-state-building",
      "checkedAt": "2026-09-17T12:00:00.000Z",
      "bisUrl": "https://a810-bisweb.nyc.gov/bisweb/bsqpm01.jsp",
      "localObservation": "Describe the locally stored count/status/balance inspected.",
      "bisObservation": "Describe the corresponding BIS count/status/balance inspected.",
      "matches": true,
      "notes": "Explain any scope or timing differences."
    }
  ]
}
```

Two distinct fixture records are required. Validate the complete directory with:

```bash
npm run acceptance:small:validate -- evidence/runs/small-YYYYMMDD-HHMMSS
```

The validator rejects empty logs, missing fixture coverage, absent or reused run IDs, invalid source-contract evidence, missing API snapshots, incomplete duplicate audits, summary mismatches, and fewer than two substantive BIS records.
