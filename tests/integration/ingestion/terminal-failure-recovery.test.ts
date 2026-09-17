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
  EcbIngestionService,
  INGESTION_EXECUTION_OUTCOMES,
} from '../../../src/services/ecb/ingestion.service';
import { TerminalPublicationService } from '../../../src/services/ecb/terminal-publication.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;
const WATERMARK = new Date('2026-09-17T10:00:00.000Z');

class TestLockClient extends EventEmitter implements IngestionLockClient {
  async connect(): Promise<void> {}

  async query(query: string): Promise<{ rows: Array<{ acquired?: boolean; released?: boolean }> }> {
    return query.includes('pg_try_advisory_lock')
      ? { rows: [{ acquired: true }] }
      : { rows: [{ released: true }] };
  }

  async end(): Promise<void> {}
}

describeIntegration('terminal failure recovery', () => {
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

  it('publishes a persisted RUNNING run with an already exhausted batch without rebuilding work', async () => {
    const property = await prisma.property.create({
      data: {
        bbl: '1000010001',
        borough: 1,
        block: 1,
        lot: 1,
        resolvedAt: WATERMARK,
        bins: { create: { bin: '1000001' } },
        datasetCoverage: {
          create: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: CoverageStatus.NOT_CHECKED,
          },
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
        status: IngestionBatchStatus.FAILED,
        attemptCount: 3,
        batchDefinition: { bins: ['1000001'], pageSize: 50_000 },
        lastError: 'PERSISTED_CONCRETE_FAILURE',
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
        sourceWatermarkAtStart: WATERMARK,
        startedAt: WATERMARK,
      },
    });
    const originalSnapshot = await prisma.ingestionRunPropertyBin.findMany({
      where: { runId: run.id },
    });
    const originalBatches = await prisma.ingestionBatch.findMany({ where: { runId: run.id } });

    const lockService = new EcbIngestionLockService({
      connectionString: process.env.DATABASE_URL!,
      clientFactory: () => new TestLockClient(),
    });
    const fetchImpl = jest.fn(async (_input: string | URL | Request) => {
      throw new Error('source fetch must not run for an exhausted persisted batch');
    }) as jest.MockedFunction<typeof fetch>;
    const terminalPublicationService = new TerminalPublicationService({
      prisma,
      executionAuthority: () => lockService.authority,
    });
    const getDatasetMetadata = jest.fn(async () => {
      throw new Error('metadata fetch must not run for an exhausted persisted batch');
    });
    const ingestion = new EcbIngestionService({
      prisma,
      connectionString: process.env.DATABASE_URL!,
      lockService,
      fetchImpl,
      metadataPort: { getDatasetMetadata },
      terminalPublicationPort: terminalPublicationService,
      batchProcessorConfig: { maxBatchAttemptsPerRun: 3 },
    });

    const result = await ingestion.execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result).toMatchObject({
      outcome: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
      run: {
        id: run.id,
        status: IngestionRunStatus.FAILED,
        lastError: 'PERSISTED_CONCRETE_FAILURE',
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDatasetMetadata).not.toHaveBeenCalled();
    expect(await prisma.ingestionRunPropertyBin.findMany({ where: { runId: run.id } })).toEqual(
      originalSnapshot,
    );
    expect(await prisma.ingestionBatch.findMany({ where: { runId: run.id } })).toEqual(
      originalBatches,
    );
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.FAILED,
      lastAttemptRunId: run.id,
      lastError: 'PERSISTED_CONCRETE_FAILURE',
    });
  });
});
