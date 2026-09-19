import { getConfig, type AppConfig } from '../config';
import { AppError } from '../errors';
import { getLogger } from '../logging/logger';
import { canonicalizeBbl, type CanonicalBbl } from '../schemas/property-identifiers.schema';

import {
  DEFAULT_CONDO_LOOKUP_LIMIT,
  DEFAULT_NYC_OPEN_DATA_BASE_URL,
  SOCRATA_MAX_PAGE_LIMIT,
} from './condo-units.client';

export const CONDOMINIUMS_DATASET_ID = 'p8u6-a6it';
export const CONDOMINIUMS_BULK_LOOKUP_CHUNK_SIZE = 500;
export const CONDOMINIUMS_BULK_LOOKUP_RESULT_LIMIT_PER_KEY = DEFAULT_CONDO_LOOKUP_LIMIT;
export const CONDOMINIUMS_BULK_MAX_LOOKUP_PAGES = 20;

export type CondominiumBillingRecord = {
  condoBaseBbl: CanonicalBbl;
  condoBillingBbl: CanonicalBbl;
};

export type CondominiumBillingLookupResult =
  | { matchCount: 'zero'; matches: [] }
  | { matchCount: 'one'; matches: [CondominiumBillingRecord] }
  | { matchCount: 'multiple'; matches: CondominiumBillingRecord[] };

export type CondominiumsClientOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  appToken?: string;
  logger?: ReturnType<typeof getLogger>;
  lookupLimit?: number;
  config?: Pick<AppConfig, 'socrataRequestTimeoutMs' | 'socrataAppToken'>;
};

type RawCondominiumRow = Record<string, unknown>;

function escapeSoqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: string }).name === 'AbortError'
  );
}

function normalizeSourceBbl(value: unknown, fieldName: string): CanonicalBbl {
  try {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return canonicalizeBbl(String(Math.trunc(value)).padStart(10, '0'));
    }

    if (typeof value === 'string') {
      return canonicalizeBbl(value);
    }
  } catch {
    throw new AppError({
      code: 'CONDOMINIUMS_MALFORMED_RESPONSE',
      message: `Condominiums response row is missing a valid ${fieldName}`,
      statusCode: 502,
    });
  }

  throw new AppError({
    code: 'CONDOMINIUMS_MALFORMED_RESPONSE',
    message: `Condominiums response row is missing a valid ${fieldName}`,
    statusCode: 502,
  });
}

function parseCondominiumRow(row: RawCondominiumRow): CondominiumBillingRecord {
  return {
    condoBaseBbl: normalizeSourceBbl(row.condo_base_bbl, 'condo_base_bbl'),
    condoBillingBbl: normalizeSourceBbl(row.condo_billing_bbl, 'condo_billing_bbl'),
  };
}

function classifyLookupResult(
  matches: CondominiumBillingRecord[],
): CondominiumBillingLookupResult {
  if (matches.length === 0) {
    return { matchCount: 'zero', matches: [] };
  }

  if (matches.length === 1) {
    return { matchCount: 'one', matches: [matches[0]] };
  }

  return { matchCount: 'multiple', matches };
}

