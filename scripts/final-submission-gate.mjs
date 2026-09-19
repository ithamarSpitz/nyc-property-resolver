import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAILURE_LOG_PATH =
  process.env.FINAL_GATE_FAILURE_LOG_PATH ??
  path.join(tmpdir(), 'nycpr-final-submission-gate-last-failure.log');
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.harness',
  'node_modules',
  'dist',
  'coverage',
  '.cache',
  '.pytest_cache',
  '__pycache__',
]);
const REQUIRED_FIXTURE_TAGS = new Set([
  'reference_empire_state',
  'queens_hyphenated_house_number',
  'condominium_unit',
  'small_2_3_family',
  'unpaid_ecb_balance',
]);
const REQUIRED_FILES = [
  'package.json',
  'package-lock.json',
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
  'README.md',
  'DESIGN.md',
  'RUN_LOG.md',
  'prisma/schema.prisma',
  'seed/acceptance-properties.json',
  'seed/scale-10000-bbls.json',
  'evidence/acceptance-small/run/baseline/ingestion.log',
  'evidence/acceptance-small/run/second-run/ingestion.log',
  'evidence/acceptance-small/run/summary.json',
  'evidence/scale-10000/summary.json',
  'evidence/scale-10000/worker.log',
  'scripts/acceptance/validate-small-evidence.mjs',
  'scripts/acceptance/validate-scale-evidence.mjs',
  'tests/unit/property-resolution/address-normalizer.test.ts',
  'tests/integration/property-resolution/property-resolution.behavior.test.ts',
  'tests/integration/ingestion/ingestion-publication.behavior.test.ts',
  'tests/api/properties.ecb-violations.test.ts',
  'tests/integration/api/api-operations-gate.test.ts',
];
const COMPOSE_HOST_ENV_KEYS = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
]);

let cleanRoot;
let composeProject;
let composeMayExist = false;
const diagnosticLines = [];

function record(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  diagnosticLines.push(line);
  console.log(line);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeRelative(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function shouldIncludeProspectiveFile(file) {
  const normalized = normalizeRelative(file);
  const segments = normalized.split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  const basename = segments.at(-1)?.toLowerCase();
  if (basename === '.env') return false;
  if (basename?.startsWith('.env.') && basename !== '.env.example') return false;
  if (basename?.endsWith('.tsbuildinfo')) return false;
  return normalized.length > 0;
}

function runCapture(command, args, options = {}) {
  const {
    cwd = cleanRoot ?? sourceRoot,
    env = process.env,
    label = [command, ...args].join(' '),
    timeoutMs = 30 * 60_000,
    echo = true,
    acceptedExitCodes = [0],
  } = options;
  record(`START ${label}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (echo) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (echo) process.stderr.write(text);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label} exceeded its ${timeoutMs} ms bound`));
        return;
      }
      if (!acceptedExitCodes.includes(status)) {
        reject(
          new Error(
            `${label} failed with exit code ${status}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ''}`,
          ),
        );
        return;
      }
      record(`${status === 0 ? 'PASS' : `EXIT ${status}`} ${label}`);
      resolve({ stdout, stderr, status });
    });
  });
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

async function prospectiveFiles() {
  const { stdout } = await runCapture(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: sourceRoot, label: 'inventory prospective committed files', echo: false },
  );
  const files = stdout.split('\0').filter(Boolean).map(normalizeRelative);
  invariant(files.length > 0, 'Git prospective file inventory is empty');
  return files;
}

export function inspectProspectiveEntries(entries) {
  return {
    files: entries.map(({ file }) => normalizeRelative(file)).filter(shouldIncludeProspectiveFile),
    findings: findSecretFindings(entries),
  };
}

export function inspectProspectiveFiles(files, root = sourceRoot) {
  const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.ico']);
  const entries = files
    .map((file) => ({ file, absolute: path.join(root, file) }))
    .filter(({ absolute }) => existsSync(absolute) && statSync(absolute).isFile())
    // Scan all text, including large evidence logs; size must never exempt secrets.
    .map(({ file, absolute }) => ({
      file,
      content: !binaryExtensions.has(path.extname(file).toLowerCase())
        ? readFileSync(absolute, 'utf8') : '',
    }));
  return inspectProspectiveEntries(entries);
}

