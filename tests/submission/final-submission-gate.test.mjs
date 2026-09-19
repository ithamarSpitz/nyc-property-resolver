import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildComposeEnvironment,
  findSecretFindings,
  inspectProspectiveEntries,
  inspectProspectiveFiles,
  runManualReferenceIngestion,
  shouldIncludeProspectiveFile,
  startCleanRuntime,
  validateDocumentedCommands,
} from '../../scripts/final-submission-gate.mjs';

const tokenKey = 'SOCRATA_APP_TOKEN';
const headerKey = 'X-App-Token';
const assignment = (value) => [tokenKey, value].join('=');

test('disk inventory retains binary and large deliverables while scanning all text', () => {
  const root = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.inventory-'));
  try {
    writeFileSync(path.join(root, 'evidence.png'), Buffer.from([137, 80, 78, 71, 0, 255]));
    writeFileSync(path.join(root, 'large.log'), Buffer.alloc(5_000_001, 32));
    writeFileSync(path.join(root, '.env'), Buffer.alloc(5_000_001, 32));
    writeFileSync(path.join(root, 'notes.txt'), assignment('inventory-secret'));
    const inspection = inspectProspectiveFiles(['evidence.png', 'large.log', '.env', 'notes.txt'], root);
    assert.deepEqual(inspection.files, ['evidence.png', 'large.log', 'notes.txt']);
    assert.deepEqual(inspection.findings, [
      '.env: committed runtime environment file',
      'notes.txt: non-empty secret assignment',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('large tracked logs detect tokens and database credentials beyond the former size cutoff', () => {
  const root = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.inventory-'));
  try {
    const secret = 'large-log-negative-test';
    for (const [content, finding] of [
      [assignment(secret), 'non-empty secret assignment'],
      [['postgresql://user:', secret, '@production.example/db'].join(''), 'database credential'],
    ]) {
      for (const offset of [0, 4_999_990, 5_100_000]) {
        const padding = ' '.repeat(5_200_000);
        writeFileSync(path.join(root, 'large.log'), `${padding.slice(0, offset)}\n${content}\n${padding.slice(offset)}`);
        const inspection = inspectProspectiveFiles(['large.log'], root);
        assert.deepEqual(inspection.files, ['large.log']);
        assert.deepEqual(inspection.findings, [`large.log: ${finding}`]);
        assert.ok(!inspection.findings.join('\n').includes(secret));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('behavior runtime excludes scheduler; documented reference startup still requires it', async () => {
  for (const includeWorker of [false, true]) {
    const commands = [];
    await startCleanRuntime('test startup', {
      includeWorker,
      execute: async (args) => {
        commands.push(args);
        if (args[0] === 'port') return { stdout: '127.0.0.1:12345' };
        if (args.includes('--services')) return { stdout: `postgres\napi\n${includeWorker ? 'worker\n' : ''}` };
        if (args.includes('--all')) return { stdout: JSON.stringify({ Service: 'migrate', ExitCode: 0 }) };
        return { stdout: '' };
      },
      waitForApi: async (url) => assert.equal(url, 'http://127.0.0.1:12345'),
    });
    assert.deepEqual(commands[0], ['up', '--build', '--detach', ...(includeWorker ? [] : ['api'])]);
  }
});

test('readiness rejects a scheduler in the behavior runtime and a missing scheduler in the reference runtime', async () => {
  for (const includeWorker of [false, true]) {
    await assert.rejects(startCleanRuntime('test invalid runtime', {
      includeWorker,
      execute: async (args) => {
        if (args[0] === 'port') return { stdout: '127.0.0.1:12345' };
        return { stdout: `postgres\napi\n${includeWorker ? '' : 'worker\n'}` };
      },
      waitForApi: async () => {},
    }), includeWorker ? /not running: worker/ : /must not run against the behavior-test database/);
  }
});

test('secret scan rejects JSON, YAML, source/header literals, and database credentials without echoing secrets', () => {
  const secret = 'credential-for-negative-test';
  const database = ['postgresql://user:', secret, '@production.example/db'].join('');
  for (const [file, content] of [
    ['config.json', JSON.stringify({ [tokenKey]: secret })],
    ['config.yaml', `  ${tokenKey}: "${secret}"`],
    ['src/client.ts', `const headers = ${JSON.stringify({ [headerKey]: secret })}`],
    ['request.txt', `${headerKey}: ${secret}`],
    ['notes.md', `DATABASE_URL=${database}`],
    ['config.json', JSON.stringify({ DATABASE_URL: database })],
    ['evidence/log.txt', `Connection failed: ${database}`],
    ['tests/unit/foundation/config.test.ts', JSON.stringify({ [tokenKey]: secret })],
    ['.env.example', assignment(secret)],
  ]) {
    const findings = findSecretFindings([{ file, content }]);
    assert.ok(findings.length > 0, file);
    assert.ok(!findings.join('\n').includes(secret), 'diagnostics must redact values');
  }
});

test('secret scan permits empty templates, references, and exact public fixtures only', () => {
  for (const content of [
    assignment(''), assignment('your-token-here'),
    `${tokenKey}: "\${SOCRATA_APP_TOKEN:-}"`,
    `const headers = { 'X-App-Token': this.appToken }`,
    JSON.stringify({ [tokenKey]: '[Redacted]' }),
  ]) assert.deepEqual(findSecretFindings([{ file: '.env.example', content }]), []);
  const fixture = JSON.stringify({ [tokenKey]: 'test-token' });
  assert.deepEqual(findSecretFindings([{ file: 'tests/unit/foundation/config.test.ts', content: fixture }]), []);
  assert.ok(findSecretFindings([{ file: 'src/config.ts', content: fixture }]).length);
  for (const value of ['example-real-credential', 'placeholder-real-credential', '${TOKEN:-real-credential}']) {
    assert.ok(findSecretFindings([{ file: 'notes.txt', content: assignment(value) }]).length);
  }
});

const cliResult = (status, outcome, terminalStatus = outcome) => ({
  status, stdout: `npm output\n${JSON.stringify({ outcome, status: terminalStatus })}\n`, stderr: '',
});

test('manual reference ingestion waits through scheduler contention then requires manual completion', async () => {
  const responses = [cliResult(2, 'ACTIVE_EXECUTOR'), cliResult(2, 'ACTIVE_EXECUTOR'), cliResult(0, 'COMPLETED')];
  let time = 0;
  const budgets = [];
  const result = await runManualReferenceIngestion({
    execute: async (budget) => { budgets.push(budget); return responses.shift(); },
    now: () => time, sleep: async (ms) => { time += ms; }, log: () => {},
    timeoutMs: 100, retryDelayMs: 10,
  });
  assert.equal(result.outcome, 'COMPLETED');
  assert.deepEqual(budgets, [100, 90, 80]);
  assert.equal(responses.length, 0);
});

test('persistent scheduler contention fails at attempt and deadline bounds', async () => {
  for (const bounds of [{ maxAttempts: 3, timeoutMs: 100 }, { maxAttempts: 100, timeoutMs: 25 }]) {
    let calls = 0;
    let time = 0;
    await assert.rejects(runManualReferenceIngestion({
      ...bounds, execute: async () => { calls += 1; return cliResult(2, 'ACTIVE_EXECUTOR'); },
      now: () => time, sleep: async (ms) => { time += ms; }, retryDelayMs: 10, log: () => {},
    }), /remained blocked by ACTIVE_EXECUTOR/);
    assert.equal(calls, 3);
  }
});

test('manual ingestion never retries source failures, malformed results, or command errors', async () => {
  for (const result of [cliResult(1, 'FAILED'), cliResult(1, 'SOURCE_CHANGED'), cliResult(2, 'FAILED'), cliResult(0, 'ACTIVE_EXECUTOR'), { status: 2, stdout: '', stderr: 'docker error' }]) {
    let calls = 0;
    await assert.rejects(runManualReferenceIngestion({
      execute: async () => { calls += 1; return result; },
      sleep: async () => assert.fail('must not retry'),
    }), /Manual ingestion did not complete/);
    assert.equal(calls, 1);
  }
  await assert.rejects(runManualReferenceIngestion({ execute: async () => { throw new Error('command timeout'); } }), /command timeout/);
});

test('clean-copy filter excludes local state but retains the public environment template', () => {
  for (const file of [
    '.git/config',
    '.harness/state.json',
    '.env',
    '.env.local',
    'node_modules/pkg/index.js',
    'dist/server.js',
    'coverage/lcov.info',
    'src/cache.tsbuildinfo',
  ]) assert.equal(shouldIncludeProspectiveFile(file), false, file);

  for (const file of ['.env.example', 'src/app.ts', 'evidence/scale-10000/summary.json']) {
    assert.equal(shouldIncludeProspectiveFile(file), true, file);
  }
});

test('secret scan detects high-confidence credentials without flagging an empty env example', () => {
  assert.deepEqual(
    findSecretFindings([{ file: '.env.example', content: `${assignment('')}\nDATABASE_URL=\n` }]),
    [],
  );
  assert.match(
    findSecretFindings([{ file: '.env', content: assignment('actual-secret-value') }]).join('\n'),
    /runtime environment file|secret assignment/,
  );
  assert.match(
    findSecretFindings([{ file: '.env.example', content: assignment('actual-secret-value') }]).join('\n'),
    /secret assignment/,
  );
  const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
  assert.match(
    findSecretFindings([{ file: 'notes.txt', content: githubToken }]).join('\n'),
    /GitHub token/,
  );
});

test('prospective inventory scans excluded runtime env files before clean-copy filtering', () => {
  const inspection = inspectProspectiveEntries([
    { file: '.env', content: assignment('tracked-secret-value') },
    { file: '.env.example', content: assignment('') },
    { file: 'src/app.ts', content: 'export {};\n' },
  ]);

  assert.deepEqual(inspection.files, ['.env.example', 'src/app.ts']);
  assert.match(inspection.findings.join('\n'), /\.env: committed runtime environment file/);
  assert.match(inspection.findings.join('\n'), /\.env: non-empty secret assignment/);
});

test('Compose execution environment excludes caller application configuration and tokens', () => {
  const env = buildComposeEnvironment(
    {
      Path: 'C:\\Windows\\System32',
      DOCKER_HOST: 'npipe:////./pipe/docker_engine',
      [tokenKey]: 'uncommitted-token',
      INGEST_INTERVAL_MS: '1',
      ECB_BATCH_SIZE: '9999',
      API_RATE_LIMIT: '9999',
    },
    'isolated-project',
  );

  assert.equal(env.Path, 'C:\\Windows\\System32');
  assert.equal(env.DOCKER_HOST, 'npipe:////./pipe/docker_engine');
  assert.equal(env.COMPOSE_PROJECT_NAME, 'isolated-project');
  assert.equal(env.API_HOST_PORT, '0');
  assert.equal(env.SOCRATA_APP_TOKEN, '');
  assert.equal(Object.hasOwn(env, 'INGEST_INTERVAL_MS'), false);
  assert.equal(Object.hasOwn(env, 'ECB_BATCH_SIZE'), false);
  assert.equal(Object.hasOwn(env, 'API_RATE_LIMIT'), false);
});

test('documented startup and manual commands must match package and Compose entrypoints', () => {
  const packageJson = {
    scripts: {
      'start:api': 'node dist/server.js',
      'start:worker': 'node dist/workers/ingestion.worker.js',
      'ingest:ecb': 'node dist/cli/ingest-ecb.js',
    },
  };
  const readme = 'docker compose up --build\n\ndocker compose run --rm worker npm run ingest:ecb';
  const composeConfig = {
    services: {
      postgres: { healthcheck: { test: ['CMD-SHELL', 'pg_isready'] } },
      migrate: {
        command: ['npx', 'prisma', 'migrate', 'deploy'],
        depends_on: { postgres: { condition: 'service_healthy' } },
      },
      api: {
        command: ['npm', 'run', 'start:api'],
        depends_on: { migrate: { condition: 'service_completed_successfully' } },
      },
      worker: {
        command: ['npm', 'run', 'start:worker'],
        depends_on: { migrate: { condition: 'service_completed_successfully' } },
      },
    },
  };
  assert.deepEqual(validateDocumentedCommands({ readme, packageJson, composeConfig }), []);
  for (const stale of [
    'docker compose up',
    'docker compose up --build api',
    'docker-compose up --build',
    'docker compose -f old-compose.yml up --build',
    'docker compose run --rm api npm run ingest:ecb',
    'docker compose run --rm worker npm run ingest:old',
    'docker compose run --rm worker npm run ingest:ecb-old',
    'docker compose run --rm worker node dist/cli/old-ingest.js',
    'docker compose exec worker npm run ingest:ecb',
    'npm run ingest:old',
    'npm start',
  ]) {
    for (const documented of [`\n\`\`\`bash\n${stale}\n\`\`\``, `\nAlternative: \`${stale}\`.`]) {
      assert.ok(validateDocumentedCommands({ readme: readme + documented, packageJson, composeConfig }).length > 0, stale);
    }
  }
  assert.deepEqual(validateDocumentedCommands({
    readme: `\`\`\`bash\n${readme}\n\`\`\`\nRepeat \`docker compose run --rm worker npm run ingest:ecb\`.`,
    packageJson, composeConfig,
  }), []);
  assert.match(
    validateDocumentedCommands({ readme: 'docker compose up', packageJson, composeConfig }).join('\n'),
    /up --build|manual-ingestion/,
  );
});

test('Compose ordering and entrypoints are validated on their owning services', () => {
  const packageJson = {
    scripts: {
      'start:api': 'node dist/server.js',
      'start:worker': 'node dist/workers/ingestion.worker.js',
      'ingest:ecb': 'node dist/cli/ingest-ecb.js',
    },
  };
  const readme = 'docker compose up --build\n\ndocker compose run --rm worker npm run ingest:ecb';
  const composeConfig = {
    services: {
      postgres: { healthcheck: {} },
      migrate: {
        command: ['npm', 'run', 'start:api'],
        depends_on: { postgres: { condition: 'service_started' } },
      },
      api: {
        command: ['node', 'wrong-api.js'],
        depends_on: { postgres: { condition: 'service_completed_successfully' } },
      },
      worker: {
        command: ['node', 'wrong-worker.js'],
        depends_on: { postgres: { condition: 'service_completed_successfully' } },
      },
      decoy: {
        command: ['npm', 'run', 'start:worker'],
        healthcheck: { test: ['CMD-SHELL', 'true'] },
        depends_on: {
          postgres: { condition: 'service_healthy' },
          migrate: { condition: 'service_completed_successfully' },
        },
      },
    },
  };

  const errors = validateDocumentedCommands({ readme, packageJson, composeConfig }).join('\n');
  assert.match(errors, /migrate command/);
  assert.match(errors, /api command/);
  assert.match(errors, /worker command/);
  assert.match(errors, /postgres service must define a healthcheck/);
  assert.match(errors, /migrate must wait for healthy postgres/);
  assert.match(errors, /api must wait for migrate completion/);
  assert.match(errors, /worker must wait for migrate completion/);
});
