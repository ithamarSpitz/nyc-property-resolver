import { createLogger } from '../../../src/logging/logger';
import {
  PLUTO_DEFAULT_BASE_URL,
  PLUTO_ERROR_CODES,
  PLUTO_LOOKUP_RESULT_LIMIT,
  PlutoClient,
} from '../../../src/clients/pluto.client';

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

function empireStateParcelRecord() {
  return {
    borough: 'MN',
    borocode: '1',
    block: '835',
    lot: '41',
    address: '338 5 AVENUE',
    bldgclass: 'O4',
    bbl: '1008350041.00000000',
  };
}

describe('PlutoClient', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('builds a bounded PLUTO lookup request for a canonical BBL', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [empireStateParcelRecord()],
    }));
    const client = new PlutoClient({
      fetchImpl: createFetchMock(fetchImpl),
      socrataAppToken: 'test-token',
    });

    await client.lookupByBbl('1008350041');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = firstCall;
    const parsedUrl = new URL(url);

    expect(parsedUrl.origin + parsedUrl.pathname).toBe(PLUTO_DEFAULT_BASE_URL);
    expect(parsedUrl.searchParams.get('bbl')).toBe('1008350041');
    expect(parsedUrl.searchParams.get('$limit')).toBe(String(PLUTO_LOOKUP_RESULT_LIMIT));
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual(new Headers({ 'X-App-Token': 'test-token' }));
  });

  it('parses parcel identifiers without losing NYC zero padding', async () => {
    const client = new PlutoClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            borough: 'MN',
            borocode: '1',
            block: '00835',
            lot: '0041',
            address: '338 5 AVENUE',
            bldgclass: 'O4',
            bbl: 1008350041,
          },
        ],
      })),
    });

    const result = await client.lookupByBbl('1008350041');

    expect(result).toEqual({
      status: 'found',
      parcel: {
        bbl: '1008350041',
        borough: 1,
        block: 835,
        lot: 41,
        address: '338 5 AVENUE',
        bldgclass: 'O4',
      },
    });
  });

  it('returns not_found for an empty PLUTO result set', async () => {
    const client = new PlutoClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [],
      })),
    });

    await expect(client.lookupByBbl('1008350041')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('returns multiple parcels when PLUTO returns more than one match', async () => {
    const client = new PlutoClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          empireStateParcelRecord(),
          {
            borough: 'MN',
            borocode: '1',
            block: '835',
            lot: '42',
            address: '340 5 AVENUE',
            bldgclass: 'O4',
            bbl: '1008350042.00000000',
          },
        ],
      })),
    });

    const result = await client.lookupByBbl('1008350041');

    expect(result.status).toBe('multiple');
    if (result.status === 'multiple') {
      expect(result.parcels).toHaveLength(2);
      expect(result.parcels[0]?.bbl).toBe('1008350041');
      expect(result.parcels[1]?.bbl).toBe('1008350042');
    }
  });

  it('rejects malformed PLUTO payloads explicitly', async () => {
    const client = new PlutoClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: 'shape' }),
      })),
    });

    await expect(client.lookupByBbl('1008350041')).rejects.toMatchObject({
      code: PLUTO_ERROR_CODES.MALFORMED_RESPONSE,
    });
  });

  it('rejects parcel records with inconsistent identifier components', async () => {
    const client = new PlutoClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            borough: 'MN',
            borocode: '1',
            block: '999',
            lot: '41',
            address: '338 5 AVENUE',
            bbl: '1008350041.00000000',
          },
        ],
      })),
    });

    await expect(client.lookupByBbl('1008350041')).rejects.toMatchObject({
      code: PLUTO_ERROR_CODES.MALFORMED_RESPONSE,
    });
  });

  it('surfaces non-2xx HTTP responses explicitly', async () => {
    const client = new PlutoClient({
      fetchImpl: createFetchMock(async () => ({
        ok: false,
        status: 503,
        json: async () => [],
      })),
    });

    await expect(client.lookupByBbl('1008350041')).rejects.toMatchObject({
      code: PLUTO_ERROR_CODES.HTTP_ERROR,
      statusCode: 503,
    });
  });

  it('surfaces request timeouts explicitly', async () => {
    jest.useFakeTimers();

    const client = new PlutoClient({
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

    const lookupPromise = client.lookupByBbl('1008350041');
    const expectation = expect(lookupPromise).rejects.toMatchObject({
      code: PLUTO_ERROR_CODES.TIMEOUT,
    });

    await jest.advanceTimersByTimeAsync(25);
    await expectation;
  });

  it('rejects invalid BBL input before making a network request', async () => {
    const fetchImpl = jest.fn();
    const client = new PlutoClient({
      fetchImpl: createFetchMock(fetchImpl),
    });

    await expect(client.lookupByBbl('not-a-bbl')).rejects.toMatchObject({
      code: PLUTO_ERROR_CODES.INVALID_BBL,
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
    const client = new PlutoClient({
      fetchImpl: createFetchMock(async () => ({
        ok: true,
        status: 200,
        json: async () => [empireStateParcelRecord()],
      })),
      socrataAppToken: 'secret-token',
      logger,
    });

    await client.lookupByBbl('1008350041');

    const output = lines.join('');
    expect(output).not.toContain('secret-token');
  });
});
