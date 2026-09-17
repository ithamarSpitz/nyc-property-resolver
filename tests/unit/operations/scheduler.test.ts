import {
  IngestionRunStatus,
  IngestionTriggerType,
  type IngestionRun,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

import { SocrataRequestExecutor } from '../../../src/clients/socrata-request-executor';
import { loadConfig } from '../../../src/config';
import {
  INGESTION_RUNNER_OUTCOMES,
  type IngestionRunnerResult,
} from '../../../src/services/ecb/ingestion-runner.service';
import { IngestionExecutionAuthority } from '../../../src/services/ecb/ingestion-lock.service';
import {
  createAuthorityBoundMetadataPort,
  createOperationalIngestionExecutor,
  startIngestionWorker,
} from '../../../src/workers/ingestion.worker';
import {
  createIngestionScheduler,
  type IngestionExecutor,
  type OperationalIngestionResult,
} from '../../../src/workers/scheduler';

function loggerMock(): Logger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;
}

function completedResult(withOperationalSummary = true): OperationalIngestionResult {
  const run = {
    id: 'run-1',
    status: IngestionRunStatus.COMPLETED,
    expectedBinCount: 12,
    binsScanned: 0,
    dataPageCalls: 0,
    metadataCalls: 0,
    retryCalls: 0,
    totalSocrataCalls: 0,
    rowsFetched: 0,
    rowsWritten: 0,
    failures: 0,
  } as IngestionRun;

  const result = {
    outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
    run,
    publication: {
      outcome: 'COMPLETED',
      run,
      liveState: { rowsPromoted: 28, rowsMarkedNotCurrent: 0 },
      coverage: { checkedPropertyCount: 12, skippedPropertyCount: 0 },
    },
  } as unknown as IngestionRunnerResult;

  return withOperationalSummary
    ? {
        ...result,
        operationalSummary: {
          runId: 'run-1',
          status: IngestionRunStatus.COMPLETED,
          binsScanned: 12,
          socrataDataCalls: 2,
          socrataMetadataCalls: 2,
          socrataRetryCalls: 1,
          socrataTotalCalls: 5,
          rowsFetched: 30,
          rowsWritten: 28,
          failures: 0,
        },
      }
    : result;
}