function chunkValues<T>(values: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function bulkQueryPageLimit(keyCount: number, resultLimitPerKey: number): number {
  return Math.min(SOCRATA_MAX_PAGE_LIMIT, Math.max(keyCount * resultLimitPerKey, keyCount));
}

function sortCondominiumRecords(
  records: CondominiumBillingRecord[],
): CondominiumBillingRecord[] {
  return [...records].sort((left, right) => {
    const billingCompare = left.condoBillingBbl.localeCompare(right.condoBillingBbl);
    if (billingCompare !== 0) {
      return billingCompare;
    }

    return left.condoBaseBbl.localeCompare(right.condoBaseBbl);
  });
}

export class CondominiumsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly appToken?: string;
  private readonly logger: ReturnType<typeof getLogger>;
  private readonly lookupLimit: number;

  constructor(options: CondominiumsClientOptions = {}) {
    const config = options.config ?? getConfig();

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_NYC_OPEN_DATA_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? config.socrataRequestTimeoutMs;
    this.appToken = options.appToken ?? config.socrataAppToken;
    this.logger = options.logger ?? getLogger();
    this.lookupLimit = options.lookupLimit ?? DEFAULT_CONDO_LOOKUP_LIMIT;
  }

  async lookupByCondoBaseBbl(condoBaseBblInput: string): Promise<CondominiumBillingLookupResult> {
    const condoBaseBbl = canonicalizeBbl(condoBaseBblInput);
    const whereClause = `condo_base_bbl='${escapeSoqlString(condoBaseBbl)}'`;

    const rows = await this.fetchCondominiumRows(whereClause);
    const matches = sortCondominiumRecords(rows.map(parseCondominiumRow));

    return classifyLookupResult(matches);
  }

  async lookupByCondoBillingBbl(
    condoBillingBblInput: string,
  ): Promise<CondominiumBillingLookupResult> {
    const condoBillingBbl = canonicalizeBbl(condoBillingBblInput);
    const whereClause = `condo_billing_bbl='${escapeSoqlString(condoBillingBbl)}'`;

    const rows = await this.fetchCondominiumRows(whereClause);
    const matches = sortCondominiumRecords(rows.map(parseCondominiumRow));

    return classifyLookupResult(matches);
  }

  async lookupByCondoBaseBbls(
    condoBaseBblInputs: readonly string[],
  ): Promise<Map<CanonicalBbl, CondominiumBillingLookupResult>> {
    const canonicalBbls = [...new Set(condoBaseBblInputs.map((bbl) => canonicalizeBbl(bbl)))].sort();
    const grouped = new Map<CanonicalBbl, CondominiumBillingRecord[]>();

    for (const bbl of canonicalBbls) {
      grouped.set(bbl, []);
    }

    for (const chunk of chunkValues(canonicalBbls, CONDOMINIUMS_BULK_LOOKUP_CHUNK_SIZE)) {
      const quotedBbls = chunk.map((bbl) => `'${escapeSoqlString(bbl)}'`).join(',');
      const whereClause = `condo_base_bbl in (${quotedBbls})`;
      const rows = await this.fetchCondominiumRowsBulk(whereClause, chunk.length);
      for (const match of sortCondominiumRecords(rows.map(parseCondominiumRow))) {
        grouped.get(match.condoBaseBbl)?.push(match);
      }
    }

    const results = new Map<CanonicalBbl, CondominiumBillingLookupResult>();
    for (const bbl of canonicalBbls) {
      const matches = sortCondominiumRecords(grouped.get(bbl) ?? []);
      results.set(bbl, classifyLookupResult(matches));
    }

    return results;
  }

  private async fetchCondominiumRows(whereClause: string): Promise<RawCondominiumRow[]> {
    const url = new URL(`${this.baseUrl}/${CONDOMINIUMS_DATASET_ID}.json`);
    url.searchParams.set('$select', 'condo_base_bbl,condo_billing_bbl');
    url.searchParams.set('$where', whereClause);
    url.searchParams.set('$order', 'condo_billing_bbl ASC');
    url.searchParams.set('$limit', String(this.lookupLimit));

    return this.fetchRows(url);
  }

  private async fetchCondominiumRowsBulk(
    whereClause: string,
    keyCount: number,
  ): Promise<RawCondominiumRow[]> {
    const pageLimit = bulkQueryPageLimit(
      keyCount,
      CONDOMINIUMS_BULK_LOOKUP_RESULT_LIMIT_PER_KEY,
    );
    const rows: RawCondominiumRow[] = [];

    for (let pageIndex = 0; pageIndex < CONDOMINIUMS_BULK_MAX_LOOKUP_PAGES; pageIndex += 1) {
      const offset = pageIndex * pageLimit;
      const url = new URL(`${this.baseUrl}/${CONDOMINIUMS_DATASET_ID}.json`);
      url.searchParams.set('$select', 'condo_base_bbl,condo_billing_bbl');
      url.searchParams.set('$where', whereClause);
      url.searchParams.set('$order', 'condo_billing_bbl ASC');
      url.searchParams.set('$limit', String(pageLimit));
      if (offset > 0) {
        url.searchParams.set('$offset', String(offset));
      }

      const pageRows = await this.fetchRows(url);
      rows.push(...pageRows);

      if (pageRows.length < pageLimit) {
        return rows;
      }
    }

    throw new AppError({
      code: 'CONDOMINIUMS_LOOKUP_PAGE_LIMIT',
      message: `Condominiums bulk lookup exceeded the maximum of ${CONDOMINIUMS_BULK_MAX_LOOKUP_PAGES} pages`,
      statusCode: 502,
    });
  }

  private async fetchRows(url: URL): Promise<RawCondominiumRow[]> {
    this.logger.debug({ datasetId: CONDOMINIUMS_DATASET_ID }, 'condominiums request');

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(this.appToken ? { 'X-App-Token': this.appToken } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new AppError({
          code: 'CONDOMINIUMS_REQUEST_TIMEOUT',
          message: `Condominiums request timed out after ${this.timeoutMs}ms`,
          statusCode: 504,
          cause: error,
        });
      }

      throw error;
    }

    if (!response.ok) {
      throw new AppError({
        code: 'CONDOMINIUMS_HTTP_ERROR',
        message: `Condominiums request failed with HTTP ${response.status}`,
        statusCode: 502,
        cause: { status: response.status, statusText: response.statusText },
      });
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch (error) {
      throw new AppError({
        code: 'CONDOMINIUMS_MALFORMED_RESPONSE',
        message: 'Condominiums response was not valid JSON',
        statusCode: 502,
        cause: error,
      });
    }

    if (!Array.isArray(payload)) {
      throw new AppError({
        code: 'CONDOMINIUMS_MALFORMED_RESPONSE',
        message: 'Condominiums response must be a JSON array',
        statusCode: 502,
      });
    }

    return payload as RawCondominiumRow[];
  }
}
