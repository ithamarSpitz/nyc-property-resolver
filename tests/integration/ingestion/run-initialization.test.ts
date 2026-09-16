import {
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import { SocrataClientError, SOCRATA_ERROR_CODES } from '../../../src/clients/socrata.client';
import { CONFIG_DEFAULTS } from '../../../src/config/defaults';
import {
  buildBatchDefinitions,
  createIngestionInitializationService,
  rowsUpdatedAtToDate,
} from '../../../src/services/ecb/ingestion-initialization.service';
import { createIngestionBatchRepository } from '../../../src/services/ecb/ingestion-batch.repository';
import {
  IngestionAuthorityLostError,
  IngestionExecutionAuthority,
} from '../../../src/services/ecb/ingestion-lock.service';
import { createIngestionRunRepository } from '../../../src/services/ecb/ingestion-run.repository';
import {
  INGESTION_TERMINAL_FAILURE_REASONS,
  type IngestionTerminalPublicationPort,
  type IngestionTerminalPublicationRequest,
} from '../../../src/services/ecb/ingestion-terminal-publication.port';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

/** Same Unix-seconds watermark the Socrata client contract test returns unchanged. */
const SOCRATA_ROWS_UPDATED_AT_SECONDS = 1_726_000_000;
const EXPECTED_START_WATERMARK = new Date(SOCRATA_ROWS_UPDATED_AT_SECONDS * 1000);

describeIntegration('ingestion run initialization', () => {
  let prisma: PrismaClient;
  let authority: IngestionExecutionAuthority;
  let metadataRowsUpdatedAt = SOCRATA_ROWS_UPDATED_AT_SECONDS;
  let metadataShouldFail = false;
  let revokeAuthorityDuringMetadataFetch = false;
  let terminalPublicationRequests: IngestionTerminalPublicationRequest[];
  let terminalPublicationPort: IngestionTerminalPublicationPort;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    authority = new IngestionExecutionAuthority();
    metadataRowsUpdatedAt = SOCRATA_ROWS_UPDATED_AT_SECONDS;
    metadataShouldFail = false;
    revokeAuthorityDuringMetadataFetch = false;
    terminalPublicationRequests = [];

    terminalPublicationPort = {
      publishTerminalFailure: async (request) => {
        terminalPublicationRequests.push(request);
        return prisma.ingestionRun.update({
          where: { id: request.runId },
          data: {
            status: request.status,
            failureStage: request.failureStage,
            lastError: request.lastError,
            finishedAt: request.finishedAt,
          },
        });
      },
    };

    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  function createService(options: {
    ecbBatchSize?: number;
    testHooks?: {
      afterSnapshotInsert?: () => Promise<void>;
      afterBatchInsert?: () => Promise<void>;
      beforeWatermarkPersist?: () => Promise<void>;
    };
  } = {}) {
    return createIngestionInitializationService({
      prisma,
      runRepository: createIngestionRunRepository(prisma),
      batchRepository: createIngestionBatchRepository(prisma),
      metadataPort: {
        getDatasetMetadata: async () => {
          if (revokeAuthorityDuringMetadataFetch) {
            authority.revoke('lock session ended');
          }
          if (metadataShouldFail) {
            throw new SocrataClientError({
              code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
              kind: 'malformed_payload',
              retryable: false,
              statusCode: 502,
              message: 'metadata unavailable',
            });
          }
          return { rowsUpdatedAt: metadataRowsUpdatedAt };
        },
      },
      terminalPublicationPort,
      ecbBatchSize: options.ecbBatchSize ?? 3,
      socrataPageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE,
      testHooks: options.testHooks,
    });
  }

  async function seedProperty(
    bbl: string,
    bins: readonly string[],
    identifierVersion = 1,
  ) {
    return prisma.property.create({
      data: {
        bbl,
        borough: 1,
        block: Number.parseInt(bbl.slice(1, 6), 10),
        lot: Number.parseInt(bbl.slice(6), 10),
        identifierVersion,
        resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
        bins: {
          create: bins.map((bin) => ({ bin })),
        },
      },
      include: { bins: true },
    });
  }

  it('persists the snapshot, deterministic batches, expected counts, start watermark, and RUNNING state', async () => {
    await seedProperty('1000750001', ['1000001', '1000002']);
    await seedProperty('1000750002', ['1000002', '1000003', '1000004']);

    const service = createService({ ecbBatchSize: 2 });
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    const result = await service.initializeAndStartRun(queuedRun.id, authority);
    expect(result.outcome).toBe('RUNNING');

    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: queuedRun.id } });
    expect(run.status).toBe(IngestionRunStatus.RUNNING);
    expect(run.initializationComplete).toBe(true);
    expect(run.sourceWatermarkAtStart).toEqual(EXPECTED_START_WATERMARK);
    expect(run.sourceWatermarkAtStart).toEqual(rowsUpdatedAtToDate(SOCRATA_ROWS_UPDATED_AT_SECONDS));
    expect(run.sourceWatermarkAtStart).not.toEqual(new Date(SOCRATA_ROWS_UPDATED_AT_SECONDS));
    expect(run.expectedPropertyBinCount).toBe(5);
    expect(run.expectedBinCount).toBe(4);
    expect(run.expectedBatchCount).toBe(2);

    const snapshot = await prisma.ingestionRunPropertyBin.findMany({
      where: { runId: queuedRun.id },
      orderBy: [{ bin: 'asc' }, { propertyId: 'asc' }],
    });
    expect(snapshot).toHaveLength(5);

    const batches = await prisma.ingestionBatch.findMany({
      where: { runId: queuedRun.id },
      orderBy: { batchNumber: 'asc' },
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]?.batchDefinition).toEqual({
      bins: ['1000001', '1000002'],
      pageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE,
    });
    expect(batches[1]?.batchDefinition).toEqual({
      bins: ['1000003', '1000004'],
      pageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE,
    });
  });

  it('leaves no partial initialized snapshot or batches when initialization fails inside the transaction', async () => {
    await seedProperty('1000750003', ['1000010']);

    const service = createService({
      testHooks: {
        afterSnapshotInsert: async () => {
          throw new Error('simulated crash during batch creation');
        },
      },
    });
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    await expect(service.initializeAndStartRun(queuedRun.id, authority)).rejects.toThrow(
      'simulated crash during batch creation',
    );

    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: queuedRun.id } });
    expect(run.status).toBe(IngestionRunStatus.QUEUED);
    expect(run.initializationComplete).toBe(false);
    expect(await prisma.ingestionRunPropertyBin.count({ where: { runId: queuedRun.id } })).toBe(0);
    expect(await prisma.ingestionBatch.count({ where: { runId: queuedRun.id } })).toBe(0);
  });

  it('rebuilds the entire initialization transaction when retrying an uninitialized queued run', async () => {
    const firstProperty = await seedProperty('1000750004', ['1000020']);
    const failingService = createService({
      testHooks: {
        afterBatchInsert: async () => {
          throw new Error('simulated crash after batch insert');
        },
      },
    });
    const queuedRun = await failingService.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    await expect(failingService.initializeAndStartRun(queuedRun.id, authority)).rejects.toThrow(
      'simulated crash after batch insert',
    );

    await prisma.propertyBin.create({
      data: {
        propertyId: firstProperty.id,
        bin: '1000021',
      },
    });

    const retryResult = await createService().initializeAndStartRun(queuedRun.id, authority);
    expect(retryResult.outcome).toBe('RUNNING');

    const snapshot = await prisma.ingestionRunPropertyBin.findMany({
      where: { runId: queuedRun.id },
      orderBy: [{ bin: 'asc' }],
    });
    expect(snapshot.map((row: (typeof snapshot)[number]) => row.bin)).toEqual(['1000020', '1000021']);
  });

  it('does not rebuild snapshot or batches when retrying an initialized queued run with a null watermark', async () => {
    await seedProperty('1000750005', ['1000030', '1000031']);

    const service = createService({ ecbBatchSize: 10 });
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    const failingService = createService({
      ecbBatchSize: 10,
      testHooks: {
        beforeWatermarkPersist: async () => {
          throw new Error('simulated crash before watermark persistence');
        },
      },
    });

    await expect(failingService.initializeAndStartRun(queuedRun.id, authority)).rejects.toThrow(
      'simulated crash before watermark persistence',
    );

    const initializedRun = await prisma.ingestionRun.findUniqueOrThrow({
      where: { id: queuedRun.id },
    });
    expect(initializedRun.initializationComplete).toBe(true);
    expect(initializedRun.sourceWatermarkAtStart).toBeNull();

    const snapshotBeforeRetry = await prisma.ingestionRunPropertyBin.findMany({
      where: { runId: queuedRun.id },
    });
    const batchesBeforeRetry = await prisma.ingestionBatch.findMany({
      where: { runId: queuedRun.id },
    });

    await prisma.propertyBin.create({
      data: {
        propertyId: snapshotBeforeRetry[0]!.propertyId,
        bin: '1000099',
      },
    });

    const retryResult = await service.initializeAndStartRun(queuedRun.id, authority);
    expect(retryResult.outcome).toBe('RUNNING');

    const snapshotAfterRetry = await prisma.ingestionRunPropertyBin.findMany({
      where: { runId: queuedRun.id },
    });
    const batchesAfterRetry = await prisma.ingestionBatch.findMany({
      where: { runId: queuedRun.id },
    });

    expect(snapshotAfterRetry).toEqual(snapshotBeforeRetry);
    expect(batchesAfterRetry).toEqual(batchesBeforeRetry);
    expect(
      await prisma.ingestionRunPropertyBin.count({
        where: { runId: queuedRun.id, bin: '1000099' },
      }),
    ).toBe(0);
  });

  it('prevents transition to RUNNING when persisted expected counts do not match', async () => {
    await seedProperty('1000750006', ['1000040']);

    const service = createService();
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const snapshotRows = await tx.propertyBin.findMany({
        include: { property: { select: { id: true, identifierVersion: true } } },
      });
      await tx.ingestionRunPropertyBin.createMany({
        data: snapshotRows.map((row: (typeof snapshotRows)[number]) => ({
          runId: queuedRun.id,
          propertyId: row.propertyId,
          propertyIdentifierVersion: row.property.identifierVersion,
          bin: row.bin,
        })),
      });
      await tx.ingestionBatch.create({
        data: {
          runId: queuedRun.id,
          batchNumber: 1,
          batchDefinition: { bins: ['1000040'], pageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE },
        },
      });
      await tx.ingestionRun.update({
        where: { id: queuedRun.id },
        data: {
          initializationComplete: true,
          expectedPropertyBinCount: 99,
          expectedBinCount: 1,
          expectedBatchCount: 1,
        },
      });
    });

    await expect(service.initializeAndStartRun(queuedRun.id, authority)).rejects.toThrow(
      'expected_property_bin_count mismatch',
    );

    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: queuedRun.id } });
    expect(run.status).toBe(IngestionRunStatus.QUEUED);
    expect(run.sourceWatermarkAtStart).toBeNull();
  });

  it('delegates terminal start-watermark fetch failure to the publication port', async () => {
    await seedProperty('1000750007', ['1000050']);
    metadataShouldFail = true;

    const service = createService();
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    const result = await service.initializeAndStartRun(queuedRun.id, authority);
    expect(result.outcome).toBe('TERMINAL_FAILURE_PUBLISHED');
    expect(terminalPublicationRequests).toEqual([
      {
        runId: queuedRun.id,
        status: IngestionRunStatus.FAILED,
        failureStage: 'initialization',
        lastError: INGESTION_TERMINAL_FAILURE_REASONS.START_WATERMARK_FETCH_FAILED,
        finishedAt: expect.any(Date),
      },
    ]);

    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: queuedRun.id } });
    expect(run.status).toBe(IngestionRunStatus.FAILED);
    expect(run.lastError).toBe(INGESTION_TERMINAL_FAILURE_REASONS.START_WATERMARK_FETCH_FAILED);
    expect(run.failureStage).toBe('initialization');
    expect(run.sourceWatermarkAtStart).toBeNull();
  });

  it('does not persist RUNNING after start-watermark fetch if execution authority was lost', async () => {
    await seedProperty('1000750009', ['1000070']);
    revokeAuthorityDuringMetadataFetch = true;

    const service = createService();
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    await expect(service.initializeAndStartRun(queuedRun.id, authority)).rejects.toThrow(
      IngestionAuthorityLostError,
    );

    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: queuedRun.id } });
    expect(run.status).toBe(IngestionRunStatus.QUEUED);
    expect(run.initializationComplete).toBe(true);
    expect(run.sourceWatermarkAtStart).toBeNull();
    expect(terminalPublicationRequests).toEqual([]);
  });

  it('does not publish terminal failure after start-watermark fetch if execution authority was lost', async () => {
    await seedProperty('1000750010', ['1000080']);
    revokeAuthorityDuringMetadataFetch = true;
    metadataShouldFail = true;

    const service = createService();
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    await expect(service.initializeAndStartRun(queuedRun.id, authority)).rejects.toThrow(
      IngestionAuthorityLostError,
    );

    expect(terminalPublicationRequests).toEqual([]);
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: queuedRun.id } });
    expect(run.status).toBe(IngestionRunStatus.QUEUED);
    expect(run.initializationComplete).toBe(true);
    expect(run.sourceWatermarkAtStart).toBeNull();
    expect(run.lastError).toBeNull();
  });

  it('keeps the persisted snapshot and batches unchanged when live property_bins change after initialization', async () => {
    const property = await seedProperty('1000750008', ['1000060']);
    const service = createService();
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.MANUAL },
      authority,
    );

    await service.initializeAndStartRun(queuedRun.id, authority);

    const snapshotBefore = await prisma.ingestionRunPropertyBin.findMany({
      where: { runId: queuedRun.id },
    });
    const batchesBefore = await prisma.ingestionBatch.findMany({
      where: { runId: queuedRun.id },
    });

    await prisma.propertyBin.create({
      data: {
        propertyId: property.id,
        bin: '1000066',
      },
    });
    await prisma.propertyBin.deleteMany({
      where: {
        propertyId: property.id,
        bin: '1000060',
      },
    });

    const snapshotAfter = await prisma.ingestionRunPropertyBin.findMany({
      where: { runId: queuedRun.id },
    });
    const batchesAfter = await prisma.ingestionBatch.findMany({
      where: { runId: queuedRun.id },
    });

    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(batchesAfter).toEqual(batchesBefore);
  });

  it('creates a durable queued run immediately with no start watermark', async () => {
    const service = createService();
    const queuedRun = await service.createQueuedRun(
      { triggerType: IngestionTriggerType.SCHEDULED },
      authority,
    );

    expect(queuedRun.status).toBe(IngestionRunStatus.QUEUED);
    expect(queuedRun.dataset).toBe(Dataset.DOB_ECB_VIOLATIONS);
    expect(queuedRun.initializationComplete).toBe(false);
    expect(queuedRun.sourceWatermarkAtStart).toBeNull();
  });

  it('partitions sorted distinct bins deterministically by configured batch size', () => {
    const definitions = buildBatchDefinitions(
      ['1000001', '1000002', '1000003', '1000004', '1000005'],
      2,
      CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE,
    );

    expect(definitions).toEqual([
      { bins: ['1000001', '1000002'], pageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE },
      { bins: ['1000003', '1000004'], pageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE },
      { bins: ['1000005'], pageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE },
    ]);
  });
});
