import { IngestionBatchStatus, IngestionRunStatus, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

import { SocrataClient } from '../clients/socrata.client';
import { SocrataRequestExecutor } from '../clients/socrata-request-executor';
import { getConfig, type AppConfig } from '../config';
import { disconnectPrisma, getPrismaClient } from '../db/prisma';
import { getLogger } from '../logging/logger';
import { EcbBatchProcessorService } from '../services/ecb/batch-processor.service';
import {
  createEcbIngestionRunnerService,
} from '../services/ecb/ingestion-runner.service';
import {
  EcbIngestionLockService,
  IngestionAuthorityLostError,
  type IngestionExecutionAuthority,
} from '../services/ecb/ingestion-lock.service';
import type { DatasetMetadataPort } from '../services/ecb/ingestion-initialization.service';
import {
  createIngestionScheduler,
  type IngestionExecutor,
  type IngestionRunSummary,
  type IngestionScheduler,
  type OperationalIngestionResult,
} from './scheduler';

export type IngestionRunnerFactoryDependencies = {
  prisma?: PrismaClient;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  runner?: IngestionExecutor;
  dataRequestExecutor?: SocrataRequestExecutor;
  metadataRequestExecutor?: SocrataRequestExecutor;
  loadCounts?: (runId: string) => Promise<PersistedOperationalCounts>;
};

export type IngestionServiceFactory = (
  config?: AppConfig,
  dependencies?: IngestionRunnerFactoryDependencies,
) => IngestionExecutor;

type RequestMetrics = ReturnType<SocrataRequestExecutor['getMetrics']>;

export type PersistedOperationalCounts = {
  rowsFetched: number;
  rowsWritten: number;
  failedBatches: number;
};

function requestMetricsDelta(after: RequestMetrics, before: RequestMetrics): RequestMetrics {
  return {
    requestCalls: Math.max(0, after.requestCalls - before.requestCalls),
    retryCalls: Math.max(0, after.retryCalls - before.retryCalls),
  };
}

async function loadPersistedOperationalCounts(
  prisma: PrismaClient,
  runId: string,
): Promise<PersistedOperationalCounts> {
  const [batchTotals, rowsWritten, failedBatches] = await Promise.all([
    prisma.ingestionBatch.aggregate({
      where: { runId },
      _sum: { rowsFetched: true },
    }),
    prisma.ecbViolationStaging.count({ where: { runId } }),
    prisma.ingestionBatch.count({
      where: { runId, status: IngestionBatchStatus.FAILED },
    }),
  ]);

  return {
    rowsFetched: batchTotals._sum.rowsFetched ?? 0,
    rowsWritten,
    failedBatches,
  };
}

export type OperationalIngestionExecutorOptions = {
  runner: IngestionExecutor;
  prisma: PrismaClient;
  dataRequestExecutor: SocrataRequestExecutor;
  metadataRequestExecutor: SocrataRequestExecutor;
  loadCounts?: (runId: string) => Promise<PersistedOperationalCounts>;
};

/** Attach trustworthy execution metrics without copying payloads into the result/log boundary. */
export function createOperationalIngestionExecutor(
  options: OperationalIngestionExecutorOptions,
): IngestionExecutor {
  const loadCounts =
    options.loadCounts ?? ((runId: string) => loadPersistedOperationalCounts(options.prisma, runId));

  return {
    async execute(input): Promise<OperationalIngestionResult> {
      const dataBefore = options.dataRequestExecutor.getMetrics();
      const metadataBefore = options.metadataRequestExecutor.getMetrics();
      const result = await options.runner.execute(input);

      if (!('run' in result)) {
        return result;
      }

      const [counts, dataAfter, metadataAfter] = await Promise.all([
        loadCounts(result.run.id),
        Promise.resolve(options.dataRequestExecutor.getMetrics()),
        Promise.resolve(options.metadataRequestExecutor.getMetrics()),
      ]);
      const dataMetrics = requestMetricsDelta(dataAfter, dataBefore);
      const metadataMetrics = requestMetricsDelta(metadataAfter, metadataBefore);
      const retryCalls = dataMetrics.retryCalls + metadataMetrics.retryCalls;
      const operationalSummary: IngestionRunSummary = {
        runId: result.run.id,
        status: result.run.status,
        binsScanned: result.run.expectedBinCount ?? 0,
        socrataDataCalls: Math.max(0, dataMetrics.requestCalls - dataMetrics.retryCalls),
        socrataMetadataCalls: Math.max(
          0,
          metadataMetrics.requestCalls - metadataMetrics.retryCalls,
        ),
        socrataRetryCalls: retryCalls,
        socrataTotalCalls: dataMetrics.requestCalls + metadataMetrics.requestCalls,
        rowsFetched: counts.rowsFetched,
        rowsWritten: counts.rowsWritten,
        failures:
          result.run.status === IngestionRunStatus.COMPLETED
            ? 0
            : Math.max(1, counts.failedBatches),
      };

      return { ...result, operationalSummary };
    },
  };
}

function withSocrataToken(fetchImpl: typeof fetch, token: string | undefined): typeof fetch {
  if (token === undefined) {
    return fetchImpl;
  }

  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-App-Token', token);
    return fetchImpl(input, { ...init, headers });
  };
}

