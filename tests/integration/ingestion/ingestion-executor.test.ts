import { EventEmitter } from 'node:events';

import {
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import { CONFIG_DEFAULTS } from '../../../src/config/defaults';
import { FAILED_PAGE_LIMIT_ERROR } from '../../../src/services/ecb/batch-processor.service';
import {
  EcbIngestionService,
  INGESTION_EXECUTION_OUTCOMES,
  INGESTION_TERMINAL_ERRORS,
  INGESTION_TERMINAL_STAGES,
} from '../../../src/services/ecb/ingestion.service';
import {
  EcbIngestionLockService,
  type IngestionLockClient,
} from '../../../src/services/ecb/ingestion-lock.service';
import {
  rowsUpdatedAtToDate,
  type DatasetMetadataPort,
} from '../../../src/services/ecb/ingestion-initialization.service';
import type {
  IngestionTerminalPublicationPort,
  IngestionTerminalPublicationRequest,
} from '../../../src/services/ecb/ingestion-terminal-publication.port';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

const START_WATERMARK_SECONDS = 1_726_000_000;
const START_WATERMARK = rowsUpdatedAtToDate(START_WATERMARK_SECONDS);

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function response(payload: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function asResponse(value: MockResponse): Response {
  return value as unknown as Response;
}

class FakeLockClient extends EventEmitter implements IngestionLockClient {
  readonly connect = jest.fn(async () => undefined);
  readonly end = jest.fn(async () => {
    this.emit('end');
  });
  readonly queries: Array<{ query: string; values: unknown[] }> = [];
  queryResult = { acquired: true };

  async query(query: string, values: unknown[] = []): Promise<{ rows: Array<{ acquired: boolean }> }> {
    this.queries.push({ query, values });
    return { rows: [this.queryResult] };
  }
}

describeIntegration('ECB ingestion executor', () => {
  const connectionString = process.env.DATABASE_URL as string;
  let prisma: PrismaClient;
  let metadataRowsUpdatedAt = START_WATERMARK_SECONDS;
  let endMetadataRowsUpdatedAt = START_WATERMARK_SECONDS;
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
    metadataRowsUpdatedAt = START_WATERMARK_SECONDS;
    endMetadataRowsUpdatedAt = START_WATERMARK_SECONDS;
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

  function row(sourceId: string, bin = '1012345', updatedAt = '2026-01-02T03:04:05.000Z') {
    return {
      isn_dob_bis_extract: sourceId,
      ':id': `socrata-${sourceId}`,
      ':updated_at': updatedAt,
      bin,
      ecb_violation_number: `ECB-${sourceId}`,
      issue_date: '20260203',
      ecb_violation_status: 'ACTIVE',
      balance_due: '-125.50',
    };
  }

  function metadataPort(): DatasetMetadataPort {
    let metadataCalls = 0;
    return {
      getDatasetMetadata: async () => {
        metadataCalls += 1;
        return {
          rowsUpdatedAt:
            metadataCalls % 2 === 1 ? metadataRowsUpdatedAt : endMetadataRowsUpdatedAt,
        };
      },
    };
  }

  async function seedProperty(bbl: string, bins: readonly string[]) {
    return prisma.property.create({
      data: {
        bbl,
        borough: 1,
        block: Number.parseInt(bbl.slice(1, 6), 10),
        lot: Number.parseInt(bbl.slice(6), 10),
        resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
        bins: {
          create: bins.map((bin) => ({ bin })),
        },
      },
      include: { bins: true },
    });
  }

  function createExecutor(options: {
    fetchImpl: jest.MockedFunction<typeof fetch>;
    ecbBatchSize?: number;
    socrataPageSize?: number;
    lockService?: EcbIngestionLockService;
    metadata?: DatasetMetadataPort;
    batchProcessorConfig?: {
      socrataMaxPagesPerBatch?: number;
      maxBatchAttemptsPerRun?: number;
      socrataPageSize?: number;
    };
  }) {
    const socrataPageSize = options.socrataPageSize ?? CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE;
    return new EcbIngestionService({
      prisma,
      connectionString,
      metadataPort: options.metadata ?? metadataPort(),
      terminalPublicationPort,
      ecbBatchSize: options.ecbBatchSize ?? 2,
      socrataPageSize,
      fetchImpl: options.fetchImpl,
      lockService: options.lockService,
      batchProcessorConfig: {
        socrataPageSize,
        ...options.batchProcessorConfig,
      },
    });
  }

  it('acquires authority, initializes a new run, processes persisted batches, and returns READY_FOR_PUBLICATION when watermarks match', async () => {
    await seedProperty('1000750001', ['1000001']);
    await seedProperty('1000750002', ['1000002']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async (input) => {
      const where = new URL(input as string).searchParams.get('$where') ?? '';
      const bin = where.includes('1000002') ? '1000002' : '1000001';
      return asResponse(response([row(`ECB-${bin}`, bin)]));
    });

    const executor = createExecutor({ fetchImpl, ecbBatchSize: 1 });
    const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result).toMatchObject({
      outcome: INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION,
      run: {
        status: IngestionRunStatus.RUNNING,
        sourceWatermarkAtStart: START_WATERMARK,
        sourceWatermarkAtEnd: START_WATERMARK,
      },
    });
    expect(terminalPublicationRequests).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await prisma.ingestionBatch.count()).toBe(2);
    expect(
      await prisma.ingestionBatch.count({
        where: { status: IngestionBatchStatus.COMPLETED },
      }),
    ).toBe(2);
    expect(await prisma.ecbViolationStaging.count()).toBe(2);
    expect(await prisma.propertyDatasetCoverage.count()).toBe(0);
  });

  it('resumes a running run by skipping completed batches and continuing only incomplete work', async () => {
    const propertyA = await seedProperty('1000750003', ['1000010']);
    await seedProperty('1000750004', ['1000020']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async (input) => {
      const where = new URL(input as string).searchParams.get('$where') ?? '';
      const bin = where.includes('1000020') ? '1000020' : '1000010';
      return asResponse(response([row(`ECB-${bin}`, bin)]));
    });

    const executor = createExecutor({ fetchImpl, ecbBatchSize: 1 });
    const firstResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(firstResult.outcome).toBe(INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION);

    const runId = (firstResult as { run: { id: string } }).run.id;
    expect(
      await prisma.ingestionBatch.count({
        where: { runId, status: IngestionBatchStatus.COMPLETED },
      }),
    ).toBe(2);

    await prisma.ingestionRun.update({
      where: { id: runId },
      data: {
        status: IngestionRunStatus.RUNNING,
        sourceWatermarkAtEnd: null,
      },
    });
    await prisma.ingestionBatch.update({
      where: { runId_batchNumber: { runId, batchNumber: 1 } },
      data: { status: IngestionBatchStatus.COMPLETED },
    });
    await prisma.ingestionBatch.update({
      where: { runId_batchNumber: { runId, batchNumber: 2 } },
      data: {
        status: IngestionBatchStatus.PENDING,
        attemptCount: 0,
        pagesFetched: 0,
        rowsFetched: 0,
        completedAt: null,
        lastError: null,
      },
    });

    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async () => asResponse(response([row('ECB-2', '1000020')])));

    const resumeResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(resumeResult).toMatchObject({
      outcome: INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION,
      run: { id: runId },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      await prisma.ingestionBatch.findUnique({
        where: { runId_batchNumber: { runId, batchNumber: 2 } },
      }),
    ).toMatchObject({
      status: IngestionBatchStatus.COMPLETED,
      rowsFetched: 1,
    });

    await prisma.propertyBin.create({
      data: { propertyId: propertyA.id, bin: '1000098' },
    });
    const snapshotAfterResume = await prisma.ingestionRunPropertyBin.findMany({ where: { runId } });
    expect(snapshotAfterResume.some((entry) => entry.bin === '1000098')).toBe(false);
  });

  it('keeps persisted batch definitions when the live watchlist changes before resume', async () => {
    const property = await seedProperty('1000750005', ['1000030', '1000031']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => asResponse(response([row('ECB-1', '1000030')])));

    const executor = createExecutor({ fetchImpl, ecbBatchSize: 1 });
    const firstResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
    const runId = (firstResult as { run: { id: string } }).run.id;

    const batchesBefore = await prisma.ingestionBatch.findMany({
      where: { runId },
      orderBy: { batchNumber: 'asc' },
    });
    const snapshotBefore = await prisma.ingestionRunPropertyBin.findMany({ where: { runId } });

    await prisma.ingestionRun.update({
      where: { id: runId },
      data: { status: IngestionRunStatus.RUNNING, sourceWatermarkAtEnd: null },
    });
    await prisma.ingestionBatch.updateMany({
      where: { runId, batchNumber: 2 },
      data: { status: IngestionBatchStatus.PENDING, attemptCount: 0, pagesFetched: 0, rowsFetched: 0 },
    });

    await prisma.propertyBin.create({ data: { propertyId: property.id, bin: '1000099' } });
    await prisma.propertyBin.deleteMany({
      where: { propertyId: property.id, bin: '1000031' },
    });

    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async (input) => {
      const where = new URL(input as string).searchParams.get('$where');
      return asResponse(response([row('ECB-2', where?.includes('1000031') ? '1000031' : '1000030')]));
    });

    const resumeResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(resumeResult.outcome).toBe(INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION);

    const batchesAfter = await prisma.ingestionBatch.findMany({
      where: { runId },
      orderBy: { batchNumber: 'asc' },
    });
    const snapshotAfter = await prisma.ingestionRunPropertyBin.findMany({ where: { runId } });

    expect(batchesAfter.map((batch) => batch.batchDefinition)).toEqual(
      batchesBefore.map((batch) => batch.batchDefinition),
    );
    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).searchParams.get('$where')).toBe(
      "bin in ('1000031')",
    );
    expect(
      await prisma.ingestionRunPropertyBin.count({ where: { runId, bin: '1000099' } }),
    ).toBe(0);
  });

  it('delegates SOURCE_CHANGED on resume watermark mismatch before reusing completed batches', async () => {
    await seedProperty('1000750006', ['1000040', '1000041']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => asResponse(response([row('ECB-1', '1000040')])));

    const executor = createExecutor({ fetchImpl, ecbBatchSize: 1 });
    const firstResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
    const runId = (firstResult as { run: { id: string } }).run.id;

    await prisma.ingestionRun.update({
      where: { id: runId },
      data: { status: IngestionRunStatus.RUNNING, sourceWatermarkAtEnd: null },
    });
    await prisma.ingestionBatch.updateMany({
      where: { runId, batchNumber: 2 },
      data: {
        status: IngestionBatchStatus.PENDING,
        attemptCount: 0,
        pagesFetched: 0,
        rowsFetched: 0,
        completedAt: null,
        lastError: null,
      },
    });

    metadataRowsUpdatedAt = START_WATERMARK_SECONDS + 60;
    endMetadataRowsUpdatedAt = START_WATERMARK_SECONDS + 60;
    fetchImpl.mockClear();

    const resumeResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(resumeResult).toMatchObject({
      outcome: INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
      run: {
        id: runId,
        status: IngestionRunStatus.SOURCE_CHANGED,
        lastError: INGESTION_TERMINAL_ERRORS.SOURCE_CHANGED,
        failureStage: INGESTION_TERMINAL_STAGES.WATERMARK_GUARD,
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await prisma.ingestionBatch.findUnique({
        where: { runId_batchNumber: { runId, batchNumber: 2 } },
      }),
    ).toMatchObject({
      status: IngestionBatchStatus.PENDING,
      attemptCount: 0,
    });
    expect(terminalPublicationRequests).toEqual([
      {
        runId,
        status: IngestionRunStatus.SOURCE_CHANGED,
        failureStage: INGESTION_TERMINAL_STAGES.WATERMARK_GUARD,
        lastError: INGESTION_TERMINAL_ERRORS.SOURCE_CHANGED,
        finishedAt: expect.any(Date),
      },
    ]);
  });

  it('stops further batches and publishes terminal failure on page-limit exhaustion', async () => {
    await seedProperty('1000750007', ['1000050', '1000051']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () =>
      asResponse(
        response([
          row(`ECB-${fetchImpl.mock.calls.length + 1}`, '1000050', `2026-01-02T03:04:0${fetchImpl.mock.calls.length + 5}.000Z`),
        ]),
      ),
    );

    const executor = createExecutor({
      fetchImpl,
      ecbBatchSize: 1,
      socrataPageSize: 1,
      batchProcessorConfig: { socrataMaxPagesPerBatch: 1 },
    });

    const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(result).toMatchObject({
      outcome: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
      run: {
        status: IngestionRunStatus.FAILED,
        failureStage: INGESTION_TERMINAL_STAGES.BATCH_PROCESSING,
        lastError: FAILED_PAGE_LIMIT_ERROR,
      },
    });
    expect(terminalPublicationRequests).toHaveLength(1);
    expect(
      await prisma.ingestionBatch.count({
        where: { status: IngestionBatchStatus.COMPLETED },
      }),
    ).toBe(0);
    expect(await prisma.ingestionBatch.count({ where: { status: IngestionBatchStatus.FAILED } })).toBe(
      1,
    );
  });

  it('aborts source work and prevents publication handoff when execution authority is lost', async () => {
    await seedProperty('1000750008', ['1000060']);

    const fakeClient = new FakeLockClient();
    const lockService = new EcbIngestionLockService({
      connectionString,
      clientFactory: () => fakeClient,
    });

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(asResponse(response([row('ECB-1', '1000060')])))
      .mockImplementation(async () => {
        fakeClient.emit('end');
        return asResponse(response([row('ECB-2', '1000060')]));
      });

    const executor = createExecutor({
      fetchImpl,
      ecbBatchSize: 10,
      socrataPageSize: 1,
      lockService,
    });
    const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result).toEqual({
      outcome: INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST,
    });
    expect(terminalPublicationRequests).toEqual([]);
    expect(await prisma.ingestionBatch.findFirst()).toMatchObject({
      status: IngestionBatchStatus.RUNNING,
      completedAt: null,
    });
    expect(await prisma.ingestionRun.findFirst()).toMatchObject({
      status: IngestionRunStatus.RUNNING,
      sourceWatermarkAtEnd: null,
      finishedAt: null,
    });
  });

  it('reports an active executor without duplicate work when lock acquisition fails', async () => {
    await seedProperty('1000750009', ['1000070']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => asResponse(response([row('ECB-1', '1000070')])));

    const activeRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.RUNNING,
        triggerType: IngestionTriggerType.MANUAL,
        initializationComplete: true,
        sourceWatermarkAtStart: START_WATERMARK,
      },
    });

    const holdingLock = new EcbIngestionLockService({ connectionString });
    const held = await holdingLock.acquire();
    expect(held.acquired).toBe(true);

    const executor = createExecutor({ fetchImpl });
    const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result).toEqual({
      outcome: INGESTION_EXECUTION_OUTCOMES.ACTIVE_EXECUTOR,
      activeRunId: activeRun.id,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await prisma.ingestionRun.count()).toBe(1);

    if (held.acquired) {
      await held.lock.release();
    }
  });

  it('returns SOURCE_CHANGED at the publication boundary when the end watermark changes', async () => {
    await seedProperty('1000750010', ['1000080']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => asResponse(response([row('ECB-1', '1000080')])));

    endMetadataRowsUpdatedAt = START_WATERMARK_SECONDS + 120;

    const executor = createExecutor({ fetchImpl, ecbBatchSize: 10 });
    const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result).toMatchObject({
      outcome: INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
      run: {
        status: IngestionRunStatus.SOURCE_CHANGED,
        sourceWatermarkAtStart: START_WATERMARK,
        sourceWatermarkAtEnd: rowsUpdatedAtToDate(endMetadataRowsUpdatedAt),
        lastError: INGESTION_TERMINAL_ERRORS.SOURCE_CHANGED,
      },
    });
    expect(
      await prisma.ingestionBatch.findFirst({
        where: { status: IngestionBatchStatus.COMPLETED },
      }),
    ).toBeTruthy();
    expect(await prisma.propertyDatasetCoverage.count()).toBe(0);
  });

  it('does not mutate property coverage during successful S2 execution', async () => {
    const property = await seedProperty('1000750011', ['1000090']);

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => asResponse(response([row('ECB-1', '1000090')])));

    const executor = createExecutor({ fetchImpl, ecbBatchSize: 10 });
    const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result.outcome).toBe(INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION);
    expect(await prisma.propertyDatasetCoverage.count()).toBe(0);
    expect(
      await prisma.propertyDatasetCoverage.findFirst({
        where: { propertyId: property.id, dataset: Dataset.DOB_ECB_VIOLATIONS },
      }),
    ).toBeNull();
  });
});
