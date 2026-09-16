import {
  IngestionBatch,
  IngestionBatchStatus,
  PrismaClient,
} from '@prisma/client';
import { z } from 'zod';

import { SocrataClient, type SocrataRequestExecutorLike } from '../../clients/socrata.client';
import { SocrataRequestExecutor } from '../../clients/socrata-request-executor';
import type { AppConfig } from '../../config/env';
import { CONFIG_DEFAULTS } from '../../config/defaults';
import type { EcbSourceRow } from '../../schemas/ecb-ingestion.schema';
import {
  IngestionAuthorityLostError,
  type IngestionExecutionAuthority,
} from './ingestion-lock.service';
import { IngestionBatchRepository } from './ingestion-batch.repository';
import { EcbRawStagingService } from './raw-staging.service';

export const BATCH_PROCESSOR_ERROR_CODES = Object.freeze({
  INVALID_BATCH_DEFINITION: 'BATCH_INVALID_DEFINITION',
  PAGE_FETCH_FAILED: 'BATCH_PAGE_FETCH_FAILED',
  ROW_PROCESSING_FAILED: 'BATCH_ROW_PROCESSING_FAILED',
} as const);

export const BATCH_PROCESSOR_OUTCOMES = Object.freeze({
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  FAILED_PAGE_LIMIT: 'FAILED_PAGE_LIMIT',
  TERMINAL_FAILED: 'TERMINAL_FAILED',
  AUTHORITY_LOST: 'AUTHORITY_LOST',
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
} as const);

export type BatchProcessorOutcomeCode =
  (typeof BATCH_PROCESSOR_OUTCOMES)[keyof typeof BATCH_PROCESSOR_OUTCOMES];

export const FAILED_PAGE_LIMIT_ERROR = 'FAILED_PAGE_LIMIT' as const;

export const batchDefinitionSchema = z.object({
  bins: z.array(z.string().trim().min(1)).min(1),
  pageSize: z.number().int().positive().max(50_000).optional(),
});

export type PersistedBatchDefinition = z.infer<typeof batchDefinitionSchema>;

export type BatchProcessorMetrics = {
  pagesFetched: number;
  rowsFetched: number;
  requestCalls: number;
  retryCalls: number;
};

export type BatchProcessorOutcome =
  | {
      outcome: typeof BATCH_PROCESSOR_OUTCOMES.COMPLETED;
      batch: IngestionBatch;
      metrics: BatchProcessorMetrics;
    }
  | {
      outcome: typeof BATCH_PROCESSOR_OUTCOMES.FAILED;
      batch: IngestionBatch;
      error: string;
      retryable: boolean;
      metrics: BatchProcessorMetrics;
    }
  | {
      outcome: typeof BATCH_PROCESSOR_OUTCOMES.FAILED_PAGE_LIMIT;
      batch: IngestionBatch;
      metrics: BatchProcessorMetrics;
    }
  | {
      outcome: typeof BATCH_PROCESSOR_OUTCOMES.TERMINAL_FAILED;
      batch: IngestionBatch;
      error: string;
    }
  | {
      outcome: typeof BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST;
      batch: IngestionBatch;
      metrics: BatchProcessorMetrics;
    }
  | {
      outcome: typeof BATCH_PROCESSOR_OUTCOMES.ALREADY_COMPLETED;
      batch: IngestionBatch;
    };

export type BatchProcessorConfig = Pick<
  AppConfig,
  'socrataPageSize' | 'socrataMaxPagesPerBatch' | 'maxBatchAttemptsPerRun'
>;

export type BatchProcessorServiceOptions = {
  prisma: PrismaClient;
  batchRepository?: IngestionBatchRepository;
  rawStagingService?: EcbRawStagingService;
  socrataClient?: SocrataClient;
  requestExecutor?: SocrataRequestExecutor;
  config?: Partial<BatchProcessorConfig>;
  fetchImpl?: typeof fetch;
};

