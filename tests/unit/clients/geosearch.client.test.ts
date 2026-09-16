import { createLogger } from '../../../src/logging/logger';
import {
  GeoSearchClient,
  createGeoSearchClient,
  type GeoSearchSearchResult,
} from '../../../src/clients/geosearch.client';
import { AppError } from '../../../src/errors';

type MockFetch = jest.MockedFunction<typeof fetch>;

function buildFeatureCollection(features: unknown[]): { type: 'FeatureCollection'; features: unknown[] } {
  return {
    type: 'FeatureCollection',
    features,
  };
}

function buildAddressFeature(options: {
  label: string;
  bbl?: string;
  bin?: string;
  confidence?: number;
  layer?: string;
  id?: string;
}): Record<string, unknown> {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [-73.9857, 40.7484],
    },
    properties: {
      id: options.id,
      label: options.label,
      name: options.label.split(',')[0],
      layer: options.layer ?? 'address',
      confidence: options.confidence ?? 0.9,
      borough: 'Manhattan',
      pad_bbl: options.bbl,
      pad_bin: options.bin,
    },
  };
}

describe('GeoSearchClient', () => {
  let fetchMock: MockFetch;

  beforeEach(() => {
    fetchMock = jest.fn() as MockFetch;
  });

  function createClient(overrides: Partial<ConstructorParameters<typeof GeoSearchClient>[0]> = {}) {
    return createGeoSearchClient({
      fetchFn: fetchMock,
      requestTimeoutMs: 5_000,
      ...overrides,
    });
  }

  it('converts a successful mocked response into typed candidates with identifier evidence', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        buildFeatureCollection([
          buildAddressFeature({
            id: 'feature-1',
            label: '120 BROADWAY, Manhattan, New York, NY, USA',
            bbl: '1000477501',
            bin: '1001234',
            confidence: 0.95,
          }),
        ]),
    } as Response);

    const client = createClient();
    const result = await client.searchByAddress('120 Broadway');

    expect(result).toEqual<GeoSearchSearchResult>({
      queriedAddress: '120 Broadway',
      candidates: [
        {
          label: '120 BROADWAY, Manhattan, New York, NY, USA',
          name: '120 BROADWAY',
          layer: 'address',
          confidence: 0.95,
          bbl: '1000477501',
          bin: '1001234',
          borough: 'Manhattan',
          coordinates: [-73.9857, 40.7484],
          sourceId: 'feature-1',
        },
      ],
    });
  });

  it('uses the exact normalized base address in request construction, including Queens hyphens', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        buildFeatureCollection([
          buildAddressFeature({
            label: '37-15 82ND STREET, Queens, New York, NY, USA',
            bbl: '4034560001',
            bin: '4045678',
          }),
        ]),
    } as Response);

    const client = createClient();
    await client.searchByAddress('37-15 82nd Street');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      'https://geosearch.planninglabs.nyc/v2/search?text=37-15+82nd+Street&size=10',
    );
  });

  it('returns multiple candidates without selecting a final property', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        buildFeatureCollection([
          buildAddressFeature({
            id: 'first',
            label: '120 BROADWAY, Manhattan, New York, NY, USA',
            bbl: '1000477501',
            bin: '1001234',
            confidence: 0.95,
          }),
          buildAddressFeature({
            id: 'second',
            label: '120 BROADWAY, Brooklyn, New York, NY, USA',
            bbl: '3000477501',
            bin: '3001234',
            confidence: 0.7,
          }),
        ]),
    } as Response);

    const client = createClient();
    const result = await client.searchByAddress('120 Broadway');

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.bbl)).toEqual(['1000477501', '3000477501']);
    expect(result).not.toHaveProperty('selectedCandidate');
    expect(result).not.toHaveProperty('bbl');
    expect(result).not.toHaveProperty('bin');
  });

  it('surfaces non-2xx responses as explicit client errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'unavailable' }),
    } as Response);

    const client = createClient();

    await expect(client.searchByAddress('120 Broadway')).rejects.toMatchObject({
      code: 'GEOSEARCH_HTTP_ERROR',
      statusCode: 503,
    });
  });

  it('surfaces request timeouts as explicit client errors', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValue(abortError);

    const client = createClient();

    await expect(client.searchByAddress('120 Broadway')).rejects.toMatchObject({
      code: 'GEOSEARCH_TIMEOUT',
    });
  });

  it('surfaces malformed JSON as explicit client errors', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);

    const client = createClient();

    await expect(client.searchByAddress('120 Broadway')).rejects.toMatchObject({
      code: 'GEOSEARCH_MALFORMED_RESPONSE',
    });
  });

  it('surfaces malformed response shape as explicit client errors', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'NotAFeatureCollection' }),
    } as Response);

    const client = createClient();

    await expect(client.searchByAddress('120 Broadway')).rejects.toMatchObject({
      code: 'GEOSEARCH_MALFORMED_RESPONSE',
    });
  });

  it('surfaces empty upstream results as explicit client errors', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildFeatureCollection([]),
    } as Response);

    const client = createClient();

    await expect(client.searchByAddress('120 Broadway')).rejects.toMatchObject({
      code: 'GEOSEARCH_EMPTY_RESULT',
    });
  });

  it('rejects blank normalized base addresses before calling GeoSearch', async () => {
    const client = createClient();

    await expect(client.searchByAddress('   ')).rejects.toBeInstanceOf(AppError);
    await expect(client.searchByAddress('   ')).rejects.toMatchObject({
      code: 'GEOSEARCH_INVALID_INPUT',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not log complete upstream payloads', async () => {
    const logLines: string[] = [];
    const logger = createLogger({
      write(message: string): void {
        logLines.push(message);
      },
    });

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        buildFeatureCollection([
          buildAddressFeature({
            label: '120 BROADWAY, Manhattan, New York, NY, USA',
            bbl: '1000477501',
            bin: '1001234',
          }),
        ]),
    } as Response);

    const client = createClient({ logger });
    await client.searchByAddress('120 Broadway');

    const output = logLines.join('');
    expect(output).not.toContain('1000477501');
    expect(output).not.toContain('1001234');
    expect(output).not.toContain('120 BROADWAY');
  });
});
