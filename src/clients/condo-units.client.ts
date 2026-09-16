import { getConfig, type AppConfig } from '../config';
import { AppError } from '../errors';
import { getLogger } from '../logging/logger';
import { canonicalizeBbl, type CanonicalBbl } from '../schemas/property-identifiers.schema';

export const CONDO_UNITS_DATASET_ID = 'eguu-7ie3';
export const DEFAULT_NYC_OPEN_DATA_BASE_URL = 'https://data.cityofnewyork.us/resource';
export const DEFAULT_CONDO_LOOKUP_LIMIT = 25;
export const CONDO_UNITS_BULK_LOOKUP_CHUNK_SIZE = 500;
export const CONDO_UNITS_BULK_LOOKUP_RESULT_LIMIT_PER_KEY = 2;
export const CONDO_UNITS_BULK_MAX_LOOKUP_PAGES = 20;
export const SOCRATA_MAX_PAGE_LIMIT = 50_000;

export type CondoUnitRecord = {
  unitBbl: CanonicalBbl;
  condoBaseBbl: CanonicalBbl;
  unitDesignation: string | null;
};

export type CondoUnitLookupResult =
  | { matchCount: 'zero'; matches: [] }
  | { matchCount: 'one'; matches: [CondoUnitRecord] }
  | { matchCount: 'multiple'; matches: CondoUnitRecord[] };

export type CondoUnitsClientOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  appToken?: string;
  logger?: ReturnType<typeof getLogger>;
  lookupLimit?: number;
  config?: Pick<AppConfig, 'socrataRequestTimeoutMs' | 'socrataAppToken'>;
};

type RawCondoUnitRow = Record<string, unknown>;

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
      code: 'CONDO_UNITS_MALFORMED_RESPONSE',
      message: `Condominium Units response row is missing a valid ${fieldName}`,
      statusCode: 502,
    });
  }

  throw new AppError({
    code: 'CONDO_UNITS_MALFORMED_RESPONSE',
    message: `Condominium Units response row is missing a valid ${fieldName}`,
    statusCode: 502,
  });
}

function normalizeUnitDesignation(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  throw new AppError({
    code: 'CONDO_UNITS_MALFORMED_RESPONSE',
    message: 'Condominium Units response row has an invalid unit_designation',
    statusCode: 502,
  });
}

function parseCondoUnitRow(row: RawCondoUnitRow): CondoUnitRecord {
  return {
    unitBbl: normalizeSourceBbl(row.unit_bbl, 'unit_bbl'),
    condoBaseBbl: normalizeSourceBbl(row.condo_base_bbl, 'condo_base_bbl'),
    unitDesignation: normalizeUnitDesignation(row.unit_designation),
  };
}

