import { createLogger } from '../../../src/logging/logger';
import {
  BUILDING_FOOTPRINTS_DEFAULT_BASE_URL,
  BUILDING_FOOTPRINTS_ERROR_CODES,
  BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT,
  BUILDING_FOOTPRINTS_MAX_LOOKUP_PAGES,
  BuildingFootprintsClient,
} from '../../../src/clients/building-footprints.client';

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function createFetchMock(
  implementation: (url: string, init?: RequestInit) => Promise<MockResponse>,
): typeof fetch {
  return implementation as typeof fetch;
}

function footprintRecord(options: {
  bin: string | number;
  baseBbl: string | number;
  mapplutoBbl?: string | number | null;
}) {
  const record: Record<string, unknown> = {
    bin: options.bin,
    base_bbl: options.baseBbl,
  };

  if (options.mapplutoBbl !== undefined) {
    record.mappluto_bbl = options.mapplutoBbl;
  }

  return record;
}

describe('BuildingFootprintsClient', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('builds a bounded parcel lookup request matching base_bbl or mappluto_bbl', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [footprintRecord({ bin: '1000001', baseBbl: '1008350041' })],
    }));
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(fetchImpl),
      socrataAppToken: 'test-token',
    });

    await client.lookupByParcelBbl('1008350041');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = firstCall;
    const parsedUrl = new URL(url);

    expect(parsedUrl.origin + parsedUrl.pathname).toBe(BUILDING_FOOTPRINTS_DEFAULT_BASE_URL);
    expect(parsedUrl.searchParams.get('$select')).toBe('bin,base_bbl,mappluto_bbl');
    expect(parsedUrl.searchParams.get('$where')).toBe(
      "base_bbl='1008350041' OR mappluto_bbl='1008350041'",
    );
    expect(parsedUrl.searchParams.get('$order')).toBe('bin');
    expect(parsedUrl.searchParams.get('$limit')).toBe(
      String(BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT),
    );
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual(new Headers({ 'X-App-Token': 'test-token' }));
  });

  it('builds a bulk parcel lookup request using the live mappluto_bbl field', () => {
    const client = new BuildingFootprintsClient();

    const parsedUrl = new URL(
      client.buildBulkLookupUrl(['1008350041', '3035780050'], 'parcel', 100),
    );

    expect(parsedUrl.searchParams.get('$select')).toBe('bin,base_bbl,mappluto_bbl');
    expect(parsedUrl.searchParams.get('$where')).toBe(
      "base_bbl in ('1008350041','3035780050') OR mappluto_bbl in ('1008350041','3035780050')",
    );
  });

  it('builds a bounded base_bbl lookup request for condo resolution', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [footprintRecord({ bin: '1000001', baseBbl: '4130150045' })],
    }));
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(fetchImpl),
    });

    await client.lookupByBaseBbl('4130150045');

    const firstCall = fetchImpl.mock.calls[0] as unknown as [string];
    const parsedUrl = new URL(firstCall[0]);
    expect(parsedUrl.searchParams.get('$where')).toBe("base_bbl='4130150045'");
  });

  it('returns all footprint candidates for a multi-BIN lot', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          footprintRecord({ bin: '1088718', baseBbl: '3035780050', mapplutoBbl: '3035780050' }),
          footprintRecord({ bin: '1088719', baseBbl: '3035780050', mapplutoBbl: '3035780050' }),
        ],
      })),
    });

    const result = await client.lookupByParcelBbl('3035780050');

    expect(result).toEqual({
      status: 'found',
      queriedBbl: '3035780050',
      lookupMode: 'parcel',
      candidates: [
        {
          bin: '1088718',
          baseBbl: '3035780050',
          mapplutoBbl: '3035780050',
        },
        {
          bin: '1088719',
          baseBbl: '3035780050',
          mapplutoBbl: '3035780050',
        },
      ],
    });
  });

  it('preserves BASE_BBL and MAPPLUTO_BBL independently without cross-checking', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          footprintRecord({
            bin: '2019299',
            baseBbl: '2033800084',
            mapplutoBbl: '2033800099',
          }),
        ],
      })),
    });

    const result = await client.lookupByParcelBbl('2033800099');

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.candidates[0]).toEqual({
        bin: '2019299',
        baseBbl: '2033800084',
        mapplutoBbl: '2033800099',
      });
    }
  });

  it('leaves mapplutoBbl undefined when MAPPLUTO_BBL is absent', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [footprintRecord({ bin: '2019299', baseBbl: '2033800084' })],
      })),
    });

    const result = await client.lookupByBaseBbl('2033800084');

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.candidates[0]).toEqual({
        bin: '2019299',
        baseBbl: '2033800084',
      });
      expect(result.candidates[0]).not.toHaveProperty('mapplutoBbl');
    }
  });

  it('parses identifier strings without losing NYC zero padding', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          footprintRecord({
            bin: 1088718,
            baseBbl: 1008350041,
            mapplutoBbl: 1008350041,
          }),
        ],
      })),
    });

    const result = await client.lookupByParcelBbl('1008350041');

    expect(result).toEqual({
      status: 'found',
      queriedBbl: '1008350041',
      lookupMode: 'parcel',
      candidates: [
        {
          bin: '1088718',
          baseBbl: '1008350041',
          mapplutoBbl: '1008350041',
        },
      ],
    });
  });

  it('fetches additional pages when a lookup page is full', async () => {
    const fullPage = Array.from({ length: BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT }, (_, index) =>
      footprintRecord({
        bin: String(1_000_000 + index),
        baseBbl: '3035780050',
        mapplutoBbl: '3035780050',
      }),
    );
    const secondPage = [
      footprintRecord({ bin: '1088720', baseBbl: '3035780050', mapplutoBbl: '3035780050' }),
    ];
    const fetchImpl = jest.fn(async (url: string) => {
      const parsedUrl = new URL(url);
      const offset = Number(parsedUrl.searchParams.get('$offset') ?? '0');

      return {
        ok: true,
        status: 200,
        json: async () => (offset === 0 ? fullPage : secondPage),
      };
    });
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(fetchImpl),
    });

    const result = await client.lookupByParcelBbl('3035780050');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.candidates).toHaveLength(BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT + 1);
      expect(result.candidates.at(-1)).toEqual({
        bin: '1088720',
        baseBbl: '3035780050',
        mapplutoBbl: '3035780050',
      });
    }
  });

  it('rejects lookups that exceed the bounded page ceiling', async () => {
    const fullPage = Array.from({ length: BUILDING_FOOTPRINTS_LOOKUP_RESULT_LIMIT }, (_, index) =>
      footprintRecord({
        bin: String(2_000_000 + index),
        baseBbl: '3035780050',
      }),
    );
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => fullPage,
      })),
    });

    await expect(client.lookupByParcelBbl('3035780050')).rejects.toMatchObject({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.LOOKUP_PAGE_LIMIT,
    });
    expect(BUILDING_FOOTPRINTS_MAX_LOOKUP_PAGES).toBeGreaterThan(1);
  });

  it('preserves present-but-unparseable mappluto_bbl separately from a missing field', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          footprintRecord({
            bin: '2019299',
            baseBbl: '2033800084',
            mapplutoBbl: 'not-a-bbl',
          }),
        ],
      })),
    });

    const result = await client.lookupByParcelBbl('2033800084');

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.candidates[0]).toEqual({
        bin: '2019299',
        baseBbl: '2033800084',
        mapplutoBbl: null,
      });
    }
  });

  it('keeps parseable footprint rows when other rows have malformed identifiers', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { bin: 'not-a-bin', base_bbl: '3035780050' },
          footprintRecord({
            bin: '1088718',
            baseBbl: '3035780050',
            mapplutoBbl: '3035780050',
          }),
          footprintRecord({
            bin: '1088719',
            baseBbl: '3035780050',
            mapplutoBbl: '',
          }),
        ],
      })),
    });

    const result = await client.lookupByParcelBbl('3035780050');

    expect(result).toEqual({
      status: 'found',
      queriedBbl: '3035780050',
      lookupMode: 'parcel',
      candidates: [
        {
          bin: '1088718',
          baseBbl: '3035780050',
          mapplutoBbl: '3035780050',
        },
        {
          bin: '1088719',
          baseBbl: '3035780050',
          mapplutoBbl: null,
        },
      ],
    });
  });

  it('rejects short numeric identifier strings instead of zero-padding them', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          footprintRecord({
            bin: '123',
            baseBbl: '8350041',
            mapplutoBbl: '8350041',
          }),
        ],
      })),
    });

    await expect(client.lookupByParcelBbl('1008350041')).rejects.toMatchObject({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.MALFORMED_RESPONSE,
    });
  });

  it('returns not_found for an empty Building Footprints result set', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [],
      })),
    });

    await expect(client.lookupByParcelBbl('1008350041')).resolves.toEqual({
      status: 'not_found',
      queriedBbl: '1008350041',
      lookupMode: 'parcel',
    });
  });

  it('rejects malformed Building Footprints payloads explicitly', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: 'shape' }),
      })),
    });

    await expect(client.lookupByParcelBbl('1008350041')).rejects.toMatchObject({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.MALFORMED_RESPONSE,
    });
  });

  it('rejects responses with only malformed identifier records', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { bin: 'not-a-bin', base_bbl: '1008350041' },
          { bin: '1088718', base_bbl: 'invalid-bbl' },
        ],
      })),
    });

    await expect(client.lookupByParcelBbl('1008350041')).rejects.toMatchObject({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.MALFORMED_RESPONSE,
    });
  });

  it('surfaces non-2xx HTTP responses explicitly', async () => {
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: false,
        status: 503,
        json: async () => [],
      })),
    });

    await expect(client.lookupByParcelBbl('1008350041')).rejects.toMatchObject({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.HTTP_ERROR,
      statusCode: 503,
    });
  });

  it('surfaces request timeouts explicitly', async () => {
    jest.useFakeTimers();

    const client = new BuildingFootprintsClient({
      requestTimeoutMs: 25,
      fetchImpl: createFetchMock(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      ),
    });

    const lookupPromise = client.lookupByParcelBbl('1008350041');
    const expectation = expect(lookupPromise).rejects.toMatchObject({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.TIMEOUT,
    });

    await jest.advanceTimersByTimeAsync(25);
    await expectation;
  });

  it('rejects invalid BBL input before making a network request', async () => {
    const fetchImpl = jest.fn();
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(fetchImpl),
    });

    await expect(client.lookupByParcelBbl('not-a-bbl')).rejects.toMatchObject({
      code: BUILDING_FOOTPRINTS_ERROR_CODES.INVALID_BBL,
      statusCode: 400,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not log configured Socrata tokens', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      write(message: string): void {
        lines.push(message);
      },
    });
    const client = new BuildingFootprintsClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [footprintRecord({ bin: '1088718', baseBbl: '1008350041' })],
      })),
      socrataAppToken: 'secret-token',
      logger,
    });

    await client.lookupByParcelBbl('1008350041');

    const output = lines.join('');
    expect(output).not.toContain('secret-token');
  });
});
