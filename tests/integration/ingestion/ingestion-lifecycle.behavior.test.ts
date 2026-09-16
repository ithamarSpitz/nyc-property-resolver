import { EventEmitter } from 'node:events';

import {
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import { SocrataClient, SocrataClientError, SOCRATA_ERROR_CODES } from '../../../src/clients/socrata.client';
import { SocrataRequestExecutor } from '../../../src/clients/socrata-request-executor';
import { CONFIG_DEFAULTS } from '../../../src/config/defaults';
import {
  ECB_SOURCE_ID_FIELD,
  SOCRATA_ROW_ID_FIELD,
  SOURCE_ROW_UPDATED_AT_FIELD,
} from '../../../src/schemas/ecb-ingestion.schema';
import {
  BATCH_PROCESSOR_OUTCOMES,
  EcbBatchProcessorService,
  FAILED_PAGE_LIMIT_ERROR,
} from '../../../src/services/ecb/batch-processor.service';
import { createIngestionInitializationService } from '../../../src/services/ecb/ingestion-initialization.service';
import { createIngestionBatchRepository } from '../../../src/services/ecb/ingestion-batch.repository';
import {
  EcbIngestionLockService,
  IngestionExecutionAuthority,
  type IngestionLockClient,
} from '../../../src/services/ecb/ingestion-lock.service';
import { createIngestionRunRepository } from '../../../src/services/ecb/ingestion-run.repository';
import {
  INGESTION_EXECUTION_OUTCOMES,
  INGESTION_TERMINAL_ERRORS,
  INGESTION_TERMINAL_STAGES,
} from '../../../src/services/ecb/ingestion.service';
import {
  INGESTION_TERMINAL_FAILURE_REASONS,
  type IngestionTerminalPublicationRequest,
} from '../../../src/services/ecb/ingestion-terminal-publication.port';
import { EcbRawStagingService } from '../../../src/services/ecb/raw-staging.service';
import { verifyEcbSourceContract } from '../../../src/services/ecb/source-contract.service';
import { START_WATERMARK, START_WATERMARK_SECONDS } from '../../fixtures/ingestion/constants';
import { ecbSocrataRow } from '../../fixtures/ingestion/socrata-rows';
import {
  asFetchResponse,
  createIngestionExecutor,
  createMetadataPort,
  createTerminalPublicationPort,
  FakeLockClient,
  mockSocrataResponse,
  seedProperty,
  truncateIngestionTables,
} from '../../fixtures/ingestion/scenarios';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

class CompetingLockClient extends EventEmitter implements IngestionLockClient {
  readonly connect = jest.fn(async () => undefined);
  readonly end = jest.fn(async () => undefined);
  queryResult = { acquired: false };

  async query(): Promise<{ rows: Array<{ acquired: boolean }> }> {
    return { rows: [this.queryResult] };
  }
}

describeIntegration('S2 ingestion lifecycle behavior gate', () => {
  const connectionString = process.env.DATABASE_URL as string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateIngestionTables(prisma);
  });

  describe('persistence contracts', () => {
    async function createRun(status: IngestionRunStatus = IngestionRunStatus.QUEUED) {
      return prisma.ingestionRun.create({
        data: {
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status,
          triggerType: IngestionTriggerType.MANUAL,
          ...(status === IngestionRunStatus.RUNNING
            ? {
                initializationComplete: true,
                sourceWatermarkAtStart: new Date('2026-01-01T00:00:00.000Z'),
              }
            : {}),
        },
      });
    }

    it('allows only one queued or running run per dataset', async () => {
      const queuedRun = await createRun();

      await expect(createRun()).rejects.toThrow();
      await expect(createRun(IngestionRunStatus.RUNNING)).rejects.toThrow();
      await expect(createRun(IngestionRunStatus.FAILED)).resolves.toBeTruthy();

      await prisma.ingestionRun.update({
        where: { id: queuedRun.id },
        data: { status: IngestionRunStatus.FAILED },
      });
      await expect(createRun(IngestionRunStatus.RUNNING)).resolves.toBeTruthy();
      await expect(createRun()).rejects.toThrow();
    });

    it('rejects running state without initialized snapshot and start watermark', async () => {
      await expect(
        prisma.ingestionRun.create({
          data: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: IngestionRunStatus.RUNNING,
            triggerType: IngestionTriggerType.MANUAL,
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.ingestionRun.create({
          data: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: IngestionRunStatus.QUEUED,
            triggerType: IngestionTriggerType.MANUAL,
            sourceWatermarkAtStart: new Date('2026-01-01T00:00:00.000Z'),
          },
        }),
      ).rejects.toThrow();

      await expect(createRun(IngestionRunStatus.RUNNING)).resolves.toBeTruthy();
    });

    it('rejects completed and source_changed without initialized snapshot and start watermark', async () => {
      for (const status of [IngestionRunStatus.COMPLETED, IngestionRunStatus.SOURCE_CHANGED]) {
        await expect(
          prisma.ingestionRun.create({
            data: {
              dataset: Dataset.DOB_ECB_VIOLATIONS,
              status,
              triggerType: IngestionTriggerType.MANUAL,
            },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('source contract and Socrata query selection', () => {
    it('verifies ISN_DOB_BIS_EXTRACT uniqueness using explicit :id/:updated_at identity fields', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(mockSocrataResponse([{ totalRows: '2', distinctSourceIds: '2' }]))
        .mockResolvedValueOnce(mockSocrataResponse([{ nullSourceIds: '0' }]))
        .mockResolvedValueOnce(mockSocrataResponse([]));
      const client = new SocrataClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'https://example.test',
      });

      const result = await verifyEcbSourceContract(client);
      expect(result).toMatchObject({
        sourceIdField: ECB_SOURCE_ID_FIELD,
        socrataRowIdField: SOCRATA_ROW_ID_FIELD,
        sourceRowUpdatedAtField: SOURCE_ROW_UPDATED_AT_FIELD,
        valid: true,
      });

      const aggregateUrl = new URL(fetchImpl.mock.calls[0]?.[0] as string);
      expect(aggregateUrl.searchParams.get('$select')).toContain('count(distinct ISN_DOB_BIS_EXTRACT)');
      expect(new URL(fetchImpl.mock.calls[1]?.[0] as string).searchParams.get('$where')).toBe(
        'ISN_DOB_BIS_EXTRACT is null',
      );
    });
  });

  describe('raw-before-normalization and replay idempotency', () => {
    const service = () => new EcbRawStagingService(prisma);

    it('persists an invalid row as raw on an empty run before any staging write', async () => {
      const run = await prisma.ingestionRun.create({
        data: {
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status: IngestionRunStatus.QUEUED,
          triggerType: IngestionTriggerType.MANUAL,
        },
      });
      const invalidRow = ecbSocrataRow('ECB-1001', 'malformed');

      expect(await prisma.ecbViolationRaw.count()).toBe(0);
      expect(await prisma.ecbViolationStaging.count()).toBe(0);

      await expect(service().processRow({ runId: run.id, row: invalidRow })).rejects.toMatchObject({
        code: 'ECB_NORMALIZATION_FAILED',
        stage: 'normalization',
        rawPersisted: true,
        sourceId: 'ECB-1001',
      });

      expect(await prisma.ecbViolationRaw.count()).toBe(1);
      expect(await prisma.ecbViolationStaging.count()).toBe(0);
      expect(await prisma.ecbViolationRaw.findFirst()).toMatchObject({
        sourceId: 'ECB-1001',
        socrataRowId: 'socrata-ECB-1001',
        firstSeenRunId: run.id,
        payload: expect.objectContaining({
          isn_dob_bis_extract: 'ECB-1001',
          bin: 'malformed',
        }),
      });
    });

    it('replays source versions without duplicate raw or staging rows', async () => {
      const run = await prisma.ingestionRun.create({
        data: {
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status: IngestionRunStatus.QUEUED,
          triggerType: IngestionTriggerType.MANUAL,
        },
      });
      const rawService = service();
      const row = ecbSocrataRow('ECB-1001');

      await rawService.processRow({ runId: run.id, row });
      await rawService.processRow({ runId: run.id, row });
      expect(await prisma.ecbViolationRaw.count()).toBe(1);
      expect(await prisma.ecbViolationStaging.count()).toBe(1);

      await expect(
        rawService.processRow({
          runId: run.id,
          row: ecbSocrataRow('ECB-1001', '1012345', '2026-01-03T03:04:05.000Z'),
        }),
      ).resolves.toBeTruthy();

      expect(await prisma.ecbViolationRaw.count()).toBe(2);
      expect(await prisma.ecbViolationStaging.count()).toBe(1);
    });
  });

  describe('durable run initialization', () => {
    let authority: IngestionExecutionAuthority;
    let terminalPublicationRequests: IngestionTerminalPublicationRequest[];

    beforeEach(() => {
      authority = new IngestionExecutionAuthority();
      terminalPublicationRequests = [];
    });

    function createInitializationService(testHooks?: {
      afterSnapshotInsert?: () => Promise<void>;
      beforeWatermarkPersist?: () => Promise<void>;
    }) {
      return createIngestionInitializationService({
        prisma,
        runRepository: createIngestionRunRepository(prisma),
        batchRepository: createIngestionBatchRepository(prisma),
        metadataPort: createMetadataPort(),
        terminalPublicationPort: createTerminalPublicationPort(prisma, terminalPublicationRequests),
        ecbBatchSize: 2,
        socrataPageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE,
        testHooks,
      });
    }

    it('creates a durable queued run before initialization completes', async () => {
      const service = createInitializationService();
      const queuedRun = await service.createQueuedRun(
        { triggerType: IngestionTriggerType.SCHEDULED },
        authority,
      );

      expect(queuedRun).toMatchObject({
        status: IngestionRunStatus.QUEUED,
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        initializationComplete: false,
        sourceWatermarkAtStart: null,
      });
    });

    it('leaves no partial snapshot or batches when initialization fails inside the transaction', async () => {
      await seedProperty(prisma, '1000750001', ['1000001']);
      const service = createInitializationService({
        afterSnapshotInsert: async () => {
          throw new Error('simulated crash during batch creation');
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
      expect(run.initializationComplete).toBe(false);
      expect(await prisma.ingestionRunPropertyBin.count({ where: { runId: queuedRun.id } })).toBe(0);
      expect(await prisma.ingestionBatch.count({ where: { runId: queuedRun.id } })).toBe(0);
    });

    it('retries initialized queued runs with a null watermark without rebuilding snapshot or batches', async () => {
      await seedProperty(prisma, '1000750002', ['1000002', '1000003']);
      const service = createInitializationService();
      const queuedRun = await service.createQueuedRun(
        { triggerType: IngestionTriggerType.MANUAL },
        authority,
      );

      const failingService = createInitializationService({
        beforeWatermarkPersist: async () => {
          throw new Error('simulated crash before watermark persistence');
        },
      });
      await expect(failingService.initializeAndStartRun(queuedRun.id, authority)).rejects.toThrow(
        'simulated crash before watermark persistence',
      );

      const runAfterCrash = await prisma.ingestionRun.findUniqueOrThrow({
        where: { id: queuedRun.id },
      });
      expect(runAfterCrash).toMatchObject({
        status: IngestionRunStatus.QUEUED,
        initializationComplete: true,
        sourceWatermarkAtStart: null,
      });

      const snapshotBefore = await prisma.ingestionRunPropertyBin.findMany({
        where: { runId: queuedRun.id },
      });
      const batchesBefore = await prisma.ingestionBatch.findMany({ where: { runId: queuedRun.id } });

      await prisma.propertyBin.create({
        data: {
          propertyId: snapshotBefore[0]!.propertyId,
          bin: '1000099',
        },
      });

      const retryResult = await service.initializeAndStartRun(queuedRun.id, authority);
      expect(retryResult.outcome).toBe('RUNNING');
      expect(
        await prisma.ingestionRunPropertyBin.findMany({ where: { runId: queuedRun.id } }),
      ).toEqual(snapshotBefore);
      expect(await prisma.ingestionBatch.findMany({ where: { runId: queuedRun.id } })).toEqual(
        batchesBefore,
      );
    });

    it('delegates start-watermark metadata failure to the terminal publication port', async () => {
      await seedProperty(prisma, '1000750003', ['1000010']);
      const service = createIngestionInitializationService({
        prisma,
        runRepository: createIngestionRunRepository(prisma),
        batchRepository: createIngestionBatchRepository(prisma),
        metadataPort: {
          getDatasetMetadata: async () => {
            throw new SocrataClientError({
              code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
              kind: 'malformed_payload',
              retryable: false,
              statusCode: 502,
              message: 'metadata unavailable',
            });
          },
        },
        terminalPublicationPort: createTerminalPublicationPort(prisma, terminalPublicationRequests),
        ecbBatchSize: 2,
        socrataPageSize: CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE,
      });
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
      expect(run).toMatchObject({
        status: IngestionRunStatus.FAILED,
        initializationComplete: true,
        sourceWatermarkAtStart: null,
        failureStage: 'initialization',
        lastError: INGESTION_TERMINAL_FAILURE_REASONS.START_WATERMARK_FETCH_FAILED,
        expectedPropertyBinCount: 1,
        expectedBinCount: 1,
        expectedBatchCount: 1,
      });
      expect(
        await prisma.ingestionRunPropertyBin.findMany({ where: { runId: queuedRun.id } }),
      ).toEqual([
        expect.objectContaining({
          runId: queuedRun.id,
          bin: '1000010',
        }),
      ]);
      expect(await prisma.ingestionBatch.findMany({ where: { runId: queuedRun.id } })).toEqual([
        expect.objectContaining({
          runId: queuedRun.id,
          batchNumber: 1,
          batchDefinition: expect.objectContaining({ bins: ['1000010'] }),
        }),
      ]);
    });
  });

  describe('executor resume and immutable snapshots', () => {
    function mockFetchForBins(fetchImpl: jest.MockedFunction<typeof fetch>) {
      fetchImpl.mockImplementation(async (input) => {
        const where = new URL(input as string).searchParams.get('$where') ?? '';
        const bin = ['1000020', '1000031', '1000041', '1000051', '1000060', '1000070', '1000080', '1000090'].find(
          (candidate) => where.includes(candidate),
        );
        const resolvedBin = bin ?? '1000001';
        return asFetchResponse(mockSocrataResponse([ecbSocrataRow(`ECB-${resolvedBin}`, resolvedBin)]));
      });
    }

    it('resumes by skipping completed batches and never reloading the live watchlist', async () => {
      await seedProperty(prisma, '1000750010', ['1000010']);
      await seedProperty(prisma, '1000750011', ['1000020']);

      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      mockFetchForBins(fetchImpl);
      const { executor } = createIngestionExecutor(prisma, connectionString, {
        fetchImpl,
        ecbBatchSize: 1,
      });

      const firstResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
      expect(firstResult.outcome).toBe(INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION);
      const runId = (firstResult as { run: { id: string } }).run.id;

      await prisma.ingestionRun.update({
        where: { id: runId },
        data: { status: IngestionRunStatus.RUNNING, sourceWatermarkAtEnd: null },
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
      const resumeResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
      expect(resumeResult.outcome).toBe(INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps persisted batch definitions when the live watchlist changes before resume', async () => {
      const property = await seedProperty(prisma, '1000750012', ['1000030', '1000031']);
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl.mockImplementation(async () =>
        asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-1', '1000030')])),
      );
      const { executor } = createIngestionExecutor(prisma, connectionString, {
        fetchImpl,
        ecbBatchSize: 1,
      });

      const firstResult = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
      const runId = (firstResult as { run: { id: string } }).run.id;
      const batchesBefore = await prisma.ingestionBatch.findMany({
        where: { runId },
        orderBy: { batchNumber: 'asc' },
      });

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
      await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

      const batchesAfter = await prisma.ingestionBatch.findMany({
        where: { runId },
        orderBy: { batchNumber: 'asc' },
      });
      expect(batchesAfter.map((batch) => batch.batchDefinition)).toEqual(
        batchesBefore.map((batch) => batch.batchDefinition),
      );
      expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).searchParams.get('$where')).toBe(
        "bin in ('1000031')",
      );
      expect(
        await prisma.ingestionRunPropertyBin.count({ where: { runId, bin: '1000099' } }),
      ).toBe(0);
    });
  });

  describe('batch processing boundaries', () => {
    async function createInitializedBatch(definition: { bins: string[]; pageSize?: number }) {
      const run = await prisma.ingestionRun.create({
        data: {
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status: IngestionRunStatus.QUEUED,
          triggerType: IngestionTriggerType.MANUAL,
          initializationComplete: false,
        },
      });
      const batch = await prisma.ingestionBatch.create({
        data: {
          runId: run.id,
          batchNumber: 1,
          batchDefinition: definition,
        },
      });
      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: IngestionRunStatus.RUNNING,
          initializationComplete: true,
          sourceWatermarkAtStart: new Date('2026-01-01T00:00:00.000Z'),
          expectedPropertyBinCount: definition.bins.length,
          expectedBinCount: definition.bins.length,
          expectedBatchCount: 1,
        },
      });
      return { run, batch };
    }

    function createBatchProcessor(fetchImpl: jest.MockedFunction<typeof fetch>, config?: {
      socrataPageSize?: number;
      socrataMaxPagesPerBatch?: number;
      maxBatchAttemptsPerRun?: number;
      maxRetries?: number;
    }) {
      const authority = new IngestionExecutionAuthority();
      const requestExecutor = new SocrataRequestExecutor({
        maxRetries: config?.maxRetries ?? 2,
      });
      const socrataClient = new SocrataClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        baseUrl: 'https://example.test',
        signal: authority.signal,
        requestExecutor: {
          execute: (attempt) =>
            requestExecutor.execute(async () => attempt.execute(), authority.signal),
        },
      });
      const service = new EcbBatchProcessorService({
        prisma,
        socrataClient,
        requestExecutor,
        config,
      });
      return { service, authority, requestExecutor };
    }

    it('replays partial batches from page 1 without duplicate raw or staging rows', async () => {
      const { batch } = await createInitializedBatch({ bins: ['1012345'], pageSize: 2 });
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl
        .mockResolvedValueOnce(
          asFetchResponse(
            mockSocrataResponse([
              ecbSocrataRow('ECB-1'),
              ecbSocrataRow('ECB-2', '1012345', '2026-01-02T03:04:06.000Z'),
            ]),
          ),
        )
        .mockRejectedValueOnce(new TypeError('network down'))
        .mockResolvedValueOnce(
          asFetchResponse(
            mockSocrataResponse([
              ecbSocrataRow('ECB-1'),
              ecbSocrataRow('ECB-2', '1012345', '2026-01-02T03:04:06.000Z'),
            ]),
          ),
        )
        .mockResolvedValueOnce(
          asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-3', '1012345', '2026-01-02T03:04:07.000Z')])),
        );

      const { service, authority } = createBatchProcessor(fetchImpl, { maxRetries: 0, socrataPageSize: 2 });
      expect((await service.executeBatchAttempt(batch.id, authority)).outcome).toBe(
        BATCH_PROCESSOR_OUTCOMES.FAILED,
      );
      expect((await service.executeBatchAttempt(batch.id, authority)).outcome).toBe(
        BATCH_PROCESSOR_OUTCOMES.COMPLETED,
      );
      expect(new URL(fetchImpl.mock.calls[2]?.[0] as string).searchParams.get('$offset')).toBe('0');
      expect(await prisma.ecbViolationRaw.count()).toBe(3);
      expect(await prisma.ecbViolationStaging.count()).toBe(3);
    });

    it('keeps request retries separate from logical batch attempts', async () => {
      const { batch } = await createInitializedBatch({ bins: ['1012345'], pageSize: 10 });
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl
        .mockResolvedValueOnce(asFetchResponse(mockSocrataResponse({ message: 'unavailable' }, 503)))
        .mockResolvedValueOnce(asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-1')])));

      const { service, authority, requestExecutor } = createBatchProcessor(fetchImpl);
      const outcome = await service.executeBatchAttempt(batch.id, authority);

      expect(outcome.outcome).toBe(BATCH_PROCESSOR_OUTCOMES.COMPLETED);
      expect(requestExecutor.getMetrics().retryCalls).toBe(1);
      expect(await prisma.ingestionBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
        attemptCount: 1,
        status: IngestionBatchStatus.COMPLETED,
      });
    });

    it('terminates on page-limit exhaustion and batch-attempt exhaustion', async () => {
      const pageLimitFixture = await createInitializedBatch({ bins: ['1012345'], pageSize: 1 });
      const pageLimitBatch = pageLimitFixture.batch;
      const pageFetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      pageFetchImpl.mockImplementation(async () =>
        asFetchResponse(
          mockSocrataResponse([
            ecbSocrataRow(
              `ECB-${pageFetchImpl.mock.calls.length + 1}`,
              '1012345',
              `2026-01-02T03:04:0${pageFetchImpl.mock.calls.length + 5}.000Z`,
            ),
          ]),
        ),
      );
      const pageProcessor = createBatchProcessor(pageFetchImpl, {
        socrataMaxPagesPerBatch: 2,
        socrataPageSize: 1,
        maxRetries: 0,
      });
      expect(
        (await pageProcessor.service.executeBatchAttempt(pageLimitBatch.id, pageProcessor.authority))
          .outcome,
      ).toBe(BATCH_PROCESSOR_OUTCOMES.FAILED_PAGE_LIMIT);
      expect(await prisma.ingestionBatch.findUnique({ where: { id: pageLimitBatch.id } })).toMatchObject({
        lastError: FAILED_PAGE_LIMIT_ERROR,
        status: IngestionBatchStatus.FAILED,
      });

      await prisma.ingestionRun.update({
        where: { id: pageLimitFixture.run.id },
        data: { status: IngestionRunStatus.FAILED },
      });

      const attemptBatch = (await createInitializedBatch({ bins: ['1012345'], pageSize: 10 })).batch;
      const attemptFetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      attemptFetchImpl.mockRejectedValue(new TypeError('network down'));
      const attemptProcessor = createBatchProcessor(attemptFetchImpl, {
        maxBatchAttemptsPerRun: 3,
        maxRetries: 0,
      });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(
          (
            await attemptProcessor.service.executeBatchAttempt(
              attemptBatch.id,
              attemptProcessor.authority,
            )
          ).outcome,
        ).toBe(BATCH_PROCESSOR_OUTCOMES.FAILED);
      }
      expect(
        (
          await attemptProcessor.service.executeBatchAttempt(
            attemptBatch.id,
            attemptProcessor.authority,
          )
        ).outcome,
      ).toBe(BATCH_PROCESSOR_OUTCOMES.TERMINAL_FAILED);
    });
  });

  describe('advisory-lock authority', () => {
    it('reports an active executor when lock acquisition fails', async () => {
      await seedProperty(prisma, '1000750020', ['1000070']);
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl.mockImplementation(async () =>
        asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-1', '1000070')])),
      );

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

      const { executor } = createIngestionExecutor(prisma, connectionString, { fetchImpl });
      const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

      expect(result).toEqual({
        outcome: INGESTION_EXECUTION_OUTCOMES.ACTIVE_EXECUTOR,
        activeRunId: activeRun.id,
      });
      expect(fetchImpl).not.toHaveBeenCalled();

      if (held.acquired) {
        await held.lock.release();
      }
    });

    it('aborts execution without publication when the lock session is lost', async () => {
      await seedProperty(prisma, '1000750021', ['1000060']);
      const fakeClient = new FakeLockClient();
      const lockService = new EcbIngestionLockService({
        connectionString,
        clientFactory: () => fakeClient,
      });
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl
        .mockResolvedValueOnce(asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-1', '1000060')])))
        .mockImplementation(async () => {
          fakeClient.emit('end');
          return asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-2', '1000060')]));
        });

      const { executor, terminalPublicationRequests } = createIngestionExecutor(prisma, connectionString, {
        fetchImpl,
        ecbBatchSize: 10,
        socrataPageSize: 1,
        lockService,
      });
      const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });

      expect(result.outcome).toBe(INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST);
      expect(terminalPublicationRequests).toEqual([]);
      expect(await prisma.ingestionRun.findFirst()).toMatchObject({
        status: IngestionRunStatus.RUNNING,
        finishedAt: null,
      });
    });

    it('fails fast when the dedicated lock client cannot acquire ownership', async () => {
      const lockService = new EcbIngestionLockService({
        connectionString,
        clientFactory: () => new CompetingLockClient(),
      });
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      const { executor } = createIngestionExecutor(prisma, connectionString, {
        fetchImpl,
        lockService,
      });

      const result = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
      expect(result.outcome).toBe(INGESTION_EXECUTION_OUTCOMES.ACTIVE_EXECUTOR);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('publication handoff without live promotion', () => {
    it('returns READY_FOR_PUBLICATION when start and end watermarks match without mutating live state', async () => {
      await seedProperty(prisma, '1000750030', ['1000080']);
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl.mockImplementation(async () =>
        asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-1', '1000080')])),
      );

      const { executor, terminalPublicationRequests } = createIngestionExecutor(prisma, connectionString, {
        fetchImpl,
        ecbBatchSize: 10,
      });
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
      expect(await prisma.ecbViolationStaging.count()).toBeGreaterThan(0);
      expect(await prisma.propertyDatasetCoverage.count()).toBe(0);
    });

    it('publishes SOURCE_CHANGED when the end watermark changes without promoting live state', async () => {
      await seedProperty(prisma, '1000750031', ['1000081']);
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl.mockImplementation(async () =>
        asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-1', '1000081')])),
      );

      const metadataState = {
        startRowsUpdatedAt: START_WATERMARK_SECONDS,
        endRowsUpdatedAt: START_WATERMARK_SECONDS + 120,
      };
      const { executor, terminalPublicationRequests } = createIngestionExecutor(prisma, connectionString, {
        fetchImpl,
        ecbBatchSize: 10,
        metadataState,
      });

      const changedWatermarkResult = await executor.execute({
        triggerType: IngestionTriggerType.MANUAL,
      });
      expect(changedWatermarkResult).toMatchObject({
        outcome: INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
        run: {
          status: IngestionRunStatus.SOURCE_CHANGED,
          lastError: INGESTION_TERMINAL_ERRORS.SOURCE_CHANGED,
        },
      });
      expect(terminalPublicationRequests).toHaveLength(1);
      expect(await prisma.propertyDatasetCoverage.count()).toBe(0);
    });

    it('delegates SOURCE_CHANGED on resume watermark mismatch before reusing completed batches', async () => {
      await seedProperty(prisma, '1000750033', ['1000040', '1000041']);
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl.mockImplementation(async () =>
        asFetchResponse(mockSocrataResponse([ecbSocrataRow('ECB-1', '1000040')])),
      );

      const metadataState = {
        startRowsUpdatedAt: START_WATERMARK_SECONDS,
        endRowsUpdatedAt: START_WATERMARK_SECONDS,
      };
      const { executor, terminalPublicationRequests } = createIngestionExecutor(prisma, connectionString, {
        fetchImpl,
        ecbBatchSize: 1,
        metadataState,
      });

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

      metadataState.startRowsUpdatedAt = START_WATERMARK_SECONDS + 60;
      metadataState.endRowsUpdatedAt = START_WATERMARK_SECONDS + 60;
      fetchImpl.mockClear();
      terminalPublicationRequests.length = 0;

      const resumeMismatch = await executor.execute({ triggerType: IngestionTriggerType.MANUAL });
      expect(resumeMismatch).toMatchObject({
        outcome: INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
        run: {
          id: runId,
          status: IngestionRunStatus.SOURCE_CHANGED,
          failureStage: INGESTION_TERMINAL_STAGES.WATERMARK_GUARD,
          lastError: INGESTION_TERMINAL_ERRORS.SOURCE_CHANGED,
        },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(terminalPublicationRequests).toHaveLength(1);
      expect(
        await prisma.ingestionBatch.findUnique({
          where: { runId_batchNumber: { runId, batchNumber: 2 } },
        }),
      ).toMatchObject({
        status: IngestionBatchStatus.PENDING,
        attemptCount: 0,
      });
    });

    it('publishes terminal batch failure without touching live violations or coverage', async () => {
      await seedProperty(prisma, '1000750032', ['1000050', '1000051']);
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl.mockImplementation(async () =>
        asFetchResponse(
          mockSocrataResponse([
            ecbSocrataRow(
              `ECB-${fetchImpl.mock.calls.length + 1}`,
              '1000050',
              `2026-01-02T03:04:0${fetchImpl.mock.calls.length + 5}.000Z`,
            ),
          ]),
        ),
      );

      const { executor, terminalPublicationRequests } = createIngestionExecutor(prisma, connectionString, {
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
      expect(await prisma.propertyDatasetCoverage.count()).toBe(0);
    });
  });
});
