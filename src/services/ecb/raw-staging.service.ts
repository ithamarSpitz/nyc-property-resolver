import { Prisma, PrismaClient, type EcbViolationRaw, type EcbViolationStaging } from '@prisma/client';

import { extractEcbSourceIdentity, ecbTransportRowSchema, type EcbTransportRow } from '../../schemas/ecb.schema';
import { AppError } from '../../errors';
import {
  normalizeEcbViolation,
  parseEcbDate,
  type NormalizedEcbViolation,
} from './normalization.service';

export const ECB_ROW_PROCESSING_ERROR_CODES = Object.freeze({
  INVALID_TRANSPORT: 'ECB_INVALID_TRANSPORT',
  RAW_PERSISTENCE_FAILED: 'ECB_RAW_PERSISTENCE_FAILED',
  NORMALIZATION_FAILED: 'ECB_NORMALIZATION_FAILED',
  STAGING_PERSISTENCE_FAILED: 'ECB_STAGING_PERSISTENCE_FAILED',
} as const);

export type EcbRowProcessingStage = 'transport' | 'raw' | 'normalization' | 'staging';

export class EcbRowProcessingError extends AppError {
  readonly stage: EcbRowProcessingStage;
  readonly sourceId: string | null;
  readonly rawPersisted: boolean;
  readonly issues: readonly zodIssue[];

  constructor(options: {
    code: string;
    message: string;
    stage: EcbRowProcessingStage;
    sourceId?: string | null;
    rawPersisted: boolean;
    cause?: unknown;
  }) {
    super(options);
    this.stage = options.stage;
    this.sourceId = options.sourceId ?? null;
    this.rawPersisted = options.rawPersisted;
    this.issues = isZodError(options.cause) ? options.cause.issues : [];
  }
}

type zodIssue = {
  readonly code: string;
  readonly path: PropertyKey[];
  readonly message: string;
};

function isZodError(error: unknown): error is { issues: readonly zodIssue[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray(error.issues)
  );
}

function jsonPayload(row: EcbTransportRow): Prisma.InputJsonValue {
  // JSONB stores semantic JSON values. JSON serialization also mirrors what
  // the HTTP boundary can actually receive, omitting undefined object keys.
  return JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue;
}

export type ProcessEcbRowInput = {
  runId: string;
  row: unknown;
  fetchedAt?: Date;
};

export type EcbRowProcessingResult = {
  raw: EcbViolationRaw;
  staging: EcbViolationStaging;
  normalized: NormalizedEcbViolation;
};

function decimalValue(value: number | null): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(value.toString());
}

