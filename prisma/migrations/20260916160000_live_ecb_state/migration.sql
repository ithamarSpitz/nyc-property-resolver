-- Accepted live ECB state. Staging remains run-scoped and is never served.

CREATE TABLE "ecb_violations" (
    "id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "socrata_row_id" TEXT NOT NULL,
    "bin" VARCHAR(7) NOT NULL,
    "violation_number" TEXT,
    "issue_date" DATE,
    "ecb_violation_status" TEXT,
    "balance_due" DECIMAL(15,2),
    "source_row_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "last_success_run_id" UUID NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecb_violations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ecb_violations_source_id_key" UNIQUE ("source_id")
);

CREATE INDEX "ecb_violations_bin_idx" ON "ecb_violations"("bin");

ALTER TABLE "ecb_violations"
  ADD CONSTRAINT "ecb_violations_last_success_run_id_fkey"
  FOREIGN KEY ("last_success_run_id") REFERENCES "ingestion_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