function createCleanCopy(files) {
  cleanRoot = mkdtempSync(path.join(tmpdir(), 'nycpr-submission-'));
  for (const relativePath of files) {
    const source = path.join(sourceRoot, relativePath);
    invariant(existsSync(source), `Prospective committed file is missing: ${relativePath}`);
    invariant(!lstatSync(source).isSymbolicLink(), `Symlinks are not allowed in the submission copy: ${relativePath}`);
    const destination = path.join(cleanRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  record(`Clean prospective repository copied (${files.length} files)`);
}

function requireNonEmptyFile(root, relativePath) {
  const target = path.join(root, relativePath);
  invariant(existsSync(target), `Required deliverable is missing: ${relativePath}`);
  invariant(statSync(target).isFile(), `Required deliverable is not a file: ${relativePath}`);
  invariant(statSync(target).size > 0, `Required deliverable is empty: ${relativePath}`);
}

function walkFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  };
  visit(root);
  return result;
}

// Exact file/value exceptions for the public local Compose credentials and
// existing synthetic test inputs. Never exempt a whole test or evidence file.
const PUBLIC_SECRET_EXAMPLES = new Map([
  ['docker-compose.yml', ['postgresql://nycpr:nycpr@postgres:5432/nyc_property_resolver']],
  ['scripts/verify-runtime-config.mjs', ['postgresql://nycpr:nycpr@postgres:5432/nyc_property_resolver', 'runtime-token-sentinel']],
  ...['harness.yaml', 'scripts/verify-foundation.mjs', 'scripts/verify-property-resolution.mjs', 'scripts/verify-ingestion-lifecycle.mjs', 'scripts/verify-ingestion-publication.mjs'].map((file) => [file, ['postgresql://validation:validation@127.0.0.1:1/validation?schema=public']]),
  ['tests/unit/operations/scheduler.test.ts', ['postgresql://log-user:connection-sentinel@example.invalid/log-db', 'token-sentinel-operations']],
  ['tests/unit/operations/ingest-ecb-cli.test.ts', ['postgresql://cli-user:cli-secret@example.invalid/cli-db', 'cli-token-sentinel']],
  ['tests/unit/http/security-error-middleware.test.ts', ['postgresql://app:secret@localhost:5432/test', 'postgresql://app:cause-secret@localhost/database']],
  ['tests/unit/foundation/logger.test.ts', ['postgresql://app:super-secret@db.example:5432/nyc_property_resolver', 'postgresql://app:another-secret@localhost:5432/db']],
  ['tests/unit/foundation/config.test.ts', ['postgresql://app:secret@localhost:5432/nyc_property_resolver', 'test-token']],
  ...['condominiums', 'condo-units', 'pluto', 'building-footprints'].map((client) => [`tests/unit/clients/${client}.client.test.ts`, ['test-token']]),
  ['tests/harness/test_verifier.py', ['postgresql://validation:validation@127.0.0.1:1/validation', 'postgresql://ambient:ambient@localhost:5432/ambient', 'postgresql://real:real@postgres:5432/app']],
]);

function isPublicSecretExample(file, value) {
  return /^(?:example|placeholder|redacted|\[Redacted\]|your-token-here|\$\{[A-Z_][A-Z_0-9]*(?::-)?\}|<[^>]+>)$/i.test(value)
    || PUBLIC_SECRET_EXAMPLES.get(file)?.includes(value)
    // The allowlist itself necessarily contains these exact public values.
    || (file === 'scripts/final-submission-gate.mjs'
      && [...PUBLIC_SECRET_EXAMPLES.values()].some((values) => values.includes(value)));
}

