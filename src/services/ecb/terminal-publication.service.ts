import {
  CoverageStatus,
  Dataset,
  IngestionBatchStatus,
  IngestionRun,
  IngestionRunStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import type { IngestionExecutionAuthority } from './ingestion-lock.service';
import type {
  IngestionTerminalPublicationPort,
  IngestionTerminalPublicationRequest,
} from './ingestion-terminal-publication.port';
import { CONFIG_DEFAULTS } from '../../config/defaults';

export const TERMINAL_COVERAGE_ERRORS = Object.freeze({
  SOURCE_CHANGED: 'SOURCE_CHANGED',
  RUN_NOT_PROMOTED: 'RUN_NOT_PROMOTED',
} as const);

type TerminalPublicationTransaction = Prisma.TransactionClient & {
  readonly $transaction?: never;
};

export type TerminalPublicationTestHooks = {
  afterRunUpdate?: (tx: TerminalPublicationTransaction) => Promise<void>;
  afterCoverage?: (tx: TerminalPublicationTransaction) => Promise<void>;
};

export type TerminalPublicationServiceOptions = {
  prisma: PrismaClient;
  transactionTimeoutMs?: number;
  testHooks?: TerminalPublicationTestHooks;
  executionAuthority?:
    | IngestionExecutionAuthority
    | (() => IngestionExecutionAuthority | undefined);
};

export class TerminalPublicationError extends Error {
  constructor(message: string) {
    super(`Terminal failure publication: ${message}`);
    this.name = 'TerminalPublicationError';
  }
}

type SnapshotVersionRow = {
  propertyId: string;
  snapshotVersionCount: bigint;
};

function publicationError(message: string): TerminalPublicationError {
  return new TerminalPublicationError(message);
}

function validateRequest(request: IngestionTerminalPublicationRequest): void {
  if (
    request.status !== IngestionRunStatus.FAILED &&
    request.status !== IngestionRunStatus.SOURCE_CHANGED
  ) {
    throw publicationError(`unsupported terminal status ${String(request.status)}`);
  }
  if (request.failureStage.trim().length === 0) {
    throw publicationError('failureStage must be non-empty');
  }
  if (request.lastError.trim().length === 0) {
    throw publicationError('lastError must be non-empty');
  }
  if (Number.isNaN(request.finishedAt.getTime())) {
    throw publicationError('finishedAt must be a valid date');
  }
  if (
    request.status === IngestionRunStatus.SOURCE_CHANGED &&
    request.lastError !== TERMINAL_COVERAGE_ERRORS.SOURCE_CHANGED
  ) {
    throw publicationError('SOURCE_CHANGED publication requires lastError=SOURCE_CHANGED');
  }
}

async function lockAndValidateRun(
  tx: TerminalPublicationTransaction,
  request: IngestionTerminalPublicationRequest,
): Promise<IngestionRun> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "ingestion_runs"
    WHERE "id" = ${request.runId}::uuid
    FOR UPDATE
  `);

  const run = await tx.ingestionRun.findUnique({ where: { id: request.runId } });
  if (run === null) {
    throw publicationError(`run ${request.runId} does not exist`);
  }
  if (run.dataset !== Dataset.DOB_ECB_VIOLATIONS) {
    throw publicationError(`run ${request.runId} is not an ECB ingestion run`);
  }
  if (
    run.status !== IngestionRunStatus.QUEUED &&
    run.status !== IngestionRunStatus.RUNNING
  ) {
    throw publicationError(
      `run ${request.runId} is not active (status=${run.status})`,
    );
  }
  if (
    request.status === IngestionRunStatus.SOURCE_CHANGED &&
    (run.status !== IngestionRunStatus.RUNNING ||
      !run.initializationComplete ||
      run.sourceWatermarkAtStart === null)
  ) {
    throw publicationError(
      `run ${request.runId} is not eligible for SOURCE_CHANGED publication`,
    );
  }

  return run;
}

async function lockAndValidateSnapshotProperties(
  tx: TerminalPublicationTransaction,
  runId: string,
): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT property."id"
    FROM "properties" AS property
    WHERE EXISTS (
      SELECT 1
      FROM "ingestion_run_property_bins" AS snapshot
      WHERE snapshot."run_id" = ${runId}::uuid
        AND snapshot."property_id" = property."id"
    )
    ORDER BY property."id"
    FOR UPDATE OF property
  `);

  const versions = await tx.$queryRaw<SnapshotVersionRow[]>(Prisma.sql`
    SELECT
      "property_id" AS "propertyId",
      COUNT(DISTINCT "property_identifier_version")::bigint AS "snapshotVersionCount"
    FROM "ingestion_run_property_bins"
    WHERE "run_id" = ${runId}::uuid
    GROUP BY "property_id"
  `);
  if (versions.some((row) => row.snapshotVersionCount !== 1n)) {
    throw publicationError(
      `run ${runId} has inconsistent identifier versions in its snapshot`,
    );
  }
}

