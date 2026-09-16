import { EventEmitter } from 'node:events';

import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import { SocrataClientError, SOCRATA_ERROR_CODES } from '../../../src/clients/socrata.client';
import { FAILED_PAGE_LIMIT_ERROR } from '../../../src/services/ecb/batch-processor.service';
import { AcceptedPublicationService } from '../../../src/services/ecb/accepted-publication.service';
import {
  EcbIngestionLockService,
  type IngestionLockClient,
} from '../../../src/services/ecb/ingestion-lock.service';
import {
  EcbIngestionRunnerService,
  INGESTION_RUNNER_OUTCOMES,
} from '../../../src/services/ecb/ingestion-runner.service';
import type { DatasetMetadataPort } from '../../../src/services/ecb/ingestion-initialization.service';
import { INGESTION_TERMINAL_FAILURE_REASONS } from '../../../src/services/ecb/ingestion-terminal-publication.port';

const describeIntegration = process.env.INGESTION_PUBLICATION_INTEGRATION === '1'
  ? describe
  : describe.skip;

const WATERMARK_SECONDS = 1_789_540_000;

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function response(payload: unknown): Response {
  const value: MockResponse = { ok: true, status: 200, json: async () => payload };
  return value as unknown as Response;
}

function sourceRow(sourceId: string, bin: string) {
  return {
    isn_dob_bis_extract: sourceId,
    ':id': `socrata-${sourceId}`,
    ':updated_at': '2026-09-16T08:00:00.000Z',
    bin,
    ecb_violation_number: `ECB-${sourceId}`,
    issue_date: '20260915',
    ecb_violation_status: 'ACTIVE',
    balance_due: '25.00',
  };
}

function binFromFetchInput(input: string | URL | Request): string | undefined {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const where = new URL(url).searchParams.get('$where') ?? '';
  return where.match(/'(\d+)'/)?.[1];
}

class FakeLockClient extends EventEmitter implements IngestionLockClient {
  readonly connect = jest.fn(async () => undefined);
  readonly end = jest.fn(async () => {
    this.emit('end');
  });

  async query(): Promise<{ rows: Array<{ acquired: boolean }> }> {
    return { rows: [{ acquired: true }] };
  }
}