export function findSecretFindings(entries) {
  const findings = [];
  const highConfidencePatterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['GitHub token', /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];
  const assignedSecret = /(?<!\$\{)\b(?:SOCRATA_APP_TOKEN|X-App-Token|API_TOKEN|ACCESS_TOKEN|SECRET_KEY|CLIENT_SECRET)["']?[ \t]*(?::|=(?![=>]))[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'#},;]+))/gi;
  const databaseCredential = /\bpostgres(?:ql)?:\/\/[^\s"'`<>/@]+:[^\s"'`<>/@]+@[^\s"'`<>),;]+/gi;

  for (const { file, content } of entries) {
    const normalized = normalizeRelative(file);
    const basename = path.posix.basename(normalized).toLowerCase();
    if ((basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example'))) {
      findings.push(`${normalized}: committed runtime environment file`);
    }
    for (const [label, pattern] of highConfidencePatterns) {
      if (pattern.test(content)) findings.push(`${normalized}: ${label}`);
    }
    for (const match of content.matchAll(assignedSecret)) {
      const value = (match[1] ?? match[2] ?? match[3]).trim();
      const reference = match[3] && /^(?:(?:this|process\.env|env)\.[\w.]+|optionalSecret)$/.test(value);
      if (value && !reference && !isPublicSecretExample(normalized, value)) {
        findings.push(`${normalized}: non-empty secret assignment`);
      }
    }
    for (const [value] of content.matchAll(databaseCredential)) {
      if (!isPublicSecretExample(normalized, value)) findings.push(`${normalized}: database credential`);
    }
  }
  return [...new Set(findings)];
}

function validateSecrets(root) {
  const { findings } = inspectProspectiveFiles(
    walkFiles(root).map((file) => path.relative(root, file)), root,
  );
  invariant(findings.length === 0, `Secret scan failed:\n- ${findings.join('\n- ')}`);
  record('Secret scan passed');
}

function localMarkdownTargets(markdown) {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, '').split('#')[0])
    .filter((target) => target && !/^(?:https?:|mailto:)/i.test(target));
}

function validateMarkdownLinks(root, relativePath) {
  const markdown = readFileSync(path.join(root, relativePath), 'utf8');
  for (const target of localMarkdownTargets(markdown)) {
    const resolved = path.resolve(path.dirname(path.join(root, relativePath)), decodeURIComponent(target));
    invariant(resolved.startsWith(`${path.resolve(root)}${path.sep}`), `${relativePath} links outside the repository: ${target}`);
    invariant(existsSync(resolved), `${relativePath} has a stale local link: ${target}`);
  }
}

function commandEquals(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((part, index) => part === expected[index]);
}

export function validateDocumentedCommands({ readme, packageJson, composeConfig }) {
  const errors = [];
  const expect = (condition, message) => { if (!condition) errors.push(message); };
  const services = composeConfig?.services ?? {};
  // Inspect every command, not just the presence of a correct example. Keep the
  // evaluator path explicit: alternate startup/worker invocations need review.
  const commandText = readme.replace(/\\\r?\n\s*/g, ' ');
  const composeCommands = [...commandText.matchAll(/\bdocker(?:[ \t]+compose|-compose)\b[^\r\n`;|&#]*/g)]
    .map(([command]) => command.trim().replace(/[ \t]+/g, ' '));
  const startup = 'docker compose up --build';
  const manual = 'docker compose run --rm worker npm run ingest:ecb';
  expect(composeCommands.includes(startup), 'README must document docker compose up --build');
  expect(
    composeCommands.includes(manual),
    'README must document the worker manual-ingestion command',
  );
  for (const command of composeCommands) {
    if (/\b(?:up|start|restart|run|exec)\b/.test(command)) {
      expect(command === startup || command === manual,
        `README has a stale or unsupported startup/manual-ingestion command: ${command}`);
    }
  }
  for (const [, script] of commandText.matchAll(/\bnpm[ \t]+(?:run|run-script)[ \t]+([\w:.-]+)/g)) {
    expect(Object.hasOwn(packageJson.scripts ?? {}, script), `README references a stale package command: ${script}`);
  }
  expect(!/\bnpm[ \t]+start\b/.test(commandText), 'README must use the documented Docker startup command');
  expect(packageJson.scripts?.['start:api'] === 'node dist/server.js', 'start:api package entrypoint is stale');
  expect(
    packageJson.scripts?.['start:worker'] === 'node dist/workers/ingestion.worker.js',
    'start:worker package entrypoint is stale',
  );
  expect(packageJson.scripts?.['ingest:ecb'] === 'node dist/cli/ingest-ecb.js', 'ingest:ecb package entrypoint is stale');
  expect(
    commandEquals(services.migrate?.command, ['npx', 'prisma', 'migrate', 'deploy']),
    'Compose migrate command must run prisma migrate deploy',
  );
  expect(
    commandEquals(services.api?.command, ['npm', 'run', 'start:api']),
    'Compose api command does not match start:api',
  );
  expect(
    commandEquals(services.worker?.command, ['npm', 'run', 'start:worker']),
    'Compose worker command does not match start:worker',
  );
  expect(
    Array.isArray(services.postgres?.healthcheck?.test) && services.postgres.healthcheck.test.length > 0,
    'Compose postgres service must define a healthcheck',
  );
  expect(
    services.migrate?.depends_on?.postgres?.condition === 'service_healthy',
    'Compose migrate must wait for healthy postgres',
  );
  expect(
    services.api?.depends_on?.migrate?.condition === 'service_completed_successfully',
    'Compose api must wait for migrate completion',
  );
  expect(
    services.worker?.depends_on?.migrate?.condition === 'service_completed_successfully',
    'Compose worker must wait for migrate completion',
  );
  return errors;
}

function validateArtifacts(root, composeConfig) {
  for (const file of REQUIRED_FILES) requireNonEmptyFile(root, file);
  const sourceFiles = walkFiles(path.join(root, 'src')).filter((file) => file.endsWith('.ts'));
  invariant(sourceFiles.length > 0, 'TypeScript application code is missing');

  const seed = readJson(root, 'seed/acceptance-properties.json');
  invariant(Array.isArray(seed.properties), 'Small acceptance seed must contain properties');
  invariant(seed.properties.length >= 5 && seed.properties.length <= 8, 'Small acceptance seed must contain 5-8 properties');
  const tags = new Set(seed.properties.flatMap((property) => property.requirementTags ?? []));
  for (const tag of REQUIRED_FIXTURE_TAGS) invariant(tags.has(tag), `Small acceptance seed is missing tag: ${tag}`);
  invariant(
    seed.properties.some((property) => /350\s+5th Avenue/i.test(property.originalInput ?? '')),
    'Small acceptance seed is missing 350 5th Avenue, Manhattan',
  );

  const scaleSeed = readJson(root, 'seed/scale-10000-bbls.json');
  invariant(Array.isArray(scaleSeed.bbls) && scaleSeed.bbls.length === 10_000, 'Scale seed must contain exactly 10,000 BBLs');
  invariant(new Set(scaleSeed.bbls).size === 10_000, 'Scale seed BBLs must be unique');
  invariant(scaleSeed.bbls.every((bbl) => /^[1-5]\d{9}$/.test(bbl)), 'Scale seed contains an invalid canonical BBL');

  const behaviorText = REQUIRED_FILES
    .filter((file) => file.startsWith('tests/'))
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  for (const [label, pattern] of [
    ['address normalization', /normaliz/i],
    ['resolver idempotency', /idempoten|reuses stored propert/i],
    ['ingestion upsert/publication', /upsert|promot/i],
    ['coverage metadata states', /checked-empty|NOT_CHECKED|failed coverage/i],
    ['local-only ECB query seam', /never invokes external NYC clients/i],
  ]) invariant(pattern.test(behaviorText), `Behavior tests do not cover ${label}`);

  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const packageJson = readJson(root, 'package.json');
  const commandErrors = validateDocumentedCommands({ readme, packageJson, composeConfig });
  invariant(commandErrors.length === 0, `Documentation/entrypoint validation failed:\n- ${commandErrors.join('\n- ')}`);

  for (const document of ['README.md', 'DESIGN.md', 'RUN_LOG.md']) validateMarkdownLinks(root, document);

  const scale = readJson(root, 'evidence/scale-10000/summary.json');
  const docs = ['README.md', 'DESIGN.md', 'RUN_LOG.md']
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  for (const value of [
    scale.sample?.requestedProperties,
    scale.sample?.uniqueProperties,
    scale.ingestion?.uniqueValidBins,
    scale.ingestion?.socrataTotalCalls,
    scale.ingestion?.rowsPromoted,
    scale.failures?.bulkRegistration,
  ]) invariant(Number.isInteger(value) && docs.includes(value.toLocaleString('en-US')), `S5 documentation does not reference scale metric ${value}`);
  record('Deliverables, documented commands, behavior tests, and S5 references passed');
}

export function buildComposeEnvironment(hostEnv, projectName) {
  const env = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value !== undefined && COMPOSE_HOST_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    API_HOST_PORT: '0',
    COMPOSE_PROJECT_NAME: projectName,
    SOCRATA_APP_TOKEN: '',
  };
}

function composeEnv() {
  return buildComposeEnvironment(process.env, composeProject);
}

async function loadComposeConfig() {
  const result = await runCapture(
    'docker',
    ['compose', '-f', 'docker-compose.yml', 'config', '--format', 'json'],
    {
      cwd: cleanRoot,
      env: composeEnv(),
      label: 'render isolated Compose configuration',
      timeoutMs: 60_000,
      echo: false,
    },
  );
  const config = JSON.parse(result.stdout);
  invariant(
    config.services?.worker?.environment?.SOCRATA_APP_TOKEN === '',
    'Isolated Compose configuration must use an empty Socrata token',
  );
  record('Compose configuration rendered without caller application settings');
  return config;
}

function compose(args, options = {}) {
  composeMayExist = true;
  return runCapture('docker', ['compose', '-f', 'docker-compose.yml', ...args], {
    cwd: cleanRoot,
    env: composeEnv(),
    ...options,
  });
}

async function cleanupCompose() {
  if (!composeMayExist || !cleanRoot || !composeProject) return;
  try {
    await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], {
      label: 'tear down isolated Compose project and volumes',
      timeoutMs: 120_000,
      echo: false,
    });
  } catch (error) {
    record(`CLEANUP ERROR ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    composeMayExist = false;
  }
}

function parsePublishedPort(output) {
  const line = output.trim().split(/\r?\n/).find(Boolean);
  invariant(line, 'Compose did not publish api port 3000');
  const match = line.match(/:(\d+)$/);
  invariant(match, `Unexpected Compose port output: ${line}`);
  return Number(match[1]);
}

async function waitForHealth(baseUrl, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/health`, {}, 3_000);
      if (response.ok && (await response.json())?.status === 'ok') return;
    } catch {
      // Bounded retry while Compose completes startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`API did not become healthy within ${timeoutMs} ms`);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function assertComposeReadiness({ includeWorker, execute }) {
  const running = await execute(['ps', '--status', 'running', '--services'], { echo: false });
  const services = new Set(running.stdout.split(/\r?\n/).filter(Boolean));
  for (const service of ['postgres', 'api', ...(includeWorker ? ['worker'] : [])]) invariant(services.has(service), `Compose service is not running: ${service}`);
  invariant(includeWorker || !services.has('worker'), 'Scheduled worker must not run against the behavior-test database');
  const all = await execute(['ps', '--all', '--format', 'json'], { echo: false });
  const records = all.stdout.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const parsed = JSON.parse(line);
    return Array.isArray(parsed) ? parsed : [parsed];
  });
  const migrate = records.find((record) => record.Service === 'migrate');
  invariant(migrate, 'Compose migrate service was not created');
  invariant(Number(migrate.ExitCode) === 0, `Compose migrate service did not exit successfully: ${migrate.ExitCode}`);
}

