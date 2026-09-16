import {
  DOB_ECB_DATASET_ID,
  SOCRATA_DEFAULT_MAX_BINS_PER_QUERY,
  SOCRATA_ERROR_CODES,
  SOCRATA_MAX_BIN_VALUE_LENGTH,
  SocrataClient,
  SocrataClientError,
  type SocrataHttpRequest,
} from '../../../src/clients/socrata.client';
import { CONFIG_DEFAULTS } from '../../../src/config/defaults';

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function response(payload: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function asResponse(value: MockResponse): Response {
  return value as unknown as Response;
}

describe('SocrataClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds an explicitly selected, stably ordered ECB page request', async () => {
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(asResponse(response([{ ':id': 'row-1', ':updated_at': '10' }])));
    const client = new SocrataClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://example.test',
    });

    await client.getEcbDataPage(['2000002', '1000001'], 500, 1000);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe(`/resource/${DOB_ECB_DATASET_ID}.json`);
    expect(parsedUrl.searchParams.get('$select')).toBe(':id,:updated_at,*');
    expect(parsedUrl.searchParams.get('$order')).toBe(':updated_at,:id');
    expect(parsedUrl.searchParams.get('$limit')).toBe('1000');
    expect(parsedUrl.searchParams.get('$offset')).toBe('500');
    expect(parsedUrl.searchParams.get('$where')).toBe("bin in ('1000001','2000002')");
    expect(init.method).toBe('GET');
  });

  it('does not mutate the supplied BIN batch and escapes query values', () => {
    const bins = ['2000002', "100'0001"];
    const client = new SocrataClient({ baseUrl: 'https://example.test' });

    const url = client.buildEcbDataPageUrl(bins, 0, 50);

    expect(bins).toEqual(['2000002', "100'0001"]);
    expect(new URL(url).searchParams.get('$where')).toBe("bin in ('100''0001','2000002')");
  });

  it('returns a typed rowsUpdatedAt metadata watermark', async () => {
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(asResponse(response({ rowsUpdatedAt: 1_726_000_000 })));
    const client = new SocrataClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://example.test',
    });

    await expect(client.getDatasetMetadata()).resolves.toEqual({ rowsUpdatedAt: 1_726_000_000 });
    expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).pathname).toBe(
      `/api/views/${DOB_ECB_DATASET_ID}`,
    );
  });

  it('rejects missing metadata watermarks explicitly', async () => {
    const client = new SocrataClient({
      fetchImpl: (async () => asResponse(response({ name: 'ECB' }))) as typeof fetch,
      baseUrl: 'https://example.test',
    });

    await expect(client.getDatasetMetadata()).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'malformed_payload',
      retryable: false,
    });
  });

  it.each([['invalid'], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])(
    'rejects malformed rowsUpdatedAt metadata values (%p)',
    async (rowsUpdatedAt) => {
      const client = new SocrataClient({
        fetchImpl: (async () => asResponse(response({ rowsUpdatedAt }))) as typeof fetch,
        baseUrl: 'https://example.test',
      });

      await expect(client.getDatasetMetadata()).rejects.toMatchObject({
        code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
        kind: 'malformed_payload',
        retryable: false,
      });
    },
  );

  it('bounds BIN batch cardinality by the configured maximum', () => {
    const bins = (count: number) =>
      Array.from({ length: count }, (_, index) => String(index).padStart(7, '0'));
    const client = new SocrataClient({
      baseUrl: 'https://example.test',
      maxBinsPerQuery: 3,
    });

    const url = client.buildEcbDataPageUrl(bins(3), 0, 50);
    expect(new URL(url).searchParams.get('$where')).toBe(
      "bin in ('0000000','0000001','0000002')",
    );

    expect(() => client.buildEcbDataPageUrl(bins(4), 0, 50)).toThrow(
      'at most 3 BINs per batch',
    );
  });

  it('defaults BIN batch cardinality to the configured ECB batch size', () => {
    const client = new SocrataClient({ baseUrl: 'https://example.test' });
    const oversizedBatch = Array.from(
      { length: SOCRATA_DEFAULT_MAX_BINS_PER_QUERY + 1 },
      (_, index) => String(index).padStart(7, '0'),
    );

    expect(SOCRATA_DEFAULT_MAX_BINS_PER_QUERY).toBe(CONFIG_DEFAULTS.ECB_BATCH_SIZE);
    expect(() => client.buildEcbDataPageUrl(oversizedBatch, 0, 50)).toThrow(
      `at most ${SOCRATA_DEFAULT_MAX_BINS_PER_QUERY} BINs per batch`,
    );
    expect(() =>
      client.buildEcbDataPageUrl(oversizedBatch.slice(0, SOCRATA_DEFAULT_MAX_BINS_PER_QUERY), 0, 50),
    ).not.toThrow();
  });

  it('bounds the total constructed query size and individual BIN values', () => {
    const client = new SocrataClient({
      baseUrl: 'https://example.test',
      maxBinsPerQuery: 100,
      maxQueryUrlLength: 300,
    });
    const batch = Array.from({ length: 100 }, (_, index) => String(index).padStart(7, '0'));

    expect(() => client.buildEcbDataPageUrl(batch, 0, 50)).toThrow(
      'exceeds the 300 character query bound',
    );
    expect(() =>
      client.buildEcbDataPageUrl(['x'.repeat(SOCRATA_MAX_BIN_VALUE_LENGTH + 1)], 0, 50),
    ).toThrow('up to');
  });

  it('rejects non-positive bulk-query bound configuration', () => {
    expect(() => new SocrataClient({ maxBinsPerQuery: 0 })).toThrow(
      'maxBinsPerQuery must be a positive integer',
    );
    expect(() => new SocrataClient({ maxQueryUrlLength: -1 })).toThrow(
      'maxQueryUrlLength must be a positive integer',
    );
  });

  it.each([
    [{}],
    [{ ':id': 'row-1' }],
    [{ ':updated_at': '10' }],
    [{ ':id': '', ':updated_at': '10' }],
    [{ ':id': 'row-1', ':updated_at': 10 }],
  ])('rejects ECB rows without raw-persistence identity fields (%p)', async (row) => {
    const client = new SocrataClient({
      fetchImpl: (async () => asResponse(response([row]))) as typeof fetch,
      baseUrl: 'https://example.test',
    });

    await expect(client.getEcbDataPage(['1000001'], 0, 50)).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'malformed_payload',
      retryable: false,
    });
  });

  it('provides S2-T1 source-contract aggregate and duplicate-group stats', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response([{ totalRows: '3', distinctSourceIds: '2' }]))
      .mockResolvedValueOnce(response([{ nullSourceIds: '1' }]))
      .mockResolvedValueOnce(response([{ isn_dob_bis_extract: 'ECB-1', count: '2' }]));
    const client = new SocrataClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://example.test',
    });

    await expect(client.getSourceContractStats()).resolves.toEqual({
      totalRows: 3,
      distinctSourceIds: 2,
      nullSourceIds: 1,
      duplicateGroups: [{ sourceId: 'ECB-1', count: 2 }],
    });

    const aggregateUrl = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    const nullCountUrl = new URL(fetchImpl.mock.calls[1]?.[0] as string);
    const duplicateUrl = new URL(fetchImpl.mock.calls[2]?.[0] as string);
    expect(aggregateUrl.searchParams.get('$select')).toContain('count(distinct ISN_DOB_BIS_EXTRACT)');
    expect(aggregateUrl.searchParams.get('$select')).not.toContain(' where ');
    expect(nullCountUrl.searchParams.get('$select')).toBe('count(*) as nullSourceIds');
    expect(nullCountUrl.searchParams.get('$where')).toBe('ISN_DOB_BIS_EXTRACT is null');
    expect(duplicateUrl.searchParams.get('$group')).toBe('ISN_DOB_BIS_EXTRACT');
    expect(duplicateUrl.searchParams.get('$having')).toBe('count(*) > 1');
  });

  it('lets the request executor consume HTTP classification and retry an attempt', async () => {
    const requests: SocrataHttpRequest[] = [];
    const classifiedErrors: SocrataClientError[] = [];
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response({ message: 'unavailable' }, 503))
      .mockResolvedValueOnce(response([]));
    const client = new SocrataClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://example.test',
      requestExecutor: async (attempt) => {
        requests.push(attempt.request);
        try {
          return await attempt.execute();
        } catch (error) {
          if (!(error instanceof SocrataClientError) || !error.retryable) {
            throw error;
          }

          classifiedErrors.push(error);
          return attempt.execute();
        }
      },
    });

    await client.getEcbDataPage(['1000001'], 0, 10);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.method).toBe('GET');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(classifiedErrors).toHaveLength(1);
    expect(classifiedErrors[0]).toMatchObject({
      code: SOCRATA_ERROR_CODES.HTTP_ERROR,
      statusCode: 503,
      retryable: true,
    });
  });

  it('lets the request executor consume transport classification', async () => {
    const transportError = new TypeError('network down');
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(response([]));
    const classifiedErrors: SocrataClientError[] = [];
    const client = new SocrataClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://example.test',
      requestExecutor: async (attempt) => {
        try {
          return await attempt.execute();
        } catch (error) {
          if (!(error instanceof SocrataClientError) || !error.retryable) {
            throw error;
          }

          classifiedErrors.push(error);
          return attempt.execute();
        }
      },
    });

    await client.getEcbDataPage(['1000001'], 0, 10);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(classifiedErrors[0]).toMatchObject({
      code: SOCRATA_ERROR_CODES.TRANSPORT_ERROR,
      kind: 'transport',
      retryable: true,
    });
  });

  it.each([
    [503, true],
    [429, true],
    [404, false],
  ])('classifies HTTP status %s for the retry executor', async (status, retryable) => {
    const client = new SocrataClient({
      fetchImpl: (async () => asResponse(response({ message: 'failure' }, status))) as typeof fetch,
      baseUrl: 'https://example.test',
    });

    await expect(client.getDatasetMetadata()).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.HTTP_ERROR,
      statusCode: status,
      retryable,
    });
  });

  it('classifies aborts, transport failures, malformed JSON, and malformed response shapes', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const abortingClient = new SocrataClient({
      fetchImpl: (async () => {
        throw abortError;
      }) as typeof fetch,
      baseUrl: 'https://example.test',
    });
    await expect(abortingClient.getDatasetMetadata()).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.TIMEOUT,
      retryable: true,
    });

    const transportClient = new SocrataClient({
      fetchImpl: (async () => {
        throw new TypeError('network down');
      }) as typeof fetch,
      baseUrl: 'https://example.test',
    });
    await expect(transportClient.getDatasetMetadata()).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.TRANSPORT_ERROR,
      retryable: true,
    });

    const jsonClient = new SocrataClient({
      fetchImpl: (async () => asResponse({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })) as typeof fetch,
      baseUrl: 'https://example.test',
    });
    await expect(jsonClient.getDatasetMetadata()).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'malformed_json',
      retryable: false,
    });

    const shapeClient = new SocrataClient({
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
      baseUrl: 'https://example.test',
    });
    await expect(shapeClient.getDatasetMetadata()).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.MALFORMED_RESPONSE,
      kind: 'transport_shape',
      retryable: false,
    });
  });

  it.each([
    ['AbortError', SOCRATA_ERROR_CODES.TIMEOUT, 'timeout'],
    ['TimeoutError', SOCRATA_ERROR_CODES.TIMEOUT, 'timeout'],
  ])(
    'classifies %s while reading the response body as retryable',
    async (errorName, code, kind) => {
      const bodyError = new Error('aborted while reading body');
      bodyError.name = errorName;
      const client = new SocrataClient({
        fetchImpl: (async () =>
          asResponse({
            ok: true,
            status: 200,
            json: async () => {
              throw bodyError;
            },
          })) as typeof fetch,
        baseUrl: 'https://example.test',
      });

      await expect(client.getDatasetMetadata()).rejects.toMatchObject({
        code,
        kind,
        retryable: true,
      });
    },
  );

  it('classifies a truncated response body as a retryable transport failure', async () => {
    const client = new SocrataClient({
      fetchImpl: (async () =>
        asResponse({
          ok: true,
          status: 200,
          json: async () => {
            throw new TypeError('terminated');
          },
        })) as typeof fetch,
      baseUrl: 'https://example.test',
    });

    await expect(client.getEcbDataPage(['1000001'], 0, 50)).rejects.toMatchObject({
      code: SOCRATA_ERROR_CODES.TRANSPORT_ERROR,
      kind: 'transport',
      retryable: true,
    });
  });

  it('lets the request executor retry a body-read abort inside one attempt boundary', async () => {
    const abortError = new Error('aborted while reading body');
    abortError.name = 'AbortError';
    const classifiedErrors: SocrataClientError[] = [];
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw abortError;
        },
      })
      .mockResolvedValueOnce(response([{ ':id': 'row-1', ':updated_at': '10' }]));
    const client = new SocrataClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://example.test',
      requestExecutor: async (attempt) => {
        try {
          return await attempt.execute();
        } catch (error) {
          if (!(error instanceof SocrataClientError) || !error.retryable) {
            throw error;
          }

          classifiedErrors.push(error);
          return attempt.execute();
        }
      },
    });

    await expect(client.getEcbDataPage(['1000001'], 0, 50)).resolves.toEqual([
      { ':id': 'row-1', ':updated_at': '10' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(classifiedErrors).toHaveLength(1);
    expect(classifiedErrors[0]).toMatchObject({
      code: SOCRATA_ERROR_CODES.TIMEOUT,
      kind: 'timeout',
      retryable: true,
    });
  });
});