describeIntegration('S2 + S3 ingestion publication semantic gate', () => {
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
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violations", "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  async function seedProperty(bins: string[] = ['1000001']) {
    return prisma.property.create({
      data: {
        bbl: '1000010001',
        borough: 1,
        block: 1,
        lot: 1,
        resolvedAt: new Date('2026-09-16T07:00:00.000Z'),
        bins: { create: bins.map((bin) => ({ bin })) },
        datasetCoverage: {
          create: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: CoverageStatus.NOT_CHECKED,
            statusReason: CoverageStatusReason.NEVER_INGESTED,
          },
        },
      },
    });
  }

  function metadataPort(start: number, end = start): DatasetMetadataPort {
    let calls = 0;
    return {
      getDatasetMetadata: async () => ({ rowsUpdatedAt: calls++ === 0 ? start : end }),
    };
  }

  function runner(options: {
    fetchImpl: jest.MockedFunction<typeof fetch>;
    metadata?: DatasetMetadataPort;
    lockService?: EcbIngestionLockService;
    acceptedPublicationService?: AcceptedPublicationService;
    socrataPageSize?: number;
    socrataMaxPagesPerBatch?: number;
  }): EcbIngestionRunnerService {
    return new EcbIngestionRunnerService({
      prisma,
      connectionString,
      metadataPort: options.metadata ?? metadataPort(WATERMARK_SECONDS),
      fetchImpl: options.fetchImpl,
      lockService: options.lockService,
      acceptedPublicationService: options.acceptedPublicationService,
      ecbBatchSize: 10,
      socrataPageSize: options.socrataPageSize ?? 100,
      batchProcessorConfig: {
        socrataPageSize: options.socrataPageSize ?? 100,
        socrataMaxPagesPerBatch: options.socrataMaxPagesPerBatch,
      },
    });
  }

  it('publishes accepted runs idempotently and rejects SOURCE_CHANGED without hybrid live state', async () => {
    const property = await seedProperty();
    const acceptedFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    acceptedFetch.mockResolvedValue(response([sourceRow('accepted-row', '1000001')]));

    const runA = await runner({ fetchImpl: acceptedFetch }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    expect(runA).toMatchObject({
      outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
      run: { status: IngestionRunStatus.COMPLETED },
    });
    const runAId = 'run' in runA ? runA.run.id : '';
    await expect(prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'accepted-row' } }))
      .resolves.toMatchObject({ isCurrent: true, lastSuccessRunId: runAId });
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
      status: CoverageStatus.CHECKED,
      lastAttemptRunId: runAId,
      lastSuccessRunId: runAId,
    });

    const repeated = await runner({ fetchImpl: acceptedFetch }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    expect(repeated.outcome).toBe(INGESTION_RUNNER_OUTCOMES.COMPLETED);
    const repeatedRunId = 'run' in repeated ? repeated.run.id : '';
    expect(await prisma.ecbViolation.count()).toBe(1);
    expect(await prisma.ecbViolationRaw.count()).toBe(1);

    const rejectedFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    rejectedFetch.mockResolvedValue(response([sourceRow('rejected-row', '1000001')]));
    const rejected = await runner({
      fetchImpl: rejectedFetch,
      metadata: metadataPort(WATERMARK_SECONDS, WATERMARK_SECONDS + 1),
    }).execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(rejected).toMatchObject({
      outcome: INGESTION_RUNNER_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
      run: { status: IngestionRunStatus.SOURCE_CHANGED, lastError: 'SOURCE_CHANGED' },
    });
    const rejectedRunId = 'run' in rejected ? rejected.run.id : '';
    expect(await prisma.ecbViolation.findUnique({ where: { sourceId: 'rejected-row' } })).toBeNull();
    await expect(prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'accepted-row' } }))
      .resolves.toMatchObject({ isCurrent: true, lastSuccessRunId: repeatedRunId });
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
      lastAttemptRunId: rejectedRunId,
      lastSuccessRunId: repeatedRunId,
      lastError: 'SOURCE_CHANGED',
    });

    const emptyFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    emptyFetch.mockResolvedValue(response([]));
    const acceptedReconciliation = await runner({ fetchImpl: emptyFetch }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    expect(acceptedReconciliation.outcome).toBe(INGESTION_RUNNER_OUTCOMES.COMPLETED);
    await expect(prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'accepted-row' } }))
      .resolves.toMatchObject({ isCurrent: false, lastSuccessRunId: repeatedRunId });
  });

  it('atomically publishes a post-scope terminal failure while preserving accepted state', async () => {
    const property = await seedProperty();
    const acceptedFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    acceptedFetch.mockResolvedValue(response([sourceRow('accepted-row', '1000001')]));
    const accepted = await runner({ fetchImpl: acceptedFetch }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    const acceptedRunId = 'run' in accepted ? accepted.run.id : '';

    const endlessPage = jest.fn() as jest.MockedFunction<typeof fetch>;
    endlessPage.mockResolvedValue(response([sourceRow('candidate-row', '1000001')]));
    const failed = await runner({
      fetchImpl: endlessPage,
      socrataPageSize: 1,
      socrataMaxPagesPerBatch: 1,
    }).execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(failed).toMatchObject({
      outcome: INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
      run: {
        status: IngestionRunStatus.FAILED,
        lastError: FAILED_PAGE_LIMIT_ERROR,
      },
    });
    const failedRunId = 'run' in failed ? failed.run.id : '';
    await expect(prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'accepted-row' } }))
      .resolves.toMatchObject({ isCurrent: true, lastSuccessRunId: acceptedRunId });
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
      lastAttemptRunId: failedRunId,
      lastSuccessRunId: acceptedRunId,
      lastError: FAILED_PAGE_LIMIT_ERROR,
    });
    expect(await prisma.ecbViolation.findUnique({ where: { sourceId: 'candidate-row' } })).toBeNull();
  });

  it('terminalizes initialization-stage failure without property coverage when the run snapshot is empty', async () => {
    const property = await prisma.property.create({
      data: {
        bbl: '1000010099',
        borough: 1,
        block: 1,
        lot: 99,
        resolvedAt: new Date('2026-09-16T07:00:00.000Z'),
        datasetCoverage: {
          create: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: CoverageStatus.NOT_CHECKED,
            statusReason: CoverageStatusReason.NO_VALID_BIN,
          },
        },
      },
    });
    const failingMetadata: DatasetMetadataPort = {
      getDatasetMetadata: async () => {
        throw new SocrataClientError({
          code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
          kind: 'malformed_payload',
          retryable: false,
          statusCode: 502,
          message: 'metadata unavailable',
        });
      },
    };

    const result = await runner({
      fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
      metadata: failingMetadata,
    }).execute({ triggerType: IngestionTriggerType.MANUAL });

    expect(result).toMatchObject({
      outcome: INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
      run: {
        status: IngestionRunStatus.FAILED,
        failureStage: 'initialization',
        lastError: INGESTION_TERMINAL_FAILURE_REASONS.START_WATERMARK_FETCH_FAILED,
        sourceWatermarkAtStart: null,
      },
    });
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
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NO_VALID_BIN,
      lastAttemptRunId: null,
    });
    expect(await prisma.ingestionRunPropertyBin.count()).toBe(0);
  });

  it('blocks stale success and failure coverage when identifier_version changes after snapshot', async () => {
    const property = await seedProperty();

    const acceptedFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    acceptedFetch.mockResolvedValue(response([sourceRow('accepted-row', '1000001')]));
    const accepted = await runner({ fetchImpl: acceptedFetch }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    const acceptedRunId = 'run' in accepted ? accepted.run.id : '';

    const staleSuccessFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    staleSuccessFetch.mockImplementation(async () => {
      await prisma.property.update({
        where: { id: property.id },
        data: { identifierVersion: { increment: 1 } },
      });
      return response([sourceRow('stale-success-row', '1000001')]);
    });
    const staleSuccess = await runner({ fetchImpl: staleSuccessFetch }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    const staleSuccessRunId = 'run' in staleSuccess ? staleSuccess.run.id : '';
    expect(staleSuccess.outcome).toBe(INGESTION_RUNNER_OUTCOMES.COMPLETED);
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
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED_AFTER_SNAPSHOT,
      lastAttemptRunId: acceptedRunId,
      lastSuccessRunId: acceptedRunId,
    });
    expect(staleSuccessRunId).not.toBe(acceptedRunId);

    const staleFailureFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    staleFailureFetch.mockImplementation(async () => {
      await prisma.property.update({
        where: { id: property.id },
        data: { identifierVersion: { increment: 1 } },
      });
      return response([sourceRow('stale-failure-row', '1000001')]);
    });
    const staleFailure = await runner({
      fetchImpl: staleFailureFetch,
      socrataPageSize: 1,
      socrataMaxPagesPerBatch: 1,
    }).execute({ triggerType: IngestionTriggerType.MANUAL });
    expect(staleFailure).toMatchObject({
      outcome: INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
      run: { status: IngestionRunStatus.FAILED, lastError: FAILED_PAGE_LIMIT_ERROR },
    });
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
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED_AFTER_SNAPSHOT,
      lastAttemptRunId: acceptedRunId,
      lastSuccessRunId: acceptedRunId,
    });
  });

  it('checks coverage from the immutable run snapshot rather than live property_bins additions', async () => {
    const property = await seedProperty(['1000010', '1000011']);
    let liveWatchlistExpanded = false;
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async (input) => {
      if (!liveWatchlistExpanded) {
        liveWatchlistExpanded = true;
        await prisma.propertyBin.create({
          data: {
            propertyId: property.id,
            bin: '1000012',
          },
        });
      }

      const bin = binFromFetchInput(input);
      if (bin === '1000010') {
        return response([sourceRow('snapshot-row-a', '1000010')]);
      }
      if (bin === '1000011') {
        return response([sourceRow('snapshot-row-b', '1000011')]);
      }
      return response([]);
    });

    const result = await runner({ fetchImpl }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    expect(result.outcome).toBe(INGESTION_RUNNER_OUTCOMES.COMPLETED);
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
      status: CoverageStatus.CHECKED,
      lastSuccessRunId: 'run' in result ? result.run.id : '',
    });
    expect(
      await prisma.ingestionRunPropertyBin.count({
        where: { runId: 'run' in result ? result.run.id : '', bin: '1000012' },
      }),
    ).toBe(0);
  });

  it('reconciles only the accepted run scanned BIN scope', async () => {
    await seedProperty();
    const previousRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    await prisma.ecbViolation.create({
      data: {
        sourceId: 'outside-row',
        socrataRowId: 'outside-row',
        bin: '9000009',
        violationNumber: 'OUTSIDE',
        sourceRowUpdatedAt: new Date('2026-09-16T07:00:00.000Z'),
        lastSuccessRunId: previousRun.id,
        isCurrent: true,
      },
    });
    await prisma.ecbViolation.create({
      data: {
        sourceId: 'missing-row',
        socrataRowId: 'missing-row',
        bin: '1000001',
        violationNumber: 'MISSING',
        sourceRowUpdatedAt: new Date('2026-09-16T07:00:00.000Z'),
        lastSuccessRunId: previousRun.id,
        isCurrent: true,
      },
    });

    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(response([sourceRow('promoted-row', '1000001')]));
    const result = await runner({ fetchImpl }).execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    expect(result.outcome).toBe(INGESTION_RUNNER_OUTCOMES.COMPLETED);

    await expect(prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'outside-row' } }))
      .resolves.toMatchObject({ isCurrent: true, lastSuccessRunId: previousRun.id });
    await expect(prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'missing-row' } }))
      .resolves.toMatchObject({ isCurrent: false });
    await expect(prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'promoted-row' } }))
      .resolves.toMatchObject({
        isCurrent: true,
        lastSuccessRunId: 'run' in result ? result.run.id : '',
      });
  });

  it.each([
    ['after live-state work', 'afterLiveState'],
    ['after coverage work', 'afterCoverage'],
  ] as const)('rolls accepted publication back through the runner on failure %s', async (_label, hook) => {
    await seedProperty();
    const injectedFailure = new Error(`failure ${hook}`);
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(response([sourceRow('promoted-row', '1000001')]));
    const acceptedPublicationService = new AcceptedPublicationService({
      prisma,
      testHooks: { [hook]: async () => Promise.reject(injectedFailure) },
    });

    await expect(
      runner({ fetchImpl, acceptedPublicationService }).execute({
        triggerType: IngestionTriggerType.MANUAL,
      }),
    ).rejects.toBe(injectedFailure);

    await expect(prisma.ingestionRun.findFirstOrThrow()).resolves.toMatchObject({
      status: IngestionRunStatus.RUNNING,
      finishedAt: null,
    });
    expect(await prisma.ecbViolation.count()).toBe(0);
    expect(await prisma.propertyDatasetCoverage.count({ where: { status: CoverageStatus.CHECKED } }))
      .toBe(0);
  });

  it('surfaces publication invariant failures instead of reporting execution authority loss', async () => {
    await seedProperty();
    const injectedFailure = new Error('accepted publication invariant failure');
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(response([sourceRow('promoted-row', '1000001')]));
    const acceptedPublicationService = new AcceptedPublicationService({
      prisma,
      testHooks: {
        afterLiveState: async () => {
          throw injectedFailure;
        },
      },
    });

    await expect(
      runner({ fetchImpl, acceptedPublicationService }).execute({
        triggerType: IngestionTriggerType.MANUAL,
      }),
    ).rejects.toBe(injectedFailure);
  });

  it('does not publish accepted or terminal state after lock authority is lost at publication handoff', async () => {
    await seedProperty();
    const lockClient = new FakeLockClient();
    const lockService = new EcbIngestionLockService({
      connectionString,
      clientFactory: () => lockClient,
    });
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(response([sourceRow('superseded-row', '1000001')]));
    const acceptedPublicationService = new AcceptedPublicationService({
      prisma,
      testHooks: {
        afterLiveState: async () => {
          lockClient.emit('end');
        },
      },
    });

    await expect(
      runner({ fetchImpl, lockService, acceptedPublicationService }).execute({
        triggerType: IngestionTriggerType.MANUAL,
      }),
    ).resolves.toEqual({ outcome: INGESTION_RUNNER_OUTCOMES.EXECUTION_AUTHORITY_LOST });
    expect(await prisma.ecbViolation.count()).toBe(0);
    expect(await prisma.propertyDatasetCoverage.count({ where: { status: CoverageStatus.CHECKED } }))
      .toBe(0);
    await expect(prisma.ingestionRun.findFirstOrThrow()).resolves.toMatchObject({
      status: IngestionRunStatus.RUNNING,
      finishedAt: null,
    });
  });
});
