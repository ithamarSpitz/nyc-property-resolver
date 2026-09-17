# Small acceptance seed

`acceptance-properties.json` is the auditable 5-property real-data set used by the small acceptance runner. Each entry retains the exact original input, its assignment requirement tag, and public provenance for why it was selected.

The file deliberately does not supply resolved BBLs or BINs to the runner. Those identifiers are outputs of `POST /properties` and are captured in the acceptance evidence. The unpaid-balance source URL contains the independently observed BIN only as dated selection provenance; it is never submitted to the resolver.

Fixture categories are validated without network access by:

```bash
npm run acceptance:small:check
```

Real-source facts can change after `preparedAt`. A later live acceptance run must preserve the resulting evidence rather than changing fixtures merely to conceal resolver or ingestion defects.
