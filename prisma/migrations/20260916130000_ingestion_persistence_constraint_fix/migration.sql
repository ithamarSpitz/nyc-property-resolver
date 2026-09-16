-- Correct constraints and trigger functions for databases that applied the
-- initial S2 migration before its immutability guards were finalized.

ALTER TABLE "ingestion_runs"
  DROP CONSTRAINT "ingestion_runs_queued_watermark_check";

ALTER TABLE "ingestion_runs"
  ADD CONSTRAINT "ingestion_runs_queued_watermark_check" CHECK (
    NOT ("status" = 'QUEUED' AND "source_watermark_at_start" IS NOT NULL)
  );

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
