import { IngestionTriggerType } from '@prisma/client';
import type { Logger } from 'pino';

import type { AppConfig } from '../config';
import { disconnectPrisma } from '../db/prisma';
import { getLogger } from '../logging/logger';
import { INGESTION_RUNNER_OUTCOMES } from '../services/ecb/ingestion-runner.service';
import {
  createProductionIngestionRunner,
  type IngestionRunnerFactoryDependencies,
  type IngestionServiceFactory,
} from '../workers/ingestion.worker';
import {
  summarizeIngestionResult,
  type IngestionExecutor,
} from '../workers/scheduler';

export const MANUAL_INGESTION_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FAILURE: 1,
  ACTIVE_EXECUTOR: 2,
} as const);

export type ManualIngestionOptions = {
  ingestionService: IngestionExecutor;
  logger: Logger;
  now?: () => number;
};

export type ManualCliDependencies = {
  config?: AppConfig;
  logger?: Logger;
  ingestionServiceFactory?: IngestionServiceFactory;
  ingestionRunnerFactoryDependencies?: IngestionRunnerFactoryDependencies;
  disconnect?: () => Promise<void>;
};

function failureDiagnostics(error: unknown): {
  errorType: string;
  errorCode?: string;
  errorMessage?: string;
} {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^P\d{4}$/.test(error.code)
  ) {
    return { errorType, errorCode: error.code, errorMessage: error.message };
  }
  return { errorType };
}

/** Execute exactly one manual ingestion attempt and return a process-safe exit code. */
export async function runManualIngestion(options: ManualIngestionOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  options.logger.info(
    { triggerType: IngestionTriggerType.MANUAL },
    'ECB manual ingestion started',
  );

  try {
    const result = await options.ingestionService.execute({
      triggerType: IngestionTriggerType.MANUAL,
    });
    const summary = summarizeIngestionResult(result, now() - startedAt);

    if (result.outcome === INGESTION_RUNNER_OUTCOMES.COMPLETED) {
      options.logger.info(summary, 'ECB manual ingestion completed');
      return MANUAL_INGESTION_EXIT_CODES.SUCCESS;
    }

    if (result.outcome === INGESTION_RUNNER_OUTCOMES.ACTIVE_EXECUTOR) {
      options.logger.warn(summary, 'ECB manual ingestion not started because another executor is active');
      return MANUAL_INGESTION_EXIT_CODES.ACTIVE_EXECUTOR;
    }

    options.logger.error(summary, 'ECB manual ingestion completed with a failure outcome');
    return MANUAL_INGESTION_EXIT_CODES.FAILURE;
  } catch (error) {
    options.logger.error(
      {
        triggerType: IngestionTriggerType.MANUAL,
        durationMs: now() - startedAt,
        ...failureDiagnostics(error),
      },
      'ECB manual ingestion failed',
    );
    return MANUAL_INGESTION_EXIT_CODES.FAILURE;
  }
}

export async function main(dependencies: ManualCliDependencies = {}): Promise<number> {
  const logger = dependencies.logger ?? getLogger();
  const ingestionServiceFactory =
    dependencies.ingestionServiceFactory ?? createProductionIngestionRunner;
  let exitCode: number;

  try {
    exitCode = await runManualIngestion({
      ingestionService: ingestionServiceFactory(dependencies.config, {
        ...dependencies.ingestionRunnerFactoryDependencies,
        logger,
      }),
      logger,
    });
  } catch (error) {
    logger.error(
      failureDiagnostics(error),
      'ECB manual ingestion could not start',
    );
    exitCode = MANUAL_INGESTION_EXIT_CODES.FAILURE;
  }

  try {
    await (dependencies.disconnect ?? disconnectPrisma)();
  } catch (error) {
    logger.error(
      failureDiagnostics(error),
      'ECB manual ingestion database shutdown failed',
    );
    exitCode = MANUAL_INGESTION_EXIT_CODES.FAILURE;
  }

  return exitCode;
}

/** Executable bridge: translate the one-run result into the process outcome. */
export async function runCli(dependencies: ManualCliDependencies = {}): Promise<void> {
  process.exitCode = await main(dependencies);
}

if (require.main === module) {
  void runCli();
}
