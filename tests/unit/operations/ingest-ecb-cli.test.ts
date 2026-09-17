import {
  IngestionRunStatus,
  IngestionTriggerType,
  type IngestionRun,
  type PrismaClient,
} from '@prisma/client';
import type { Logger } from 'pino';

import { SocrataRequestExecutor } from '../../../src/clients/socrata-request-executor';
import {
  MANUAL_INGESTION_EXIT_CODES,
  runCli,
} from '../../../src/cli/ingest-ecb';
import { loadConfig } from '../../../src/config';
import {
  startIngestionWorker,
  type IngestionServiceFactory,
} from '../../../src/workers/ingestion.worker';
import {
  INGESTION_RUNNER_OUTCOMES,
  type IngestionRunnerResult,
} from '../../../src/services/ecb/ingestion-runner.service';
import type {
  IngestionExecutor,
  OperationalIngestionResult,
} from '../../../src/workers/scheduler';

function loggerMock(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;
}

function terminalResult(
  outcome:
    | typeof INGESTION_RUNNER_OUTCOMES.COMPLETED
    | typeof INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
): OperationalIngestionResult {
  const run = {
    id: 'manual-run',
    status:
      outcome === INGESTION_RUNNER_OUTCOMES.COMPLETED
        ? IngestionRunStatus.COMPLETED
        : IngestionRunStatus.FAILED,
    expectedBinCount: 8,
    binsScanned: 0,
    dataPageCalls: 0,
    metadataCalls: 0,
    retryCalls: 0,
    totalSocrataCalls: 0,
    rowsFetched: 0,
    rowsWritten: 0,
    failures: outcome === INGESTION_RUNNER_OUTCOMES.COMPLETED ? 0 : 1,
  } as IngestionRun;

  if (outcome === INGESTION_RUNNER_OUTCOMES.COMPLETED) {
    const result = {
      outcome,
      run,
      publication: {
        outcome: 'COMPLETED',
        run,
        liveState: { rowsPromoted: 4, rowsMarkedNotCurrent: 0 },
        coverage: { checkedPropertyCount: 8, skippedPropertyCount: 0 },
      },
    } as unknown as IngestionRunnerResult;

    return {
      ...result,
      operationalSummary: {
        runId: 'manual-run',
        status: IngestionRunStatus.COMPLETED,
        binsScanned: 8,
        socrataDataCalls: 1,
        socrataMetadataCalls: 2,
        socrataRetryCalls: 0,
        socrataTotalCalls: 3,
        rowsFetched: 4,
        rowsWritten: 4,
        failures: 0,
      },
    };
  }

  return {
    outcome,
    run,
    operationalSummary: {
      runId: 'manual-run',
      status: IngestionRunStatus.FAILED,
      binsScanned: 8,
      socrataDataCalls: 1,
      socrataMetadataCalls: 2,
      socrataRetryCalls: 0,
      socrataTotalCalls: 3,
      rowsFetched: 4,
      rowsWritten: 4,
      failures: 1,
    },
  };
}

async function invoke(result: IngestionRunnerResult): Promise<{
  exitCode: number;
  execute: jest.MockedFunction<IngestionExecutor['execute']>;
  logger: Logger;
  factory: jest.MockedFunction<IngestionServiceFactory>;
}> {
  const execute = jest.fn<ReturnType<IngestionExecutor['execute']>, Parameters<IngestionExecutor['execute']>>()
    .mockResolvedValue(result);
  const logger = loggerMock();
  const factory = jest.fn(() => ({ execute }));
  await runCli({
    ingestionServiceFactory: factory,
    logger,
    disconnect: jest.fn().mockResolvedValue(undefined),
  });
  return { exitCode: Number(process.exitCode), execute, logger, factory };
}

