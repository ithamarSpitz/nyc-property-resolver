import { IngestionTriggerType, type IngestionRun } from '@prisma/client';
import type { Logger } from 'pino';

import {
  INGESTION_RUNNER_OUTCOMES,
  type IngestionRunnerResult,
} from '../services/ecb/ingestion-runner.service';

export type IngestionExecutor = {
  execute(input: { triggerType: IngestionTriggerType }): Promise<OperationalIngestionResult>;
};

export type SchedulerTimers = {
  setInterval(callback: () => void, intervalMs: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
};

export type IngestionSchedulerOptions = {
  intervalMs: number;
  ingestionService: IngestionExecutor;
  logger: Logger;
  timers?: SchedulerTimers;
  now?: () => number;
  runImmediately?: boolean;
  onExecutionAuthorityLost?: () => void;
};

export type IngestionRunSummary = {
  runId: string;
  status: IngestionRun['status'];
  binsScanned: number;
  socrataDataCalls: number;
  socrataMetadataCalls: number;
  socrataRetryCalls: number;
  socrataTotalCalls: number;
  rowsFetched: number;
  rowsWritten: number;
  failures: number;
};

/**
 * The ingestion lifecycle currently persists batch/staging progress separately
 * from the legacy run-level counter columns. Production composition attaches
 * this fixed-field summary after execution so entrypoints never report those
 * run-column defaults as real metrics.
 */
export type OperationalIngestionResult = IngestionRunnerResult & {
  operationalSummary?: IngestionRunSummary;
};

const defaultTimers: SchedulerTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => clearInterval(timer),
};

function summarizeRun(run: IngestionRun): IngestionRunSummary {
  return {
    runId: run.id,
    status: run.status,
    binsScanned: run.binsScanned,
    socrataDataCalls: run.dataPageCalls,
    socrataMetadataCalls: run.metadataCalls,
    socrataRetryCalls: run.retryCalls,
    socrataTotalCalls: run.totalSocrataCalls,
    rowsFetched: run.rowsFetched,
    rowsWritten: run.rowsWritten,
    failures: run.failures,
  };
}

/** Build a fixed-field operational summary; never copy arbitrary result data into logs. */
export function summarizeIngestionResult(
  result: OperationalIngestionResult,
  durationMs: number,
): Record<string, unknown> {
  if (result.outcome === INGESTION_RUNNER_OUTCOMES.ACTIVE_EXECUTOR) {
    return {
      outcome: result.outcome,
      activeRunId: result.activeRunId,
      durationMs,
    };
  }

  if (result.outcome === INGESTION_RUNNER_OUTCOMES.EXECUTION_AUTHORITY_LOST) {
    return { outcome: result.outcome, durationMs };
  }

  return {
    outcome: result.outcome,
    ...(result.operationalSummary ?? summarizeRun(result.run)),
    durationMs,
  };
}

export class IngestionScheduler {
  private readonly intervalMs: number;
  private readonly ingestionService: IngestionExecutor;
  private readonly logger: Logger;
  private readonly timers: SchedulerTimers;
  private readonly now: () => number;
  private readonly runImmediately: boolean;
  private readonly onExecutionAuthorityLost?: () => void;
  private timer: NodeJS.Timeout | undefined;
  private currentExecution: Promise<OperationalIngestionResult | undefined> | undefined;

  constructor(options: IngestionSchedulerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new TypeError('ingestion scheduler interval must be a positive integer');
    }

    this.intervalMs = options.intervalMs;
    this.ingestionService = options.ingestionService;
    this.logger = options.logger;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? Date.now;
    this.runImmediately = options.runImmediately ?? true;
    this.onExecutionAuthorityLost = options.onExecutionAuthorityLost;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = this.timers.setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);

    this.logger.info({ ingestIntervalMs: this.intervalMs }, 'ECB ingestion scheduler started');
    if (this.runImmediately) {
      void this.runOnce();
    }
  }

  async runOnce(): Promise<OperationalIngestionResult | undefined> {
    if (this.currentExecution !== undefined) {
      this.logger.warn(
        { triggerType: IngestionTriggerType.SCHEDULED },
        'ECB scheduled ingestion skipped because the local execution is still active',
      );
      return undefined;
    }

    const execution = this.executeScheduledRun();
    this.currentExecution = execution;

    try {
      return await execution;
    } finally {
      if (this.currentExecution === execution) {
        this.currentExecution = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }

    await this.currentExecution;
    this.logger.info('ECB ingestion scheduler stopped');
  }

  private async executeScheduledRun(): Promise<OperationalIngestionResult | undefined> {
    const startedAt = this.now();
    this.logger.info(
      { triggerType: IngestionTriggerType.SCHEDULED },
      'ECB scheduled ingestion started',
    );

    try {
      const result = await this.ingestionService.execute({
        triggerType: IngestionTriggerType.SCHEDULED,
      });
      const summary = summarizeIngestionResult(result, this.now() - startedAt);

      if (result.outcome === INGESTION_RUNNER_OUTCOMES.EXECUTION_AUTHORITY_LOST) {
        this.logger.error(summary, 'ECB scheduled ingestion lost execution authority');
        this.onExecutionAuthorityLost?.();
      } else if (
        result.outcome === INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED ||
        result.outcome === INGESTION_RUNNER_OUTCOMES.SOURCE_CHANGED_PUBLISHED
      ) {
        this.logger.warn(summary, 'ECB scheduled ingestion completed with a terminal outcome');
      } else {
        this.logger.info(summary, 'ECB scheduled ingestion completed');
      }

      return result;
    } catch (error) {
      this.logger.error(
        {
          triggerType: IngestionTriggerType.SCHEDULED,
          durationMs: this.now() - startedAt,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        },
        'ECB scheduled ingestion failed',
      );
      return undefined;
    }
  }
}

export function createIngestionScheduler(
  options: IngestionSchedulerOptions,
): IngestionScheduler {
  return new IngestionScheduler(options);
}
