import type { Logger } from 'pino';

import { CONFIG_DEFAULTS } from '../config/defaults';
import { SOCRATA_MAX_PAGE_LIMIT } from './condo-units.client';
import { AppError } from '../errors';
import {
  CanonicalBbl,
  CanonicalBin,
  canonicalizeBbl,
  canonicalizeBin,
} from '../schemas/property-identifiers.schema';

export const BUILDING_FOOTPRINTS_DATASET_RESOURCE_ID = '5zhs-2jue';
export const BUILDING_FOOTPRINTS_DEFAULT_BASE_URL = `https://data.cityofnewyork.us/resource/${BUILDING_FOOTPRINTS_DATASET_RESOURCE_ID}.json`;
export const BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT = 50;
export const BUILDING_FOOTPRINTS_MAX_LOOKUP_PAGES = 20;
export const BUILDING_FOOTPRINTS_BULK_LOOKUP_CHUNK_SIZE = 500;
export const BUILDING_FOOTPRINTS_BULK_BINS_PER_BBL_ESTIMATE = 50;
export const BUILDING_FOOTPRINTS_BULK_MAX_LOOKUP_PAGES = 20;
export const BUILDING_FOOTPRINTS_SELECT_FIELDS = 'bin,base_bbl,mpluto_bbl';

export const BUILDING_FOOTPRINTS_ERROR_CODES = {
  INVALID_BBL: 'BUILDING_FOOTPRINTS_INVALID_BBL',
  HTTP_ERROR: 'BUILDING_FOOTPRINTS_HTTP_ERROR',
  TIMEOUT: 'BUILDING_FOOTPRINTS_TIMEOUT',
  MALFORMED_RESPONSE: 'BUILDING_FOOTPRINTS_MALFORMED_RESPONSE',
  LOOKUP_PAGE_LIMIT: 'BUILDING_FOOTPRINTS_LOOKUP_PAGE_LIMIT',
} as const;

export type BuildingFootprintLookupMode = 'parcel' | 'base';

export type BuildingFootprintCandidate = {
  bin: CanonicalBin;
  baseBbl: CanonicalBbl;
  mapplutoBbl?: CanonicalBbl | null;
};

export type BuildingFootprintsLookupResult =
  | { status: 'not_found'; queriedBbl: CanonicalBbl; lookupMode: BuildingFootprintLookupMode }
  | {
      status: 'found';
      queriedBbl: CanonicalBbl;
      lookupMode: BuildingFootprintLookupMode;
      candidates: BuildingFootprintCandidate[];
    };

export type BuildingFootprintsClientDependencies = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
  socrataAppToken?: string;
  logger?: Logger;
};

type BuildingFootprintSourceRecord = Record<string, unknown>;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

const SOURCE_BBL_DIGITS_PATTERN = /^\d{10}$/;
const SOURCE_BIN_DIGITS_PATTERN = /^\d{7}$/;

function parseSourceBbl(value: unknown): CanonicalBbl | null {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = typeof value === 'number' ? String(value) : String(value).trim();
  if (raw.length === 0) {
    return null;
  }

  const integerPart = raw.split('.')[0];
  if (!SOURCE_BBL_DIGITS_PATTERN.test(integerPart)) {
    return null;
  }

  try {
    return canonicalizeBbl(integerPart);
  } catch {
    return null;
  }
}

function parseSourceBin(value: unknown): CanonicalBin | null {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = typeof value === 'number' ? String(value) : String(value).trim();
  if (raw.length === 0) {
    return null;
  }

  const integerPart = raw.split('.')[0];
  if (!SOURCE_BIN_DIGITS_PATTERN.test(integerPart)) {
    return null;
  }

  try {
    return canonicalizeBin(integerPart);
  } catch {
    return null;
  }
}

function parseMapplutoBblEvidence(
  record: BuildingFootprintSourceRecord,
): CanonicalBbl | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'mpluto_bbl')) {
    return undefined;
  }

  return parseSourceBbl(record.mpluto_bbl);
}