export async function startCleanRuntime(label, {
  includeWorker = true,
  execute = compose,
  waitForApi = waitForHealth,
} = {}) {
  // Targeting api starts its postgres/migrate dependencies without the scheduler.
  await execute(['up', '--build', '--detach', ...(includeWorker ? [] : ['api'])], { label, timeoutMs: 15 * 60_000 });
  const portResult = await execute(['port', 'api', '3000'], { echo: false });
  const baseUrl = `http://127.0.0.1:${parsePublishedPort(portResult.stdout)}`;
  await waitForApi(baseUrl);
  await assertComposeReadiness({ includeWorker, execute });
  record(`Clean runtime ready at ${baseUrl}`);
  return baseUrl;
}

async function runCleanBehaviorSuite() {
  const composeYamlB64 = Buffer.from(readFileSync(path.join(cleanRoot, 'docker-compose.yml'))).toString('base64');
  await compose(
    ['run', '--rm', '--no-deps', 'api', 'npm', 'run', 'typecheck'],
    { label: 'typecheck inside clean application image', timeoutMs: 10 * 60_000 },
  );
  await compose(
    ['run', '--rm', '--no-deps', 'api', 'npx', 'prisma', 'validate'],
    { label: 'Prisma schema validation inside clean application image', timeoutMs: 5 * 60_000 },
  );
  const runJest = (label, testPaths, environment = []) => compose(
    [
      'run', '--rm', '--no-deps',
      '--volume', `${path.join(cleanRoot, 'seed')}:/app/seed:ro`,
      '--volume', `${path.join(cleanRoot, 'evidence')}:/app/evidence`,
      '--volume', `${path.join(cleanRoot, 'scripts', 'acceptance')}:/app/scripts/acceptance:ro`,
      ...environment.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      'api', 'npm', 'test', '--', '--runInBand', ...testPaths,
    ],
    { label, timeoutMs: 30 * 60_000 },
  );
  const resetDatabase = async (label) => {
    await compose(
      [
        'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'nycpr',
        '-d', 'nyc_property_resolver', '-c',
        'DROP/**/SCHEMA/**/public/**/CASCADE;CREATE/**/SCHEMA/**/public;',
      ],
      { label: `${label}: reset PostgreSQL schema`, timeoutMs: 120_000, echo: false },
    );
    await compose(['run', '--rm', 'migrate'], {
      label: `${label}: reapply migrations`,
      timeoutMs: 5 * 60_000,
      echo: false,
    });
  };

  await runJest('S0 unit behavior suite', ['tests/unit'], [['DATABASE_URL', '']]);
  await runJest(
    'S1 property resolution request validation and bulk behavior gate',
    ['tests/api/properties.single.test.ts', 'tests/api/properties.bulk.test.ts'],
    [['DATABASE_URL', '']],
  );

  await runJest(
    'S0 foundation integration gate',
    ['tests/integration/foundation/prisma-smoke.test.ts'],
    [['FOUNDATION_INTEGRATION', '1']],
  );

  await resetDatabase('S1 property resolution');
  await runJest(
    'S1 property resolution integration and HTTP gate',
    ['tests/integration/property-resolution', 'tests/api/properties.e2e.test.ts'],
    [['PROPERTY_RESOLUTION_INTEGRATION', '1']],
  );

  await resetDatabase('S2 ingestion lifecycle');
  await runJest(
    'S2 ingestion lifecycle behavior gate',
    ['tests/integration/ingestion/ingestion-lifecycle.behavior.test.ts'],
    [['INGESTION_LIFECYCLE_INTEGRATION', '1']],
  );

  await resetDatabase('S3 ingestion publication');
  await runJest(
    'S3 ingestion publication semantic suite',
    ['tests/integration/ingestion'],
    [['INGESTION_PUBLICATION_INTEGRATION', '1']],
  );

  await resetDatabase('S4 API operations');
  await runJest(
    'S4 API operations and local-only query gate',
    [
      'tests/integration/api/api-operations-gate.test.ts',
      'tests/integration/operations/scheduler-cli-gate.test.ts',
      'tests/submission/accepted-state-local-query.test.ts',
    ],
    [
      ['API_OPERATIONS_GATE', '1'],
      ['API_OPERATIONS_GATE_API_URL', 'http://api:3000'],
      ['API_OPERATIONS_GATE_COMPOSE_YAML_B64', composeYamlB64],
    ],
  );
  record('Clean-runtime typecheck and complete behavior suite passed');
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options, 120_000);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${options.method ?? 'GET'} ${url} returned non-JSON status ${response.status}: ${text.slice(0, 500)}`); }
  invariant(response.ok, `${options.method ?? 'GET'} ${url} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