function defaultConfig(overrides: Partial<BatchProcessorConfig> = {}): BatchProcessorConfig {
  return {
    socrataPageSize: overrides.socrataPageSize ?? CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE,
    socrataMaxPagesPerBatch:
      overrides.socrataMaxPagesPerBatch ?? CONFIG_DEFAULTS.SOCRATA_MAX_PAGES_PER_BATCH,
    maxBatchAttemptsPerRun:
      overrides.maxBatchAttemptsPerRun ?? CONFIG_DEFAULTS.MAX_BATCH_ATTEMPTS_PER_RUN,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isAuthorityLost(error: unknown): boolean {
  return (
    error instanceof IngestionAuthorityLostError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'INGESTION_AUTHORITY_LOST')
  );
}

function createBoundedSocrataClient(
  fetchImpl: typeof fetch,
  requestExecutor: SocrataRequestExecutor,
  authority: IngestionExecutionAuthority,
): SocrataClient {
  const boundedExecutor: SocrataRequestExecutorLike = {
    execute: (attempt) =>
      requestExecutor.execute(async () => attempt.execute(), authority.signal),
  };

  return new SocrataClient({
    fetchImpl,
    signal: authority.signal,
    requestExecutor: boundedExecutor,
  });
}

export class EcbBatchProcessorService {
  private readonly batchRepository: IngestionBatchRepository;
  private readonly rawStagingService: EcbRawStagingService;
  private readonly config: BatchProcessorConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly injectedSocrataClient?: SocrataClient;
  private readonly injectedRequestExecutor?: SocrataRequestExecutor;

  constructor(options: BatchProcessorServiceOptions) {
    this.batchRepository = options.batchRepository ?? new IngestionBatchRepository(options.prisma);
    this.rawStagingService = options.rawStagingService ?? new EcbRawStagingService(options.prisma);
    this.config = defaultConfig(options.config);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.injectedSocrataClient = options.socrataClient;
    this.injectedRequestExecutor = options.requestExecutor;
  }

  async executeBatchAttempt(
    batchId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<BatchProcessorOutcome> {
    authority.assertAuthorized('process ingestion batch');

    const existing = await this.batchRepository.findById(batchId);
    if (!existing) {
      throw new Error(`Ingestion batch ${batchId} was not found`);
    }

    if (existing.status === IngestionBatchStatus.COMPLETED) {
      return { outcome: BATCH_PROCESSOR_OUTCOMES.ALREADY_COMPLETED, batch: existing };
    }

    if (existing.attemptCount >= this.config.maxBatchAttemptsPerRun) {
      const terminalBatch = await this.batchRepository.markFailed(
        existing.id,
        `Batch attempt budget exhausted after ${existing.attemptCount} logical attempts`,
      );
      return {
        outcome: BATCH_PROCESSOR_OUTCOMES.TERMINAL_FAILED,
        batch: terminalBatch,
        error: terminalBatch.lastError ?? 'Batch attempt budget exhausted',
      };
    }

    const startedBatch = await this.batchRepository.incrementAttempt(existing.id);
    const runningBatch = await this.batchRepository.updateProgress(startedBatch.id, {
      status: IngestionBatchStatus.RUNNING,
      lastError: null,
    });

    return this.runLogicalAttempt(runningBatch, authority);
  }

  private async runLogicalAttempt(
    batch: IngestionBatch,
    authority: IngestionExecutionAuthority,
  ): Promise<BatchProcessorOutcome> {
    const definition = this.parseBatchDefinition(batch.batchDefinition);
    const pageSize = definition.pageSize ?? this.config.socrataPageSize;
    const requestExecutor =
      this.injectedRequestExecutor ??
      new SocrataRequestExecutor({
        maxRetries: CONFIG_DEFAULTS.SOCRATA_MAX_RETRIES,
      });
    const socrataClient =
      this.injectedSocrataClient ??
      createBoundedSocrataClient(this.fetchImpl, requestExecutor, authority);

    let pagesFetched = 0;
    let rowsFetched = 0;
    let offset = 0;

    try {
      while (true) {
        if (!authority.checkAuthorized()) {
          return {
            outcome: BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST,
            batch,
            metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
          };
        }

        let pageRows: EcbSourceRow[];
        try {
          pageRows = await socrataClient.getEcbDataPage(definition.bins, offset, pageSize);
        } catch (error) {
          if (isAuthorityLost(error) || !authority.checkAuthorized()) {
            return {
              outcome: BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST,
              batch,
              metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
            };
          }

          const failedBatch = await this.batchRepository.markFailed(
            batch.id,
            `${BATCH_PROCESSOR_ERROR_CODES.PAGE_FETCH_FAILED}: ${errorMessage(error)}`,
          );
          return {
            outcome: BATCH_PROCESSOR_OUTCOMES.FAILED,
            batch: failedBatch,
            error: failedBatch.lastError ?? errorMessage(error),
            retryable: true,
            metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
          };
        }

        if (!authority.checkAuthorized()) {
          return {
            outcome: BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST,
            batch,
            metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
          };
        }

        pagesFetched += 1;
        rowsFetched += await this.processPageRows(batch.runId, pageRows, authority);
        batch = await this.batchRepository.updateProgress(batch.id, {
          pagesFetched,
          rowsFetched,
        });

        const terminalPage = pageRows.length < pageSize;
        if (terminalPage) {
          const completedBatch = await this.markCompletedIfAuthorized(
            batch.id,
            authority,
            pagesFetched,
            rowsFetched,
          );
          if (!completedBatch) {
            return {
              outcome: BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST,
              batch,
              metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
            };
          }

          return {
            outcome: BATCH_PROCESSOR_OUTCOMES.COMPLETED,
            batch: completedBatch,
            metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
          };
        }

        if (pagesFetched >= this.config.socrataMaxPagesPerBatch) {
          const failedBatch = await this.batchRepository.markFailed(
            batch.id,
            FAILED_PAGE_LIMIT_ERROR,
          );
          return {
            outcome: BATCH_PROCESSOR_OUTCOMES.FAILED_PAGE_LIMIT,
            batch: failedBatch,
            metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
          };
        }

        offset += pageRows.length;
      }
    } catch (error) {
      if (isAuthorityLost(error) || !authority.checkAuthorized()) {
        return {
          outcome: BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST,
          batch,
          metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
        };
      }

      const failedBatch = await this.batchRepository.markFailed(
        batch.id,
        `${BATCH_PROCESSOR_ERROR_CODES.ROW_PROCESSING_FAILED}: ${errorMessage(error)}`,
      );
      return {
        outcome: BATCH_PROCESSOR_OUTCOMES.FAILED,
        batch: failedBatch,
        error: failedBatch.lastError ?? errorMessage(error),
        retryable: true,
        metrics: this.metrics(requestExecutor, pagesFetched, rowsFetched),
      };
    }
  }

  private async processPageRows(
    runId: string,
    rows: readonly EcbSourceRow[],
    authority: IngestionExecutionAuthority,
  ): Promise<number> {
    let processed = 0;

    for (const row of rows) {
      if (!authority.checkAuthorized()) {
        throw new IngestionAuthorityLostError(
          'persist ECB staging rows',
          'lock session ended',
        );
      }

      await this.rawStagingService.processRow({ runId, row });
      processed += 1;
    }

    return processed;
  }

  private async markCompletedIfAuthorized(
    batchId: string,
    authority: IngestionExecutionAuthority,
    pagesFetched: number,
    rowsFetched: number,
  ): Promise<IngestionBatch | null> {
    if (!authority.checkAuthorized()) {
      return null;
    }

    authority.assertAuthorized('mark ingestion batch complete');
    return this.batchRepository.markCompleted(batchId, { pagesFetched, rowsFetched });
  }

  private metrics(
    requestExecutor: SocrataRequestExecutor,
    pagesFetched: number,
    rowsFetched: number,
  ): BatchProcessorMetrics {
    const executorMetrics = requestExecutor.getMetrics();
    return {
      pagesFetched,
      rowsFetched,
      requestCalls: executorMetrics.requestCalls,
      retryCalls: executorMetrics.retryCalls,
    };
  }

  private parseBatchDefinition(value: unknown): PersistedBatchDefinition {
    try {
      return batchDefinitionSchema.parse(value);
    } catch (error) {
      throw new Error(
        `${BATCH_PROCESSOR_ERROR_CODES.INVALID_BATCH_DEFINITION}: ${errorMessage(error)}`,
      );
    }
  }
}

export const BatchProcessorService = EcbBatchProcessorService;

export function createEcbBatchProcessorService(
  options: BatchProcessorServiceOptions,
): EcbBatchProcessorService {
  return new EcbBatchProcessorService(options);
}
