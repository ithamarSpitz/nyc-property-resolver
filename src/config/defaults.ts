/** Canonical architecture-owned defaults for operational configuration. */
export const CONFIG_DEFAULTS = {
  PORT: 3000,
  INGEST_INTERVAL_MS: 604_800_000,
  ECB_BATCH_SIZE: 1_000,
  SOCRATA_PAGE_SIZE: 50_000,
  SOCRATA_MAX_PAGES_PER_BATCH: 100,
  SOCRATA_CONCURRENCY: 10,
  SOCRATA_REQUEST_TIMEOUT_MS: 15_000,
  SOCRATA_MAX_RETRIES: 3,
  MAX_BATCH_ATTEMPTS_PER_RUN: 3,
  // The 10k-property / 81,507-row PostgreSQL publication fixture completes
  // well inside this bound. Keeping a 60s budget leaves capacity for the
  // documented 20k-property strategy without making publication unbounded.
  ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS: 60_000,
  TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS: 30_000,
  API_BODY_LIMIT: '512kb',
} as const;
