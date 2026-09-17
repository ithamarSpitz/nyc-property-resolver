import { z } from 'zod';

import { ConfigError } from '../errors/config-error';
import { CONFIG_DEFAULTS } from './defaults';

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

const optionalNonEmptyString = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

function envPositiveInt(defaultValue: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') {
      return defaultValue;
    }

    return Number(value);
  }, z.number().int().positive());
}

function envTcpPort(defaultValue: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') {
      return defaultValue;
    }

    return Number(value);
  }, z.number().int().min(1).max(65535));
}

const rawEnvSchema = z.object({
  DATABASE_URL: z.string().trim().min(1, 'DATABASE_URL is required'),
  PORT: envTcpPort(CONFIG_DEFAULTS.PORT),
  SOCRATA_APP_TOKEN: optionalSecret,
  INGEST_INTERVAL_MS: envPositiveInt(CONFIG_DEFAULTS.INGEST_INTERVAL_MS),
  ECB_BATCH_SIZE: envPositiveInt(CONFIG_DEFAULTS.ECB_BATCH_SIZE),
  SOCRATA_PAGE_SIZE: envPositiveInt(CONFIG_DEFAULTS.SOCRATA_PAGE_SIZE).refine(
    (value) => value <= 50_000,
    'SOCRATA_PAGE_SIZE must be at most 50000',
  ),
  SOCRATA_MAX_PAGES_PER_BATCH: envPositiveInt(CONFIG_DEFAULTS.SOCRATA_MAX_PAGES_PER_BATCH),
  SOCRATA_CONCURRENCY: envPositiveInt(CONFIG_DEFAULTS.SOCRATA_CONCURRENCY),
  SOCRATA_REQUEST_TIMEOUT_MS: envPositiveInt(CONFIG_DEFAULTS.SOCRATA_REQUEST_TIMEOUT_MS),
  SOCRATA_MAX_RETRIES: envPositiveInt(CONFIG_DEFAULTS.SOCRATA_MAX_RETRIES),
  MAX_BATCH_ATTEMPTS_PER_RUN: envPositiveInt(CONFIG_DEFAULTS.MAX_BATCH_ATTEMPTS_PER_RUN),
  TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS: envPositiveInt(
    CONFIG_DEFAULTS.TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS,
  ),
  API_RATE_LIMIT: optionalNonEmptyString,
  API_BODY_LIMIT: z.preprocess((value) => {
    if (value === undefined || value === '') {
      return CONFIG_DEFAULTS.API_BODY_LIMIT;
    }

    return value;
  }, z.string().trim().min(1)),
});

const appConfigSchema = rawEnvSchema.transform((env) => ({
  databaseUrl: env.DATABASE_URL,
  port: env.PORT,
  socrataAppToken: env.SOCRATA_APP_TOKEN,
  ingestIntervalMs: env.INGEST_INTERVAL_MS,
  ecbBatchSize: env.ECB_BATCH_SIZE,
  socrataPageSize: env.SOCRATA_PAGE_SIZE,
  socrataMaxPagesPerBatch: env.SOCRATA_MAX_PAGES_PER_BATCH,
  socrataConcurrency: env.SOCRATA_CONCURRENCY,
  socrataRequestTimeoutMs: env.SOCRATA_REQUEST_TIMEOUT_MS,
  socrataMaxRetries: env.SOCRATA_MAX_RETRIES,
  maxBatchAttemptsPerRun: env.MAX_BATCH_ATTEMPTS_PER_RUN,
  terminalPublicationTransactionTimeoutMs: env.TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS,
  apiRateLimit: env.API_RATE_LIMIT,
  apiBodyLimit: env.API_BODY_LIMIT,
}));

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = appConfigSchema.safeParse(source);

  if (!result.success) {
    throw new ConfigError(result.error);
  }

  return result.data;
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }

  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = undefined;
}
