import type { IngestionRun } from '@prisma/client';

import {
  ACCEPTED_PUBLICATION_OUTCOMES,
  AcceptedPublicationService,
  type AcceptedPublicationResult,
} from './accepted-publication.service';
import {
  EcbIngestionService,
  INGESTION_EXECUTION_OUTCOMES,
  type ExecuteIngestionInput,
  type IngestionExecutionResult,
  type IngestionServiceOptions,
} from './ingestion.service';
import {
  EcbIngestionLockService,
  IngestionAuthorityLostError,
  type IngestionExecutionAuthority,
  type IngestionLockAcquisitionResult,
} from './ingestion-lock.service';
import { TerminalPublicationService } from './terminal-publication.service';

export const INGESTION_RUNNER_OUTCOMES = Object.freeze({
  ACTIVE_EXECUTOR: INGESTION_EXECUTION_OUTCOMES.ACTIVE_EXECUTOR,
  COMPLETED: ACCEPTED_PUBLICATION_OUTCOMES.COMPLETED,
  TERMINAL_FAILURE_PUBLISHED: INGESTION_EXECUTION_OUTCOMES.TERMINAL_FAILURE_PUBLISHED,
  SOURCE_CHANGED_PUBLISHED: INGESTION_EXECUTION_OUTCOMES.SOURCE_CHANGED_PUBLISHED,
  EXECUTION_AUTHORITY_LOST: INGESTION_EXECUTION_OUTCOMES.EXECUTION_AUTHORITY_LOST,
} as const);

type AcceptedPublicationPort = {
  publish(
    runId: string,
    authority: IngestionExecutionAuthority,
  ): Promise<AcceptedPublicationResult>;
};

export type IngestionRunnerResult =
  | {
      outcome: typeof INGESTION_RUNNER_OUTCOMES.ACTIVE_EXECUTOR;
      activeRunId: string | null;
    }
  | {
      outcome: typeof INGESTION_RUNNER_OUTCOMES.COMPLETED;
      run: IngestionRun;
      publication: AcceptedPublicationResult;
    }
  | {
      outcome: typeof INGESTION_RUNNER_OUTCOMES.TERMINAL_FAILURE_PUBLISHED;
      run: IngestionRun;
    }
  | {
      outcome: typeof INGESTION_RUNNER_OUTCOMES.SOURCE_CHANGED_PUBLISHED;
      run: IngestionRun;
    }
  | {
      outcome: typeof INGESTION_RUNNER_OUTCOMES.EXECUTION_AUTHORITY_LOST;
    };

export type IngestionRunnerOptions = Omit<
  IngestionServiceOptions,
  'lockService' | 'terminalPublicationPort'
> & {
  lockService?: EcbIngestionLockService;
  acceptedPublicationService?: AcceptedPublicationPort;
  terminalPublicationService?: TerminalPublicationService;
};

/**
 * The S2 executor owns lock acquisition, while S3 publication must execute
 * under that same session authority. This adapter defers the executor's
 * normal finally-release until the runner has published the terminal state.
 */
class PublicationScopedLockService extends EcbIngestionLockService {
  constructor(
    connectionString: string,
    private readonly delegate: EcbIngestionLockService,
  ) {
    super({ connectionString });
  }

  override get authority(): IngestionExecutionAuthority | undefined {
    return this.delegate.authority;
  }

  override get executionAuthorized(): boolean {
    return this.delegate.executionAuthorized;
  }

  override get isAuthorized(): boolean {
    return this.delegate.isAuthorized;
  }

  override acquire(): Promise<IngestionLockAcquisitionResult> {
    return this.delegate.acquire();
  }

  override checkAuthorized(): boolean {
    return this.delegate.checkAuthorized();
  }

  override release(): Promise<void> {
    return Promise.resolve();
  }

  releaseAfterPublication(): Promise<void> {
    return this.delegate.release();
  }
}

/** Production composition boundary for one complete accepted-or-rejected run. */
export class EcbIngestionRunnerService {
  private readonly lockService: PublicationScopedLockService;
  private readonly executor: EcbIngestionService;
  private readonly acceptedPublicationService: AcceptedPublicationPort;

  constructor(options: IngestionRunnerOptions) {
    const {
      lockService,
      acceptedPublicationService,
      terminalPublicationService,
      ...executorOptions
    } = options;
    const lockDelegate =
      lockService ?? new EcbIngestionLockService({ connectionString: options.connectionString });
    this.lockService = new PublicationScopedLockService(options.connectionString, lockDelegate);

    const terminalPublisher =
      terminalPublicationService ??
      new TerminalPublicationService({
        prisma: options.prisma,
        executionAuthority: () => this.lockService.authority,
      });
    this.acceptedPublicationService =
      acceptedPublicationService ?? new AcceptedPublicationService({ prisma: options.prisma });
    this.executor = new EcbIngestionService({
      ...executorOptions,
      lockService: this.lockService,
      terminalPublicationPort: terminalPublisher,
    });
  }

  async execute(input: ExecuteIngestionInput): Promise<IngestionRunnerResult> {
    try {
      const execution = await this.executor.execute(input);
      if (execution.outcome !== INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION) {
        return execution;
      }

      const authority = this.requireAuthority(execution);
      const publication = await this.acceptedPublicationService.publish(
        execution.run.id,
        authority,
      );
      return {
        outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
        run: publication.run,
        publication,
      };
    } catch (error) {
      if (
        error instanceof IngestionAuthorityLostError ||
        (this.lockService.authority !== undefined && !this.lockService.checkAuthorized())
      ) {
        return { outcome: INGESTION_RUNNER_OUTCOMES.EXECUTION_AUTHORITY_LOST };
      }
      throw error;
    } finally {
      await this.lockService.releaseAfterPublication();
    }
  }

  private requireAuthority(
    execution: Extract<
      IngestionExecutionResult,
      { outcome: typeof INGESTION_EXECUTION_OUTCOMES.READY_FOR_PUBLICATION }
    >,
  ): IngestionExecutionAuthority {
    const authority = this.lockService.authority;
    if (authority === undefined) {
      throw new Error(`ingestion run ${execution.run.id} reached publication without lock authority`);
    }
    authority.assertAuthorized('handoff an ingestion run for accepted publication');
    return authority;
  }
}

export const IngestionRunnerService = EcbIngestionRunnerService;

export function createEcbIngestionRunnerService(
  options: IngestionRunnerOptions,
): EcbIngestionRunnerService {
  return new EcbIngestionRunnerService(options);
}
