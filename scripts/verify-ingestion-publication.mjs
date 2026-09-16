import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectName = `nycpr-ingestion-publication-${randomBytes(4).toString('hex')}`;
const composeBaseArgs = ['compose', '-p', projectName, '-f', 'docker-compose.yml'];
const hostPrismaEnv = {
  DATABASE_URL: 'postgresql://validation:validation@127.0.0.1:1/validation?schema=public',
};

let dockerStarted = false;

function composeEnv() {
  return { ...process.env, API_HOST_PORT: '0' };
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
  run('docker', [...composeBaseArgs, ...args], {
    env: composeEnv(),
    ...options,
  });
}

function cleanupDocker() {
  if (!dockerStarted) {
    return;
  }
  try {
    compose(['down', '-v', '--remove-orphans'], {
      label: 'docker compose down -v --remove-orphans',
    });
  } catch (error) {
    console.error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  run('npx', ['prisma', 'validate'], { env: { ...process.env, ...hostPrismaEnv } });
  run('npx', ['prisma', 'generate'], { env: { ...process.env, ...hostPrismaEnv } });
  run('npm', ['run', 'typecheck']);
  run('npm', ['test', '--', '--runInBand', 'tests/unit/ingestion'], {
    label: 'npm test -- --runInBand tests/unit/ingestion',
  });

  compose(['config'], { label: 'docker compose config' });
  compose(['build'], { label: 'docker compose build' });
  dockerStarted = true;
  compose(['up', '-d', '--wait', 'postgres'], {
    label: 'docker compose up -d --wait postgres',
  });
  compose(['run', '--rm', 'migrate'], { label: 'docker compose run --rm migrate' });
  compose(
    [
      'run',
      '--rm',
      '-e',
      'INGESTION_PUBLICATION_INTEGRATION=1',
      'api',
      'npx',
      'jest',
      'tests/integration/ingestion',
      '--runInBand',
    ],
    { label: 'docker compose run --rm api S2 + S3 ingestion publication semantic suite' },
  );

  console.log('\nIngestion publication verification passed.');
}

async function runVerification() {
  try {
    await main();
  } catch (error) {
    console.error(
      `\nIngestion publication verification failed: ${error instanceof Error ? error.message : String(error)}`,
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
