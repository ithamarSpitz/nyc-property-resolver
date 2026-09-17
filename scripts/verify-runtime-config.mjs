import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const internalDatabaseUrl = 'postgresql://nycpr:nycpr@postgres:5432/nyc_property_resolver';
const ingestionVariables = [
  'SOCRATA_APP_TOKEN',
  'INGEST_INTERVAL_MS',
  'ECB_BATCH_SIZE',
  'SOCRATA_PAGE_SIZE',
  'SOCRATA_MAX_PAGES_PER_BATCH',
  'SOCRATA_CONCURRENCY',
  'SOCRATA_REQUEST_TIMEOUT_MS',
  'SOCRATA_MAX_RETRIES',
  'MAX_BATCH_ATTEMPTS_PER_RUN',
];
const operationalVariables = [
  ...ingestionVariables,
  'API_RATE_LIMIT',
  'API_BODY_LIMIT',
  'API_HOST_PORT',
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isolatedEnvironment(overrides = {}) {
  const env = { ...process.env };

  for (const name of operationalVariables) {
    delete env[name];
  }

  delete env.COMPOSE_ENV_FILES;
  delete env.COMPOSE_FILE;

  return { ...env, ...overrides };
}

function resolveComposeConfig(envFile, overrides = {}) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-f',
      'docker-compose.yml',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: rootDir,
      env: isolatedEnvironment(overrides),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `docker compose config failed (${result.status}): ${result.stderr?.trim() || 'no error output'}`,
    );
  }

  return JSON.parse(result.stdout);
}

function serviceEnvironment(config, serviceName) {
  const service = config.services?.[serviceName];
  assert(service, `Missing ${serviceName} service in resolved Compose config`);
  assert(service.environment, `Missing ${serviceName} environment in resolved Compose config`);
  return service.environment;
}

function verifyDefaults(config) {
  const api = serviceEnvironment(config, 'api');
  const worker = serviceEnvironment(config, 'worker');
  const migrate = serviceEnvironment(config, 'migrate');

  assert(String(api.API_RATE_LIMIT) === '100', 'API_RATE_LIMIT must default to 100 in Compose');
  assert(api.API_BODY_LIMIT === '', 'Unset API_BODY_LIMIT must remain empty for the application default');
  assert(String(api.PORT) === '3000', 'API container PORT must remain 3000');

  for (const name of ingestionVariables) {
    assert(worker[name] === '', `Unset worker ${name} must remain empty`);
  }

  assert(!Object.hasOwn(api, 'SOCRATA_APP_TOKEN'), 'SOCRATA_APP_TOKEN must not be exposed to api');
  assert(!Object.hasOwn(migrate, 'SOCRATA_APP_TOKEN'), 'SOCRATA_APP_TOKEN must not be exposed to migrate');

  for (const [serviceName, environment] of [
    ['api', api],
    ['worker', worker],
    ['migrate', migrate],
  ]) {
    assert(
      environment.DATABASE_URL === internalDatabaseUrl,
      `${serviceName} DATABASE_URL must retain the Compose-internal value`,
    );
  }
}

function verifyOverrides(config, sentinels) {
  const api = serviceEnvironment(config, 'api');
  const worker = serviceEnvironment(config, 'worker');
  const migrate = serviceEnvironment(config, 'migrate');

  for (const name of ingestionVariables) {
    assert(worker[name] === sentinels[name], `${name} override did not reach worker`);
  }

  assert(!Object.hasOwn(api, 'SOCRATA_APP_TOKEN'), 'SOCRATA_APP_TOKEN override leaked into api');
  assert(!Object.hasOwn(migrate, 'SOCRATA_APP_TOKEN'), 'SOCRATA_APP_TOKEN override leaked into migrate');
  assert(api.API_RATE_LIMIT === sentinels.API_RATE_LIMIT, 'API_RATE_LIMIT override did not reach api');
  assert(api.API_BODY_LIMIT === sentinels.API_BODY_LIMIT, 'API_BODY_LIMIT override did not reach api');
  assert(String(api.PORT) === '3000', 'API container PORT changed under overrides');

  const apiPorts = config.services.api.ports ?? [];
  const publishedPort = apiPorts.find((port) => Number(port.target) === 3000);
  assert(publishedPort, 'API must publish container port 3000');
  assert(
    String(publishedPort.published) === sentinels.API_HOST_PORT,
    'API_HOST_PORT override did not control the published host port',
  );
}

function main() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nycpr-compose-env-'));
  const emptyEnvFile = path.join(tempDir, 'empty.env');

  try {
    writeFileSync(emptyEnvFile, '', 'utf8');

    const defaultConfig = resolveComposeConfig(emptyEnvFile);
    verifyDefaults(defaultConfig);

    const sentinels = {
      SOCRATA_APP_TOKEN: 'runtime-token-sentinel',
      INGEST_INTERVAL_MS: '11001',
      ECB_BATCH_SIZE: '11002',
      SOCRATA_PAGE_SIZE: '11003',
      SOCRATA_MAX_PAGES_PER_BATCH: '11004',
      SOCRATA_CONCURRENCY: '11005',
      SOCRATA_REQUEST_TIMEOUT_MS: '11006',
      SOCRATA_MAX_RETRIES: '11007',
      MAX_BATCH_ATTEMPTS_PER_RUN: '11008',
      API_RATE_LIMIT: '11009',
      API_BODY_LIMIT: '11010kb',
      API_HOST_PORT: '43123',
    };
    const overrideConfig = resolveComposeConfig(emptyEnvFile, sentinels);
    verifyOverrides(overrideConfig, sentinels);

    console.log('Runtime configuration verification passed.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(
    `Runtime configuration verification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