describe('manual ECB ingestion CLI', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('invokes exactly one manual execution through the shared injectable boundary', async () => {
    const { exitCode, execute, logger, factory } = await invoke(
      terminalResult(INGESTION_RUNNER_OUTCOMES.COMPLETED),
    );

    expect(exitCode).toBe(MANUAL_INGESTION_EXIT_CODES.SUCCESS);
    expect(process.exitCode).toBe(MANUAL_INGESTION_EXIT_CODES.SUCCESS);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ triggerType: IngestionTriggerType.MANUAL });
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
        rowsFetched: 4,
      }),
      'ECB manual ingestion completed',
    );
  });

  it('returns failure for a published terminal failure', async () => {
    const { exitCode, execute } = await invoke(
      terminalResult(INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED),
    );

    expect(exitCode).toBe(MANUAL_INGESTION_EXIT_CODES.FAILURE);
    expect(process.exitCode).toBe(MANUAL_INGESTION_EXIT_CODES.FAILURE);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns a distinct active-owner result without retrying', async () => {
    const { exitCode, execute, logger } = await invoke({
      outcome: INGESTION_RUNNER_OUTCOMES.ACTIVE_EXECUTOR,
      activeRunId: 'owned-run',
    });

    expect(exitCode).toBe(MANUAL_INGESTION_EXIT_CODES.ACTIVE_EXECUTOR);
    expect(process.exitCode).toBe(MANUAL_INGESTION_EXIT_CODES.ACTIVE_EXECUTOR);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ activeRunId: 'owned-run' }),
      'ECB manual ingestion not started because another executor is active',
    );
  });

  it('returns failure when the shared ingestion boundary rejects', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('connection failure'));
    const logger = loggerMock();

    await runCli({
      ingestionServiceFactory: jest.fn(() => ({ execute })),
      logger,
      disconnect: jest.fn().mockResolvedValue(undefined),
    });

    expect(process.exitCode).toBe(MANUAL_INGESTION_EXIT_CODES.FAILURE);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(
      'connection failure',
    );
  });

  it.each(['completed', 'failed', 'rejected'] as const)(
    'keeps configured secrets and raw records out of %s logs',
    async (scenario) => {
      const config = loadConfig({
        DATABASE_URL: 'postgresql://cli-user:cli-secret@example.invalid/cli-db',
        SOCRATA_APP_TOKEN: 'cli-token-sentinel',
      });
      const rawSource = { source_id: 'cli-raw-sentinel', details: 'complete source record' };
      const result = terminalResult(scenario === 'completed'
        ? INGESTION_RUNNER_OUTCOMES.COMPLETED
        : INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED);
      Object.assign(result, { credentials: config, sourceRecord: rawSource });
      if ('run' in result) {
        Object.assign(result.run, { lastError: config.databaseUrl, sourceRecord: rawSource });
      }
      const execute = scenario === 'rejected'
        ? jest.fn().mockRejectedValue(new Error(JSON.stringify({ config, rawSource })))
        : jest.fn().mockResolvedValue(result);
      const logger = loggerMock();

      await runCli({
        config,
        ingestionServiceFactory: jest.fn(() => ({ execute })),
        logger,
        disconnect: jest.fn().mockResolvedValue(undefined),
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(scenario === 'completed' ? 0 : 1);
      const serializedCalls = JSON.stringify(
        (['info', 'warn', 'error'] as const).map((level) => (logger[level] as jest.Mock).mock.calls),
      );
      if (scenario !== 'rejected') {
        expect(serializedCalls).toContain('"rowsFetched":4');
        expect(serializedCalls).toContain(scenario === 'completed' ? 'COMPLETED' : 'FAILED');
      }
      expect(serializedCalls).not.toContain(config.databaseUrl);
      expect(serializedCalls).not.toContain(config.socrataAppToken!);
      expect(serializedCalls).not.toContain(rawSource.source_id);
      expect(serializedCalls).not.toContain(rawSource.details);
    },
  );

  it('worker and executable CLI both resolve the same injectable production composition root', async () => {
    const execute = jest.fn().mockResolvedValue(
      terminalResult(INGESTION_RUNNER_OUTCOMES.COMPLETED),
    );
    const requestExecutor = {
      getMetrics: () => ({ requestCalls: 0, retryCalls: 0 }),
    } as unknown as SocrataRequestExecutor;
    const productionDependencies = {
      prisma: {} as PrismaClient,
      runner: { execute },
      dataRequestExecutor: requestExecutor,
      metadataRequestExecutor: requestExecutor,
      loadCounts: async () => ({ rowsFetched: 4, rowsWritten: 4, failedBatches: 0 }),
    };
    const config = loadConfig({
      DATABASE_URL: 'postgresql://example.invalid/db',
      INGEST_INTERVAL_MS: '60000',
    });
    const worker = startIngestionWorker({
      config,
      logger: loggerMock(),
      ingestionRunnerFactoryDependencies: productionDependencies,
      disconnect: jest.fn().mockResolvedValue(undefined),
      registerProcessHandlers: false,
    });

    await worker.shutdown('TEST');
    await runCli({
      config,
      logger: loggerMock(),
      ingestionRunnerFactoryDependencies: productionDependencies,
      disconnect: jest.fn().mockResolvedValue(undefined),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, {
      triggerType: IngestionTriggerType.SCHEDULED,
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      triggerType: IngestionTriggerType.MANUAL,
    });
  });
});
