import {
  CoverageStatus,
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import { CONFIG_DEFAULTS } from '../../../src/config/defaults';
import { AcceptedPublicationService } from '../../../src/services/ecb/accepted-publication.service';
import { IngestionExecutionAuthority } from '../../../src/services/ecb/ingestion-lock.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;
const PROPERTY_COUNT = 10_000;
const BIN_COUNT = 10_815;
const STAGING_COUNT = 81_507;
const WATERMARK = new Date('2026-09-18T10:00:00.000Z');

jest.setTimeout(180_000);

describeIntegration('accepted publication at required scale', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violations", "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  it('commits 10,000 properties, 10,815 BINs, and 81,507 candidates within its finite budget', async () => {
    const previousRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.COMPLETED,
        triggerType: IngestionTriggerType.MANUAL,
        initializationComplete: true,
        expectedPropertyBinCount: 0,
        expectedBinCount: 0,
        expectedBatchCount: 0,
        startedAt: new Date(WATERMARK.getTime() - 120_000),
        finishedAt: new Date(WATERMARK.getTime() - 60_000),
        sourceWatermarkAtStart: WATERMARK,
        sourceWatermarkAtEnd: WATERMARK,
      },
    });
    const run = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "properties" (
        "id", "identifier_version", "bbl", "borough", "block", "lot", "resolved_at"
      )
      SELECT
        gen_random_uuid(), 1,
        '1' || lpad((sequence / 10000)::text, 5, '0') || lpad((sequence % 10000)::text, 4, '0'),
        1, sequence / 10000, sequence % 10000, ${WATERMARK}
      FROM generate_series(1, ${PROPERTY_COUNT}) AS sequence
    `);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "property_dataset_coverage" ("property_id", "dataset", "status")
      SELECT "id", ${Dataset.DOB_ECB_VIOLATIONS}::"Dataset",
        ${CoverageStatus.NOT_CHECKED}::"CoverageStatus"
      FROM "properties"
    `);
    await prisma.$executeRaw(Prisma.sql`
      WITH ranked AS MATERIALIZED (
        SELECT "id", "identifier_version", row_number() OVER (ORDER BY "bbl")::integer AS sequence
        FROM "properties"
      )
      INSERT INTO "ingestion_run_property_bins" (
        "run_id", "property_id", "property_identifier_version", "bin"
      )
      SELECT ${run.id}::uuid, "id", "identifier_version", (1000000 + sequence)::text FROM ranked
      UNION ALL
      SELECT ${run.id}::uuid, "id", "identifier_version", (2000000 + sequence)::text
      FROM ranked WHERE sequence <= ${BIN_COUNT - PROPERTY_COUNT}
    `);

    const bins = Array.from({ length: BIN_COUNT }, (_, index) =>
      index < PROPERTY_COUNT
        ? String(1_000_001 + index)
        : String(2_000_001 + index - PROPERTY_COUNT),
    ).sort();
    await prisma.ingestionBatch.createMany({
      data: Array.from({ length: 11 }, (_, index) => ({
        runId: run.id,
        batchNumber: index + 1,
        status: IngestionBatchStatus.COMPLETED,
        batchDefinition: { bins: bins.slice(index * 1_000, (index + 1) * 1_000) },
        completedAt: WATERMARK,
      })),
    });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ecb_violation_staging" (
        "id", "run_id", "source_id", "socrata_row_id", "bin", "violation_number",
        "source_row_updated_at", "created_at", "updated_at"
      )
      SELECT
        gen_random_uuid(), ${run.id}::uuid, 'scale-' || sequence, 'row-' || sequence,
        (1000001 + ((sequence - 1) % ${PROPERTY_COUNT}))::text,
        'V-' || sequence, ${WATERMARK}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM generate_series(1, ${STAGING_COUNT}) AS sequence
    `);
    await prisma.ecbViolation.create({
      data: {
        sourceId: 'missing-from-accepted-run',
        socrataRowId: 'old-row',
        bin: '1000001',
        sourceRowUpdatedAt: WATERMARK,
        lastSuccessRunId: previousRun.id,
      },
    });
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: IngestionRunStatus.RUNNING,
        initializationComplete: true,
        expectedPropertyBinCount: BIN_COUNT,
        expectedBinCount: BIN_COUNT,
        expectedBatchCount: 11,
        startedAt: WATERMARK,
        sourceWatermarkAtStart: WATERMARK,
        sourceWatermarkAtEnd: WATERMARK,
      },
    });

    let liveStateFinishedAt = 0;
    let coverageFinishedAt = 0;
    const publicationStartedAt = Date.now();
    const result = await new AcceptedPublicationService({
      prisma,
      transactionTimeoutMs: CONFIG_DEFAULTS.ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS,
      testHooks: {
        afterLiveState: async () => { liveStateFinishedAt = Date.now(); },
        afterCoverage: async () => { coverageFinishedAt = Date.now(); },
      },
    }).publish(run.id, new IngestionExecutionAuthority());
    const publicationFinishedAt = Date.now();

    expect(result).toMatchObject({
      run: { status: IngestionRunStatus.COMPLETED },
      liveState: { promotedCount: STAGING_COUNT, reconciledCount: 1 },
      coverage: { checkedCount: PROPERTY_COUNT, identifiersChangedCount: 0 },
    });
    expect(liveStateFinishedAt - publicationStartedAt).toBeLessThan(
      CONFIG_DEFAULTS.ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS,
    );
    expect(coverageFinishedAt - liveStateFinishedAt).toBeLessThan(
      CONFIG_DEFAULTS.ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS,
    );
    expect(publicationFinishedAt - publicationStartedAt).toBeLessThan(
      CONFIG_DEFAULTS.ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS,
    );
    expect(await prisma.ecbViolation.count({ where: { isCurrent: true } })).toBe(STAGING_COUNT);
    expect(await prisma.propertyDatasetCoverage.count({
      where: { status: CoverageStatus.CHECKED, lastSuccessRunId: run.id },
    })).toBe(PROPERTY_COUNT);
  }, 180_000);
});
