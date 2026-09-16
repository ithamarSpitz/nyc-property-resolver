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

export const PLUTO_ERROR_CODES = {
  INVALID_BBL: 'PLUTO_INVALID_BBL',
  HTTP_ERROR: 'PLUTO_HTTP_ERROR',
  TIMEOUT: 'PLUTO_TIMEOUT',
  MALFORMED_RESPONSE: 'PLUTO_MALFORMED_RESPONSE',
} as const;

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

function parsePlutoParcelRecord(record: PlutoSourceRecord): PlutoParcelRecord | null {
  const bbl = parseSourceBbl(record.bbl);
  const borough = parseSourceInteger(record.borocode);
  const block = parseSourceInteger(record.block);
  const lot = parseSourceInteger(record.lot);
  const address = parseSourceAddress(record.address);

  if (bbl === null || borough === null || block === null || lot === null || address === null) {
    return null;
  }

  const components = parseBblComponents(bbl);
  if (
    components.borough !== borough ||
    components.block !== block ||
    components.lot !== lot
  ) {
    return null;
  }

  return {
    bbl,
    borough,
    block,
    lot,
    address,
    bldgclass: parseSourceBldgclass(record.bldgclass),
  };
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
      if (records.length === 0) {
        return { status: 'not_found' };
      }

      const parcels = records
        .map((record) => parsePlutoParcelRecord(record))
        .filter((parcel): parcel is PlutoParcelRecord => parcel !== null);

      if (parcels.length === 0) {
        throw new AppError({
          code: PLUTO_ERROR_CODES.MALFORMED_RESPONSE,
          message: 'PLUTO response did not contain any parseable parcel records',
        });
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