export async function runManualReferenceIngestion({
  execute = (timeoutMs) => compose(
    ['run', '--rm', 'worker', 'npm', 'run', 'ingest:ecb'],
    { label: 'documented manual Empire State ingestion command', timeoutMs, acceptedExitCodes: [0, 2] },
  ),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = record,
  timeoutMs = 20 * 60_000,
  maxAttempts = 60,
  retryDelayMs = 5_000,
} = {}) {
  const deadline = now() + timeoutMs;
  for (let attempt = 1; attempt <= maxAttempts && now() < deadline; attempt += 1) {
    const ingestion = await execute(deadline - now());
    const records = `${ingestion.stdout}\n${ingestion.stderr}`.split(/\r?\n/)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    const completion = records.findLast((entry) => entry.outcome !== undefined);
    if (ingestion.status === 0 && completion?.outcome === 'COMPLETED' && completion?.status === 'COMPLETED') return completion;
    invariant(ingestion.status === 2 && completion?.outcome === 'ACTIVE_EXECUTOR',
      `Manual ingestion did not complete (exit ${ingestion.status}): ${JSON.stringify(completion)}`);
    log(`Manual ingestion attempt ${attempt}: ACTIVE_EXECUTOR; waiting for scheduled execution to release authority`);
    if (attempt < maxAttempts && now() < deadline) await sleep(Math.min(retryDelayMs, deadline - now()));
  }
  throw new Error(`Manual ingestion remained blocked by ACTIVE_EXECUTOR (bound: ${maxAttempts} attempts / ${timeoutMs} ms)`);
}

