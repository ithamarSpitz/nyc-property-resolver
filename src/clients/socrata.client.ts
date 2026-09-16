import type { Logger } from 'pino';

import {
  ECB_SOURCE_ID_FIELD,
  DOB_ECB_SOURCE_CONTRACT_QUERY,
  parseSourceContractStats,
  SOCRATA_ROW_ID_FIELD,
  SOURCE_ROW_UPDATED_AT_FIELD,
  type EcbSourceRow,
  type SourceContractStats,
} from '../schemas/ecb-ingestion.schema';
import { CONFIG_DEFAULTS } from '../config/defaults';
import { AppError } from '../errors';

export const DOB_ECB_DATASET_ID = '6bgk-3dad';
export const SOCRATA_ECB_DATASET_ID = DOB_ECB_DATASET_ID;
export const SOCRATA_DEFAULT_BASE_URL = 'https://data.cityofnewyork.us';
export const SOCRATA_ECB_DATA_URL =
  `${SOCRATA_DEFAULT_BASE_URL}/resource/${DOB_ECB_DATASET_ID}.json`;
export const SOCRATA_ECB_METADATA_URL =
  `${SOCRATA_DEFAULT_BASE_URL}/api/views/${DOB_ECB_DATASET_ID}`;
export const SOCRATA_ECB_BIN_FIELD = 'bin';
const SOCRATA_ECB_SOURCE_ID_RESPONSE_FIELD = 'isn_dob_bis_extract';
export const SOCRATA_ECB_PAGE_SELECT = `${SOCRATA_ROW_ID_FIELD},${SOURCE_ROW_UPDATED_AT_FIELD},*`;
export const SOCRATA_ECB_PAGE_ORDER = `${SOURCE_ROW_UPDATED_AT_FIELD},${SOCRATA_ROW_ID_FIELD}`;
export const SOCRATA_MAX_PAGE_SIZE = 50_000;
/** A BIN is an identifier, not an unbounded query fragment. */
export const SOCRATA_MAX_BIN_VALUE_LENGTH = 64;
/**
 * Default bulk-query bounds. Batch cardinality follows the configured logical
 * ECB batch size and the constructed request has an explicit size ceiling so no
 * caller can build an arbitrarily large Socrata query.
 */
export const SOCRATA_DEFAULT_MAX_BINS_PER_QUERY = CONFIG_DEFAULTS.ECB_BATCH_SIZE;
export const SOCRATA_DEFAULT_MAX_QUERY_URL_LENGTH = 32_768;

export const SOCRATA_ERROR_CODES = {
  INVALID_REQUEST: 'SOCRATA_INVALID_REQUEST',
  HTTP_ERROR: 'SOCRATA_HTTP_ERROR',
  TIMEOUT: 'SOCRATA_TIMEOUT',
  TRANSPORT_ERROR: 'SOCRATA_TRANSPORT_ERROR',
  MALFORMED_RESPONSE: 'SOCRATA_MALFORMED_RESPONSE',
  MALFORMED_JSON: 'SOCRATA_MALFORMED_RESPONSE',
} as const;

export type SocrataErrorKind =
  | 'invalid_request'
  | 'http'
  | 'timeout'
  | 'transport'
  | 'transport_shape'
  | 'malformed_json'
  | 'malformed_payload';

export type SocrataErrorClassification = 'retryable' | 'non_retryable';

export type SocrataRowsUpdatedAt = number;

export type SocrataDatasetMetadata = {
  rowsUpdatedAt: SocrataRowsUpdatedAt;
};

export type SocrataHttpRequest = {
  url: string;
  init: RequestInit;
};

/**
 * One attempt materializes the whole request, including reading and parsing the
 * response body, so a failure while streaming the body is classified and
 * retryable exactly like a failure while opening the connection.
 */
export type SocrataResponseEnvelope = {
  status: number;
  payload: unknown;
};

export type SocrataRequestAttempt = {
  request: SocrataHttpRequest;
  execute: () => Promise<SocrataResponseEnvelope>;
};

/**
 * The request executor is deliberately a narrow port. S2-T3 can add
 * throttling, timeout and retry behavior around this request without making
 * the query client aware of scheduling policy.
 */
