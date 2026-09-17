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
import { IngestionExecutionAuthority } from '../../../src/services/ecb/ingestion-lock.service';
import {
  TERMINAL_COVERAGE_ERRORS,
  TerminalPublicationService,
} from '../../../src/services/ecb/terminal-publication.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

const PROPERTY_COUNT = 10_000;
const EXTRA_BIN_COUNT = 815;
const FINISHED_AT = new Date('2026-09-17T12:00:00.000Z');
const WATERMARK = new Date('2026-09-17T11:00:00.000Z');

describeIntegration('terminal failure publication at acceptance scale', () => {
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

  it(
    'atomically commits 10,000 property / 10,815 BIN failed coverage within the finite budget',
    async () => {
      const previousRun = await prisma.ingestionRun.create({
        data: {
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status: IngestionRunStatus.COMPLETED,
          triggerType: IngestionTriggerType.MANUAL,
          initializationComplete: true,
          expectedPropertyBinCount: 0,
          expectedBinCount: 0,
          expectedBatchCount: 0,
          sourceWatermarkAtStart: WATERMARK,
          sourceWatermarkAtEnd: WATERMARK,
          startedAt: new Date(WATERMARK.getTime() - 60_000),
          finishedAt: WATERMARK,
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
          gen_random_uuid(),
          1,
          '1' || lpad((sequence / 10000)::text, 5, '0') || lpad((sequence % 10000)::text, 4, '0'),
          1,
          sequence / 10000,
          sequence % 10000,
          ${WATERMARK}
        FROM generate_series(1, ${PROPERTY_COUNT}) AS sequence
      `);
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "property_dataset_coverage" (
          "property_id", "dataset", "status", "last_attempt_run_id", "last_success_run_id",
          "last_attempt_at", "last_success_at", "source_watermark_at"
        )
        SELECT
          "id",
          ${Dataset.DOB_ECB_VIOLATIONS}::"Dataset",
          ${CoverageStatus.CHECKED}::"CoverageStatus",
          ${previousRun.id}::uuid,
          ${previousRun.id}::uuid,
          ${WATERMARK},
          ${WATERMARK},
          ${WATERMARK}
        FROM "properties"
      `);
      await prisma.$executeRaw(Prisma.sql`
        WITH ranked_properties AS MATERIALIZED (
          SELECT
            "id",
            "identifier_version",
            row_number() OVER (ORDER BY "bbl")::integer AS "sequence"
          FROM "properties"
        )
        INSERT INTO "ingestion_run_property_bins" (
          "run_id", "property_id", "property_identifier_version", "bin"
        )
        SELECT ${run.id}::uuid, "id", "identifier_version", (1000000 + "sequence")::text
        FROM ranked_properties
        UNION ALL
        SELECT ${run.id}::uuid, "id", "identifier_version", (2000000 + "sequence")::text
        FROM ranked_properties
        WHERE "sequence" <= ${EXTRA_BIN_COUNT}
      `);

      const bins = Array.from({ length: PROPERTY_COUNT + EXTRA_BIN_COUNT }, (_, index) =>
        index < PROPERTY_COUNT
          ? String(1_000_001 + index)
          : String(2_000_001 + index - PROPERTY_COUNT),
      ).sort();
      await prisma.ingestionBatch.createMany({
        data: Array.from({ length: 11 }, (_, index) => ({
          runId: run.id,
          batchNumber: index + 1,
          status: index === 0 ? IngestionBatchStatus.FAILED : IngestionBatchStatus.PENDING,
          attemptCount: index === 0 ? 3 : 0,
          batchDefinition: { bins: bins.slice(index * 1_000, (index + 1) * 1_000) },
          lastError: index === 0 ? 'UPSTREAM_TIMEOUT' : null,
        })),
      });
      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: IngestionRunStatus.RUNNING,
          initializationComplete: true,
          expectedPropertyBinCount: PROPERTY_COUNT + EXTRA_BIN_COUNT,
          expectedBinCount: PROPERTY_COUNT + EXTRA_BIN_COUNT,
          expectedBatchCount: 11,
          sourceWatermarkAtStart: WATERMARK,
          startedAt: WATERMARK,
        },
      });
      expect(
        await prisma.ingestionRunPropertyBin.count({ where: { runId: run.id } }),
      ).toBe(PROPERTY_COUNT + EXTRA_BIN_COUNT);

      const startedAt = Date.now();
      const terminalRun = await new TerminalPublicationService({
        prisma,
        transactionTimeoutMs: CONFIG_DEFAULTS.TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS,
      }).publishTerminalFailure(
        {
          runId: run.id,
          status: IngestionRunStatus.FAILED,
          failureStage: 'batch_processing',
          lastError: 'UPSTREAM_TIMEOUT',
          finishedAt: FINISHED_AT,
        },
        new IngestionExecutionAuthority(),
      );
      const elapsedMs = Date.now() - startedAt;

      expect(terminalRun).toMatchObject({
        status: IngestionRunStatus.FAILED,
        finishedAt: FINISHED_AT,
      });
      expect(elapsedMs).toBeLessThan(
        CONFIG_DEFAULTS.TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS,
      );
      expect(
        await prisma.propertyDatasetCoverage.count({
          where: { lastAttemptRunId: run.id, status: CoverageStatus.FAILED },
        }),
      ).toBe(PROPERTY_COUNT);
      expect(
        await prisma.propertyDatasetCoverage.count({
          where: { lastAttemptRunId: run.id, lastError: 'UPSTREAM_TIMEOUT' },
        }),
      ).toBeGreaterThan(0);
      expect(
        await prisma.propertyDatasetCoverage.count({
          where: {
            lastAttemptRunId: run.id,
            lastError: TERMINAL_COVERAGE_ERRORS.RUN_NOT_PROMOTED,
          },
        }),
      ).toBeGreaterThan(0);
      expect(
        await prisma.propertyDatasetCoverage.count({
          where: {
            lastSuccessRunId: previousRun.id,
            lastSuccessAt: WATERMARK,
            sourceWatermarkAt: WATERMARK,
          },
        }),
      ).toBe(PROPERTY_COUNT);
    },
    120_000,
  );
});
