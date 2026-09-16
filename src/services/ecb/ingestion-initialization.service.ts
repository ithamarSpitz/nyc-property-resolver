import {
  IngestionRun,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import type { SocrataDatasetMetadata } from '../../clients/socrata.client';
import { SocrataClientError } from '../../clients/socrata.client';
import { IngestionBatchRepository } from './ingestion-batch.repository';
import type { IngestionExecutionAuthority } from './ingestion-lock.service';
import {
  IngestionRunRepository,
  type RunPropertyBinSnapshotInput,
} from './ingestion-run.repository';
import {
  INGESTION_TERMINAL_FAILURE_REASONS,
  type IngestionTerminalPublicationPort,
} from './ingestion-terminal-publication.port';

export type IngestionBatchDefinition = {
  bins: string[];
  pageSize: number;
};

export type DatasetMetadataPort = {
  getDatasetMetadata(): Promise<SocrataDatasetMetadata>;
};

export type CreateQueuedIngestionRunInput = {
  triggerType: IngestionTriggerType;
};

export type IngestionInitializationServiceOptions = {
  prisma: PrismaClient;
  runRepository: IngestionRunRepository;
  batchRepository: IngestionBatchRepository;
  metadataPort: DatasetMetadataPort;
  terminalPublicationPort: IngestionTerminalPublicationPort;
  ecbBatchSize: number;
  socrataPageSize: number;
  testHooks?: IngestionInitializationTestHooks;
};

export type IngestionInitializationTestHooks = {
  afterSnapshotInsert?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterBatchInsert?: (tx: Prisma.TransactionClient) => Promise<void>;
  beforeWatermarkPersist?: () => Promise<void>;
};

export type InitializeAndStartRunResult =
  | { outcome: 'RUNNING'; run: IngestionRun }
  | { outcome: 'TERMINAL_FAILURE_PUBLISHED'; run: IngestionRun };

export class IngestionInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionInitializationError';
  }
}

/**
 * Socrata `/api/views/{id}` `rowsUpdatedAt` is Unix seconds. Persist it as a
 * Date so coverage freshness later reads the observed source watermark, not a
 * 1970 epoch produced by treating seconds as JavaScript milliseconds.
 */
export function rowsUpdatedAtToDate(rowsUpdatedAt: number): Date {
  return new Date(rowsUpdatedAt * 1000);
}

export function partitionSortedBins(
  sortedDistinctBins: readonly string[],
  batchSize: number,
): string[][] {
  if (sortedDistinctBins.length === 0) {
    return [];
  }

  const batches: string[][] = [];
  for (let index = 0; index < sortedDistinctBins.length; index += batchSize) {
    batches.push(sortedDistinctBins.slice(index, index + batchSize));
  }
  return batches;
}

export function buildBatchDefinitions(
  sortedDistinctBins: readonly string[],
  batchSize: number,
  pageSize: number,
): IngestionBatchDefinition[] {
  return partitionSortedBins(sortedDistinctBins, batchSize).map((bins) => ({
    bins,
    pageSize,
  }));
}

function initializationError(message: string): IngestionInitializationError {
  return new IngestionInitializationError(message);
}

function isTerminalMetadataFailure(error: unknown): boolean {
  return error instanceof SocrataClientError && !error.retryable;
}

export class IngestionInitializationService {
  private readonly prisma: PrismaClient;
  private readonly runRepository: IngestionRunRepository;
  private readonly batchRepository: IngestionBatchRepository;
  private readonly metadataPort: DatasetMetadataPort;
  private readonly terminalPublicationPort: IngestionTerminalPublicationPort;
  private readonly ecbBatchSize: number;
  private readonly socrataPageSize: number;
  private readonly testHooks: IngestionInitializationTestHooks;

  constructor(options: IngestionInitializationServiceOptions) {
    this.prisma = options.prisma;
    this.runRepository = options.runRepository;
    this.batchRepository = options.batchRepository;
    this.metadataPort = options.metadataPort;
    this.terminalPublicationPort = options.terminalPublicationPort;
    this.ecbBatchSize = options.ecbBatchSize;
    this.socrataPageSize = options.socrataPageSize;
    this.testHooks = options.testHooks ?? {};
  }

  async createQueuedRun(
    input: CreateQueuedIngestionRunInput,
    authority: IngestionExecutionAuthority,
  ): Promise<IngestionRun> {
    authority.assertAuthorized('create a queued ingestion run');
    return this.runRepository.createQueuedRun({ triggerType: input.triggerType });
  }

