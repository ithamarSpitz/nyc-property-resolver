import {
  IngestionBatchStatus,
  IngestionRun,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import { SocrataClient } from '../../clients/socrata.client';
import { SocrataRequestExecutor } from '../../clients/socrata-request-executor';
import { CONFIG_DEFAULTS } from '../../config/defaults';
import {
  BATCH_PROCESSOR_OUTCOMES,
  EcbBatchProcessorService,
  type BatchProcessorConfig,
  type BatchProcessorOutcome,
} from './batch-processor.service';
import { IngestionBatchRepository } from './ingestion-batch.repository';
import {
  createIngestionInitializationService,
  type DatasetMetadataPort,
  type IngestionInitializationService,
  rowsUpdatedAtToDate,
} from './ingestion-initialization.service';
import {
  EcbIngestionLockService,
  IngestionAuthorityLostError,
  type IngestionExecutionAuthority,
  type IngestionLockAcquisitionResult,
} from './ingestion-lock.service';
import { IngestionRunRepository } from './ingestion-run.repository';
import {
  type IngestionTerminalPublicationPort,
  type IngestionTerminalPublicationRequest,
} from './ingestion-terminal-publication.port';

export const INGESTION_EXECUTION_OUTCOMES = Object.freeze({
  ACTIVE_EXECUTOR: 'ACTIVE_EXECUTOR',
  READY_FOR_PUBLICATION: 'READY_FOR_PUBLICATION',
  TERMINAL_FAILURE_PUBLISHED: 'TERMINAL_FAILURE_PUBLISHED',
  SOURCE_CHANGED_PUBLISHED: 'SOURCE_CHANGED_PUBLISHED',
  EXECUTION_AUTHORITY_LOST: 'EXECUTION_AUTHORITY_LOST',
} as const);

export const INGESTION_TERMINAL_STAGES = Object.freeze({
  WATERMARK_GUARD: 'watermark_guard',
  BATCH_PROCESSING: 'batch_processing',
} as const);

export const INGESTION_TERMINAL_ERRORS = Object.freeze({
  SOURCE_CHANGED: 'SOURCE_CHANGED',
} as const);

export type IngestionExecutionOutcomeCode =
  (typeof INGESTION_EXECUTION_OUTCOMES)[keyof typeof INGESTION_EXECUTION_OUTCOMES];

export type IngestionExecutionResult =
  | {
      outcome: typeof INGESTION_EXECUTION_OUTCOMES.ACTIVE_EXECUTOR;
      activeRunId: string | null;
    }
  | {
      outcome: typeof INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION;
      run: IngestionRun;
    }
  | {
      outcome: typeof INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED;
      run: IngestionRun;
    }
  | {
      outcome: typeof INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED;
      run: IngestionRun;
    }
  | {
      outcome: typeof INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST;
    };

export type IngestionServiceOptions = {
  prisma: PrismaClient;
  connectionString: string;
  metadataPort: DatasetMetadataPort;
  terminalPublicationPort: IngestionTerminalPublicationPort;
  ecbBatchSize?: number;
  socrataPageSize?: number;
  fetchImpl?: typeof fetch;
  lockService?: EcbIngestionLockService;
  initializationService?: IngestionInitializationService;
  batchProcessor?: EcbBatchProcessorService;
  runRepository?: IngestionRunRepository;
  batchRepository?: IngestionBatchRepository;
  batchProcessorConfig?: Partial<BatchProcessorConfig> & {
    terminalPublicationTransactionTimeoutMs?: number;
  };
};

export type ExecuteIngestionInput = {
  triggerType: IngestionTriggerType;
};

function watermarksEqual(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function isTerminalBatchOutcome(
  outcome: BatchProcessorOutcome,
): outcome is Extract<
  BatchProcessorOutcome,
  { outcome: typeof BATCH_PROCESSOR_OUTCOMES.TERMINAL_FAILED | typeof BATCH_PROCESSOR_OUTCOMES.FAILED_PAGE_LIMIT }
> {
  return (
    outcome.outcome === BATCH_PROCESSOR_OUTCOMES.TERMINAL_FAILED ||
    outcome.outcome === BATCH_PROCESSOR_OUTCOMES.FAILED_PAGE_LIMIT
  );
}

export class EcbIngestionService {
  private readonly prisma: PrismaClient;
  private readonly connectionString: string;
  private readonly metadataPort: DatasetMetadataPort;
  private readonly terminalPublicationPort: IngestionTerminalPublicationPort;
  private readonly ecbBatchSize: number;
  private readonly socrataPageSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly lockService: EcbIngestionLockService;
  private readonly initializationService: IngestionInitializationService;
  private readonly batchProcessor: EcbBatchProcessorService;
  private readonly runRepository: IngestionRunRepository;
  private readonly batchRepository: IngestionBatchRepository;
  private readonly maxBatchAttemptsPerRun: number;

  constructor(options: IngestionServiceOptions) {
    this.prisma = options.prisma;
    this.connectionString = options.connectionString;
    this.metadataPort = options.metadataPort;
    this.terminalPublicationPort = options.terminalPublicationPort;
    this.ecbBatchSize = options.ecbBatchSize ?? CONFIG_DEFAULTS.ECB_BATCH_SIZE;
    this.socrataPageSize = options.socrataPageSize ?? CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runRepository = options.runRepository ?? new IngestionRunRepository(options.prisma);
    this.batchRepository = options.batchRepository ?? new IngestionBatchRepository(options.prisma);
    this.maxBatchAttemptsPerRun =
      options.batchProcessorConfig?.maxBatchAttemptsPerRun ??
      CONFIG_DEFAULTS.MAX_BATCH_ATTEMPTS_PER_RUN;
    this.lockService =
      options.lockService ?? new EcbIngestionLockService({ connectionString: this.connectionString });
    this.initializationService =
      options.initializationService ??
      createIngestionInitializationService({
        prisma: this.prisma,
        runRepository: this.runRepository,
        batchRepository: this.batchRepository,
        metadataPort: this.metadataPort,
        terminalPublicationPort: this.terminalPublicationPort,
        ecbBatchSize: this.ecbBatchSize,
        socrataPageSize: this.socrataPageSize,
      });
    this.batchProcessor =
      options.batchProcessor ??
      new EcbBatchProcessorService({
        prisma: this.prisma,
        batchRepository: this.batchRepository,
        fetchImpl: this.fetchImpl,
        config: options.batchProcessorConfig,
      });
  }

  async execute(input: ExecuteIngestionInput): Promise<IngestionExecutionResult> {
    const lockResult = await this.lockService.acquire();
    if (!lockResult.acquired) {
      const activeRun = await this.runRepository.findActiveRun();
      return {
        outcome: INGESTION_EXECUTION_OUTCOMES.ACTIVE_EXECUTOR,
        activeRunId: activeRun?.id ?? null,
      };
    }

    const authority = lockResult.authority;
    try {
      return await this.executeWithAuthority(input, authority);
    } catch (error) {
      if (error instanceof IngestionAuthorityLostError || !authority.checkAuthorized()) {
        return { outcome: INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST };
      }
      throw error;
    } finally {
      await this.lockService.release();
    }
  }

  private async executeWithAuthority(
    input: ExecuteIngestionInput,
    authority: IngestionExecutionAuthority,
  ): Promise<IngestionExecutionResult> {
    authority.assertAuthorized('execute ECB ingestion');

    const activeRun = await this.runRepository.findActiveRun();
    let run: IngestionRun;
    let resumedExistingRunning = false;

    if (activeRun === null) {
      const queuedRun = await this.initializationService.createQueuedRun(
        { triggerType: input.triggerType },
        authority,
      );
      const initResult = await this.initializationService.initializeAndStartRun(queuedRun.id, authority);
      if (initResult.outcome === 'TERMINAL_FAILURE_PUBLISHED') {
        return {
          outcome: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
          run: initResult.run,
        };
      }
      run = initResult.run;
    } else if (activeRun.status === IngestionRunStatus.QUEUED) {
      const initResult = await this.initializationService.initializeAndStartRun(activeRun.id, authority);
      if (initResult.outcome === 'TERMINAL_FAILURE_PUBLISHED') {
        return {
          outcome: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
          run: initResult.run,
        };
      }
      run = initResult.run;
    } else if (activeRun.status === IngestionRunStatus.RUNNING) {
      run = activeRun;
      resumedExistingRunning = true;
    } else {
      throw new Error(`unexpected active ingestion run status ${activeRun.status}`);
    }

    if (resumedExistingRunning) {
      const persistedFailure = await this.publishPersistedTerminalBatchFailure(
        run.id,
        authority,
      );
      if (persistedFailure !== null) {
        return {
          outcome: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
          run: persistedFailure,
        };
      }
      const sourceChangedRun = await this.rejectResumeOnWatermarkMismatch(run.id, authority, run);
      if (sourceChangedRun !== null) {
        return {
          outcome: INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
          run: sourceChangedRun,
        };
      }
      const refreshedRun = await this.runRepository.findById(run.id);
      if (refreshedRun === null) {
        throw new Error(`ingestion run ${run.id} disappeared during resume`);
      }
      run = refreshedRun;
    }

    const batchResult = await this.processPersistedBatches(run.id, authority);
    if (batchResult.outcome === INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST) {
      return batchResult;
    }
    if (batchResult.outcome === INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED) {
      return batchResult;
    }

    return this.finalizePublicationHandoff(run.id, authority);
  }

  private async publishPersistedTerminalBatchFailure(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<IngestionRun | null> {
    authority.assertAuthorized('recover a persisted terminal batch failure');
    const batches = await this.batchRepository.listByRun(runId);
    const exhaustedBatch = batches.find(
      (batch) =>
        batch.status === IngestionBatchStatus.FAILED &&
        batch.attemptCount >= this.maxBatchAttemptsPerRun,
    );
    if (exhaustedBatch === undefined) {
      return null;
    }

    return this.publishTerminalBatchFailure(runId, authority, exhaustedBatch.lastError);
  }

  private async rejectResumeOnWatermarkMismatch(
    runId: string,
    authority: IngestionExecutionAuthority,
    run: IngestionRun,
  ): Promise<IngestionRun | null> {
    authority.assertAuthorized('validate the resume watermark guard');

    if (run.sourceWatermarkAtStart === null) {
      throw new Error(`run ${runId} is RUNNING without a persisted start watermark`);
    }

    const metadata = await this.metadataPort.getDatasetMetadata();
    if (!authority.checkAuthorized()) {
      throw new IngestionAuthorityLostError(
        'publish SOURCE_CHANGED after resume watermark mismatch',
        'lock session ended',
      );
    }

    const currentWatermark = rowsUpdatedAtToDate(metadata.rowsUpdatedAt);
    if (watermarksEqual(currentWatermark, run.sourceWatermarkAtStart)) {
      return null;
    }

    return this.publishSourceChanged(runId, authority, INGESTION_TERMINAL_STAGES.WATERMARK_GUARD);
  }

  private async processPersistedBatches(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<
    | { outcome: typeof INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST }
    | { outcome: typeof INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED; run: IngestionRun }
    | { outcome: 'ALL_BATCHES_COMPLETED' }
  > {
    while (true) {
      authority.assertAuthorized('orchestrate persisted ingestion batches');

      const batches = await this.batchRepository.listByRun(runId);
      const nextBatch = batches.find((batch) => batch.status !== IngestionBatchStatus.COMPLETED);
      if (nextBatch === undefined) {
        return { outcome: 'ALL_BATCHES_COMPLETED' };
      }

      if (
        nextBatch.status === IngestionBatchStatus.FAILED &&
        nextBatch.attemptCount >= this.maxBatchAttemptsPerRun
      ) {
        const failedRun = await this.publishTerminalBatchFailure(
          runId,
          authority,
          nextBatch.lastError,
        );
        return {
          outcome: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
          run: failedRun,
        };
      }

      const outcome = await this.batchProcessor.executeBatchAttempt(nextBatch.id, authority);
      if (outcome.outcome === BATCH_PROCESSOR_OUTCOMES.AUTHORITY_LOST) {
        return { outcome: INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST };
      }

      if (isTerminalBatchOutcome(outcome)) {
        const failedRun = await this.publishTerminalBatchFailure(runId, authority, outcome.batch.lastError);
        return {
          outcome: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
          run: failedRun,
        };
      }
    }
  }

  private async finalizePublicationHandoff(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<
    | { outcome: typeof INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION; run: IngestionRun }
    | { outcome: typeof INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED; run: IngestionRun }
    | { outcome: typeof INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST }
  > {
    authority.assertAuthorized('finalize the ingestion publication handoff');

    const run = await this.runRepository.findById(runId);
    if (run === null) {
      throw new Error(`ingestion run ${runId} disappeared before publication handoff`);
    }
    if (run.sourceWatermarkAtStart === null) {
      throw new Error(`ingestion run ${runId} is missing source_watermark_at_start`);
    }

    const metadata = await this.metadataPort.getDatasetMetadata();
    if (!authority.checkAuthorized()) {
      return { outcome: INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST };
    }

    const endWatermark = rowsUpdatedAtToDate(metadata.rowsUpdatedAt);
    const updatedRun = await this.runRepository.update(runId, {
      sourceWatermarkAtEnd: endWatermark,
    });

    if (!watermarksEqual(endWatermark, run.sourceWatermarkAtStart)) {
      const sourceChangedRun = await this.publishSourceChanged(
        runId,
        authority,
        INGESTION_TERMINAL_STAGES.WATERMARK_GUARD,
      );
      return {
        outcome: INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
        run: sourceChangedRun,
      };
    }

    return {
      outcome: INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION,
      run: updatedRun,
    };
  }

  private async publishSourceChanged(
    runId: string,
    authority: IngestionExecutionAuthority,
    failureStage: string,
  ): Promise<IngestionRun> {
    authority.assertAuthorized('publish SOURCE_CHANGED terminal decision');
    return this.terminalPublicationPort.publishTerminalFailure({
      runId,
      status: IngestionRunStatus.SOURCE_CHANGED,
      failureStage,
      lastError: INGESTION_TERMINAL_ERRORS.SOURCE_CHANGED,
      finishedAt: new Date(),
    });
  }

  private async publishTerminalBatchFailure(
    runId: string,
    authority: IngestionExecutionAuthority,
    lastError: string | null,
  ): Promise<IngestionRun> {
    authority.assertAuthorized('publish terminal batch failure');
    return this.terminalPublicationPort.publishTerminalFailure({
      runId,
      status: IngestionRunStatus.FAILED,
      failureStage: INGESTION_TERMINAL_STAGES.BATCH_PROCESSING,
      lastError: lastError ?? 'BATCH_TERMINAL_FAILURE',
      finishedAt: new Date(),
    });
  }
}

export const IngestionService = EcbIngestionService;

export function createEcbIngestionService(options: IngestionServiceOptions): EcbIngestionService {
  return new EcbIngestionService(options);
}

export function isLockAcquired(
  result: IngestionLockAcquisitionResult,
): result is Extract<IngestionLockAcquisitionResult, { acquired: true }> {
  return result.acquired;
}

export function createBoundedSocrataClientForAuthority(
  fetchImpl: typeof fetch,
  authority: IngestionExecutionAuthority,
  requestExecutor: SocrataRequestExecutor = new SocrataRequestExecutor({
    maxRetries: CONFIG_DEFAULTS.SOCRATA_MAX_RETRIES,
  }),
): SocrataClient {
  return new SocrataClient({
    fetchImpl,
    signal: authority.signal,
    requestExecutor: {
      execute: (attempt) =>
        requestExecutor.execute(async () => attempt.execute(), authority.signal),
    },
  });
}

export type { IngestionTerminalPublicationRequest };
