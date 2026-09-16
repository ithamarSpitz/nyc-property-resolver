import { AppError } from '../../../src/errors';
import {
  CONDO_UNITS_DATASET_ID,
  CondoUnitsClient,
  DEFAULT_NYC_OPEN_DATA_BASE_URL,
} from '../../../src/clients/condo-units.client';

const TEST_BASE_URL = 'https://example.test/resource';
const TEST_TIMEOUT_MS = 5_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function createClient(fetchImpl: FetchImpl): CondoUnitsClient {
  return new CondoUnitsClient({
    fetchImpl,
    baseUrl: TEST_BASE_URL,
    timeoutMs: TEST_TIMEOUT_MS,
    appToken: 'test-token',
    lookupLimit: 25,
    config: {
      socrataRequestTimeoutMs: TEST_TIMEOUT_MS,
      socrataAppToken: 'test-token',
    },
  });
}

function parseRequestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  return new URL(typeof input === 'string' ? input : input.toString());
}

describe('CondoUnitsClient', () => {
  describe('lookupByUnitBbl', () => {
    it('builds an exact unit_bbl request against the Condominium Units dataset', async () => {
      const fetchImpl = jest.fn(async (input, init) => {
        const url = parseRequestUrl(input);

        expect(url.origin + url.pathname).toBe(
          `${TEST_BASE_URL}/${CONDO_UNITS_DATASET_ID}.json`,
        );
        expect(url.searchParams.get('$select')).toBe('unit_bbl,condo_base_bbl,unit_designation');
        expect(url.searchParams.get('$where')).toBe("unit_bbl='1012345678'");
        expect(url.searchParams.get('$order')).toBe('unit_bbl ASC');
        expect(url.searchParams.get('$limit')).toBe('25');
        expect(init?.headers).toMatchObject({
          Accept: 'application/json',
          'X-App-Token': 'test-token',
        });

        return jsonResponse([
          {
            unit_bbl: '1012345678',
            condo_base_bbl: '1010060001',
            unit_designation: '12C',
          },
        ]);
      });

      const client = createClient(fetchImpl);
      const result = await client.lookupByUnitBbl('1012345678');

      expect(result).toEqual({
        matchCount: 'one',
        matches: [
          {
            unitBbl: '1012345678',
            condoBaseBbl: '1010060001',
            unitDesignation: '12C',
          },
        ],
      });
    });

    it('preserves BBL zero padding when the source returns numeric identifiers', async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse([
          {
            unit_bbl: 1008350041,
            condo_base_bbl: 1008350001,
            unit_designation: '4A',
          },
        ]),
      );

      const client = createClient(fetchImpl);
      const result = await client.lookupByUnitBbl('1008350041');

      expect(result.matchCount).toBe('one');
      if (result.matchCount === 'one') {
        expect(result.matches[0]).toEqual({
          unitBbl: '1008350041',
          condoBaseBbl: '1008350001',
          unitDesignation: '4A',
        });
      }
    });

    it('returns zero matches without fabricating a condo base BBL', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse([]));
      const client = createClient(fetchImpl);

      await expect(client.lookupByUnitBbl('1012345678')).resolves.toEqual({
        matchCount: 'zero',
        matches: [],
      });
    });

    it('returns multiple matches without selecting one arbitrarily', async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse([
          {
            unit_bbl: '1012345678',
            condo_base_bbl: '1010060001',
            unit_designation: '12C',
          },
          {
            unit_bbl: '1012345679',
            condo_base_bbl: '1010060002',
            unit_designation: '12D',
          },
        ]),
      );

      const client = createClient(fetchImpl);
      const result = await client.lookupByUnitBbl('1012345678');

      expect(result.matchCount).toBe('multiple');
      if (result.matchCount === 'multiple') {
        expect(result.matches).toHaveLength(2);
        expect(result.matches.map((match) => match.unitBbl)).toEqual(['1012345678', '1012345679']);
      }
    });
  });

  describe('lookupByCondoBaseAndUnitDesignation', () => {
    it('filters by condo base context and unit designation', async () => {
      const fetchImpl = jest.fn(async (input) => {
        const url = parseRequestUrl(input);

        expect(url.searchParams.get('$where')).toBe(
          "condo_base_bbl='1010060001' AND unit_designation='12C'",
        );

        return jsonResponse([
          {
            unit_bbl: '1012345678',
            condo_base_bbl: '1010060001',
            unit_designation: '12C',
          },
        ]);
      });

      const client = createClient(fetchImpl);
      const result = await client.lookupByCondoBaseAndUnitDesignation('1010060001', '12C');

      expect(result).toEqual({
        matchCount: 'one',
        matches: [
          {
            unitBbl: '1012345678',
            condoBaseBbl: '1010060001',
            unitDesignation: '12C',
          },
        ],
      });
    });

    it('escapes single quotes in unit designations for SoQL', async () => {
      const fetchImpl = jest.fn(async (input) => {
        const url = parseRequestUrl(input);

        expect(url.searchParams.get('$where')).toBe(
          "condo_base_bbl='1010060001' AND unit_designation='PH''A'",
        );

        return jsonResponse([]);
      });

      const client = createClient(fetchImpl);
      await client.lookupByCondoBaseAndUnitDesignation('1010060001', "PH'A");

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('returns zero matches when the unit designation is unmatched', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse([]));
      const client = createClient(fetchImpl);

      await expect(
        client.lookupByCondoBaseAndUnitDesignation('1010060001', '99Z'),
      ).resolves.toEqual({
        matchCount: 'zero',
        matches: [],
      });
    });

    it('returns multiple matches when the designation is ambiguous in the condo context', async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse([
          {
            unit_bbl: '1012345678',
            condo_base_bbl: '1010060001',
            unit_designation: '12C',
          },
          {
            unit_bbl: '1012345679',
            condo_base_bbl: '1010060001',
            unit_designation: '12C',
          },
        ]),
      );

      const client = createClient(fetchImpl);
      const result = await client.lookupByCondoBaseAndUnitDesignation('1010060001', '12C');

      expect(result.matchCount).toBe('multiple');
      if (result.matchCount === 'multiple') {
        expect(result.matches).toHaveLength(2);
        expect(result.matches.every((match) => match.unitDesignation === '12C')).toBe(true);
      }
    });

    it('rejects blank unit designations before calling the source', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse([]));
      const client = createClient(fetchImpl);

      await expect(client.lookupByCondoBaseAndUnitDesignation('1010060001', '   ')).rejects.toMatchObject({
        code: 'CONDO_UNITS_INVALID_UNIT_DESIGNATION',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('transport and response validation', () => {
    it('surfaces non-2xx HTTP responses explicitly', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse({ message: 'upstream failure' }, 503));
      const client = createClient(fetchImpl);

      await expect(client.lookupByUnitBbl('1012345678')).rejects.toMatchObject({
        code: 'CONDO_UNITS_HTTP_ERROR',
        statusCode: 502,
      });
    });

    it('surfaces request timeouts explicitly', async () => {
      const fetchImpl = jest.fn(async (_input, init) => {
        const signal = init?.signal;
        if (signal) {
          signal.dispatchEvent(new Event('abort'));
        }

        throw new DOMException('The operation was aborted.', 'AbortError');
      });

      const client = createClient(fetchImpl);

      await expect(client.lookupByUnitBbl('1012345678')).rejects.toMatchObject({
        code: 'CONDO_UNITS_REQUEST_TIMEOUT',
        statusCode: 504,
      });
    });

    it('rejects malformed JSON responses', async () => {
      const fetchImpl = jest.fn(
        async () =>
          new Response('not-json', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      const client = createClient(fetchImpl);

      await expect(client.lookupByUnitBbl('1012345678')).rejects.toMatchObject({
        code: 'CONDO_UNITS_MALFORMED_RESPONSE',
      });
    });

    it('rejects non-array JSON payloads', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse({ unit_bbl: '1012345678' }));
      const client = createClient(fetchImpl);

      await expect(client.lookupByUnitBbl('1012345678')).rejects.toMatchObject({
        code: 'CONDO_UNITS_MALFORMED_RESPONSE',
        message: 'Condominium Units response must be a JSON array',
      });
    });

    it('rejects rows with invalid BBL fields', async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse([
          {
            unit_bbl: '1012345678',
            condo_base_bbl: 'not-a-bbl',
            unit_designation: '12C',
          },
        ]),
      );
      const client = createClient(fetchImpl);

      await expect(client.lookupByUnitBbl('1012345678')).rejects.toBeInstanceOf(AppError);
      await expect(client.lookupByUnitBbl('1012345678')).rejects.toMatchObject({
        code: 'CONDO_UNITS_MALFORMED_RESPONSE',
      });
    });
  });

  it('uses the NYC Open Data default base URL when none is supplied', () => {
    const client = new CondoUnitsClient({
      fetchImpl: jest.fn(async () => jsonResponse([])),
      config: {
        socrataRequestTimeoutMs: TEST_TIMEOUT_MS,
        socrataAppToken: undefined,
      },
    });

    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(DEFAULT_NYC_OPEN_DATA_BASE_URL);
  });
});