async function runReferenceFlow(baseUrl) {
  const property = await fetchJson(`${baseUrl}/properties`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: '350 5th Avenue, Manhattan, NY' }),
  });
  invariant(typeof property.id === 'string' && property.id.length > 0, 'Empire State resolution did not return a property ID');
  invariant(property.bbl === '1008350041', `Empire State resolution returned unexpected BBL: ${property.bbl}`);
  invariant(Array.isArray(property.bins) && property.bins.includes('1015862'), 'Empire State resolution did not return BIN 1015862');

  await runManualReferenceIngestion();

  const result = await fetchJson(`${baseUrl}/properties/${property.id}/ecb-violations?limit=100`);
  invariant(Array.isArray(result.violations), 'Local ECB query did not return a violations array');
  invariant(result.violations.length > 0, 'Empire State local ECB query returned no accepted violations');
  invariant(result.coverage?.status === 'CHECKED', `Local ECB query coverage is not CHECKED: ${JSON.stringify(result.coverage)}`);
  invariant(Number.isFinite(Date.parse(result.coverage.lastSuccessAt)), 'Local ECB query is missing lastSuccessAt freshness');
  invariant(Number.isFinite(Date.parse(result.coverage.sourceWatermarkAt)), 'Local ECB query is missing sourceWatermarkAt freshness');
  invariant(result.page?.limit === 100, 'Local ECB query pagination metadata is invalid');
  record(`Empire State reference flow passed: ${result.violations.length} first-page rows, coverage ${result.coverage.status}, watermark ${result.coverage.sourceWatermarkAt}`);
  record('Local-only query proof passed against CHECKED accepted state through external-client/fetch instrumentation in the clean behavior suite');
}

