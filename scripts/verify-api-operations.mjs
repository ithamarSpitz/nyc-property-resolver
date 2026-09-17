import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifierProjectName =
  process.env.COMPOSE_PROJECT_NAME ??
  `nycpr-api-operations-${randomBytes(4).toString('hex')}`;
const composeBaseArgs = ['compose', '-f', 'docker-compose.yml'];
const composeYamlB64 = Buffer.from(
  readFileSync(path.join(rootDir, 'docker-compose.yml')),
).toString('base64');

function composeEnv() {
  return {
    ...process.env,
    API_HOST_PORT: '0',
    COMPOSE_PROJECT_NAME: verifierProjectName,
  };
}

function run(command, args, { env, label } = {}) {
  const display = label ?? [command, ...args].join(' ');
  console.log(`\n==> ${display}`);

  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: env ?? process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${display}`);
  }
}

function compose(args, options = {}) {
  return run('docker', [...composeBaseArgs, ...args], {
    env: composeEnv(),
    ...options,
  });
}

function cleanupDocker({ bestEffort = false } = {}) {
  try {
    compose(['down', '-v', '--remove-orphans'], {
      label: 'docker compose down -v --remove-orphans',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (bestEffort) {
      console.error(`Pre-start cleanup (best-effort): ${message}`);
    } else {
      console.error(`Cleanup failed: ${message}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  cleanupDocker({ bestEffort: true });

  compose(['build'], { label: 'docker compose build' });
  compose(['up', '-d'], { label: 'docker compose up -d' });
  compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'API_OPERATIONS_GATE=1',
      '-e',
      'API_OPERATIONS_GATE_API_URL=http://api:3000',
      '-e',
      `API_OPERATIONS_GATE_COMPOSE_YAML_B64=${composeYamlB64}`,
      'worker',
      'npm',
      'test',
      '--',
      '--runInBand',
      'tests/integration/api/api-operations-gate.test.ts',
      'tests/integration/operations/scheduler-cli-gate.test.ts',
    ],
    { label: 'docker compose run --rm worker S4 api-operations gate' },
  );

  console.log('\nAPI operations verification passed.');
}

async function runVerification() {
  try {
    await main();
  } catch (error) {
    console.error(
      `\nAPI operations verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    cleanupDocker();
  }

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

void runVerification();
