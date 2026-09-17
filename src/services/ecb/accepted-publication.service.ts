import {
  Dataset,
  IngestionBatchStatus,
  IngestionRun,
  IngestionRunStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import type { IngestionExecutionAuthority } from './ingestion-lock.service';
import { CONFIG_DEFAULTS } from '../../config/defaults';
import {
  promoteEcbLiveState,
  type LiveStatePromotionResult,
} from './live-state.repository';
import {
  publishSuccessfulCoverage,
  type SuccessfulCoveragePublicationResult,
  type SuccessfulCoverageTransaction,
} from './successful-coverage.service';

export const ACCEPTED_PUBLICATION_OUTCOMES = Object.freeze({
  COMPLETED: 'COMPLETED',
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
} as const);

export type AcceptedPublicationResult =
  | {
      outcome: typeof ACCEPTED_PUBLICATION_OUTCOMES.COMPLETED;
      run: IngestionRun;
      liveState: LiveStatePromotionResult;
      coverage: SuccessfulCoveragePublicationResult;
    }
  | {
      outcome: typeof ACCEPTED_PUBLICATION_OUTCOMES.ALREADY_COMPLETED;
      run: IngestionRun;
    };

export type AcceptedPublicationTestHooks = {
  afterLiveState?: (tx: SuccessfulCoverageTransaction) => Promise<void>;
  afterCoverage?: (tx: SuccessfulCoverageTransaction) => Promise<void>;
};

export type AcceptedPublicationServiceOptions = {
  prisma: PrismaClient;
  transactionTimeoutMs?: number;
  testHooks?: AcceptedPublicationTestHooks;
  now?: () => Date;
};

export class AcceptedPublicationError extends Error {
  constructor(message: string) {
    super(`Accepted run publication: ${message}`);
    this.name = 'AcceptedPublicationError';
  }
}

type SnapshotBinRow = { bin: string };

function publicationError(message: string): AcceptedPublicationError {
  return new AcceptedPublicationError(message);
}

function batchDefinitionBins(value: Prisma.JsonValue, runId: string, batchNumber: number): string[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray(value.bins) ||
    value.bins.some((bin) => typeof bin !== 'string')
  ) {
    throw publicationError(
      `run ${runId} batch ${batchNumber} does not have a valid immutable BIN definition`,
    );
  }

  return value.bins as string[];
}