function classifyLookupResult(matches: CondoUnitRecord[]): CondoUnitLookupResult {
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

function sortCondoUnitRecords(records: CondoUnitRecord[]): CondoUnitRecord[] {
  return [...records].sort((left, right) => {
    const unitCompare = left.unitBbl.localeCompare(right.unitBbl);
    if (unitCompare !== 0) {
      return unitCompare;
    }

    return left.condoBaseBbl.localeCompare(right.condoBaseBbl);
  });
}

export class CondoUnitsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly appToken?: string;
  private readonly logger: ReturnType<typeof getLogger>;
  private readonly lookupLimit: number;

  constructor(options: CondoUnitsClientOptions = {}) {
    const config = options.config ?? getConfig();

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_NYC_OPEN_DATA_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? config.socrataRequestTimeoutMs;
    this.appToken = options.appToken ?? config.socrataAppToken;
    this.logger = options.logger ?? getLogger();
    this.lookupLimit = options.lookupLimit ?? DEFAULT_CONDO_LOOKUP_LIMIT;
  }

  async lookupByUnitBbl(unitBblInput: string): Promise<CondoUnitLookupResult> {
    const unitBbl = canonicalizeBbl(unitBblInput);
    const whereClause = `unit_bbl='${escapeSoqlString(unitBbl)}'`;

    return this.queryCondoUnits(whereClause, 'lookupByUnitBbl');
  }

  async lookupByUnitBbls(unitBblInputs: readonly string[]): Promise<Map<CanonicalBbl, CondoUnitLookupResult>> {
    const canonicalBbls = [...new Set(unitBblInputs.map((bbl) => canonicalizeBbl(bbl)))].sort();
    const grouped = new Map<CanonicalBbl, CondoUnitRecord[]>();

    for (const bbl of canonicalBbls) {
      grouped.set(bbl, []);
    }

    for (const chunk of chunkValues(canonicalBbls, CONDO_UNITS_BULK_LOOKUP_CHUNK_SIZE)) {
      const quotedBbls = chunk.map((bbl) => `'${escapeSoqlString(bbl)}'`).join(',');
      const whereClause = `unit_bbl in (${quotedBbls})`;
      const rows = await this.fetchCondoUnitRowsBulk(whereClause, chunk.length, 'lookupByUnitBbls');
      for (const match of rows.map(parseCondoUnitRow)) {
        grouped.get(match.unitBbl)?.push(match);
      }
    }

    const results = new Map<CanonicalBbl, CondoUnitLookupResult>();
    for (const bbl of canonicalBbls) {
      const matches = sortCondoUnitRecords(grouped.get(bbl) ?? []);
      results.set(bbl, classifyLookupResult(matches));
    }

    return results;
  }

  async lookupByCondoBaseAndUnitDesignation(
    condoBaseBblInput: string,
    unitDesignationInput: string,
  ): Promise<CondoUnitLookupResult> {
    const condoBaseBbl = canonicalizeBbl(condoBaseBblInput);
    const unitDesignation = unitDesignationInput.trim();

    if (unitDesignation.length === 0) {
      throw new AppError({
        code: 'CONDO_UNITS_INVALID_UNIT_DESIGNATION',
        message: 'Unit designation is required for condo unit lookup by context',
        statusCode: 400,
      });
    }

    const whereClause =
      `condo_base_bbl='${escapeSoqlString(condoBaseBbl)}' ` +
      `AND unit_designation='${escapeSoqlString(unitDesignation)}'`;

    return this.queryCondoUnits(whereClause, 'lookupByCondoBaseAndUnitDesignation');
  }

  private async queryCondoUnits(
    whereClause: string,
    operation: string,
  ): Promise<CondoUnitLookupResult> {
    const rows = await this.fetchCondoUnitRows(whereClause, operation);
    const matches = sortCondoUnitRecords(rows.map(parseCondoUnitRow));

    return classifyLookupResult(matches);
  }

  private async fetchCondoUnitRows(whereClause: string, operation: string): Promise<RawCondoUnitRow[]> {
    const url = new URL(`${this.baseUrl}/${CONDO_UNITS_DATASET_ID}.json`);
    url.searchParams.set('$select', 'unit_bbl,condo_base_bbl,unit_designation');
    url.searchParams.set('$where', whereClause);
    url.searchParams.set('$order', 'unit_bbl ASC');
    url.searchParams.set('$limit', String(this.lookupLimit));

    return this.fetchRows(url, operation);
  }

  private async fetchCondoUnitRowsBulk(
    whereClause: string,
    keyCount: number,
    operation: string,
  ): Promise<RawCondoUnitRow[]> {
    const pageLimit = bulkQueryPageLimit(keyCount, CONDO_UNITS_BULK_LOOKUP_RESULT_LIMIT_PER_KEY);
    const rows: RawCondoUnitRow[] = [];

    for (let pageIndex = 0; pageIndex < CONDO_UNITS_BULK_MAX_LOOKUP_PAGES; pageIndex += 1) {
      const offset = pageIndex * pageLimit;
      const url = new URL(`${this.baseUrl}/${CONDO_UNITS_DATASET_ID}.json`);
      url.searchParams.set('$select', 'unit_bbl,condo_base_bbl,unit_designation');
      url.searchParams.set('$where', whereClause);
      url.searchParams.set('$order', 'unit_bbl ASC');
      url.searchParams.set('$limit', String(pageLimit));
      if (offset > 0) {
        url.searchParams.set('$offset', String(offset));
      }

      const pageRows = await this.fetchRows(url, operation);
      rows.push(...pageRows);

      if (pageRows.length < pageLimit) {
        return rows;
      }
    }

    throw new AppError({
      code: 'CONDO_UNITS_LOOKUP_PAGE_LIMIT',
      message: `Condominium Units bulk lookup exceeded the maximum of ${CONDO_UNITS_BULK_MAX_LOOKUP_PAGES} pages`,
      statusCode: 502,
    });
  }

  private async fetchRows(url: URL, operation: string): Promise<RawCondoUnitRow[]> {
    this.logger.debug({ operation, datasetId: CONDO_UNITS_DATASET_ID }, 'condo units request');

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
          code: 'CONDO_UNITS_REQUEST_TIMEOUT',
          message: `Condominium Units request timed out after ${this.timeoutMs}ms`,
          statusCode: 504,
          cause: error,
        });
      }

      throw error;
    }

    if (!response.ok) {
      throw new AppError({
        code: 'CONDO_UNITS_HTTP_ERROR',
        message: `Condominium Units request failed with HTTP ${response.status}`,
        statusCode: 502,
        cause: { status: response.status, statusText: response.statusText },
      });
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch (error) {
      throw new AppError({
        code: 'CONDO_UNITS_MALFORMED_RESPONSE',
        message: 'Condominium Units response was not valid JSON',
        statusCode: 502,
        cause: error,
      });
    }

    if (!Array.isArray(payload)) {
      throw new AppError({
        code: 'CONDO_UNITS_MALFORMED_RESPONSE',
        message: 'Condominium Units response must be a JSON array',
        statusCode: 502,
      });
    }

    return payload as RawCondoUnitRow[];
  }
}
