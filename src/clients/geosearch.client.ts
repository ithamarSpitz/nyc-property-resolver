import { z } from 'zod';

import { CONFIG_DEFAULTS } from '../config/defaults';
import { getConfig } from '../config';
import { AppError } from '../errors';
import type { Logger } from 'pino';

import { getLogger } from '../logging/logger';

const DEFAULT_BASE_URL = 'https://geosearch.planninglabs.nyc';
const DEFAULT_SEARCH_SIZE = 10;

const geosearchFeatureSchema = z
  .object({
    type: z.literal('Feature'),
    geometry: z
      .object({
        type: z.string(),
        coordinates: z.array(z.number()).optional(),
      })
      .passthrough()
      .optional(),
    properties: z.record(z.unknown()).optional(),
  })
  .passthrough();

const geosearchResponseSchema = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z.array(geosearchFeatureSchema),
  })
  .passthrough();

type GeoSearchFeature = z.infer<typeof geosearchFeatureSchema>;

export type GeoSearchCandidate = {
  label: string;
  name?: string;
  layer: string;
  confidence?: number;
  bbl?: string;
  bin?: string;
  borough?: string;
  coordinates?: [number, number];
  sourceId?: string;
};

export type GeoSearchSearchResult = {
  queriedAddress: string;
  candidates: GeoSearchCandidate[];
};

export type GeoSearchClientOptions = {
  baseUrl?: string;
  requestTimeoutMs?: number;
  searchSize?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
  signal?: AbortSignal;
};

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceIdentifier(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  return undefined;
}

function coerceConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function extractPadIdentifier(
  properties: Record<string, unknown>,
  field: 'bbl' | 'bin',
): string | undefined {
  const direct = coerceIdentifier(properties[`pad_${field}`]);
  if (direct !== undefined) {
    return direct;
  }

  const addendum = properties.addendum;
  if (!addendum || typeof addendum !== 'object') {
    return undefined;
  }

  const pad = (addendum as Record<string, unknown>).pad;
  if (!pad || typeof pad !== 'object') {
    return undefined;
  }

  return coerceIdentifier((pad as Record<string, unknown>)[field]);
}

function parseCandidate(feature: GeoSearchFeature): GeoSearchCandidate | null {
  const properties = feature.properties ?? {};
  const label = coerceString(properties.label) ?? coerceString(properties.name);
  if (label === undefined) {
    return null;
  }

  const coordinates = feature.geometry?.coordinates;
  let parsedCoordinates: [number, number] | undefined;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    parsedCoordinates = [coordinates[0], coordinates[1]];
  }

  return {
    label,
    name: coerceString(properties.name),
    layer: coerceString(properties.layer) ?? 'unknown',
    confidence: coerceConfidence(properties.confidence),
    bbl: extractPadIdentifier(properties, 'bbl'),
    bin: extractPadIdentifier(properties, 'bin'),
    borough: coerceString(properties.borough),
    coordinates: parsedCoordinates,
    sourceId: coerceString(properties.id) ?? coerceString(properties.gid),
  };
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

function buildSearchUrl(baseUrl: string, normalizedBaseAddress: string, searchSize: number): string {
  const url = new URL('/v2/search', baseUrl);
  url.searchParams.set('text', normalizedBaseAddress);
  url.searchParams.set('size', String(searchSize));
  return url.toString();
}

export class GeoSearchClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly searchSize: number;
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;
  private readonly signal?: AbortSignal;

  constructor(options: GeoSearchClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? getConfig().socrataRequestTimeoutMs ?? CONFIG_DEFAULTS.SOCRATA_REQUEST_TIMEOUT_MS;
    this.searchSize = options.searchSize ?? DEFAULT_SEARCH_SIZE;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger ?? getLogger();
    this.signal = options.signal;
  }

  async searchByAddress(normalizedBaseAddress: string): Promise<GeoSearchSearchResult> {
    const trimmedAddress = normalizedBaseAddress.trim();
    if (trimmedAddress.length === 0) {
      throw new AppError({
        code: 'GEOSEARCH_INVALID_INPUT',
        message: 'GeoSearch requires a non-empty normalized base address',
        statusCode: 400,
      });
    }

    const requestUrl = buildSearchUrl(this.baseUrl, trimmedAddress, this.searchSize);
    this.logger.debug(
      {
        client: 'geosearch',
        operation: 'search',
        addressLength: trimmedAddress.length,
        searchSize: this.searchSize,
      },
      'geosearch search requested',
    );

    let response: Response;
    try {
      response = await this.fetchFn(requestUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: this.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new AppError({
          code: 'GEOSEARCH_TIMEOUT',
          message: `GeoSearch request timed out after ${this.requestTimeoutMs}ms`,
          cause: error,
        });
      }

      throw new AppError({
        code: 'GEOSEARCH_REQUEST_FAILED',
        message: 'GeoSearch request failed before a response was received',
        cause: error,
      });
    }

    if (!response.ok) {
      throw new AppError({
        code: 'GEOSEARCH_HTTP_ERROR',
        message: `GeoSearch returned HTTP ${response.status}`,
        statusCode: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AppError({
        code: 'GEOSEARCH_MALFORMED_RESPONSE',
        message: 'GeoSearch response was not valid JSON',
        cause: error,
      });
    }

    const parsed = geosearchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError({
        code: 'GEOSEARCH_MALFORMED_RESPONSE',
        message: 'GeoSearch response did not match the expected GeoJSON FeatureCollection shape',
        cause: parsed.error,
      });
    }

    if (parsed.data.features.length === 0) {
      throw new AppError({
        code: 'GEOSEARCH_EMPTY_RESULT',
        message: 'GeoSearch returned no address candidates for the normalized base address',
      });
    }

    const candidates = parsed.data.features
      .map((feature) => parseCandidate(feature))
      .filter((candidate): candidate is GeoSearchCandidate => candidate !== null);

    if (candidates.length === 0) {
      throw new AppError({
        code: 'GEOSEARCH_MALFORMED_RESPONSE',
        message: 'GeoSearch returned features without usable candidate labels',
      });
    }

    this.logger.debug(
      {
        client: 'geosearch',
        operation: 'search',
        candidateCount: candidates.length,
      },
      'geosearch search completed',
    );

    return {
      queriedAddress: trimmedAddress,
      candidates,
    };
  }
}

export function createGeoSearchClient(options?: GeoSearchClientOptions): GeoSearchClient {
  return new GeoSearchClient(options);
}