export function createAuthorityBoundMetadataPort(options: {
  config: AppConfig;
  fetchImpl: typeof fetch;
  logger: Logger;
  authority: () => IngestionExecutionAuthority | undefined;
  requestExecutor?: SocrataRequestExecutor;
}): DatasetMetadataPort {
  const requestExecutor =
    options.requestExecutor ??
    new SocrataRequestExecutor({ config: options.config, logger: options.logger });

  return new SocrataClient({
    fetchImpl: options.fetchImpl,
    logger: options.logger,
    requestExecutor: {
      execute: (attempt) => {
        const authority = options.authority();
        if (authority === undefined) {
          throw new IngestionAuthorityLostError(
            'fetch Socrata dataset metadata',
            'lock authority is unavailable',
          );
        }

        authority.assertAuthorized('fetch Socrata dataset metadata');
        return requestExecutor.execute((requestSignal) => {
          // The executor signal combines its per-attempt timeout with lock-session
          // cancellation. Install it on the materialized request so native fetch
          // is cancelled, rather than merely abandoning the caller-facing promise.
          attempt.request.init = { ...attempt.request.init, signal: requestSignal };
          return attempt.execute();
        }, authority.signal);
      },
    },
    maxBinsPerQuery: options.config.ecbBatchSize,
  });
}

/** Shared production composition root used by both the worker and manual CLI. */
export function createProductionIngestionRunner(
  config: AppConfig = getConfig(),
  dependencies: IngestionRunnerFactoryDependencies = {},
): IngestionExecutor {
  const prisma = dependencies.prisma ?? getPrismaClient();
  const logger = dependencies.logger ?? getLogger();
  const batchRequestExecutor =
    dependencies.dataRequestExecutor ?? new SocrataRequestExecutor({ config, logger });
  const metadataRequestExecutor =
    dependencies.metadataRequestExecutor ?? new SocrataRequestExecutor({ config, logger });
  let runner = dependencies.runner;

  if (runner === undefined) {
    const fetchImpl = withSocrataToken(dependencies.fetchImpl ?? fetch, config.socrataAppToken);
    const lockService = new EcbIngestionLockService({ connectionString: config.databaseUrl });
    const metadataPort = createAuthorityBoundMetadataPort({
      config,
      fetchImpl,
      logger,
      authority: () => lockService.authority,
      requestExecutor: metadataRequestExecutor,
    });
    const batchProcessor = new EcbBatchProcessorService({
      prisma,
      fetchImpl,
      requestExecutor: batchRequestExecutor,
      config,
    });

    runner = createEcbIngestionRunnerService({
      prisma,
      connectionString: config.databaseUrl,
      lockService,
      metadataPort,
      batchProcessor,
      ecbBatchSize: config.ecbBatchSize,
      socrataPageSize: config.socrataPageSize,
      batchProcessorConfig: config,
    });
  }

  return createOperationalIngestionExecutor({
    runner,
    prisma,
    dataRequestExecutor: batchRequestExecutor,
    metadataRequestExecutor,
    loadCounts: dependencies.loadCounts,
  });
}

export type WorkerOptions = {
  config?: AppConfig;
  logger?: Logger;
  ingestionService?: IngestionExecutor;
  ingestionServiceFactory?: IngestionServiceFactory;
  ingestionRunnerFactoryDependencies?: IngestionRunnerFactoryDependencies;
  disconnect?: () => Promise<void>;
  registerProcessHandlers?: boolean;
};

export type IngestionWorker = {
  scheduler: IngestionScheduler;
  shutdown(signal: string, exitCode?: number): Promise<void>;
};

export function startIngestionWorker(options: WorkerOptions = {}): IngestionWorker {
  const config = options.config ?? getConfig();
  const logger = options.logger ?? getLogger();
  const ingestionService =
    options.ingestionService ??
    (options.ingestionServiceFactory ?? createProductionIngestionRunner)(config, {
      ...options.ingestionRunnerFactoryDependencies,
      logger,
    });
  const disconnect = options.disconnect ?? disconnectPrisma;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownExitCode = 0;

  const worker = {} as IngestionWorker;
  const scheduler = createIngestionScheduler({
    intervalMs: config.ingestIntervalMs,
    ingestionService,
    logger,
    onExecutionAuthorityLost: () => {
      void worker.shutdown('EXECUTION_AUTHORITY_LOST', 1);
    },
  });

  worker.scheduler = scheduler;
  worker.shutdown = (signal: string, exitCode = 0) => {
    // A later authority-loss request must upgrade an in-progress graceful stop.
    if (exitCode !== 0) {
      shutdownExitCode = exitCode;
    }
    shutdownPromise ??= (async () => {
      logger.info({ signal }, 'Ingestion worker shutting down');
      try {
        await scheduler.stop();
        await disconnect();
        process.exitCode = shutdownExitCode;
      } catch (error) {
        logger.error(
          { signal, errorType: error instanceof Error ? error.name : 'UnknownError' },
          'Ingestion worker shutdown failed',
        );
        process.exitCode = 1;
      }
    })();
    return shutdownPromise;
  };

  const onSigterm = () => {
    void worker.shutdown('SIGTERM');
  };
  const onSigint = () => {
    void worker.shutdown('SIGINT');
  };
  if (options.registerProcessHandlers ?? true) {
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
  }

  logger.info(
    {
      ingestIntervalMs: config.ingestIntervalMs,
      ecbBatchSize: config.ecbBatchSize,
    },
    'Ingestion worker started',
  );
  scheduler.start();

  return worker;
}

if (require.main === module) {
  startIngestionWorker();
}