async function publishFailedCoverage(
  tx: TerminalPublicationTransaction,
  request: IngestionTerminalPublicationRequest,
): Promise<void> {
  const failureReason =
    request.status === IngestionRunStatus.SOURCE_CHANGED
      ? Prisma.sql`${TERMINAL_COVERAGE_ERRORS.SOURCE_CHANGED}::text`
      : Prisma.sql`COALESCE(
          failed_property."last_error",
          ${TERMINAL_COVERAGE_ERRORS.RUN_NOT_PROMOTED}::text
        )`;

  const failedBatchCtes =
    request.status === IngestionRunStatus.SOURCE_CHANGED
      ? Prisma.sql`
          failed_property AS MATERIALIZED (
            SELECT NULL::uuid AS "property_id", NULL::text AS "last_error"
            WHERE FALSE
          )
        `
      : Prisma.sql`
          failed_bins AS MATERIALIZED (
            SELECT
              failed_bin."bin",
              batch."batch_number",
              batch."last_error"
            FROM "ingestion_batches" AS batch
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(batch."batch_definition"->'bins') = 'array'
                  THEN batch."batch_definition"->'bins'
                ELSE '[]'::jsonb
              END
            ) AS failed_bin("bin")
            WHERE batch."run_id" = ${request.runId}::uuid
              AND batch."status" = ${IngestionBatchStatus.FAILED}::"IngestionBatchStatus"
              AND batch."last_error" IS NOT NULL
              AND length(trim(batch."last_error")) > 0
          ),
          failed_property AS MATERIALIZED (
            SELECT DISTINCT ON (snapshot."property_id")
              snapshot."property_id",
              failed_bins."last_error"
            FROM "ingestion_run_property_bins" AS snapshot
            JOIN failed_bins ON failed_bins."bin" = snapshot."bin"
            WHERE snapshot."run_id" = ${request.runId}::uuid
            ORDER BY snapshot."property_id", failed_bins."batch_number"
          )
        `;

  await tx.$executeRaw(Prisma.sql`
    WITH
    eligible_snapshot AS MATERIALIZED (
      SELECT DISTINCT ON (snapshot."property_id")
        snapshot."property_id",
        snapshot."property_identifier_version"
      FROM "ingestion_run_property_bins" AS snapshot
      WHERE snapshot."run_id" = ${request.runId}::uuid
      ORDER BY snapshot."property_id", snapshot."bin"
    ),
    ${failedBatchCtes}
    INSERT INTO "property_dataset_coverage" (
      "property_id",
      "dataset",
      "status",
      "status_reason",
      "last_attempt_run_id",
      "last_attempt_at",
      "last_error"
    )
    SELECT
      snapshot."property_id",
      ${Dataset.DOB_ECB_VIOLATIONS}::"Dataset",
      ${CoverageStatus.FAILED}::"CoverageStatus",
      NULL::"CoverageStatusReason",
      ${request.runId}::uuid,
      ${request.finishedAt},
      ${failureReason}
    FROM eligible_snapshot AS snapshot
    JOIN "properties" AS property ON property."id" = snapshot."property_id"
    LEFT JOIN failed_property
      ON failed_property."property_id" = snapshot."property_id"
    WHERE property."identifier_version" = snapshot."property_identifier_version"
    ON CONFLICT ("property_id", "dataset") DO UPDATE SET
      "status" = EXCLUDED."status",
      "status_reason" = NULL,
      "last_attempt_run_id" = EXCLUDED."last_attempt_run_id",
      "last_attempt_at" = EXCLUDED."last_attempt_at",
      "last_error" = EXCLUDED."last_error"
  `);
}

