import { CONFIG_DEFAULTS, loadConfig, resetConfigCache } from '../../../src/config';
import { ConfigError } from '../../../src/errors';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://app:secret@localhost:5432/nyc_property_resolver',
  };
}

describe('application config', () => {
  afterEach(() => {
    resetConfigCache();
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(ConfigError);
  });

  it('treats SOCRATA_APP_TOKEN as optional', () => {
    const withoutToken = loadConfig(baseEnv());
    const withToken = loadConfig({
      ...baseEnv(),
      SOCRATA_APP_TOKEN: 'test-token',
    });
    const withBlankToken = loadConfig({
      ...baseEnv(),
      SOCRATA_APP_TOKEN: '   ',
    });

    expect(withoutToken.socrataAppToken).toBeUndefined();
    expect(withToken.socrataAppToken).toBe('test-token');
    expect(withBlankToken.socrataAppToken).toBeUndefined();
  });

  it('applies architecture defaults from the canonical config module', () => {
    const config = loadConfig(baseEnv());

    expect(config.ingestIntervalMs).toBe(CONFIG_DEFAULTS.INGEST_INTERVAL_MS);
    expect(config.ecbBatchSize).toBe(CONFIG_DEFAULTS.ECB_BATCH_SIZE);
    expect(config.socrataPageSize).toBe(CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE);
    expect(config.socrataMaxPagesPerBatch).toBe(CONFIG_DEFAULTS.SOCRATA_MAX_PAGES_PER_BATCH);
    expect(config.socrataConcurrency).toBe(CONFIG_DEFAULTS.SOCRATA_CONCURRENCY);
    expect(config.socrataRequestTimeoutMs).toBe(CONFIG_DEFAULTS.SOCRATA_REQUEST_TIMEOUT_MS);
    expect(config.socrataMaxRetries).toBe(CONFIG_DEFAULTS.SOCRATA_MAX_RETRIES);
    expect(config.maxBatchAttemptsPerRun).toBe(CONFIG_DEFAULTS.MAX_BATCH_ATTEMPTS_PER_RUN);
    expect(config.apiBodyLimit).toBe(CONFIG_DEFAULTS.API_BODY_LIMIT);
    expect(config.port).toBe(CONFIG_DEFAULTS.PORT);
  });

  it('coerces numeric environment values', () => {
    const config = loadConfig({
      ...baseEnv(),
      ECB_BATCH_SIZE: '2500',
      SOCRATA_CONCURRENCY: '4',
    });

    expect(config.ecbBatchSize).toBe(2500);
    expect(config.socrataConcurrency).toBe(4);
  });

  it('leaves API_RATE_LIMIT unset when not provided', () => {
    const config = loadConfig(baseEnv());

    expect(config.apiRateLimit).toBeUndefined();
  });

  it('accepts an explicit API_RATE_LIMIT value without applying a default', () => {
    const config = loadConfig({
      ...baseEnv(),
      API_RATE_LIMIT: '120',
    });

    expect(config.apiRateLimit).toBe('120');
  });

  it('rejects invalid required numeric configuration', () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ECB_BATCH_SIZE: '0',
      }),
    ).toThrow(ConfigError);
  });

  it('coerces PORT from the environment', () => {
    const config = loadConfig({
      ...baseEnv(),
      PORT: '8080',
    });

    expect(config.port).toBe(8080);
  });

  it('rejects invalid PORT values', () => {
    for (const port of ['0', '-1', '65536', 'not-a-port']) {
      expect(() =>
        loadConfig({
          ...baseEnv(),
          PORT: port,
        }),
      ).toThrow(ConfigError);
    }
  });
});