export class EcbRawStagingService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Persist the raw source version without performing domain validation. */
  async persistRaw(
    runId: string,
    row: unknown,
    fetchedAt: Date = new Date(),
  ): Promise<EcbViolationRaw> {
    let transport: EcbTransportRow;
    let identity: ReturnType<typeof extractEcbSourceIdentity>;
    try {
      transport = ecbTransportRowSchema.parse(row);
      identity = extractEcbSourceIdentity(transport);
    } catch (error) {
      throw new EcbRowProcessingError({
        code: ECB_ROW_PROCESSING_ERROR_CODES.INVALID_TRANSPORT,
        message: 'ECB row is not minimally identifiable for raw persistence',
        stage: 'transport',
        rawPersisted: false,
        cause: error,
      });
    }

    let sourceRowUpdatedAt: Date;
    try {
      const parsedSourceRowUpdatedAt = parseEcbDate(identity.sourceRowUpdatedAt, ':updated_at');
      if (parsedSourceRowUpdatedAt === null) {
        throw new Error('timestamp is empty');
      }
      sourceRowUpdatedAt = parsedSourceRowUpdatedAt;
    } catch (error) {
      throw new EcbRowProcessingError({
        code: ECB_ROW_PROCESSING_ERROR_CODES.INVALID_TRANSPORT,
        message: 'ECB row has an invalid :updated_at value for raw persistence',
        stage: 'transport',
        sourceId: identity.sourceId,
        rawPersisted: false,
        cause: error,
      });
    }

    try {
      return await this.prisma.ecbViolationRaw.upsert({
        where: {
          sourceId_sourceRowUpdatedAt: {
            sourceId: identity.sourceId,
            sourceRowUpdatedAt,
          },
        },
        create: {
          sourceId: identity.sourceId,
          socrataRowId: identity.socrataRowId,
          sourceRowUpdatedAt,
          fetchedAt,
          firstSeenRunId: runId,
          payload: jsonPayload(transport),
        },
        // A raw source version is immutable evidence. Replays must return the
        // original row rather than replacing its observed payload/provenance.
        update: {},
      });
    } catch (error) {
      throw new EcbRowProcessingError({
        code: ECB_ROW_PROCESSING_ERROR_CODES.RAW_PERSISTENCE_FAILED,
        message: `Could not persist raw ECB source version for ${identity.sourceId}`,
        stage: 'raw',
        sourceId: identity.sourceId,
        rawPersisted: false,
        cause: error,
      });
    }
  }

  async upsertStaging(
    runId: string,
    normalized: NormalizedEcbViolation,
  ): Promise<EcbViolationStaging> {
    try {
      return await this.prisma.ecbViolationStaging.upsert({
        where: {
          runId_sourceId: { runId, sourceId: normalized.sourceId },
        },
        create: {
          runId,
          sourceId: normalized.sourceId,
          socrataRowId: normalized.socrataRowId,
          bin: normalized.bin,
          violationNumber: normalized.violationNumber,
          issueDate: normalized.issueDate,
          ecbViolationStatus: normalized.ecbViolationStatus,
          balanceDue: decimalValue(normalized.balanceDue),
          sourceRowUpdatedAt: normalized.sourceRowUpdatedAt,
        },
        update: {
          socrataRowId: normalized.socrataRowId,
          bin: normalized.bin,
          violationNumber: normalized.violationNumber,
          issueDate: normalized.issueDate,
          ecbViolationStatus: normalized.ecbViolationStatus,
          balanceDue: decimalValue(normalized.balanceDue),
          sourceRowUpdatedAt: normalized.sourceRowUpdatedAt,
        },
      });
    } catch (error) {
      throw new EcbRowProcessingError({
        code: ECB_ROW_PROCESSING_ERROR_CODES.STAGING_PERSISTENCE_FAILED,
        message: `Could not persist ECB staging candidate for ${normalized.sourceId}`,
        stage: 'staging',
        sourceId: normalized.sourceId,
        rawPersisted: true,
        cause: error,
      });
    }
  }

  /**
   * Raw persistence intentionally completes before normalize() is called.
   * Consequently, a strict validation error retains its raw evidence.
   */
  async processRow(input: ProcessEcbRowInput): Promise<EcbRowProcessingResult>;
  async processRow(
    runId: string,
    row: unknown,
    fetchedAt?: Date,
  ): Promise<EcbRowProcessingResult>;
  async processRow(
    inputOrRunId: ProcessEcbRowInput | string,
    row?: unknown,
    fetchedAt?: Date,
  ): Promise<EcbRowProcessingResult> {
    const input: ProcessEcbRowInput =
      typeof inputOrRunId === 'string'
        ? { runId: inputOrRunId, row, fetchedAt }
        : inputOrRunId;
    const raw = await this.persistRaw(input.runId, input.row, input.fetchedAt);

    let normalized: NormalizedEcbViolation;
    try {
      normalized = normalizeEcbViolation(input.row);
    } catch (error) {
      throw new EcbRowProcessingError({
        code: ECB_ROW_PROCESSING_ERROR_CODES.NORMALIZATION_FAILED,
        message: `ECB row ${raw.sourceId} failed strict validation or normalization`,
        stage: 'normalization',
        sourceId: raw.sourceId,
        rawPersisted: true,
        cause: error,
      });
    }

    const staging = await this.upsertStaging(input.runId, normalized);
    return { raw, staging, normalized };
  }

  async processSourceRow(
    runId: string,
    row: unknown,
    fetchedAt?: Date,
  ): Promise<EcbRowProcessingResult> {
    return this.processRow({ runId, row, fetchedAt });
  }
}

export const RawStagingService = EcbRawStagingService;
export const EcbRawAndStagingService = EcbRawStagingService;
export const RawEcbStagingService = EcbRawStagingService;

export function createEcbRawStagingService(prisma: PrismaClient): EcbRawStagingService {
  return new EcbRawStagingService(prisma);
}

export async function processEcbSourceRow(
  prisma: PrismaClient,
  input: ProcessEcbRowInput,
): Promise<EcbRowProcessingResult> {
  return new EcbRawStagingService(prisma).processRow(input);
}

export async function processEcbRow(
  prisma: PrismaClient,
  input: ProcessEcbRowInput,
): Promise<EcbRowProcessingResult> {
  return processEcbSourceRow(prisma, input);
}
