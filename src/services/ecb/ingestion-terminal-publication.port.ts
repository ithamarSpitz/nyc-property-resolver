import type { IngestionRun, IngestionRunStatus } from '@prisma/client';

export const INGESTION_TERMINAL_FAILURE_REASONS = {
  START_WATERMARK_FETCH_FAILED: 'START_WATERMARK_FETCH_FAILED',
} as const;

export type IngestionTerminalFailureReason =
  (typeof INGESTION_TERMINAL_FAILURE_REASONS)[keyof typeof INGESTION_TERMINAL_FAILURE_REASONS];

export type IngestionTerminalPublicationStatus = Extract<
  IngestionRunStatus,
  'FAILED' | 'SOURCE_CHANGED'
>;

export type IngestionTerminalPublicationRequest = {
  runId: string;
  status: IngestionTerminalPublicationStatus;
  failureStage: string;
  lastError: string;
  finishedAt: Date;
};

/**
 * Boundary for atomic terminal run publication and eligible property coverage
 * updates. S2 depends on this port; S3 provides the concrete implementation.
 */
export interface IngestionTerminalPublicationPort {
  publishTerminalFailure(request: IngestionTerminalPublicationRequest): Promise<IngestionRun>;
}
