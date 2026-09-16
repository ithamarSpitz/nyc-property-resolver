import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  IngestionBatchStatus,
  IngestionRun,
  IngestionRunStatus,
  Prisma,
} from "@prisma/client";

export type SuccessfulCoveragePublicationResult = {
  checkedCount: number;
  identifiersChangedCount: number;
};

/**
 * Prisma's TransactionClient is structurally compatible with a root
 * PrismaClient unless a transaction-only member is made explicit here.
 */
export type SuccessfulCoverageTransaction = Prisma.TransactionClient & {
  readonly $transaction?: never;
};

export class SuccessfulCoveragePublicationError extends Error {
  constructor(message: string) {
    super(`Successful coverage publication: ${message}`);
    this.name = "SuccessfulCoveragePublicationError";
  }
}

type SnapshotProperty = {
  propertyId: string;
  propertyIdentifierVersion: number;
  currentIdentifierVersion: number;
  snapshotBinCount: bigint;
  snapshotVersionCount: bigint;
};

type DistinctBinRow = { bin: string };

function publicationError(message: string): SuccessfulCoveragePublicationError {
  return new SuccessfulCoveragePublicationError(message);
}

function parseBatchBins(
  definition: Prisma.JsonValue,
  runId: string,
  batchNumber: number,
): string[] {
  if (
    typeof definition !== "object" ||
    definition === null ||
    Array.isArray(definition) ||
    !Array.isArray(definition.bins) ||
    definition.bins.some((bin) => typeof bin !== "string")
  ) {
    throw publicationError(
      `run ${runId} batch ${batchNumber} does not have a valid immutable BIN definition`,
    );
  }

  return definition.bins as string[];
}

function acceptedAtFor(run: IngestionRun, acceptedAt: Date | undefined): Date {
  return acceptedAt ?? run.finishedAt ?? new Date();
}

