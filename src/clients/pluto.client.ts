import type { Logger } from 'pino';

import { CONFIG_DEFAULTS } from '../config/defaults';
import { AppError } from '../errors';
import {
  CanonicalBbl,
  canonicalizeBbl,
  parseBblComponents,
} from '../schemas/property-identifiers.schema';

export const PLUTO_DATASET_RESOURCE_ID = '64uk-42ks';
export const PLUTO_DEFAULT_BASE_URL = `https://data.cityofnewyork.us/resource/${PLUTO_DATASET_RESOURCE_ID}.json`;
export const PLUTO_LOOKUP_RESULT_LIMIT = 2;
export const PLUTO_BULK_LOOKUP_CHUNK_SIZE = 500;

export const PLUTO_ERROR_CODES = {
  INVALID_BBL: 'PLUTO_INVALID_BBL',
  HTTP_ERROR: 'PLUTO_HTTP_ERROR',
  TIMEOUT: 'PLUTO_TIMEOUT',
  MALFORMED_RESPONSE: 'PLUTO_MALFORMED_RESPONSE',
} as const;

export type PlutoIncompleteReason =
  | 'missing_address'
  | 'missing_bbl'
  | 'missing_borocode'
  | 'missing_block'
  | 'missing_lot'
  | 'identifier_mismatch';

export type PlutoParcelRecord = {
  bbl: CanonicalBbl;
  borough: number;
  block: number;
  lot: number;
  address: string;
  bldgclass: string | null;
};

export type PlutoLookupResult =
  | { status: 'not_found' }
  | { status: 'incomplete'; reasons: PlutoIncompleteReason[] }
  | { status: 'found'; parcel: PlutoParcelRecord }
  | { status: 'multiple'; parcels: PlutoParcelRecord[] };

export type PlutoClientDependencies = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
  socrataAppToken?: string;
  logger?: Logger;
};

type PlutoSourceRecord = Record<string, unknown>;