  async initializeAndStartRun(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<InitializeAndStartRunResult> {
    authority.assertAuthorized('initialize and start an ingestion run');

    const run = await this.runRepository.findById(runId);
    if (run === null) {
      throw initializationError(`run ${runId} does not exist`);
    }

    if (run.status === IngestionRunStatus.RUNNING) {
      if (!run.initializationComplete || run.sourceWatermarkAtStart === null) {
        throw initializationError(`run ${runId} is RUNNING without a valid initialized start watermark`);
      }
      return { outcome: 'RUNNING', run };
    }

    if (run.status !== IngestionRunStatus.QUEUED) {
      throw initializationError(`run ${runId} is not eligible for initialization (status=${run.status})`);
    }

    if (run.sourceWatermarkAtStart !== null) {
      throw initializationError(`run ${runId} already has a persisted start watermark while QUEUED`);
    }

    let currentRun = run;
    if (!currentRun.initializationComplete) {
      currentRun = await this.initializeRunSnapshotAndBatches(runId, authority);
    }

    return this.acquireStartWatermarkAndStart(runId, authority, currentRun);
  }

  private async initializeRunSnapshotAndBatches(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<IngestionRun> {
    authority.assertAuthorized('initialize the run Property<->BIN snapshot and batches');

    const snapshotRows = await this.loadLivePropertyBinSnapshotRows(runId);

    return this.runRepository.transaction(async (tx) => {
      await tx.ingestionRunPropertyBin.deleteMany({ where: { runId } });
      await tx.ingestionBatch.deleteMany({ where: { runId } });

      await this.runRepository.createPropertyBinSnapshot(snapshotRows, tx);
      await this.testHooks.afterSnapshotInsert?.(tx);

      const sortedDistinctBins = [
        ...new Set(snapshotRows.map((row) => row.bin)),
      ].sort();
      const batchDefinitions = buildBatchDefinitions(
        sortedDistinctBins,
        this.ecbBatchSize,
        this.socrataPageSize,
      );

      await this.batchRepository.createMany(
        batchDefinitions.map((definition, index) => ({
          runId,
          batchNumber: index + 1,
          batchDefinition: definition,
        })),
        tx,
      );
      await this.testHooks.afterBatchInsert?.(tx);

      return this.runRepository.markInitialized(
        runId,
        {
          expectedPropertyBinCount: snapshotRows.length,
          expectedBinCount: sortedDistinctBins.length,
          expectedBatchCount: batchDefinitions.length,
        },
        tx,
      );
    });
  }

  private async loadLivePropertyBinSnapshotRows(
    runId: string,
  ): Promise<RunPropertyBinSnapshotInput[]> {
    const relationships = await this.prisma.propertyBin.findMany({
      include: {
        property: {
          select: {
            id: true,
            identifierVersion: true,
          },
        },
      },
      orderBy: [{ bin: 'asc' }, { propertyId: 'asc' }],
    });

    return relationships.map((relationship: (typeof relationships)[number]) => ({
      runId,
      propertyId: relationship.property.id,
      propertyIdentifierVersion: relationship.property.identifierVersion,
      bin: relationship.bin,
    }));
  }

  private async acquireStartWatermarkAndStart(
    runId: string,
    authority: IngestionExecutionAuthority,
    run: IngestionRun,
  ): Promise<InitializeAndStartRunResult> {
    authority.assertAuthorized('acquire the ingestion start watermark');

    if (!run.initializationComplete) {
      throw initializationError(`run ${runId} is not initialized`);
    }

    await this.assertExpectedInitializationCounts(runId, run);

    let metadata: SocrataDatasetMetadata;
    try {
      metadata = await this.metadataPort.getDatasetMetadata();
    } catch (error) {
      if (!isTerminalMetadataFailure(error)) {
        throw error;
      }

      authority.assertAuthorized('publish terminal start-watermark failure');
      const failedRun = await this.terminalPublicationPort.publishTerminalFailure({
        runId,
        status: IngestionRunStatus.FAILED,
        failureStage: 'initialization',
        lastError: INGESTION_TERMINAL_FAILURE_REASONS.START_WATERMARK_FETCH_FAILED,
        finishedAt: new Date(),
      });
      return { outcome: 'TERMINAL_FAILURE_PUBLISHED', run: failedRun };
    }

    await this.testHooks.beforeWatermarkPersist?.();

    authority.assertAuthorized('persist the start watermark and transition to RUNNING');
    const startedRun = await this.runRepository.transaction((tx) =>
      this.runRepository.setStartWatermarkAndRunning(
        runId,
        rowsUpdatedAtToDate(metadata.rowsUpdatedAt),
        tx,
      ),
    );

    return { outcome: 'RUNNING', run: startedRun };
  }

  private async assertExpectedInitializationCounts(
    runId: string,
    run: IngestionRun,
  ): Promise<void> {
    const [propertyBinCount, distinctBinRows, batchCount] = await Promise.all([
      this.prisma.ingestionRunPropertyBin.count({ where: { runId } }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT bin)::bigint AS count
        FROM ingestion_run_property_bins
        WHERE run_id = ${runId}::uuid
      `,
      this.prisma.ingestionBatch.count({ where: { runId } }),
    ]);

    const distinctBinCount = Number(distinctBinRows[0]?.count ?? 0);

    if (run.expectedPropertyBinCount !== propertyBinCount) {
      throw initializationError(
        `run ${runId} expected_property_bin_count mismatch (expected ${run.expectedPropertyBinCount}, found ${propertyBinCount})`,
      );
    }
    if (run.expectedBinCount !== distinctBinCount) {
      throw initializationError(
        `run ${runId} expected_bin_count mismatch (expected ${run.expectedBinCount}, found ${distinctBinCount})`,
      );
    }
    if (run.expectedBatchCount !== batchCount) {
      throw initializationError(
        `run ${runId} expected_batch_count mismatch (expected ${run.expectedBatchCount}, found ${batchCount})`,
      );
    }
  }
}

export function createIngestionInitializationService(
  options: IngestionInitializationServiceOptions,
): IngestionInitializationService {
  return new IngestionInitializationService(options);
}