export interface SocrataRequestExecutor {
  execute(attempt: SocrataRequestAttempt): Promise<SocrataResponseEnvelope>;
}

export type SocrataRequestExecutorLike =
  | SocrataRequestExecutor
  | ((attempt: SocrataRequestAttempt) => Promise<SocrataResponseEnvelope>);

export type SocrataClientOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  dataUrl?: string;
  metadataUrl?: string;
  socrataAppToken?: string;
  requestExecutor?: SocrataRequestExecutorLike;
  logger?: Logger;
  signal?: AbortSignal;
  maxBinsPerQuery?: number;
  maxQueryUrlLength?: number;
};

export type SocrataEcbPageRequest = {
  binBatch: readonly string[];
  offset: number;
  pageSize: number;
};

export class SocrataClientError extends AppError {
  readonly kind: SocrataErrorKind;
  readonly classification: SocrataErrorClassification;
  readonly retryable: boolean;
  readonly isRetryable: boolean;

  constructor(options: {
    message: string;
    code: string;
    kind: SocrataErrorKind;
    retryable: boolean;
    statusCode?: number;
    cause?: unknown;
  }) {
    super({
      message: options.message,
      code: options.code,
      statusCode: options.statusCode,
      cause: options.cause,
    });
    this.name = 'SocrataClientError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.isRetryable = options.retryable;
    this.classification = options.retryable ? 'retryable' : 'non_retryable';
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function isResponseShape(value: unknown): value is Response {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.ok === 'boolean' &&
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    typeof value.json === 'function'
  );
}

function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  } else if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new SocrataClientError({
    code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
    kind: 'malformed_payload',
    retryable: false,
    statusCode: 502,
    message: `Socrata response field ${fieldName} must be a non-negative integer`,
  });
}

function parseRowsUpdatedAt(value: unknown): SocrataRowsUpdatedAt {
  return parseNonNegativeInteger(value, 'rowsUpdatedAt');
}

function parseBound(value: number, optionName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.INVALID_REQUEST,
      kind: 'invalid_request',
      retryable: false,
      statusCode: 400,
      message: `Socrata ${optionName} must be a positive integer`,
    });
  }

  return value;
}

function normalizeBins(binBatch: readonly string[], maxBinsPerQuery: number): string[] {
  if (!Array.isArray(binBatch) || binBatch.length === 0) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.INVALID_REQUEST,
      kind: 'invalid_request',
      retryable: false,
      statusCode: 400,
      message: 'Socrata ECB data queries require a non-empty BIN batch',
    });
  }

  if (binBatch.length > maxBinsPerQuery) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.INVALID_REQUEST,
      kind: 'invalid_request',
      retryable: false,
      statusCode: 400,
      message: `Socrata ECB data queries accept at most ${maxBinsPerQuery} BINs per batch, received ${binBatch.length}`,
    });
  }

  const bins = [...new Set(binBatch)];
  if (
    bins.some(
      (bin) =>
        typeof bin !== 'string' ||
        bin.trim().length === 0 ||
        bin.length > SOCRATA_MAX_BIN_VALUE_LENGTH,
    )
  ) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.INVALID_REQUEST,
      kind: 'invalid_request',
      retryable: false,
      statusCode: 400,
      message: `Socrata ECB data queries require non-empty BIN strings up to ${SOCRATA_MAX_BIN_VALUE_LENGTH} characters`,
    });
  }

  return bins.sort();
}

function validatePageValue(value: number, fieldName: string, allowZero: boolean): void {
  const isValid =
    Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
  if (!isValid) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.INVALID_REQUEST,
      kind: 'invalid_request',
      retryable: false,
      statusCode: 400,
      message: `Socrata ${fieldName} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`,
    });
  }

  if (fieldName === 'page size' && value > SOCRATA_MAX_PAGE_SIZE) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.INVALID_REQUEST,
      kind: 'invalid_request',
      retryable: false,
      statusCode: 400,
      message: `Socrata page size must be at most ${SOCRATA_MAX_PAGE_SIZE}`,
    });
  }
}

function escapeSoqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function parsePayloadRows(payload: unknown, operation: string): EcbSourceRow[] {
  if (!Array.isArray(payload) || payload.some((row) => !isRecord(row))) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'malformed_payload',
      retryable: false,
      statusCode: 502,
      message: `Socrata ${operation} response must be a JSON array of row objects`,
    });
  }

  if (
    payload.some(
      (row) =>
        typeof row[SOCRATA_ROW_ID_FIELD] !== 'string' ||
        row[SOCRATA_ROW_ID_FIELD].trim().length === 0 ||
        typeof row[SOURCE_ROW_UPDATED_AT_FIELD] !== 'string' ||
        row[SOURCE_ROW_UPDATED_AT_FIELD].trim().length === 0,
    )
  ) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'malformed_payload',
      retryable: false,
      statusCode: 502,
      message: `Socrata ${operation} rows require non-empty ${SOCRATA_ROW_ID_FIELD} and ${SOURCE_ROW_UPDATED_AT_FIELD} string fields`,
    });
  }

  return payload as EcbSourceRow[];
}

function parseAggregatePayload(payload: unknown): Record<string, unknown> {
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'malformed_payload',
      retryable: false,
      statusCode: 502,
      message: 'Socrata source-contract aggregate response must contain one object',
    });
  }

  return payload[0];
}

function parseDuplicateGroupsPayload(payload: unknown): Array<{ sourceId: string | null; count: number }> {
  if (!Array.isArray(payload)) {
    throw new SocrataClientError({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'malformed_payload',
      retryable: false,
      statusCode: 502,
      message: 'Socrata duplicate-group response must be a JSON array',
    });
  }

  return payload.map((row) => {
    if (!isRecord(row)) {
      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
        kind: 'malformed_payload',
        retryable: false,
        statusCode: 502,
        message: 'Socrata duplicate-group response contains a non-object row',
      });
    }

    const sourceId = Object.prototype.hasOwnProperty.call(
      row,
      SOCRATA_ECB_SOURCE_ID_RESPONSE_FIELD,
    )
      ? row[SOCRATA_ECB_SOURCE_ID_RESPONSE_FIELD]
      : row[ECB_SOURCE_ID_FIELD];
    if (sourceId !== null && typeof sourceId !== 'string') {
      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
        kind: 'malformed_payload',
        retryable: false,
        statusCode: 502,
        message: `Socrata duplicate-group field ${ECB_SOURCE_ID_FIELD} must be a string or null`,
      });
    }

    return {
      sourceId,
      count: parseNonNegativeInteger(row.count, 'count'),
    };
  });
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

export function isRetryableSocrataError(error: unknown): boolean {
  return error instanceof SocrataClientError && error.retryable;
}

export class SocrataClient {
  private readonly fetchImpl: typeof fetch;
  private readonly dataUrl: string;
  private readonly metadataUrl: string;
  private readonly socrataAppToken?: string;
  private readonly requestExecutor?: SocrataRequestExecutorLike;
  private readonly logger?: Logger;
  private readonly signal?: AbortSignal;
  private readonly maxBinsPerQuery: number;
  private readonly maxQueryUrlLength: number;

  constructor(options: SocrataClientOptions = {}) {
    const baseUrl = options.baseUrl ?? SOCRATA_DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dataUrl = options.dataUrl ?? new URL(`/resource/${DOB_ECB_DATASET_ID}.json`, baseUrl).toString();
    this.metadataUrl = options.metadataUrl ?? new URL(`/api/views/${DOB_ECB_DATASET_ID}`, baseUrl).toString();
    this.socrataAppToken = options.socrataAppToken;
    this.requestExecutor = options.requestExecutor;
    this.logger = options.logger;
    this.signal = options.signal;
    this.maxBinsPerQuery = parseBound(
      options.maxBinsPerQuery ?? SOCRATA_DEFAULT_MAX_BINS_PER_QUERY,
      'maxBinsPerQuery',
    );
    this.maxQueryUrlLength = parseBound(
      options.maxQueryUrlLength ?? SOCRATA_DEFAULT_MAX_QUERY_URL_LENGTH,
      'maxQueryUrlLength',
    );
  }

  buildMetadataUrl(): string {
    return this.metadataUrl;
  }