async function loadAndValidateAcceptedRun(
  executor: SuccessfulCoverageTransaction,
  runId: string,
): Promise<{ run: IngestionRun; snapshotProperties: SnapshotProperty[] }> {
  const run = await executor.ingestionRun.findUnique({ where: { id: runId } });
  if (run === null) {
    throw publicationError(`run ${runId} does not exist`);
  }
  if (run.dataset !== Dataset.DOB_ECB_VIOLATIONS) {
    throw publicationError(`run ${runId} is not an ECB ingestion run`);
  }
  // Publication commits atomically with the run's COMPLETED transition, so a run
  // that is already COMPLETED has published once and any further call is a stale
  // replay whose snapshot may no longer describe the current identifier state.
  if (run.status === IngestionRunStatus.COMPLETED) {
    throw publicationError(
      `run ${runId} has already completed and cannot publish coverage again`,
    );
  }
  if (run.status !== IngestionRunStatus.RUNNING) {
    throw publicationError(
      `run ${runId} is not accepted (status=${run.status})`,
    );
  }
  if (!run.initializationComplete) {
    throw publicationError(
      `run ${runId} does not have a committed property scope`,
    );
  }
  if (run.startedAt === null) {
    throw publicationError(`run ${runId} is missing started_at`);
  }
  if (
    run.sourceWatermarkAtStart === null ||
    run.sourceWatermarkAtEnd === null
  ) {
    throw publicationError(
      `run ${runId} is missing an accepted dataset watermark`,
    );
  }
  if (
    run.sourceWatermarkAtStart.getTime() !== run.sourceWatermarkAtEnd.getTime()
  ) {
    throw publicationError(`run ${runId} failed the source watermark guard`);
  }
  if (
    run.expectedPropertyBinCount === null ||
    run.expectedBinCount === null ||
    run.expectedBatchCount === null
  ) {
    throw publicationError(`run ${runId} is missing persisted scope counts`);
  }

  // Locking the property rows makes the version comparison and coverage write
  // serialize with the sole effective-BIN mutation boundary.
  await executor.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT property."id"
    FROM "properties" AS property
    WHERE EXISTS (
      SELECT 1
      FROM "ingestion_run_property_bins" AS snapshot
      WHERE snapshot."run_id" = ${runId}::uuid
        AND snapshot."property_id" = property."id"
    )
    ORDER BY property."id"
    FOR UPDATE OF property
  `);

  const snapshotProperties = await executor.$queryRaw<
    SnapshotProperty[]
  >(Prisma.sql`
    SELECT
      snapshot."property_id" AS "propertyId",
      MIN(snapshot."property_identifier_version")::integer AS "propertyIdentifierVersion",
      property."identifier_version" AS "currentIdentifierVersion",
      COUNT(*)::bigint AS "snapshotBinCount",
      COUNT(DISTINCT snapshot."property_identifier_version")::bigint AS "snapshotVersionCount"
    FROM "ingestion_run_property_bins" AS snapshot
    JOIN "properties" AS property ON property."id" = snapshot."property_id"
    WHERE snapshot."run_id" = ${runId}::uuid
    GROUP BY snapshot."property_id", property."identifier_version"
    ORDER BY snapshot."property_id"
  `);

  if (
    snapshotProperties.some((property) => property.snapshotVersionCount !== 1n)
  ) {
    throw publicationError(
      `run ${runId} has inconsistent identifier versions in its snapshot`,
    );
  }

  const distinctBins = await executor.$queryRaw<DistinctBinRow[]>(Prisma.sql`
    SELECT DISTINCT "bin"
    FROM "ingestion_run_property_bins"
    WHERE "run_id" = ${runId}::uuid
    ORDER BY "bin"
  `);
  const snapshotPropertyBinCount = snapshotProperties.reduce(
    (total, property) => total + Number(property.snapshotBinCount),
    0,
  );

  const batches = await executor.ingestionBatch.findMany({
    where: { runId },
    orderBy: { batchNumber: "asc" },
  });

  if (snapshotPropertyBinCount !== run.expectedPropertyBinCount) {
    throw publicationError(
      `run ${runId} property/BIN snapshot count is incomplete`,
    );
  }
  if (distinctBins.length !== run.expectedBinCount) {
    throw publicationError(
      `run ${runId} distinct BIN snapshot count is incomplete`,
    );
  }
  if (batches.length !== run.expectedBatchCount) {
    throw publicationError(`run ${runId} batch count is incomplete`);
  }
  if (
    batches.some((batch) => batch.status !== IngestionBatchStatus.COMPLETED)
  ) {
    throw publicationError(`run ${runId} has incomplete BIN processing`);
  }

  const processedBins = batches.flatMap((batch) =>
    parseBatchBins(batch.batchDefinition, runId, batch.batchNumber),
  );
  const uniqueProcessedBins = [...new Set(processedBins)].sort();
  const snapshotBins = distinctBins.map((row) => row.bin);
  if (
    processedBins.length !== uniqueProcessedBins.length ||
    uniqueProcessedBins.length !== snapshotBins.length ||
    uniqueProcessedBins.some((bin, index) => bin !== snapshotBins[index])
  ) {
    throw publicationError(
      `run ${runId} completed batches do not exactly cover its BIN snapshot`,
    );
  }

  return { run, snapshotProperties };
}

/**
 * Publishes success-side coverage for one accepted run.
 *
 * The caller owns the transaction so this can be committed atomically with
 * live-state promotion, reconciliation, and the run's COMPLETED transition.
 */
export async function publishSuccessfulCoverage(
  executor: SuccessfulCoverageTransaction,
  acceptedRun: IngestionRun | string,
  acceptedAt?: Date,
): Promise<SuccessfulCoveragePublicationResult> {
  if ("$transaction" in executor) {
    throw publicationError("an existing transaction client is required");
  }

  const runId = typeof acceptedRun === "string" ? acceptedRun : acceptedRun.id;
  const { run, snapshotProperties } = await loadAndValidateAcceptedRun(
    executor,
    runId,
  );
  const publicationTime = acceptedAtFor(run, acceptedAt);

  if (snapshotProperties.length === 0) {
    return { checkedCount: 0, identifiersChangedCount: 0 };
  }

  // Run ids are random UUIDs and carry no chronology, so started_at is the only
  // trustworthy ordering signal. Ingestion runs are serialized by the advisory
  // lock, so two distinct runs cannot share a start instant.
  const publishedByNewerRun = Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "ingestion_runs" AS newer_run
      WHERE newer_run."id" IN (
        "property_dataset_coverage"."last_attempt_run_id",
        "property_dataset_coverage"."last_success_run_id"
      )
        AND newer_run."started_at" > ${run.startedAt}
    )
  `;

  const checkedCount = await executor.$executeRaw(Prisma.sql`
    INSERT INTO "property_dataset_coverage" (
      "property_id",
      "dataset",
      "status",
      "status_reason",
      "last_attempt_run_id",
      "last_success_run_id",
      "last_attempt_at",
      "last_success_at",
      "source_watermark_at",
      "last_error"
    )
    SELECT DISTINCT
      snapshot."property_id",
      ${Dataset.DOB_ECB_VIOLATIONS}::"Dataset",
      ${CoverageStatus.CHECKED}::"CoverageStatus",
      NULL::"CoverageStatusReason",
      ${runId}::uuid,
      ${runId}::uuid,
      ${publicationTime},
      ${publicationTime},
      ${run.sourceWatermarkAtEnd},
      NULL::text
    FROM "ingestion_run_property_bins" AS snapshot
    JOIN "properties" AS property ON property."id" = snapshot."property_id"
    WHERE snapshot."run_id" = ${runId}::uuid
      AND property."identifier_version" = snapshot."property_identifier_version"
    ON CONFLICT ("property_id", "dataset") DO UPDATE SET
      "status" = EXCLUDED."status",
      "status_reason" = NULL,
      "last_attempt_run_id" = EXCLUDED."last_attempt_run_id",
      "last_success_run_id" = EXCLUDED."last_success_run_id",
      "last_attempt_at" = EXCLUDED."last_attempt_at",
      "last_success_at" = EXCLUDED."last_success_at",
      "source_watermark_at" = EXCLUDED."source_watermark_at",
      "last_error" = NULL
    WHERE NOT ${publishedByNewerRun}
  `);

  // A version mismatch on a row that already records this run as its last
  // success means the sole BIN-set mutation boundary invalidated that success
  // after the snapshot. That invalidation is the newer state, so this run must
  // not rewrite it.
  const successAlreadyRecordedForThisRun = Prisma.sql`
    (
      "property_dataset_coverage"."last_success_run_id"
        IS NOT DISTINCT FROM ${runId}::uuid
    )
  `;

  const identifiersChangedCount = await executor.$executeRaw(Prisma.sql`
    INSERT INTO "property_dataset_coverage" (
      "property_id",
      "dataset",
      "status",
      "status_reason"
    )
    SELECT DISTINCT
      snapshot."property_id",
      ${Dataset.DOB_ECB_VIOLATIONS}::"Dataset",
      ${CoverageStatus.NOT_CHECKED}::"CoverageStatus",
      ${CoverageStatusReason.IDENTIFIERS_CHANGED_AFTER_SNAPSHOT}::"CoverageStatusReason"
    FROM "ingestion_run_property_bins" AS snapshot
    JOIN "properties" AS property ON property."id" = snapshot."property_id"
    WHERE snapshot."run_id" = ${runId}::uuid
      AND property."identifier_version" <> snapshot."property_identifier_version"
    ON CONFLICT ("property_id", "dataset") DO UPDATE SET
      "status" = EXCLUDED."status",
      "status_reason" = EXCLUDED."status_reason"
    WHERE NOT ${publishedByNewerRun}
      AND NOT ${successAlreadyRecordedForThisRun}
  `);

  return { checkedCount, identifiersChangedCount };
}

export class SuccessfulCoverageService {
  async publish(
    executor: SuccessfulCoverageTransaction,
    acceptedRun: IngestionRun | string,
    acceptedAt?: Date,
  ): Promise<SuccessfulCoveragePublicationResult> {
    return publishSuccessfulCoverage(executor, acceptedRun, acceptedAt);
  }
}
