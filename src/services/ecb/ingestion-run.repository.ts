import {
  Dataset,
  IngestionRun,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

export type PrismaExecutor = PrismaClient | Prisma.TransactionClient;

export type CreateIngestionRunInput = {
  dataset?: Dataset;
  triggerType: IngestionTriggerType;
};

export type RunPropertyBinSnapshotInput = {
  runId: string;
  propertyId: string;
  propertyIdentifierVersion: number;
  bin: string;
};

export type InitializeIngestionRunInput = {
  expectedPropertyBinCount: number;
  expectedBinCount: number;
  expectedBatchCount: number;
};

/** Fields that may change during processing without changing run lifecycle. */
export type UpdateIngestionRunOperationalData = Pick<
  Prisma.IngestionRunUpdateInput,
  | 'failureStage'
  | 'lastError'
  | 'finishedAt'
  | 'sourceWatermarkAtEnd'
  | 'binsScanned'
  | 'dataPageCalls'
  | 'metadataCalls'
  | 'retryCalls'
  | 'totalSocrataCalls'
  | 'rowsFetched'
  | 'rowsWritten'
  | 'failures'
>;

function repositoryError(message: string): Error {
  return new Error(`Ingestion run repository: ${message}`);
}

export class IngestionRunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async createQueued(
    input: CreateIngestionRunInput,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionRun> {
    return executor.ingestionRun.create({
      data: {
        dataset: input.dataset ?? Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: input.triggerType,
      },
    });
  }

  async createRun(
    input: CreateIngestionRunInput,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionRun> {
    return this.createQueued(input, executor);
  }

  async createQueuedRun(
    input: CreateIngestionRunInput,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionRun> {
    return this.createQueued(input, executor);
  }

  async findById(id: string, executor: PrismaExecutor = this.prisma): Promise<IngestionRun | null> {
    return executor.ingestionRun.findUnique({ where: { id } });
  }

  async getById(id: string, executor: PrismaExecutor = this.prisma): Promise<IngestionRun | null> {
    return this.findById(id, executor);
  }

  async findActive(
    dataset: Dataset = Dataset.DOB_ECB_VIOLATIONS,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionRun | null> {
    return executor.ingestionRun.findFirst({
      where: {
        dataset,
        status: { in: [IngestionRunStatus.QUEUED, IngestionRunStatus.RUNNING] },
      },
      orderBy: { id: 'asc' },
    });
  }

  async findActiveRun(
    dataset: Dataset = Dataset.DOB_ECB_VIOLATIONS,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionRun | null> {
    return this.findActive(dataset, executor);
  }

  async createPropertyBinSnapshot(
    rows: readonly RunPropertyBinSnapshotInput[],
    executor: PrismaExecutor,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    await executor.ingestionRunPropertyBin.createMany({
      data: rows.map((row) => ({
        runId: row.runId,
        propertyId: row.propertyId,
        propertyIdentifierVersion: row.propertyIdentifierVersion,
        bin: row.bin,
      })),
    });
  }

  async listPropertyBinSnapshot(
    runId: string,
    executor: PrismaExecutor = this.prisma,
  ) {
    return executor.ingestionRunPropertyBin.findMany({
      where: { runId },
      orderBy: [{ bin: 'asc' }, { propertyId: 'asc' }],
    });
  }

  async createSnapshot(
    rows: readonly RunPropertyBinSnapshotInput[],
    executor: PrismaExecutor,
  ): Promise<void> {
    return this.createPropertyBinSnapshot(rows, executor);
  }

  async markInitialized(
    runId: string,
    input: InitializeIngestionRunInput,
    executor: PrismaExecutor,
  ): Promise<IngestionRun> {
    const result = await executor.ingestionRun.updateMany({
      where: {
        id: runId,
        initializationComplete: false,
      },
      data: {
        expectedPropertyBinCount: input.expectedPropertyBinCount,
        expectedBinCount: input.expectedBinCount,
        expectedBatchCount: input.expectedBatchCount,
        initializationComplete: true,
      },
    });

    if (result.count !== 1) {
      throw repositoryError(`run ${runId} was already initialized or does not exist`);
    }

    const run = await this.findById(runId, executor);
    if (run === null) {
      throw repositoryError(`run ${runId} disappeared after initialization`);
    }
    return run;
  }

  async setStartWatermarkAndRunning(
    runId: string,
    sourceWatermarkAtStart: Date,
    executor: PrismaExecutor,
    startedAt: Date = new Date(),
  ): Promise<IngestionRun> {
    const result = await executor.ingestionRun.updateMany({
      where: {
        id: runId,
        status: IngestionRunStatus.QUEUED,
        initializationComplete: true,
        sourceWatermarkAtStart: null,
      },
      data: {
        sourceWatermarkAtStart,
        status: IngestionRunStatus.RUNNING,
        startedAt,
      },
    });

    if (result.count !== 1) {
      throw repositoryError(
        `run ${runId} cannot transition to RUNNING; it may be uninitialized, already started, or missing`,
      );
    }

    const run = await this.findById(runId, executor);
    if (run === null) {
      throw repositoryError(`run ${runId} disappeared after starting`);
    }
    return run;
  }

  async update(
    runId: string,
    data: UpdateIngestionRunOperationalData,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionRun> {
    // Lifecycle fields have dedicated methods so the start watermark can only
    // be persisted together with the QUEUED -> RUNNING transition.
    const attemptedLifecycleFields = ['status', 'initializationComplete', 'sourceWatermarkAtStart'].filter(
      (field) => Object.prototype.hasOwnProperty.call(data, field),
    );
    if (attemptedLifecycleFields.length > 0) {
      throw repositoryError(
        `lifecycle fields ${attemptedLifecycleFields.join(', ')} require a dedicated transition method`,
      );
    }

    return executor.ingestionRun.update({ where: { id: runId }, data });
  }
}

export function createIngestionRunRepository(prisma: PrismaClient): IngestionRunRepository {
  return new IngestionRunRepository(prisma);
}
