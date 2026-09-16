import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectName = `nycpr-foundation-${randomBytes(4).toString('hex')}`;
const composeBaseArgs = ['compose', '-p', projectName, '-f', 'docker-compose.yml'];
const hostPrismaEnv = {
  DATABASE_URL: 'postgresql://validation:validation@127.0.0.1:1/validation?schema=public',
};

let dockerStarted = false;

function composeEnv() {
  return {
    ...process.env,
    API_HOST_PORT: '0',
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

function runCapture(command, args, { env, label } = {}) {
  const display = label ?? [command, ...args].join(' ');
  console.log(`\n==> ${display}`);

  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: env ?? process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `Command failed (${result.status}): ${display}${stderr ? `\n${stderr}` : ''}`,
    );
  }

  return result.stdout.trim();
}

function compose(args, options = {}) {
  return run('docker', [...composeBaseArgs, ...args], {
    env: composeEnv(),
    ...options,
  });
}

function composeCapture(args, options = {}) {
  return runCapture('docker', [...composeBaseArgs, ...args], {
    env: composeEnv(),
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveHealthUrl(portOutput) {
  const line = portOutput.trim().split(/\r?\n/)[0]?.trim();
  if (!line) {
    throw new Error('docker compose port returned no published mapping for api:3000');
  }

  if (line.startsWith('[')) {
    const port = line.slice(line.lastIndexOf(':') + 1);
    return `http://127.0.0.1:${port}/health`;
  }

  const separator = line.lastIndexOf(':');
  if (separator === -1) {
    throw new Error(`Unexpected docker compose port output: ${line}`);
  }

  const host = line.slice(0, separator);
  const port = line.slice(separator + 1);
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `http://${probeHost}:${port}/health`;
}

async function waitForHealth(url, { timeoutMs = 120_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Connection: 'close' } });
      try {
        if (response.ok) {
          const body = await response.json();
          if (body?.status === 'ok') {
            return;
          }
        }
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch {
      // Retry until timeout.
    }

    await sleep(intervalMs);
  }

  throw new Error(`API health check failed for ${url}`);
}

function assertServiceRunning(serviceName) {
  const status = composeCapture(['ps', '--status', 'running', '--format', 'json']);
  const running = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry) => entry.Service);

  if (!running.includes(serviceName)) {
    throw new Error(`Expected ${serviceName} to be running, found: ${running.join(', ') || 'none'}`);
  }
}

function cleanupDocker() {
  if (!dockerStarted) {
    return;
  }

  try {
    compose(['down', '-v', '--remove-orphans'], { label: 'docker compose down -v --remove-orphans' });
  } catch (error) {
    console.error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function main() {
  run('npm', ['run', 'typecheck']);
  run('npm', ['test', '--', '--runInBand', 'tests/unit']);
  run('npx', ['prisma', 'validate'], { env: { ...process.env, ...hostPrismaEnv } });
  run('npx', ['prisma', 'generate'], { env: { ...process.env, ...hostPrismaEnv } });

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
      'FOUNDATION_INTEGRATION=1',
      'api',
      'npx',
      'jest',
      'tests/integration/foundation/prisma-smoke.test.ts',
      '--runInBand',
    ],
    { label: 'docker compose run --rm api prisma smoke test' },
  );

  compose(['up', '-d', 'api', 'worker'], {
    label: 'docker compose up -d api worker',
  });

  const published = composeCapture(['port', 'api', '3000'], {
    label: 'docker compose port api 3000',
  });
  const healthUrl = resolveHealthUrl(published);
  console.log(`\n==> API health probe ${healthUrl}`);

  await waitForHealth(healthUrl);
  assertServiceRunning('api');
  assertServiceRunning('worker');

  console.log('\nFoundation verification passed.');
}

async function runVerification() {
  try {
    await main();
  } catch (error) {
    console.error(`\nFoundation verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    cleanupDocker();
  }

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

void runVerification();
