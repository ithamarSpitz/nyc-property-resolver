import { EventEmitter } from 'node:events';

import {
  CoverageStatus,
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import {
  EcbIngestionLockService,
  type IngestionLockClient,
} from '../../../src/services/ecb/ingestion-lock.service';
import {
  EcbIngestionRunnerService,
  INGESTION_RUNNER_OUTCOMES,
} from '../../../src/services/ecb/ingestion-runner.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;
const WATERMARK = new Date('2026-09-18T10:00:00.000Z');

class TestLockClient extends EventEmitter implements IngestionLockClient {
  async connect(): Promise<void> {}
  async query(query: string): Promise<{ rows: Array<{ acquired?: boolean; released?: boolean }> }> {
    return query.includes('pg_try_advisory_lock')
      ? { rows: [{ acquired: true }] }
      : { rows: [{ released: true }] };
  }
  async end(): Promise<void> {}
}

describeIntegration('accepted publication recovery', () => {
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

  it('publishes an already-extracted RUNNING run without rebuilding or repeating source work', async () => {
    const property = await prisma.property.create({
      data: {
        bbl: '1000010001', borough: 1, block: 1, lot: 1, resolvedAt: WATERMARK,
        bins: { create: { bin: '1000001' } },
        datasetCoverage: {
          create: { dataset: Dataset.DOB_ECB_VIOLATIONS, status: CoverageStatus.NOT_CHECKED },
        },
      },
    });
    const run = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    await prisma.ingestionRunPropertyBin.create({
      data: {
        runId: run.id,
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bin: '1000001',
      },
    });
    await prisma.ingestionBatch.create({
      data: {
        runId: run.id,
        batchNumber: 1,
        status: IngestionBatchStatus.COMPLETED,
        batchDefinition: { bins: ['1000001'], pageSize: 50_000 },
        completedAt: WATERMARK,
      },
    });
    await prisma.ecbViolationStaging.create({
      data: {
        runId: run.id,
        sourceId: 'persisted-candidate',
        socrataRowId: 'persisted-candidate',
        bin: '1000001',
        sourceRowUpdatedAt: WATERMARK,
      },
    });
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: IngestionRunStatus.RUNNING,
        initializationComplete: true,
        expectedPropertyBinCount: 1,
        expectedBinCount: 1,
        expectedBatchCount: 1,
        startedAt: WATERMARK,
        sourceWatermarkAtStart: WATERMARK,
        sourceWatermarkAtEnd: WATERMARK,
      },
    });
    const originalSnapshot = await prisma.ingestionRunPropertyBin.findMany({ where: { runId: run.id } });
    const originalBatches = await prisma.ingestionBatch.findMany({ where: { runId: run.id } });

    const fetchImpl = jest.fn(async (_input: string | URL | Request) => {
      throw new Error('completed source work must not repeat');
    }) as jest.MockedFunction<typeof fetch>;
    const getDatasetMetadata = jest.fn(async () => {
      throw new Error('persisted matching watermarks must not be fetched again');
    });
    const lockService = new EcbIngestionLockService({
      connectionString: process.env.DATABASE_URL!,
      clientFactory: () => new TestLockClient(),
    });
    const runner = new EcbIngestionRunnerService({
      prisma,
      connectionString: process.env.DATABASE_URL!,
      lockService,
      fetchImpl,
      metadataPort: { getDatasetMetadata },
    });

    const result = await runner.execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result).toMatchObject({
      outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
      run: { id: run.id, status: IngestionRunStatus.COMPLETED },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDatasetMetadata).not.toHaveBeenCalled();
    expect(await prisma.ingestionRunPropertyBin.findMany({ where: { runId: run.id } })).toEqual(
      originalSnapshot,
    );
    expect(await prisma.ingestionBatch.findMany({ where: { runId: run.id } })).toEqual(
      originalBatches,
    );
    await expect(prisma.ecbViolation.findUniqueOrThrow({
      where: { sourceId: 'persisted-candidate' },
    })).resolves.toMatchObject({ isCurrent: true, lastSuccessRunId: run.id });
    await expect(prisma.propertyDatasetCoverage.findUniqueOrThrow({
      where: { propertyId_dataset: { propertyId: property.id, dataset: Dataset.DOB_ECB_VIOLATIONS } },
    })).resolves.toMatchObject({ status: CoverageStatus.CHECKED, lastSuccessRunId: run.id });
  });
});