type PlutoRecordAssessment =
  | { kind: 'complete'; parcel: PlutoParcelRecord }
  | { kind: 'incomplete'; reasons: PlutoIncompleteReason[]; rawBbl: CanonicalBbl | null };

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function parseSourceInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value).trim();
  if (raw.length === 0) {
    return null;
  }

  const integerPart = raw.split('.')[0];
  if (!/^\d+$/.test(integerPart)) {
    return null;
  }

  const parsed = Number.parseInt(integerPart, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSourceBbl(value: unknown): CanonicalBbl | null {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = typeof value === 'number' ? String(value) : String(value).trim();
  if (raw.length === 0) {
    return null;
  }

  const integerPart = raw.split('.')[0];
  if (!/^\d+$/.test(integerPart)) {
    return null;
  }

  try {
    return canonicalizeBbl(integerPart.padStart(10, '0'));
  } catch {
    return null;
  }
}

function parseSourceAddress(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSourceBldgclass(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeIncompleteReasons(
  left: readonly PlutoIncompleteReason[],
  right: readonly PlutoIncompleteReason[],
): PlutoIncompleteReason[] {
  return [...new Set([...left, ...right])];
}

export function assessPlutoRecord(record: PlutoSourceRecord): PlutoRecordAssessment {
  const reasons: PlutoIncompleteReason[] = [];
  const bbl = parseSourceBbl(record.bbl);
  const borough = parseSourceInteger(record.borocode);
  const block = parseSourceInteger(record.block);
  const lot = parseSourceInteger(record.lot);
  const address = parseSourceAddress(record.address);

  if (bbl === null) {
    reasons.push('missing_bbl');
  }
  if (borough === null) {
    reasons.push('missing_borocode');
  }
  if (block === null) {
    reasons.push('missing_block');
  }
  if (lot === null) {
    reasons.push('missing_lot');
  }
  if (address === null) {
    reasons.push('missing_address');
  }

  if (bbl !== null && borough !== null && block !== null && lot !== null) {
    const components = parseBblComponents(bbl);
    if (
      components.borough !== borough ||
      components.block !== block ||
      components.lot !== lot
    ) {
      reasons.push('identifier_mismatch');
    }
  }

  if (reasons.length > 0) {
    return {
      kind: 'incomplete',
      reasons,
      rawBbl: bbl,
    };
  }

  return {
    kind: 'complete',
    parcel: {
      bbl: bbl!,
      borough: borough!,
      block: block!,
      lot: lot!,
      address: address!,
      bldgclass: parseSourceBldgclass(record.bldgclass),
    },
  };
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

function classifyPlutoParcels(parcels: PlutoParcelRecord[]): PlutoLookupResult {
  if (parcels.length === 0) {
    return { status: 'not_found' };
  }

  if (parcels.length === 1) {
    return {
      status: 'found',
      parcel: parcels[0],
    };
  }

  return {
    status: 'multiple',
    parcels,
  };
}

function classifyRawPlutoRecords(records: readonly PlutoSourceRecord[]): PlutoLookupResult {
  const parcels: PlutoParcelRecord[] = [];
  let incompleteReasons: PlutoIncompleteReason[] = [];

  for (const record of records) {
    const assessment = assessPlutoRecord(record);
    if (assessment.kind === 'complete') {
      parcels.push(assessment.parcel);
      continue;
    }

    incompleteReasons = mergeIncompleteReasons(incompleteReasons, assessment.reasons);
  }

  if (parcels.length > 0) {
    return classifyPlutoParcels(parcels);
  }

  if (incompleteReasons.length > 0) {
    return {
      status: 'incomplete',
      reasons: incompleteReasons,
    };
  }

  return { status: 'not_found' };
}

function classifyBulkPlutoLookup(
  _bbl: CanonicalBbl,
  parcels: readonly PlutoParcelRecord[],
  incompleteReasons: readonly PlutoIncompleteReason[],
): PlutoLookupResult {
  if (parcels.length > 0) {
    return classifyPlutoParcels([...parcels]);
  }

  if (incompleteReasons.length > 0) {
    return {
      status: 'incomplete',
      reasons: [...incompleteReasons],
    };
  }

  return { status: 'not_found' };
}

function assertJsonArray(payload: unknown): PlutoSourceRecord[] {
  if (!Array.isArray(payload)) {
    throw new AppError({
      code: PLUTO_ERROR_CODES.MALFORMED_RESPONSE,
      message: 'PLUTO response must be a JSON array',
    });
  }

  return payload as PlutoSourceRecord[];
}

export class PlutoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly socrataAppToken?: string;
  private readonly logger?: Logger;

  constructor(dependencies: PlutoClientDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.baseUrl = dependencies.baseUrl ?? PLUTO_DEFAULT_BASE_URL;
    this.requestTimeoutMs =
      dependencies.requestTimeoutMs ?? CONFIG_DEFAULTS.SOCRATA_REQUEST_TIMEOUT_MS;
    this.socrataAppToken = dependencies.socrataAppToken;
    this.logger = dependencies.logger;
  }

  buildLookupUrl(bbl: CanonicalBbl): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('bbl', bbl);
    url.searchParams.set('$limit', String(PLUTO_LOOKUP_RESULT_LIMIT));
    return url.toString();
  }

  buildBulkLookupUrl(bbls: readonly CanonicalBbl[]): string {
    const quotedBbls = bbls.map((bbl) => `'${escapeSoqlString(bbl)}'`).join(',');
    const url = new URL(this.baseUrl);
    url.searchParams.set('$where', `bbl in (${quotedBbls})`);
    url.searchParams.set('$order', 'bbl');
    url.searchParams.set('$limit', String(Math.max(bbls.length * PLUTO_LOOKUP_RESULT_LIMIT, bbls.length)));
    return url.toString();
  }

  async lookupByBbl(bbl: string): Promise<PlutoLookupResult> {
    let canonicalBbl: CanonicalBbl;

    try {
      canonicalBbl = canonicalizeBbl(bbl);
    } catch (error) {
      throw new AppError({
        code: PLUTO_ERROR_CODES.INVALID_BBL,
        message: 'PLUTO lookup requires a canonical 10-digit BBL',
        statusCode: 400,
        cause: error,
      });
    }

    const url = this.buildLookupUrl(canonicalBbl);
    const headers = new Headers();

    if (this.socrataAppToken) {
      headers.set('X-App-Token', this.socrataAppToken);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    this.logger?.debug(
      {
        dataset: PLUTO_DATASET_RESOURCE_ID,
        bbl: canonicalBbl,
      },
      'pluto lookup request',
    );

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AppError({
          code: PLUTO_ERROR_CODES.HTTP_ERROR,
          message: `PLUTO request failed with status ${response.status}`,
          statusCode: response.status,
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new AppError({
          code: PLUTO_ERROR_CODES.MALFORMED_RESPONSE,
          message: 'PLUTO response was not valid JSON',
          cause: error,
        });
      }

      const records = assertJsonArray(payload);
      return classifyRawPlutoRecords(records);
    } catch (error) {
      if (isAbortError(error)) {
        throw new AppError({
          code: PLUTO_ERROR_CODES.TIMEOUT,
          message: `PLUTO request timed out after ${this.requestTimeoutMs}ms`,
          cause: error,
        });
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError({
        code: PLUTO_ERROR_CODES.HTTP_ERROR,
        message: 'PLUTO request failed',
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async lookupByBbls(bbls: readonly string[]): Promise<Map<CanonicalBbl, PlutoLookupResult>> {
    const canonicalBbls = [...new Set(bbls.map((bbl) => canonicalizeBbl(bbl)))].sort();
    const results = new Map<CanonicalBbl, PlutoLookupResult>();

    if (canonicalBbls.length === 0) {
      return results;
    }

    for (const chunk of chunkValues(canonicalBbls, PLUTO_BULK_LOOKUP_CHUNK_SIZE)) {
      const chunkResults = await this.lookupByBblChunk(chunk);
      for (const [bbl, lookup] of chunkResults) {
        results.set(bbl, lookup);
      }
    }

    for (const bbl of canonicalBbls) {
      if (!results.has(bbl)) {
        results.set(bbl, { status: 'not_found' });
      }
    }

    return results;
  }

  private async lookupByBblChunk(
    bbls: readonly CanonicalBbl[],
  ): Promise<Map<CanonicalBbl, PlutoLookupResult>> {
    const url = this.buildBulkLookupUrl(bbls);
    const headers = new Headers();

    if (this.socrataAppToken) {
      headers.set('X-App-Token', this.socrataAppToken);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    this.logger?.debug(
      {
        dataset: PLUTO_DATASET_RESOURCE_ID,
        bblCount: bbls.length,
      },
      'pluto bulk lookup request',
    );

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AppError({
          code: PLUTO_ERROR_CODES.HTTP_ERROR,
          message: `PLUTO request failed with status ${response.status}`,
          statusCode: response.status,
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new AppError({
          code: PLUTO_ERROR_CODES.MALFORMED_RESPONSE,
          message: 'PLUTO response was not valid JSON',
          cause: error,
        });
      }

      const records = assertJsonArray(payload);
      const parcelsByBbl = new Map<CanonicalBbl, PlutoParcelRecord[]>();
      const incompleteByBbl = new Map<CanonicalBbl, PlutoIncompleteReason[]>();

      for (const record of records) {
        const assessment = assessPlutoRecord(record);
        if (assessment.kind === 'complete') {
          const existing = parcelsByBbl.get(assessment.parcel.bbl) ?? [];
          existing.push(assessment.parcel);
          parcelsByBbl.set(assessment.parcel.bbl, existing);
          continue;
        }

        if (assessment.rawBbl === null) {
          continue;
        }

        const existingReasons = incompleteByBbl.get(assessment.rawBbl) ?? [];
        incompleteByBbl.set(
          assessment.rawBbl,
          mergeIncompleteReasons(existingReasons, assessment.reasons),
        );
      }

      const chunkResults = new Map<CanonicalBbl, PlutoLookupResult>();
      for (const bbl of bbls) {
        chunkResults.set(
          bbl,
          classifyBulkPlutoLookup(
            bbl,
            parcelsByBbl.get(bbl) ?? [],
            incompleteByBbl.get(bbl) ?? [],
          ),
        );
      }

      return chunkResults;
    } catch (error) {
      if (isAbortError(error)) {
        throw new AppError({
          code: PLUTO_ERROR_CODES.TIMEOUT,
          message: `PLUTO request timed out after ${this.requestTimeoutMs}ms`,
          cause: error,
        });
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError({
        code: PLUTO_ERROR_CODES.HTTP_ERROR,
        message: 'PLUTO request failed',
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
