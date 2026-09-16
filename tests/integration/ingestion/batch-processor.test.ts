import {
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import { SocrataClient } from '../../../src/clients/socrata.client';
import { SocrataRequestExecutor } from '../../../src/clients/socrata-request-executor';
import {
  BATCH_PROCESSOR_OUTCOMES,
  EcbBatchProcessorService,
  FAILED_PAGE_LIMIT_ERROR,
} from '../../../src/services/ecb/batch-processor.service';
import { IngestionExecutionAuthority } from '../../../src/services/ecb/ingestion-lock.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

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

describeIntegration('ECB persisted batch processor', () => {
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
      'TRUNCATE TABLE "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  function row(sourceId: string, updatedAt = '2026-01-02T03:04:05.000Z') {
    return {
      isn_dob_bis_extract: sourceId,
      ':id': `socrata-${sourceId}`,
      ':updated_at': updatedAt,
      bin: '1012345',
      ecb_violation_number: `ECB-${sourceId}`,
      issue_date: '20260203',
      ecb_violation_status: 'ACTIVE',
      balance_due: '-125.50',
    };
  }

  async function createInitializedRunWithBatch(
    definition: { bins: string[]; pageSize?: number },
    batchOverrides: {
      status?: IngestionBatchStatus;
      attemptCount?: number;
      pagesFetched?: number;
      rowsFetched?: number;
    } = {},
  ) {
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
        status: batchOverrides.status ?? IngestionBatchStatus.PENDING,
        attemptCount: batchOverrides.attemptCount ?? 0,
        pagesFetched: batchOverrides.pagesFetched ?? 0,
        rowsFetched: batchOverrides.rowsFetched ?? 0,
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

  function createProcessor(options: {
    fetchImpl: jest.MockedFunction<typeof fetch>;
    requestExecutor?: SocrataRequestExecutor;
    config?: {
      socrataPageSize?: number;
      socrataMaxPagesPerBatch?: number;
      maxBatchAttemptsPerRun?: number;
    };
  }) {
    const requestExecutor = options.requestExecutor ?? new SocrataRequestExecutor({ maxRetries: 2 });
    const authority = new IngestionExecutionAuthority();
    const socrataClient = new SocrataClient({
      fetchImpl: options.fetchImpl as unknown as typeof fetch,
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
      config: options.config,
    });

    return { service, authority, requestExecutor };
  }

  it('writes all raw/staging candidates across multiple pages and marks the batch complete', async () => {
    const { batch } = await createInitializedRunWithBatch({ bins: ['1012345'], pageSize: 2 });
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        asResponse(response([row('ECB-1'), row('ECB-2', '2026-01-02T03:04:06.000Z')])),
      )
      .mockResolvedValueOnce(asResponse(response([row('ECB-3', '2026-01-02T03:04:07.000Z')])));

    const { service, authority } = createProcessor({ fetchImpl });
    const outcome = await service.executeBatchAttempt(batch.id, authority);

    expect(outcome).toMatchObject({
      outcome: BATCH_PROCESSOR_OUTCOMES.COMPLETED,
      metrics: { pagesFetched: 2, rowsFetched: 3, retryCalls: 0 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).searchParams.get('$offset')).toBe('0');
    expect(new URL(fetchImpl.mock.calls[1]?.[0] as string).searchParams.get('$offset')).toBe('2');

    const persisted = await prisma.ingestionBatch.findUnique({ where: { id: batch.id } });
    expect(persisted).toMatchObject({
      status: IngestionBatchStatus.COMPLETED,
      attemptCount: 1,
      pagesFetched: 2,
      rowsFetched: 3,
      lastError: null,
    });
    expect(await prisma.ecbViolationRaw.count()).toBe(3);
    expect(await prisma.ecbViolationStaging.count()).toBe(3);
  });

  it('replays safely after a partial attempt and restarts pagination from offset 0', async () => {
    const { batch } = await createInitializedRunWithBatch({ bins: ['1012345'], pageSize: 2 });
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        asResponse(response([row('ECB-1'), row('ECB-2', '2026-01-02T03:04:06.000Z')])),
      )
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(
        asResponse(response([row('ECB-1'), row('ECB-2', '2026-01-02T03:04:06.000Z')])),
      )
      .mockResolvedValueOnce(asResponse(response([row('ECB-3', '2026-01-02T03:04:07.000Z')])));

    const { service, authority, requestExecutor } = createProcessor({
      fetchImpl,
      requestExecutor: new SocrataRequestExecutor({ maxRetries: 0 }),
    });

    const firstOutcome = await service.executeBatchAttempt(batch.id, authority);
    expect(firstOutcome.outcome).toBe(BATCH_PROCESSOR_OUTCOMES.FAILED);
    expect(firstOutcome).toMatchObject({
      metrics: { pagesFetched: 1, rowsFetched: 2 },
    });

    const secondOutcome = await service.executeBatchAttempt(batch.id, authority);
    expect(secondOutcome).toMatchObject({
      outcome: BATCH_PROCESSOR_OUTCOMES.COMPLETED,
      metrics: { pagesFetched: 2, rowsFetched: 3 },
    });
    expect(requestExecutor.getMetrics().retryCalls).toBe(0);
    expect(new URL(fetchImpl.mock.calls[2]?.[0] as string).searchParams.get('$offset')).toBe('0');
    expect(new URL(fetchImpl.mock.calls[3]?.[0] as string).searchParams.get('$offset')).toBe('2');

    expect(await prisma.ecbViolationRaw.count()).toBe(3);
    expect(await prisma.ecbViolationStaging.count()).toBe(3);
    expect(await prisma.ingestionBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      status: IngestionBatchStatus.COMPLETED,
      attemptCount: 2,
      pagesFetched: 2,
      rowsFetched: 3,
    });
  });

  it('does not consume extra logical batch attempts for request-level retries', async () => {
    const { batch } = await createInitializedRunWithBatch({ bins: ['1012345'], pageSize: 10 });
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(asResponse(response({ message: 'unavailable' }, 503)))
      .mockResolvedValueOnce(asResponse(response([row('ECB-1')])));

    const { service, authority, requestExecutor } = createProcessor({ fetchImpl });
    const outcome = await service.executeBatchAttempt(batch.id, authority);

    expect(outcome.outcome).toBe(BATCH_PROCESSOR_OUTCOMES.COMPLETED);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requestExecutor.getMetrics().retryCalls).toBe(1);
    expect(await prisma.ingestionBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      attemptCount: 1,
      status: IngestionBatchStatus.COMPLETED,
    });
  });

  it('returns FAILED_PAGE_LIMIT when the page ceiling is reached with more data remaining', async () => {
    const { batch } = await createInitializedRunWithBatch({ bins: ['1012345'], pageSize: 1 });
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () =>
      asResponse(
        response([row(`ECB-${fetchImpl.mock.calls.length + 1}`, `2026-01-02T03:04:0${fetchImpl.mock.calls.length + 5}.000Z`)]),
      ),
    );

    const { service, authority } = createProcessor({
      fetchImpl,
      config: { socrataMaxPagesPerBatch: 2, socrataPageSize: 1 },
    });
    const outcome = await service.executeBatchAttempt(batch.id, authority);

    expect(outcome).toMatchObject({
      outcome: BATCH_PROCESSOR_OUTCOMES.FAILED_PAGE_LIMIT,
      metrics: { pagesFetched: 2, rowsFetched: 2 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await prisma.ingestionBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      status: IngestionBatchStatus.FAILED,
      lastError: FAILED_PAGE_LIMIT_ERROR,
      attemptCount: 1,
      pagesFetched: 2,
      rowsFetched: 2,
      completedAt: null,
    });
  });

  it('stops after MAX_BATCH_ATTEMPTS_PER_RUN and returns a terminal batch failure', async () => {
    const { batch } = await createInitializedRunWithBatch({ bins: ['1012345'], pageSize: 10 });
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockRejectedValue(new TypeError('network down'));

    const { service, authority } = createProcessor({
      fetchImpl,
      requestExecutor: new SocrataRequestExecutor({ maxRetries: 0 }),
      config: { maxBatchAttemptsPerRun: 3 },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await service.executeBatchAttempt(batch.id, authority);
      expect(outcome.outcome).toBe(BATCH_PROCESSOR_OUTCOMES.FAILED);
      expect(await prisma.ingestionBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
        attemptCount: attempt,
        status: IngestionBatchStatus.FAILED,
      });
    }

    const terminalOutcome = await service.executeBatchAttempt(batch.id, authority);
    expect(terminalOutcome.outcome).toBe(BATCH_PROCESSOR_OUTCOMES.TERMINAL_FAILED);
    expect(await prisma.ingestionBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      attemptCount: 3,
      status: IngestionBatchStatus.FAILED,
    });
  });

  it('prevents new pages and completion writes after execution authority is lost', async () => {
    const { batch } = await createInitializedRunWithBatch({ bins: ['1012345'], pageSize: 1 });
    const authority = new IngestionExecutionAuthority();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(asResponse(response([row('ECB-1')])))
      .mockImplementation(async () => {
        authority.revoke('client ended unexpectedly');
        return asResponse(response([row('ECB-2', '2026-01-02T03:04:06.000Z')]));
      });
    const requestExecutor = new SocrataRequestExecutor({ maxRetries: 0 });
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
      config: { socrataPageSize: 1 },
    });

    const outcome = await service.executeBatchAttempt(batch.id, authority);

    expect(outcome).toMatchObject({
      outcome: BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST,
      metrics: { pagesFetched: 1, rowsFetched: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await prisma.ingestionBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      status: IngestionBatchStatus.RUNNING,
      attemptCount: 1,
      pagesFetched: 1,
      rowsFetched: 1,
      completedAt: null,
    });
    expect(await prisma.ecbViolationRaw.count()).toBe(1);
    expect(await prisma.ecbViolationStaging.count()).toBe(1);
  });

  it('uses only the persisted batch definition and never reads live property_bins', async () => {
    const property = await prisma.property.create({
      data: {
        bbl: '1000750001',
        borough: 1,
        block: 75,
        lot: 1,
        resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await prisma.propertyBin.create({
      data: { propertyId: property.id, bin: '1099999' },
    });

    const { batch } = await createInitializedRunWithBatch({ bins: ['1012345'], pageSize: 10 });
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(asResponse(response([row('ECB-1')])));

    const propertyBinsSpy = jest.spyOn(prisma.propertyBin, 'findMany');
    const { service, authority } = createProcessor({ fetchImpl });
    const outcome = await service.executeBatchAttempt(batch.id, authority);

    expect(outcome.outcome).toBe(BATCH_PROCESSOR_OUTCOMES.COMPLETED);
    expect(propertyBinsSpy).not.toHaveBeenCalled();
    expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).searchParams.get('$where')).toBe(
      "bin in ('1012345')",
    );

    propertyBinsSpy.mockRestore();
  });
});
