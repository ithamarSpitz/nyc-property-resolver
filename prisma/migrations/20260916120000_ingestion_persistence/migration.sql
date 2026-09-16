-- S2 ingestion lifecycle, immutable run snapshots, and raw/staging persistence.

CREATE TYPE "IngestionRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'SOURCE_CHANGED');

CREATE TYPE "IngestionTriggerType" AS ENUM ('SCHEDULED', 'MANUAL');

CREATE TYPE "IngestionBatchStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "ingestion_runs" (
    "id" UUID NOT NULL,
    "dataset" "Dataset" NOT NULL,
    "status" "IngestionRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger_type" "IngestionTriggerType" NOT NULL,
    "initialization_complete" BOOLEAN NOT NULL DEFAULT false,
    "expected_property_bin_count" INTEGER,
    "expected_bin_count" INTEGER,
    "expected_batch_count" INTEGER,
    "failure_stage" TEXT,
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "source_watermark_at_start" TIMESTAMPTZ(6),
    "source_watermark_at_end" TIMESTAMPTZ(6),
    "bins_scanned" INTEGER NOT NULL DEFAULT 0,
    "data_page_calls" INTEGER NOT NULL DEFAULT 0,
    "metadata_calls" INTEGER NOT NULL DEFAULT 0,
    "retry_calls" INTEGER NOT NULL DEFAULT 0,
    "total_socrata_calls" INTEGER NOT NULL DEFAULT 0,
    "rows_fetched" INTEGER NOT NULL DEFAULT 0,
    "rows_written" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ingestion_runs_state_check" CHECK (
      "status" NOT IN ('RUNNING', 'COMPLETED', 'SOURCE_CHANGED')
      OR ("initialization_complete" = true AND "source_watermark_at_start" IS NOT NULL)
    ),
    CONSTRAINT "ingestion_runs_queued_watermark_check" CHECK (
      NOT ("status" = 'QUEUED' AND "source_watermark_at_start" IS NOT NULL)
    ),
    CONSTRAINT "ingestion_runs_watermark_requires_initialization_check" CHECK (
      "source_watermark_at_start" IS NULL OR "initialization_complete" = true
    ),
    CONSTRAINT "ingestion_runs_nonnegative_metrics_check" CHECK (
      "bins_scanned" >= 0 AND "data_page_calls" >= 0 AND "metadata_calls" >= 0
      AND "retry_calls" >= 0 AND "total_socrata_calls" >= 0 AND "rows_fetched" >= 0
      AND "rows_written" >= 0 AND "failures" >= 0
    )
);

CREATE INDEX "ingestion_runs_dataset_status_idx" ON "ingestion_runs"("dataset", "status");

CREATE UNIQUE INDEX "ingestion_runs_one_active_per_dataset_idx"
  ON "ingestion_runs"("dataset")
  WHERE "status" IN ('QUEUED', 'RUNNING');

CREATE TABLE "ingestion_run_property_bins" (
    "run_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "property_identifier_version" INTEGER NOT NULL,
    "bin" VARCHAR(7) NOT NULL,

    CONSTRAINT "ingestion_run_property_bins_pkey" PRIMARY KEY ("run_id", "property_id", "bin"),
    CONSTRAINT "ingestion_run_property_bins_identifier_version_check" CHECK ("property_identifier_version" > 0)
);

CREATE INDEX "ingestion_run_property_bins_run_id_bin_idx"
  ON "ingestion_run_property_bins"("run_id", "bin");

CREATE INDEX "ingestion_run_property_bins_run_id_property_id_idx"
  ON "ingestion_run_property_bins"("run_id", "property_id");

CREATE TABLE "ingestion_batches" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "batch_number" INTEGER NOT NULL,
    "status" "IngestionBatchStatus" NOT NULL DEFAULT 'PENDING',
    "batch_definition" JSONB NOT NULL,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "rows_fetched" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ingestion_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ingestion_batches_run_batch_number_key" UNIQUE ("run_id", "batch_number"),
    CONSTRAINT "ingestion_batches_progress_check" CHECK (
      "batch_number" > 0 AND "pages_fetched" >= 0 AND "attempt_count" >= 0 AND "rows_fetched" >= 0
    )
);

CREATE TABLE "ecb_violation_raw" (
    "id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "socrata_row_id" TEXT NOT NULL,
    "source_row_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_seen_run_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "ecb_violation_raw_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ecb_violation_raw_source_version_key" UNIQUE ("source_id", "source_row_updated_at")
);

CREATE INDEX "ecb_violation_raw_source_id_idx" ON "ecb_violation_raw"("source_id");

CREATE TABLE "ecb_violation_staging" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "socrata_row_id" TEXT NOT NULL,
    "bin" VARCHAR(7) NOT NULL,
    "violation_number" TEXT,
    "issue_date" DATE,
    "ecb_violation_status" TEXT,
    "balance_due" DECIMAL(15,2),
    "source_row_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecb_violation_staging_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ecb_violation_staging_run_source_key" UNIQUE ("run_id", "source_id")
);

CREATE INDEX "ecb_violation_staging_run_id_bin_idx"
  ON "ecb_violation_staging"("run_id", "bin");

ALTER TABLE "ingestion_run_property_bins"
  ADD CONSTRAINT "ingestion_run_property_bins_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ingestion_run_property_bins"
  ADD CONSTRAINT "ingestion_run_property_bins_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ingestion_batches"
  ADD CONSTRAINT "ingestion_batches_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ecb_violation_raw"
  ADD CONSTRAINT "ecb_violation_raw_first_seen_run_id_fkey"
  FOREIGN KEY ("first_seen_run_id") REFERENCES "ingestion_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ecb_violation_staging"
  ADD CONSTRAINT "ecb_violation_staging_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_ingestion_run_watermark_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_watermark_at_start IS DISTINCT FROM NEW.source_watermark_at_start
     AND OLD.source_watermark_at_start IS NOT NULL THEN
    RAISE EXCEPTION 'source_watermark_at_start is immutable after it is set';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_runs_watermark_immutable
BEFORE UPDATE OF source_watermark_at_start ON "ingestion_runs"
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_run_watermark_immutability();

CREATE OR REPLACE FUNCTION enforce_ingestion_snapshot_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_run_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_run_id := OLD.run_id;
  ELSE
    target_run_id := NEW.run_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ingestion_runs"
    WHERE id = target_run_id AND initialization_complete = true
  ) THEN
    RAISE EXCEPTION 'ingestion run snapshot is immutable after initialization';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.run_id IS DISTINCT FROM NEW.run_id
     AND EXISTS (
       SELECT 1 FROM "ingestion_runs"
       WHERE id = OLD.run_id AND initialization_complete = true
     ) THEN
    RAISE EXCEPTION 'ingestion run snapshot is immutable after initialization';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_run_property_bins_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "ingestion_run_property_bins"
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_snapshot_immutability();

CREATE OR REPLACE FUNCTION enforce_ingestion_batch_definition_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM "ingestion_runs"
      WHERE id = NEW.run_id AND initialization_complete = true
    ) THEN
      RAISE EXCEPTION 'ingestion batch definition is immutable after initialization';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "ingestion_runs"
      WHERE id = OLD.run_id AND initialization_complete = true
    ) THEN
      RAISE EXCEPTION 'ingestion batch definition is immutable after initialization';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.batch_number IS DISTINCT FROM NEW.batch_number
     OR OLD.batch_definition IS DISTINCT FROM NEW.batch_definition THEN
    RAISE EXCEPTION 'ingestion batch definition is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_batches_definition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "ingestion_batches"
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_batch_definition_immutability();
