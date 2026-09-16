import { AppError } from '../../../src/errors';
import {
  CONDOMINIUMS_DATASET_ID,
  CondominiumsClient,
} from '../../../src/clients/condominiums.client';
import { DEFAULT_NYC_OPEN_DATA_BASE_URL } from '../../../src/clients/condo-units.client';

const TEST_BASE_URL = 'https://example.test/resource';
const TEST_TIMEOUT_MS = 5_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function createClient(fetchImpl: FetchImpl): CondominiumsClient {
  return new CondominiumsClient({
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

describe('CondominiumsClient', () => {
  describe('lookupByCondoBaseBbl', () => {
    it('builds a condo_base_bbl request against the Condominiums dataset', async () => {
      const fetchImpl = jest.fn(async (input, init) => {
        const url = parseRequestUrl(input);

        expect(url.origin + url.pathname).toBe(
          `${TEST_BASE_URL}/${CONDOMINIUMS_DATASET_ID}.json`,
        );
        expect(url.searchParams.get('$select')).toBe('condo_base_bbl,condo_billing_bbl');
        expect(url.searchParams.get('$where')).toBe("condo_base_bbl='1010060001'");
        expect(url.searchParams.get('$order')).toBe('condo_billing_bbl ASC');
        expect(url.searchParams.get('$limit')).toBe('25');
        expect(init?.headers).toMatchObject({
          Accept: 'application/json',
          'X-App-Token': 'test-token',
        });

        return jsonResponse([
          {
            condo_base_bbl: '1010060001',
            condo_billing_bbl: '1010067501',
          },
        ]);
      });

      const client = createClient(fetchImpl);
      const result = await client.lookupByCondoBaseBbl('1010060001');

      expect(result).toEqual({
        matchCount: 'one',
        matches: [
          {
            condoBaseBbl: '1010060001',
            condoBillingBbl: '1010067501',
          },
        ],
      });
    });

    it('preserves billing BBL zero padding when the source returns numeric identifiers', async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse([
          {
            condo_base_bbl: 1008350001,
            condo_billing_bbl: 1008357501,
          },
        ]),
      );

      const client = createClient(fetchImpl);
      const result = await client.lookupByCondoBaseBbl('1008350001');

      expect(result.matchCount).toBe('one');
      if (result.matchCount === 'one') {
        expect(result.matches[0]).toEqual({
          condoBaseBbl: '1008350001',
          condoBillingBbl: '1008357501',
        });
      }
    });

    it('returns zero matches without fabricating a billing BBL', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse([]));
      const client = createClient(fetchImpl);

      await expect(client.lookupByCondoBaseBbl('1010060001')).resolves.toEqual({
        matchCount: 'zero',
        matches: [],
      });
    });

    it('returns multiple billing mappings without selecting one arbitrarily', async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse([
          {
            condo_base_bbl: '1010060001',
            condo_billing_bbl: '1010067501',
          },
          {
            condo_base_bbl: '1010060001',
            condo_billing_bbl: '1010067502',
          },
        ]),
      );

      const client = createClient(fetchImpl);
      const result = await client.lookupByCondoBaseBbl('1010060001');

      expect(result.matchCount).toBe('multiple');
      if (result.matchCount === 'multiple') {
        expect(result.matches).toHaveLength(2);
        expect(result.matches.map((match) => match.condoBillingBbl)).toEqual([
          '1010067501',
          '1010067502',
        ]);
      }
    });
  });

  describe('transport and response validation', () => {
    it('surfaces non-2xx HTTP responses explicitly', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse({ message: 'upstream failure' }, 500));
      const client = createClient(fetchImpl);

      await expect(client.lookupByCondoBaseBbl('1010060001')).rejects.toMatchObject({
        code: 'CONDOMINIUMS_HTTP_ERROR',
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

      await expect(client.lookupByCondoBaseBbl('1010060001')).rejects.toMatchObject({
        code: 'CONDOMINIUMS_REQUEST_TIMEOUT',
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

      await expect(client.lookupByCondoBaseBbl('1010060001')).rejects.toMatchObject({
        code: 'CONDOMINIUMS_MALFORMED_RESPONSE',
      });
    });

    it('rejects non-array JSON payloads', async () => {
      const fetchImpl = jest.fn(async () => jsonResponse({ condo_base_bbl: '1010060001' }));
      const client = createClient(fetchImpl);

      await expect(client.lookupByCondoBaseBbl('1010060001')).rejects.toMatchObject({
        code: 'CONDOMINIUMS_MALFORMED_RESPONSE',
        message: 'Condominiums response must be a JSON array',
      });
    });

    it('rejects rows with invalid billing BBL fields', async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse([
          {
            condo_base_bbl: '1010060001',
            condo_billing_bbl: 'bad-billing-bbl',
          },
        ]),
      );
      const client = createClient(fetchImpl);

      await expect(client.lookupByCondoBaseBbl('1010060001')).rejects.toBeInstanceOf(AppError);
      await expect(client.lookupByCondoBaseBbl('1010060001')).rejects.toMatchObject({
        code: 'CONDOMINIUMS_MALFORMED_RESPONSE',
      });
    });
  });

  it('uses the NYC Open Data default base URL when none is supplied', () => {
    const client = new CondominiumsClient({
      fetchImpl: jest.fn(async () => jsonResponse([])),
      config: {
        socrataRequestTimeoutMs: TEST_TIMEOUT_MS,
        socrataAppToken: undefined,
      },
    });

    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(DEFAULT_NYC_OPEN_DATA_BASE_URL);
  });
});
