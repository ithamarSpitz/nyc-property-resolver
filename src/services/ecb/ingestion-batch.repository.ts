import {
  IngestionBatch,
  IngestionBatchStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import type { PrismaExecutor } from './ingestion-run.repository';

export type CreateIngestionBatchInput = {
  runId: string;
  batchNumber: number;
  batchDefinition: Prisma.InputJsonValue;
  status?: IngestionBatchStatus;
};

export type UpdateIngestionBatchProgressInput = {
  pagesFetched?: number;
  rowsFetched?: number;
  lastError?: string | null;
  status?: IngestionBatchStatus;
  completedAt?: Date | null;
};

function repositoryError(message: string): Error {
  return new Error(`Ingestion batch repository: ${message}`);
}

export class IngestionBatchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    input: CreateIngestionBatchInput,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch> {
    return executor.ingestionBatch.create({
      data: {
        runId: input.runId,
        batchNumber: input.batchNumber,
        status: input.status ?? IngestionBatchStatus.PENDING,
        batchDefinition: input.batchDefinition,
      },
    });
  }

  async createBatch(
    input: CreateIngestionBatchInput,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch> {
    return this.create(input, executor);
  }

  async createMany(
    inputs: readonly CreateIngestionBatchInput[],
    executor: PrismaExecutor,
  ): Promise<void> {
    if (inputs.length === 0) {
      return;
    }

    await executor.ingestionBatch.createMany({
      data: inputs.map((input) => ({
        runId: input.runId,
        batchNumber: input.batchNumber,
        status: input.status ?? IngestionBatchStatus.PENDING,
        batchDefinition: input.batchDefinition,
      })),
    });
  }

  async findById(
    id: string,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch | null> {
    return executor.ingestionBatch.findUnique({ where: { id } });
  }

  async findByRunAndNumber(
    runId: string,
    batchNumber: number,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch | null> {
    return executor.ingestionBatch.findUnique({
      where: { runId_batchNumber: { runId, batchNumber } },
    });
  }

  async listByRun(
    runId: string,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch[]> {
    return executor.ingestionBatch.findMany({
      where: { runId },
      orderBy: { batchNumber: 'asc' },
    });
  }

  async findBatchesByRunId(
    runId: string,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch[]> {
    return this.listByRun(runId, executor);
  }

  async incrementAttemptCount(
    id: string,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch> {
    return executor.ingestionBatch.update({
      where: { id },
      data: { attemptCount: { increment: 1 } },
    });
  }

  async incrementAttempt(
    id: string,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch> {
    return this.incrementAttemptCount(id, executor);
  }

  async updateProgress(
    id: string,
    input: UpdateIngestionBatchProgressInput,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch> {
    return executor.ingestionBatch.update({
      where: { id },
      data: input,
    });
  }

  async markCompleted(
    id: string,
    progress: Pick<UpdateIngestionBatchProgressInput, 'pagesFetched' | 'rowsFetched'> = {},
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch> {
    return this.updateProgress(
      id,
      {
        ...progress,
        status: IngestionBatchStatus.COMPLETED,
        completedAt: new Date(),
        lastError: null,
      },
      executor,
    );
  }

  async markFailed(
    id: string,
    lastError: string,
    executor: PrismaExecutor = this.prisma,
  ): Promise<IngestionBatch> {
    if (lastError.trim().length === 0) {
      throw repositoryError('a failed batch must have a non-empty error');
    }

    return this.updateProgress(
      id,
      {
        status: IngestionBatchStatus.FAILED,
        lastError,
      },
      executor,
    );
  }
}

export function createIngestionBatchRepository(prisma: PrismaClient): IngestionBatchRepository {
  return new IngestionBatchRepository(prisma);
}