/**
 * Atomically terminalizes a failed/rejected run and publishes only attempt-side
 * coverage for the immutable, version-matching property snapshot.
 */
export class TerminalPublicationService implements IngestionTerminalPublicationPort {
  private readonly prisma: PrismaClient;
  private readonly testHooks: TerminalPublicationTestHooks;
  private readonly transactionTimeoutMs: number;
  private readonly configuredAuthority:
    | IngestionExecutionAuthority
    | (() => IngestionExecutionAuthority | undefined)
    | undefined;

  constructor(options: TerminalPublicationServiceOptions) {
    this.prisma = options.prisma;
    this.testHooks = options.testHooks ?? {};
    this.transactionTimeoutMs =
      options.transactionTimeoutMs ??
      CONFIG_DEFAULTS.TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS;
    if (!Number.isInteger(this.transactionTimeoutMs) || this.transactionTimeoutMs <= 0) {
      throw publicationError('transactionTimeoutMs must be a positive integer');
    }
    this.configuredAuthority = options.executionAuthority;
  }

  async publishTerminalFailure(
    request: IngestionTerminalPublicationRequest,
    authority?: IngestionExecutionAuthority,
  ): Promise<IngestionRun> {
    validateRequest(request);
    const resolvedAuthority =
      authority ??
      (typeof this.configuredAuthority === 'function'
        ? this.configuredAuthority()
        : this.configuredAuthority);
    if (resolvedAuthority === undefined) {
      throw publicationError('execution authority is required');
    }
    resolvedAuthority.assertAuthorized('publish a terminal ingestion failure');

    return this.prisma.$transaction(async (transaction) => {
      const tx = transaction as TerminalPublicationTransaction;
      const run = await lockAndValidateRun(tx, request);

      resolvedAuthority.assertAuthorized('terminalize the ingestion run');
      const transition = await tx.ingestionRun.updateMany({
        where: { id: request.runId, status: run.status },
        data: {
          status: request.status,
          finishedAt: request.finishedAt,
          failureStage: request.failureStage,
          lastError: request.lastError,
        },
      });
      if (transition.count !== 1) {
        throw publicationError(
          `run ${request.runId} could not transition atomically to ${request.status}`,
        );
      }
      await this.testHooks.afterRunUpdate?.(tx);

      if (run.initializationComplete) {
        resolvedAuthority.assertAuthorized('publish failed property coverage');
        await lockAndValidateSnapshotProperties(tx, request.runId);
        await publishFailedCoverage(tx, request);
        await this.testHooks.afterCoverage?.(tx);
      }

      resolvedAuthority.assertAuthorized('commit terminal ingestion publication');
      const terminalRun = await tx.ingestionRun.findUnique({
        where: { id: request.runId },
      });
      if (terminalRun === null) {
        throw publicationError(`run ${request.runId} disappeared after publication`);
      }
      return terminalRun;
    }, { timeout: this.transactionTimeoutMs });
  }

  async publish(
    request: IngestionTerminalPublicationRequest,
    authority: IngestionExecutionAuthority,
  ): Promise<IngestionRun> {
    return this.publishTerminalFailure(request, authority);
  }
}

export const EcbTerminalPublicationService = TerminalPublicationService;

export function createTerminalPublicationService(
  options: TerminalPublicationServiceOptions,
): TerminalPublicationService {
  return new TerminalPublicationService(options);
}

export const createEcbTerminalPublicationService = createTerminalPublicationService;