function parseBuildingFootprintCandidate(
  record: BuildingFootprintSourceRecord,
): BuildingFootprintCandidate | null {
  const bin = parseSourceBin(record.bin);
  const baseBbl = parseSourceBbl(record.base_bbl);

  if (bin === null || baseBbl === null) {
    return null;
  }

  const mapplutoBbl = parseMapplutoBblEvidence(record);
  if (mapplutoBbl === undefined) {
    return {
      bin,
      baseBbl,
    };
  }

  return {
    bin,
    baseBbl,
    mapplutoBbl,
  };
}

function assertJsonArray(payload: unknown): BuildingFootprintSourceRecord[] {
  if (!Array.isArray(payload)) {
    throw new AppError({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.MALFORMED_RESPONSE,
      message: 'Building Footprints response must be a JSON array',
    });
  }

  return payload as BuildingFootprintSourceRecord[];
}

function escapeSoqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function chunkValues<T>(values: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function buildWhereClause(bbl: CanonicalBbl, lookupMode: BuildingFootprintLookupMode): string {
  if (lookupMode === 'base') {
    return `base_bbl='${escapeSoqlString(bbl)}'`;
  }

  return `base_bbl='${escapeSoqlString(bbl)}' OR mpluto_bbl='${escapeSoqlString(bbl)}'`;
}

function bulkFootprintPageLimit(bblCount: number): number {
  return Math.min(
    SOCRATA_MAX_PAGE_LIMIT,
    Math.max(bblCount * BUILDING_FOOTPRINTS_BULK_BINS_PER_BBL_ESTIMATE, bblCount),
  );
}

function buildBulkWhereClause(
  bbls: readonly CanonicalBbl[],
  lookupMode: BuildingFootprintLookupMode,
): string {
  const quotedBbls = bbls.map((bbl) => `'${escapeSoqlString(bbl)}'`).join(',');

  if (lookupMode === 'base') {
    return `base_bbl in (${quotedBbls})`;
  }

  return `base_bbl in (${quotedBbls}) OR mpluto_bbl in (${quotedBbls})`;
}

export class BuildingFootprintsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly socrataAppToken?: string;
  private readonly logger?: Logger;

  constructor(dependencies: BuildingFootprintsClientDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.baseUrl = dependencies.baseUrl ?? BUILDING_FOOTPRINTS_DEFAULT_BASE_URL;
    this.requestTimeoutMs =
      dependencies.requestTimeoutMs ?? CONFIG_DEFAULTS.SOCRATA_REQUEST_TIMEOUT_MS;
    this.socrataAppToken = dependencies.socrataAppToken;
    this.logger = dependencies.logger;
  }

  buildLookupUrl(
    bbl: CanonicalBbl,
    lookupMode: BuildingFootprintLookupMode,
    offset = 0,
  ): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('$select', BUILDING_FOOTPRINTS_SELECT_FIELDS);
    url.searchParams.set('$where', buildWhereClause(bbl, lookupMode));
    url.searchParams.set('$order', 'bin');
    url.searchParams.set('$limit', String(BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT));
    if (offset > 0) {
      url.searchParams.set('$offset', String(offset));
    }
    return url.toString();
  }

  buildBulkLookupUrl(
    bbls: readonly CanonicalBbl[],
    lookupMode: BuildingFootprintLookupMode,
    pageLimit: number,
    offset = 0,
  ): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('$select', BUILDING_FOOTPRINTS_SELECT_FIELDS);
    url.searchParams.set('$where', buildBulkWhereClause(bbls, lookupMode));
    url.searchParams.set('$order', 'bin');
    url.searchParams.set('$limit', String(pageLimit));
    if (offset > 0) {
      url.searchParams.set('$offset', String(offset));
    }
    return url.toString();
  }

  async lookupByParcelBbl(bbl: string): Promise<BuildingFootprintsLookupResult> {
    return this.lookup(bbl, 'parcel');
  }

  async lookupByBaseBbl(baseBbl: string): Promise<BuildingFootprintsLookupResult> {
    return this.lookup(baseBbl, 'base');
  }

  async lookupByParcelBbls(
    bbls: readonly string[],
  ): Promise<Map<CanonicalBbl, BuildingFootprintsLookupResult>> {
    return this.lookupMany(bbls, 'parcel');
  }

  async lookupByBaseBbls(
    bbls: readonly string[],
  ): Promise<Map<CanonicalBbl, BuildingFootprintsLookupResult>> {
    return this.lookupMany(bbls, 'base');
  }

  private async lookupMany(
    bbls: readonly string[],
    lookupMode: BuildingFootprintLookupMode,
  ): Promise<Map<CanonicalBbl, BuildingFootprintsLookupResult>> {
    const canonicalBbls = [...new Set(bbls.map((bbl) => canonicalizeBbl(bbl)))].sort();
    const groupedCandidates = new Map<CanonicalBbl, BuildingFootprintCandidate[]>();

    for (const bbl of canonicalBbls) {
      groupedCandidates.set(bbl, []);
    }

    if (canonicalBbls.length === 0) {
      return new Map();
    }

    for (const chunk of chunkValues(canonicalBbls, BUILDING_FOOTPRINTS_BULK_LOOKUP_CHUNK_SIZE)) {
      const chunkCandidates = await this.fetchBulkLookupCandidates(chunk, lookupMode);
      for (const [bbl, candidates] of chunkCandidates) {
        groupedCandidates.get(bbl)?.push(...candidates);
      }
    }

    const results = new Map<CanonicalBbl, BuildingFootprintsLookupResult>();
    for (const bbl of canonicalBbls) {
      const candidates = groupedCandidates.get(bbl) ?? [];
      if (candidates.length === 0) {
        results.set(bbl, {
          status: 'not_found',
          queriedBbl: bbl,
          lookupMode,
        });
        continue;
      }

      results.set(bbl, {
        status: 'found',
        queriedBbl: bbl,
        lookupMode,
        candidates,
      });
    }

    return results;
  }

  private async fetchBulkLookupCandidates(
    bbls: readonly CanonicalBbl[],
    lookupMode: BuildingFootprintLookupMode,
  ): Promise<Map<CanonicalBbl, BuildingFootprintCandidate[]>> {
    const bblSet = new Set(bbls);
    const grouped = new Map<CanonicalBbl, BuildingFootprintCandidate[]>();
    for (const bbl of bbls) {
      grouped.set(bbl, []);
    }

    const headers = new Headers();
    if (this.socrataAppToken) {
      headers.set('X-App-Token', this.socrataAppToken);
    }

    const pageLimit = bulkFootprintPageLimit(bbls.length);

    this.logger?.debug(
      {
        dataset: BUILDING_FOOTPRINTS_DATASET_RESOURCE_ID,
        bblCount: bbls.length,
        lookupMode,
        pageLimit,
      },
      'building footprints bulk lookup request',
    );

    try {
      for (let pageIndex = 0; pageIndex < BUILDING_FOOTPRINTS_BULK_MAX_LOOKUP_PAGES; pageIndex += 1) {
        const offset = pageIndex * pageLimit;
        const url = this.buildBulkLookupUrl(bbls, lookupMode, pageLimit, offset);
        const pageRecords = await this.fetchLookupPageWithTimeout(url, headers);
        const candidates = pageRecords
          .map((record) => parseBuildingFootprintCandidate(record))
          .filter((candidate): candidate is BuildingFootprintCandidate => candidate !== null);

        for (const candidate of candidates) {
          if (lookupMode === 'base') {
            if (bblSet.has(candidate.baseBbl)) {
              grouped.get(candidate.baseBbl)?.push(candidate);
            }
            continue;
          }

          if (bblSet.has(candidate.baseBbl)) {
            grouped.get(candidate.baseBbl)?.push(candidate);
          }

          if (candidate.mapplutoBbl !== undefined && candidate.mapplutoBbl !== null) {
            if (bblSet.has(candidate.mapplutoBbl)) {
              grouped.get(candidate.mapplutoBbl)?.push(candidate);
            }
          }
        }

        if (pageRecords.length < pageLimit) {
          break;
        }

        if (pageIndex === BUILDING_FOOTPRINTS_BULK_MAX_LOOKUP_PAGES - 1) {
          throw new AppError({
            code: BUILDING_FOOTPRINTS_ERROR_CODES.LOOKUP_PAGE_LIMIT,
            message: `Building Footprints bulk lookup exceeded the maximum of ${BUILDING_FOOTPRINTS_BULK_MAX_LOOKUP_PAGES} pages`,
          });
        }
      }

      return grouped;
    } catch (error) {
      if (isAbortError(error)) {
        throw new AppError({
          code: BUILDING_FOOTPRINTS_ERROR_CODES.TIMEOUT,
          message: `Building Footprints request timed out after ${this.requestTimeoutMs}ms`,
          cause: error,
        });
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError({
        code: BUILDING_FOOTPRINTS_ERROR_CODES.HTTP_ERROR,
        message: 'Building Footprints request failed',
        cause: error,
      });
    }
  }

  private async lookup(
    bbl: string,
    lookupMode: BuildingFootprintLookupMode,
  ): Promise<BuildingFootprintsLookupResult> {
    let canonicalBbl: CanonicalBbl;

    try {
      canonicalBbl = canonicalizeBbl(bbl);
    } catch (error) {
      throw new AppError({
        code: BUILDING_FOOTPRINTS_ERROR_CODES.INVALID_BBL,
        message: 'Building Footprints lookup requires a canonical 10-digit BBL',
        statusCode: 400,
        cause: error,
      });
    }

    const headers = new Headers();

    if (this.socrataAppToken) {
      headers.set('X-App-Token', this.socrataAppToken);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    this.logger?.debug(
      {
        dataset: BUILDING_FOOTPRINTS_DATASET_RESOURCE_ID,
        bbl: canonicalBbl,
        lookupMode,
      },
      'building footprints lookup request',
    );

    try {
      const records = await this.fetchAllLookupRecords(canonicalBbl, lookupMode, headers, controller.signal);

      if (records.length === 0) {
        return {
          status: 'not_found',
          queriedBbl: canonicalBbl,
          lookupMode,
        };
      }

      const candidates = records
        .map((record) => parseBuildingFootprintCandidate(record))
        .filter((candidate): candidate is BuildingFootprintCandidate => candidate !== null);

      if (candidates.length === 0) {
        throw new AppError({
          code: BUILDING_FOOTPRINTS_ERROR_CODES.MALFORMED_RESPONSE,
          message: 'Building Footprints response did not contain any parseable footprint records',
        });
      }

      return {
        status: 'found',
        queriedBbl: canonicalBbl,
        lookupMode,
        candidates,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new AppError({
          code: BUILDING_FOOTPRINTS_ERROR_CODES.TIMEOUT,
          message: `Building Footprints request timed out after ${this.requestTimeoutMs}ms`,
          cause: error,
        });
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError({
        code: BUILDING_FOOTPRINTS_ERROR_CODES.HTTP_ERROR,
        message: 'Building Footprints request failed',
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchAllLookupRecords(
    canonicalBbl: CanonicalBbl,
    lookupMode: BuildingFootprintLookupMode,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<BuildingFootprintSourceRecord[]> {
    const records: BuildingFootprintSourceRecord[] = [];

    for (let pageIndex = 0; pageIndex < BUILDING_FOOTPRINTS_MAX_LOOKUP_PAGES; pageIndex += 1) {
      const offset = pageIndex * BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT;
      const url = this.buildLookupUrl(canonicalBbl, lookupMode, offset);
      const pageRecords = await this.fetchLookupPage(url, headers, signal);
      records.push(...pageRecords);

      if (pageRecords.length < BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT) {
        return records;
      }
    }

    throw new AppError({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.LOOKUP_PAGE_LIMIT,
      message: `Building Footprints lookup exceeded the maximum of ${BUILDING_FOOTPRINTS_MAX_LOOKUP_PAGES} pages`,
    });
  }

  private async fetchLookupPageWithTimeout(
    url: string,
    headers: Headers,
  ): Promise<BuildingFootprintSourceRecord[]> {
    return this.fetchLookupPage(url, headers, AbortSignal.timeout(this.requestTimeoutMs));
  }

  private async fetchLookupPage(
    url: string,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<BuildingFootprintSourceRecord[]> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      signal,
    });

    if (!response.ok) {
      throw new AppError({
        code: BUILDING_FOOTPRINTS_ERROR_CODES.HTTP_ERROR,
        message: `Building Footprints request failed with status ${response.status}`,
        statusCode: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AppError({
        code: BUILDING_FOOTPRINTS_ERROR_CODES.MALFORMED_RESPONSE,
        message: 'Building Footprints response was not valid JSON',
        cause: error,
      });
    }

    return assertJsonArray(payload);
  }
}