async function lockAndValidateRun(
  tx: SuccessfulCoverageTransaction,
  runId: string,
): Promise<IngestionRun> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "ingestion_runs"
    WHERE "id" = ${runId}::uuid
    FOR UPDATE
  `);

  const run = await tx.ingestionRun.findUnique({ where: { id: runId } });
  if (run === null) {
    throw publicationError(`run ${runId} does not exist`);
  }
  if (run.dataset !== Dataset.DOB_ECB_VIOLATIONS) {
    throw publicationError(`run ${runId} is not an ECB ingestion run`);
  }
  if (run.status === IngestionRunStatus.COMPLETED) {
    return run;
  }
  if (run.status !== IngestionRunStatus.RUNNING) {
    throw publicationError(`run ${runId} is not ready for publication (status=${run.status})`);
  }
  if (!run.initializationComplete) {
    throw publicationError(`run ${runId} initialization is incomplete`);
  }
  if (run.startedAt === null) {
    throw publicationError(`run ${runId} is missing started_at`);
  }
  if (run.sourceWatermarkAtStart === null || run.sourceWatermarkAtEnd === null) {
    throw publicationError(`run ${runId} is missing a start or end source watermark`);
  }
  if (run.sourceWatermarkAtStart.getTime() !== run.sourceWatermarkAtEnd.getTime()) {
    throw publicationError(`run ${runId} failed the source watermark guard`);
  }
  if (
    run.expectedPropertyBinCount === null ||
    run.expectedBinCount === null ||
    run.expectedBatchCount === null
  ) {
    throw publicationError(`run ${runId} is missing persisted initialization counts`);
  }

  const [snapshotPropertyBinCount, snapshotBins, batches] = await Promise.all([
    tx.ingestionRunPropertyBin.count({ where: { runId } }),
    tx.$queryRaw<SnapshotBinRow[]>(Prisma.sql`
      SELECT DISTINCT "bin"
      FROM "ingestion_run_property_bins"
      WHERE "run_id" = ${runId}::uuid
      ORDER BY "bin"
    `),
    tx.ingestionBatch.findMany({ where: { runId }, orderBy: { batchNumber: 'asc' } }),
  ]);

  if (snapshotPropertyBinCount !== run.expectedPropertyBinCount) {
    throw publicationError(`run ${runId} property/BIN snapshot count is incomplete`);
  }
  if (snapshotBins.length !== run.expectedBinCount) {
    throw publicationError(`run ${runId} distinct BIN snapshot count is incomplete`);
  }
  if (batches.length !== run.expectedBatchCount) {
    throw publicationError(`run ${runId} batch count is incomplete`);
  }
  if (
    batches.some(
      (batch) =>
        batch.status !== IngestionBatchStatus.COMPLETED ||
        batch.completedAt === null ||
        batch.lastError !== null,
    )
  ) {
    throw publicationError(`run ${runId} has incomplete or unsuccessful batch processing`);
  }

  const processedBins = batches.flatMap((batch) =>
    batchDefinitionBins(batch.batchDefinition, runId, batch.batchNumber),
  );
  const uniqueProcessedBins = [...new Set(processedBins)].sort();
  const expectedBins = snapshotBins.map((row) => row.bin);
  if (
    processedBins.length !== uniqueProcessedBins.length ||
    uniqueProcessedBins.length !== expectedBins.length ||
    uniqueProcessedBins.some((bin, index) => bin !== expectedBins[index])
  ) {
    throw publicationError(`run ${runId} completed batches do not exactly cover its BIN snapshot`);
  }

  return run;
}

export class AcceptedPublicationService {
  private readonly prisma: PrismaClient;
  private readonly testHooks: AcceptedPublicationTestHooks;
  private readonly now: () => Date;
  private readonly transactionTimeoutMs: number;

  constructor(options: AcceptedPublicationServiceOptions) {
    this.prisma = options.prisma;
    this.testHooks = options.testHooks ?? {};
    this.now = options.now ?? (() => new Date());
    this.transactionTimeoutMs =
      options.transactionTimeoutMs ??
      CONFIG_DEFAULTS.ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS;
    if (!Number.isInteger(this.transactionTimeoutMs) || this.transactionTimeoutMs <= 0) {
      throw publicationError('transactionTimeoutMs must be a positive integer');
    }
  }

  async publish(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<AcceptedPublicationResult> {
    authority.assertAuthorized('publish an accepted ingestion run');

    return this.prisma.$transaction(async (transaction) => {
      const tx = transaction as SuccessfulCoverageTransaction;
      const run = await lockAndValidateRun(tx, runId);

      // The row lock serializes concurrent/replayed publishers. A completed run
      // is an explicit no-op and cannot receive a second semantic completion.
      if (run.status === IngestionRunStatus.COMPLETED) {
        return {
          outcome: ACCEPTED_PUBLICATION_OUTCOMES.ALREADY_COMPLETED,
          run,
        };
      }

      authority.assertAuthorized('begin accepted-state publication');
      const acceptedAt = this.now();
      const liveState = await promoteEcbLiveState(tx, runId);
      await this.testHooks.afterLiveState?.(tx);

      authority.assertAuthorized('publish successful property coverage');
      const coverage = await publishSuccessfulCoverage(tx, run, acceptedAt);
      await this.testHooks.afterCoverage?.(tx);

      // This is the last application-level authority check before the terminal
      // state-changing write. Any revocation observed here rolls back every
      // live-state and coverage mutation above with the transaction.
      authority.assertAuthorized('mark the accepted ingestion run completed');
      const completion = await tx.ingestionRun.updateMany({
        where: { id: runId, status: IngestionRunStatus.RUNNING },
        data: {
          status: IngestionRunStatus.COMPLETED,
          finishedAt: acceptedAt,
          failureStage: null,
          lastError: null,
        },
      });
      if (completion.count !== 1) {
        throw publicationError(`run ${runId} could not transition atomically to COMPLETED`);
      }

      const completedRun = await tx.ingestionRun.findUnique({ where: { id: runId } });
      if (completedRun === null) {
        throw publicationError(`run ${runId} disappeared after completion`);
      }

      return {
        outcome: ACCEPTED_PUBLICATION_OUTCOMES.COMPLETED,
        run: completedRun,
        liveState,
        coverage,
      };
    }, { timeout: this.transactionTimeoutMs });
  }

  async publishAcceptedRun(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<AcceptedPublicationResult> {
    return this.publish(runId, authority);
  }
}

export const EcbAcceptedPublicationService = AcceptedPublicationService;

export function createAcceptedPublicationService(
  options: AcceptedPublicationServiceOptions,
): AcceptedPublicationService {
  return new AcceptedPublicationService(options);
}

export const createEcbAcceptedPublicationService = createAcceptedPublicationService;

export async function publishAcceptedRun(
  prisma: PrismaClient,
  runId: string,
  authority: IngestionExecutionAuthority,
  options: Omit<AcceptedPublicationServiceOptions, 'prisma'> = {},
): Promise<AcceptedPublicationResult> {
  return new AcceptedPublicationService({ prisma, ...options }).publish(runId, authority);
}
