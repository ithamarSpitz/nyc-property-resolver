-- Initialization seals the persisted run snapshot and batch definitions.
-- It cannot be reopened after the initialization transaction commits.

CREATE OR REPLACE FUNCTION enforce_ingestion_initialization_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.initialization_complete = true
     AND NEW.initialization_complete = false THEN
    RAISE EXCEPTION 'ingestion run initialization cannot be reopened';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_runs_initialization_monotonic
BEFORE UPDATE OF initialization_complete ON "ingestion_runs"
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_initialization_monotonicity();