async function validateEvidence(root) {
  await runCapture('node', ['scripts/acceptance/validate-small-evidence.mjs', 'evidence/acceptance-small/run'], {
    cwd: root,
    label: 'mechanically validate committed small-run evidence',
  });
  await runCapture('node', ['scripts/acceptance/validate-scale-evidence.mjs', 'evidence/scale-10000'], {
    cwd: root,
    label: 'mechanically validate committed 10,000-BBL scale evidence',
  });
}

function removeCleanDirectory() {
  if (!cleanRoot) return;
  const resolved = realpathSync(cleanRoot);
  const expectedPrefix = path.join(realpathSync(tmpdir()), 'nycpr-submission-');
  invariant(resolved.startsWith(expectedPrefix), `Refusing to remove unexpected temporary path: ${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
  cleanRoot = undefined;
}

async function main() {
  const prospective = await prospectiveFiles();
  const inspection = inspectProspectiveFiles(prospective);
  invariant(
    inspection.findings.length === 0,
    `Prospective repository secret scan failed:\n- ${inspection.findings.join('\n- ')}`,
  );
  record('Prospective repository secret scan passed before local-state filtering');
  createCleanCopy(inspection.files);
  composeProject = `nycpr-submission-${randomBytes(5).toString('hex')}`;
  validateSecrets(cleanRoot);
  await validateEvidence(cleanRoot);
  await runCapture('docker', ['info'], { cwd: cleanRoot, label: 'Docker availability', timeoutMs: 60_000, echo: false });
  const composeConfig = await loadComposeConfig();
  validateArtifacts(cleanRoot, composeConfig);

  await startCleanRuntime('isolated behavior runtime without scheduled ingestion', { includeWorker: false });
  await runCleanBehaviorSuite();
  await cleanupCompose();

  const baseUrl = await startCleanRuntime('documented one-command Compose startup for real Empire State flow (fresh storage)');
  await runReferenceFlow(baseUrl);
  record('FINAL SUBMISSION GATE PASSED');
}

async function execute() {
  let failure;
  try {
    await main();
  } catch (error) {
    failure = error;
    record(`FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } finally {
    try { await cleanupCompose(); } catch (error) { failure ??= error; }
    try { removeCleanDirectory(); } catch (error) { failure ??= error; }
  }

  if (failure) {
    writeFileSync(FAILURE_LOG_PATH, `${diagnosticLines.join('\n')}\n`, 'utf8');
    console.error(`Concise failure log: ${FAILURE_LOG_PATH}`);
    throw failure;
  }
  if (existsSync(FAILURE_LOG_PATH)) rmSync(FAILURE_LOG_PATH, { force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await execute().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