  buildEcbDataPageUrl(
    binBatch: readonly string[],
    offset: number,
    pageSize: number,
  ): string {
    validatePageValue(offset, 'offset', true);
    validatePageValue(pageSize, 'page size', false);

    const bins = normalizeBins(binBatch, this.maxBinsPerQuery);
    const url = new URL(this.dataUrl);
    url.searchParams.set('$select', SOCRATA_ECB_PAGE_SELECT);
    url.searchParams.set(
      '$where',
      `${SOCRATA_ECB_BIN_FIELD} in (${bins.map((bin) => `'${escapeSoqlString(bin)}'`).join(',')})`,
    );
    url.searchParams.set('$order', SOCRATA_ECB_PAGE_ORDER);
    url.searchParams.set('$limit', String(pageSize));
    url.searchParams.set('$offset', String(offset));

    const built = url.toString();
    if (built.length > this.maxQueryUrlLength) {
      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.INVALID_REQUEST,
        kind: 'invalid_request',
        retryable: false,
        statusCode: 400,
        message: `Socrata ECB data page request exceeds the ${this.maxQueryUrlLength} character query bound`,
      });
    }

    return built;
  }

  buildDataPageUrl(binBatch: readonly string[], offset: number, pageSize: number): string {
    return this.buildEcbDataPageUrl(binBatch, offset, pageSize);
  }

  buildSourceContractAggregateUrl(): string {
    const query = DOB_ECB_SOURCE_CONTRACT_QUERY;
    const url = new URL(this.dataUrl);
    url.searchParams.set(
      '$select',
      `${query.totalRows} as totalRows,${query.distinctSourceIds} as distinctSourceIds`,
    );
    return url.toString();
  }

  buildSourceContractNullCountUrl(): string {
    const query = DOB_ECB_SOURCE_CONTRACT_QUERY;
    const url = new URL(this.dataUrl);
    url.searchParams.set('$select', 'count(*) as nullSourceIds');
    url.searchParams.set('$where', `${query.sourceIdField} is null`);
    return url.toString();
  }

  buildSourceContractDuplicateGroupsUrl(): string {
    const query = DOB_ECB_SOURCE_CONTRACT_QUERY;
    const url = new URL(this.dataUrl);
    url.searchParams.set('$select', `${query.sourceIdField},count(*) as count`);
    url.searchParams.set('$where', `${query.sourceIdField} is not null`);
    url.searchParams.set('$group', query.sourceIdField);
    url.searchParams.set('$having', 'count(*) > 1');
    url.searchParams.set('$order', query.sourceIdField);
    return url.toString();
  }

  async getDatasetMetadata(): Promise<SocrataDatasetMetadata> {
    const payload = await this.requestJson(this.metadataUrl, 'metadata');
    if (!isRecord(payload) || !('rowsUpdatedAt' in payload)) {
      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
        kind: 'malformed_payload',
        retryable: false,
        statusCode: 502,
        message: 'Socrata metadata response is missing rowsUpdatedAt',
      });
    }

    return { rowsUpdatedAt: parseRowsUpdatedAt(payload.rowsUpdatedAt) };
  }

  async getMetadata(): Promise<SocrataDatasetMetadata> {
    return this.getDatasetMetadata();
  }

  async getEcbDataPage(
    binBatch: readonly string[],
    offset: number,
    pageSize: number,
  ): Promise<EcbSourceRow[]> {
    const url = this.buildEcbDataPageUrl(binBatch, offset, pageSize);
    const payload = await this.requestJson(url, 'ECB data page');
    return parsePayloadRows(payload, 'ECB data page');
  }

  async getEcbPage(
    binBatch: readonly string[],
    offset: number,
    pageSize: number,
  ): Promise<EcbSourceRow[]> {
    return this.getEcbDataPage(binBatch, offset, pageSize);
  }

  async getSourceContractStats(): Promise<SourceContractStats> {
    const aggregatePayload = await this.requestJson(
      this.buildSourceContractAggregateUrl(),
      'source-contract aggregate',
    );
    const aggregate = parseAggregatePayload(aggregatePayload);
    const nullCountPayload = await this.requestJson(
      this.buildSourceContractNullCountUrl(),
      'source-contract NULL count',
    );
    const nullCount = parseAggregatePayload(nullCountPayload);
    const duplicatePayload = await this.requestJson(
      this.buildSourceContractDuplicateGroupsUrl(),
      'source-contract duplicate groups',
    );
    const duplicateGroups = parseDuplicateGroupsPayload(duplicatePayload);

    try {
      return parseSourceContractStats({
        totalRows: parseNonNegativeInteger(aggregate.totalRows, 'totalRows'),
        distinctSourceIds: parseNonNegativeInteger(
          aggregate.distinctSourceIds,
          'distinctSourceIds',
        ),
        nullSourceIds: parseNonNegativeInteger(nullCount.nullSourceIds, 'nullSourceIds'),
        duplicateGroups,
      });
    } catch (error) {
      if (error instanceof SocrataClientError) {
        throw error;
      }

      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
        kind: 'malformed_payload',
        retryable: false,
        statusCode: 502,
        message: 'Socrata source-contract response did not match the expected shape',
        cause: error,
      });
    }
  }

  private async requestJson(url: string, operation: string): Promise<unknown> {
    const headers = new Headers({ Accept: 'application/json' });
    if (this.socrataAppToken) {
      headers.set('X-App-Token', this.socrataAppToken);
    }

    const request: SocrataHttpRequest = {
      url,
      init: {
        method: 'GET',
        headers,
        ...(this.signal ? { signal: this.signal } : {}),
      },
    };

    this.logger?.debug(
      { client: 'socrata', dataset: DOB_ECB_DATASET_ID, operation },
      'socrata request',
    );

    const envelope = await this.execute({
      request,
      execute: () => this.executeRequestAttempt(request, operation),
    });

    return envelope.payload;
  }

  private async execute(attempt: SocrataRequestAttempt): Promise<SocrataResponseEnvelope> {
    if (this.requestExecutor) {
      if (typeof this.requestExecutor === 'function') {
        return this.requestExecutor(attempt);
      }

      return this.requestExecutor.execute(attempt);
    }

    return attempt.execute();
  }

  private async executeRequestAttempt(
    request: SocrataHttpRequest,
    operation: string,
  ): Promise<SocrataResponseEnvelope> {
    let response: unknown;
    try {
      response = await this.fetchImpl(request.url, request.init);
    } catch (error) {
      if (error instanceof SocrataClientError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new SocrataClientError({
          code: SOCRATA_ERROR_CODES.TIMEOUT,
          kind: 'timeout',
          retryable: true,
          statusCode: 504,
          message: 'Socrata request was aborted or timed out',
          cause: error,
        });
      }

      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.TRANSPORT_ERROR,
        kind: 'transport',
        retryable: true,
        statusCode: 503,
        message: 'Socrata request failed before a response was received',
        cause: error,
      });
    }

    if (!isResponseShape(response)) {
      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
        kind: 'transport_shape',
        retryable: false,
        statusCode: 502,
        message: 'Socrata transport returned an invalid response shape',
      });
    }

    if (!response.ok || response.status < 200 || response.status >= 300) {
      const retryable = isRetryableStatus(response.status);
      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.HTTP_ERROR,
        kind: 'http',
        retryable,
        statusCode: response.status,
        message: `Socrata ${operation} failed with HTTP ${response.status}`,
      });
    }

    return {
      status: response.status,
      payload: await this.readJsonBody(response, operation),
    };
  }

  private async readJsonBody(response: Response, operation: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SocrataClientError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new SocrataClientError({
          code: SOCRATA_ERROR_CODES.TIMEOUT,
          kind: 'timeout',
          retryable: true,
          statusCode: 504,
          message: `Socrata ${operation} response body was aborted or timed out`,
          cause: error,
        });
      }

      if (error instanceof SyntaxError) {
        throw new SocrataClientError({
          code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
          kind: 'malformed_json',
          retryable: false,
          statusCode: 502,
          message: `Socrata ${operation} response was not valid JSON`,
          cause: error,
        });
      }

      throw new SocrataClientError({
        code: SOCRATA_ERROR_CODES.TRANSPORT_ERROR,
        kind: 'transport',
        retryable: true,
        statusCode: 503,
        message: `Socrata ${operation} response body failed before it was fully received`,
        cause: error,
      });
    }
  }
}

export function createSocrataClient(options?: SocrataClientOptions): SocrataClient {
  return new SocrataClient(options);
}
