import { EventEmitter } from 'node:events';

import { PrismaClient, type Property } from '@prisma/client';

import { CONFIG_DEFAULTS } from '../../../src/config/defaults';
import {
  rowsUpdatedAtToDate,
  type DatasetMetadataPort,
} from '../../../src/services/ecb/ingestion-initialization.service';
import {
  EcbIngestionLockService,
  type IngestionLockClient,
} from '../../../src/services/ecb/ingestion-lock.service';
import {
  EcbIngestionService,
  type IngestionServiceOptions,
} from '../../../src/services/ecb/ingestion.service';
import type {
  IngestionTerminalPublicationPort,
  IngestionTerminalPublicationRequest,
} from '../../../src/services/ecb/ingestion-terminal-publication.port';
import { START_WATERMARK_SECONDS } from './constants';

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export function mockSocrataResponse(payload: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

export function asFetchResponse(value: MockResponse): Response {
  return value as unknown as Response;
}

export class FakeLockClient extends EventEmitter implements IngestionLockClient {
  readonly connect = jest.fn(async () => undefined);
  readonly end = jest.fn(async () => {
    this.emit('end');
  });
  readonly queries: Array<{ query: string; values: unknown[] }> = [];
  queryResult = { acquired: true };

  async query(query: string, values: unknown[] = []): Promise<{ rows: Array<{ acquired: boolean }> }> {
    this.queries.push({ query, values });
    return { rows: [this.queryResult] };
  }
}

export async function truncateIngestionTables(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
  );
}

export async function seedProperty(
  prisma: PrismaClient,
  bbl: string,
  bins: readonly string[],
  identifierVersion = 1,
): Promise<Property> {
  return prisma.property.create({
    data: {
      bbl,
      borough: 1,
      block: Number.parseInt(bbl.slice(1, 6), 10),
      lot: Number.parseInt(bbl.slice(6), 10),
      identifierVersion,
      resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
      bins: {
        create: bins.map((bin) => ({ bin })),
      },
    },
  });
}

export type MutableMetadataState = {
  startRowsUpdatedAt: number;
  endRowsUpdatedAt: number;
};

export function createMetadataPort(
  state: MutableMetadataState = {
    startRowsUpdatedAt: START_WATERMARK_SECONDS,
    endRowsUpdatedAt: START_WATERMARK_SECONDS,
  },
): DatasetMetadataPort {
  let metadataCalls = 0;

  return {
    getDatasetMetadata: async () => {
      metadataCalls += 1;
      return {
        rowsUpdatedAt:
          metadataCalls % 2 === 1 ? state.startRowsUpdatedAt : state.endRowsUpdatedAt,
      };
    },
  };
}

export function createTerminalPublicationPort(
  prisma: PrismaClient,
  requests: IngestionTerminalPublicationRequest[],
): IngestionTerminalPublicationPort {
  return {
    publishTerminalFailure: async (request) => {
      requests.push(request);
      return prisma.ingestionRun.update({
        where: { id: request.runId },
        data: {
          status: request.status,
          failureStage: request.failureStage,
          lastError: request.lastError,
          finishedAt: request.finishedAt,
        },
      });
    },
  };
}

export type IngestionExecutorFixture = {
  executor: EcbIngestionService;
  metadataState: MutableMetadataState;
  terminalPublicationRequests: IngestionTerminalPublicationRequest[];
};

export function createIngestionExecutor(
  prisma: PrismaClient,
  connectionString: string,
  options: {
    fetchImpl: jest.MockedFunction<typeof fetch>;
    ecbBatchSize?: number;
    socrataPageSize?: number;
    lockService?: EcbIngestionLockService;
    metadataPort?: DatasetMetadataPort;
    metadataState?: MutableMetadataState;
    batchProcessorConfig?: IngestionServiceOptions['batchProcessorConfig'];
  },
): IngestionExecutorFixture {
  const terminalPublicationRequests: IngestionTerminalPublicationRequest[] = [];
  const metadataState =
    options.metadataState ??
    ({
      startRowsUpdatedAt: START_WATERMARK_SECONDS,
      endRowsUpdatedAt: START_WATERMARK_SECONDS,
    } satisfies MutableMetadataState);
  const metadataPort = options.metadataPort ?? createMetadataPort(metadataState);

  const socrataPageSize = options.socrataPageSize ?? CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE;
  const executor = new EcbIngestionService({
    prisma,
    connectionString,
    metadataPort,
    terminalPublicationPort: createTerminalPublicationPort(prisma, terminalPublicationRequests),
    ecbBatchSize: options.ecbBatchSize ?? 2,
    socrataPageSize,
    fetchImpl: options.fetchImpl,
    lockService: options.lockService,
    batchProcessorConfig: {
      socrataPageSize,
      ...options.batchProcessorConfig,
    },
  });

  return {
    executor,
    metadataState,
    terminalPublicationRequests,
  };
}

export function watermarkFromSeconds(seconds: number): Date {
  return rowsUpdatedAtToDate(seconds);
}
