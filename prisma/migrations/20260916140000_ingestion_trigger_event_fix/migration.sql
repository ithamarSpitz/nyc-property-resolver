-- Add the immutable-snapshot trigger events missing from early S2 deployments.

DROP TRIGGER IF EXISTS ingestion_run_property_bins_immutable
  ON "ingestion_run_property_bins";

CREATE TRIGGER ingestion_run_property_bins_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "ingestion_run_property_bins"
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_snapshot_immutability();

DROP TRIGGER IF EXISTS ingestion_batches_definition_immutable
  ON "ingestion_batches";

CREATE TRIGGER ingestion_batches_definition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "ingestion_batches"
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_batch_definition_immutability();