describe('IngestionScheduler', () => {
  const originalExitCode = process.exitCode;
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    jest.useRealTimers();
  });

  it('uses the configured interval and the injectable ingestion boundary', async () => {
    const execute = jest.fn<ReturnType<IngestionExecutor['execute']>, Parameters<IngestionExecutor['execute']>>()
      .mockResolvedValue(completedResult());
    const scheduler = createIngestionScheduler({
      intervalMs: 2_500,
      ingestionService: { execute },
      logger: loggerMock(),
      runImmediately: false,
    });

    scheduler.start();
    await jest.advanceTimersByTimeAsync(7_499);
    expect(execute).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenNthCalledWith(1, {
      triggerType: IngestionTriggerType.SCHEDULED,
    });

    await scheduler.stop();
  });

  it('runs on worker startup and never overlaps a still-running local execution', async () => {
    let resolveExecution!: (result: IngestionRunnerResult) => void;
    const pending = new Promise<IngestionRunnerResult>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = jest.fn().mockReturnValue(pending);
    const logger = loggerMock();
    const scheduler = createIngestionScheduler({
      intervalMs: 1_000,
      ingestionService: { execute },
      logger,
    });

    scheduler.start();
    expect(execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(3);

    resolveExecution(completedResult());
    await scheduler.stop();
  });

  it('reports the active-owner outcome without starting competing work', async () => {
    const logger = loggerMock();
    const execute = jest.fn().mockResolvedValue({
      outcome: INGESTION_RUNNER_OUTCOMES.ACTIVE_EXECUTOR,
      activeRunId: 'active-run',
    });
    const scheduler = createIngestionScheduler({
      intervalMs: 1_000,
      ingestionService: { execute },
      logger,
      runImmediately: false,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      outcome: INGESTION_RUNNER_OUTCOMES.ACTIVE_EXECUTOR,
      activeRunId: 'active-run',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: INGESTION_RUNNER_OUTCOMES.ACTIVE_EXECUTOR,
        activeRunId: 'active-run',
      }),
      'ECB scheduled ingestion completed',
    );
  });

  it('logs summaries without configured secret values or raw source data, including failures', async () => {
    const logger = loggerMock();
    const config = loadConfig({
      DATABASE_URL: 'postgresql://log-user:connection-sentinel@example.invalid/log-db',
      SOCRATA_APP_TOKEN: 'token-sentinel-operations',
      INGEST_INTERVAL_MS: '1000',
    });
    const rawSource = { source_id: 'raw-source-sentinel', details: 'full upstream record' };
    const result = completedResult();
    Object.assign(result, { credentials: config, sourceRecord: rawSource });
    if ('run' in result) {
      Object.assign(result.run, { lastError: config.databaseUrl, sourceRecord: rawSource });
    }
    const execute = jest.fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new Error(JSON.stringify({ config, rawSource })));
    const worker = startIngestionWorker({
      config,
      ingestionService: { execute },
      logger,
      disconnect: jest.fn().mockResolvedValue(undefined),
      registerProcessHandlers: false,
    });

    await jest.advanceTimersByTimeAsync(config.ingestIntervalMs);
    await worker.shutdown('TEST');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    const serializedCalls = JSON.stringify(
      (['debug', 'info', 'warn', 'error'] as const).map((level) => (logger[level] as jest.Mock).mock.calls),
    );

    expect(serializedCalls).toContain('"rowsFetched":30');
    expect(serializedCalls).toContain('"status":"COMPLETED"');
    expect(serializedCalls).not.toContain(config.databaseUrl);
    expect(serializedCalls).not.toContain(config.socrataAppToken!);
    expect(serializedCalls).not.toContain(rawSource.source_id);
    expect(serializedCalls).not.toContain(rawSource.details);
  });

  it.each([2500, 7300])('worker uses configured cadence %i through the shared factory', async (intervalMs) => {
    const originalExitCode = process.exitCode;
    const execute = jest.fn().mockResolvedValue(completedResult());
    const ingestionServiceFactory = jest.fn().mockReturnValue({ execute });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const worker = startIngestionWorker({
      config: loadConfig({
        DATABASE_URL: 'postgresql://example.invalid/db',
        INGEST_INTERVAL_MS: String(intervalMs),
      }),
      logger: loggerMock(),
      ingestionServiceFactory,
      disconnect,
      registerProcessHandlers: false,
    });

    expect(ingestionServiceFactory).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(intervalMs - 1);
    expect(execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(intervalMs);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledWith({ triggerType: IngestionTriggerType.SCHEDULED });
    await worker.shutdown('TEST');
    await jest.advanceTimersByTimeAsync(intervalMs * 2);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledTimes(1);
    process.exitCode = originalExitCode;
  });

  it('exits non-zero when authority is lost during an existing graceful shutdown', async () => {
    let resolveExecution!: (result: IngestionRunnerResult) => void;
    const execute = jest.fn().mockReturnValue(new Promise<IngestionRunnerResult>((resolve) => {
      resolveExecution = resolve;
    }));
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const worker = startIngestionWorker({
      config: loadConfig({ DATABASE_URL: 'postgresql://example.invalid/db', INGEST_INTERVAL_MS: '1000' }),
      ingestionService: { execute },
      logger: loggerMock(),
      disconnect,
      registerProcessHandlers: false,
    });

    const shutdown = worker.shutdown('SIGTERM');
    expect(disconnect).not.toHaveBeenCalled();
    resolveExecution({ outcome: INGESTION_RUNNER_OUTCOMES.EXECUTION_AUTHORITY_LOST });
    await shutdown;
    expect(process.exitCode).toBe(1);
    expect(worker.shutdown('SIGINT')).toBe(shutdown);
    await worker.shutdown('SIGINT');
    expect(process.exitCode).toBe(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('production metric composition ignores zero run defaults and uses real execution counters', async () => {
    let dataMetrics = { requestCalls: 10, retryCalls: 2 };
    let metadataMetrics = { requestCalls: 4, retryCalls: 1 };
    const dataRequestExecutor = {
      getMetrics: () => dataMetrics,
    } as unknown as SocrataRequestExecutor;
    const metadataRequestExecutor = {
      getMetrics: () => metadataMetrics,
    } as unknown as SocrataRequestExecutor;
    const runner: IngestionExecutor = {
      execute: jest.fn(async () => {
        dataMetrics = { requestCalls: 14, retryCalls: 3 };
        metadataMetrics = { requestCalls: 7, retryCalls: 2 };
        return completedResult(false);
      }),
    };
    const executor = createOperationalIngestionExecutor({
      runner,
      prisma: {} as PrismaClient,
      dataRequestExecutor,
      metadataRequestExecutor,
      loadCounts: async () => ({
        rowsFetched: 30,
        rowsWritten: 28,
        failedBatches: 0,
      }),
    });

    const result = await executor.execute({ triggerType: IngestionTriggerType.SCHEDULED });

    expect(result.operationalSummary).toEqual({
      runId: 'run-1',
      status: IngestionRunStatus.COMPLETED,
      binsScanned: 12,
      socrataDataCalls: 3,
      socrataMetadataCalls: 2,
      socrataRetryCalls: 2,
      socrataTotalCalls: 7,
      rowsFetched: 30,
      rowsWritten: 28,
      failures: 0,
    });
  });
});

describe('production metadata request composition', () => {
  it('aborts the underlying metadata fetch when advisory-lock authority is lost', async () => {
    const authority = new IngestionExecutionAuthority();
    const requestController = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let executorSignal: AbortSignal | undefined;
    const fetchImpl = jest.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const config = loadConfig({
      DATABASE_URL: 'postgresql://example.invalid/db',
      SOCRATA_REQUEST_TIMEOUT_MS: '10000',
      SOCRATA_MAX_RETRIES: '1',
    });
    const requestExecutor = {
      execute: jest.fn(
        async (
          operation: (signal: AbortSignal) => Promise<unknown>,
          signal?: AbortSignal,
        ) => {
          executorSignal = signal;
          signal?.addEventListener(
            'abort',
            () => requestController.abort(signal.reason),
            { once: true },
          );
          return operation(requestController.signal);
        },
      ),
    } as unknown as SocrataRequestExecutor;
    const metadataPort = createAuthorityBoundMetadataPort({
      config,
      fetchImpl,
      logger: loggerMock(),
      authority: () => authority,
      requestExecutor,
    });

    const request = metadataPort.getDatasetMetadata();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(executorSignal).toBe(authority.signal);
    expect(fetchSignal).toBe(requestController.signal);

    authority.revoke('lock session ended');

    await expect(request).rejects.toBeDefined();
    expect(fetchSignal?.aborted).toBe(true);
  });
});
