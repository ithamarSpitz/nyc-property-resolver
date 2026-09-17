#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVIDENCE_PATHS,
  assertNoValidationErrors,
  validateEvidenceDirectory,
  validateSeedDocument,
} from './lib/contract.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const SEED_PATH = path.join(REPOSITORY_ROOT, 'seed/acceptance-properties.json');
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_ENDPOINT = 100;
const HTTP_TIMEOUT_MS = 60_000;

function parseArguments(argv) {
  const options = {
    check: false,
    apiBaseUrl: process.env.ACCEPTANCE_API_BASE_URL ?? 'http://localhost:3000',
    evidenceDirectory: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--api-base-url') {
      options.apiBaseUrl = argv[++index];
    } else if (argument.startsWith('--api-base-url=')) {
      options.apiBaseUrl = argument.slice('--api-base-url='.length);
    } else if (argument === '--evidence-dir') {
      options.evidenceDirectory = argv[++index];
    } else if (argument.startsWith('--evidence-dir=')) {
      options.evidenceDirectory = argument.slice('--evidence-dir='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.apiBaseUrl) throw new Error('--api-base-url requires a value');
  if (argv.includes('--evidence-dir') && !options.evidenceDirectory) throw new Error('--evidence-dir requires a value');
  return options;
}

function readSeed() {
  return JSON.parse(readFileSync(SEED_PATH, 'utf8'));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function evidencePath(root, key) {
  return path.join(root, EVIDENCE_PATHS[key]);
}

function defaultEvidenceDirectory() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(REPOSITORY_ROOT, 'evidence/runs', `small-${timestamp}`);
}

function prepareEvidenceDirectory(directory) {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`Evidence directory must be new or empty: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });
}

function shellDisplay(command, args) {
  const quote = (value) => (/^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value));
  return [command, ...args].map(quote).join(' ');
}

function commandDocument(command, args) {
  return { command, args, display: shellDisplay(command, args) };
}

function runLoggedCommand(command, args, logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      const output = Buffer.concat(chunks);
      writeFileSync(logPath, output.length > 0 ? output : Buffer.from('[no output]\n'));
      resolve({ exitCode, signal, output: output.toString('utf8') });
    });
  });
}

function extractJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Docker/npm may prefix structured output. Line parsing below handles those cases.
        }
        start = -1;
      }
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    try {
      objects.push(JSON.parse(line.slice(jsonStart)));
    } catch {
      // Non-JSON console output is preserved in the log but is not summary data.
    }
  }
  return objects;
}

function parseSourceContract(output) {
  const result = extractJsonObjects(output).findLast(
    (candidate) => candidate?.valid !== undefined && candidate?.sourceIdField,
  );
  if (!result) throw new Error('Source-contract command did not emit its JSON verification result');
  return result;
}

function parseIngestionSummary(output) {
  const result = extractJsonObjects(output).findLast(
    (candidate) => candidate?.runId && candidate?.status && candidate?.rowsFetched !== undefined,
  );
  if (!result) throw new Error('Ingestion command did not emit a fixed-field run summary');
  const metricNames = [
    'binsScanned',
    'socrataDataCalls',
    'socrataMetadataCalls',
    'socrataRetryCalls',
    'socrataTotalCalls',
    'rowsFetched',
    'rowsWritten',
    'failures',
  ];
  const metrics = Object.fromEntries(metricNames.map((name) => [name, result[name]]));
  if (metricNames.some((name) => !Number.isInteger(metrics[name]) || metrics[name] < 0)) {
    throw new Error('Ingestion summary omitted one or more fixed numeric metrics');
  }
  return { runId: result.runId, status: result.status, outcome: result.outcome, metrics };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${url} returned non-JSON HTTP ${response.status}`);
  }
  return { httpStatus: response.status, headers: Object.fromEntries(response.headers), body };
}

async function waitForHealth(apiBaseUrl) {
  const url = new URL('/health', apiBaseUrl).toString();
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(url);
      if (result.httpStatus === 200 && result.body?.status === 'ok') return { requestedAt: new Date().toISOString(), request: { method: 'GET', url }, response: result.body, httpStatus: result.httpStatus, responseHeaders: result.headers };
      lastError = new Error(`health returned HTTP ${result.httpStatus}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`API health check failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function registerSeed(apiBaseUrl, seed) {
  const url = new URL('/properties', apiBaseUrl).toString();
  const entries = [];
  for (const fixture of seed.properties) {
    const request = { [fixture.inputType]: fixture.originalInput };
    const requestedAt = new Date().toISOString();
    const result = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const entry = {
      fixtureId: fixture.id,
      requestedAt,
      respondedAt: new Date().toISOString(),
      request: { method: 'POST', url, body: request },
      httpStatus: result.httpStatus,
      responseHeaders: result.headers,
      response: result.body,
    };
    entries.push(entry);
    if (result.httpStatus !== 200) throw new Error(`Property registration failed for ${fixture.id} with HTTP ${result.httpStatus}`);
  }
  return { capturedAt: new Date().toISOString(), entries };
}

async function fetchPaginated(urlForCursor) {
  const pages = [];
  const requests = [];
  let cursor;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_ENDPOINT; pageNumber += 1) {
    const url = urlForCursor(cursor);
    const requestedAt = new Date().toISOString();
    const result = await fetchJson(url);
    requests.push({ pageNumber, requestedAt, respondedAt: new Date().toISOString(), method: 'GET', url, httpStatus: result.httpStatus });
    if (result.httpStatus !== 200) throw new Error(`Stored-result query failed with HTTP ${result.httpStatus}: ${url}`);
    pages.push(result.body);
    if (!result.body?.page?.hasMore) return { requests, pages };
    cursor = result.body.page.nextCursor;
    if (!cursor) throw new Error(`Paginated response reported hasMore without nextCursor: ${url}`);
  }
  throw new Error(`Stored-result query exceeded ${MAX_PAGES_PER_ENDPOINT} pages`);
}

async function captureApiSnapshot(apiBaseUrl, registrations) {
  const properties = [];
  for (const registration of registrations.entries) {
    const propertyId = registration.response.id;
    const snapshot = await fetchPaginated((cursor) => {
      const url = new URL(`/properties/${propertyId}/ecb-violations`, apiBaseUrl);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor) url.searchParams.set('cursor', cursor);
      return url.toString();
    });
    properties.push({ fixtureId: registration.fixtureId, propertyId, ...snapshot });
  }

  const portfolio = await fetchPaginated((cursor) => {
    const url = new URL('/ecb-violations', apiBaseUrl);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);
    return url.toString();
  });
  const capturedAt = new Date().toISOString();
  return {
    properties: { capturedAt, properties },
    portfolio: { capturedAt, ...portfolio },
  };
}

function sourceWatermarks(propertySnapshot) {
  return [...new Set(propertySnapshot.properties.flatMap((property) => property.pages.map((page) => page.coverage?.sourceWatermarkAt).filter(Boolean)))].sort();
}

function auditSnapshot(snapshot) {
  const propertyResultRows = snapshot.properties.properties.reduce(
    (total, property) => total + property.pages.reduce((count, page) => count + page.violations.length, 0),
    0,
  );
  const portfolioSourceIds = snapshot.portfolio.pages.flatMap((page) => page.violations.map((violation) => violation.sourceId));
  const uniqueIds = new Set(portfolioSourceIds);
  return {
    propertyResultRows,
    portfolioResultRows: portfolioSourceIds.length,
    portfolioUniqueSourceIds: uniqueIds.size,
    duplicateSourceIdCount: portfolioSourceIds.length - uniqueIds.size,
  };
}

function subtraction(second, baseline) {
  return {
    propertyResultRows: second.propertyResultRows - baseline.propertyResultRows,
    portfolioResultRows: second.portfolioResultRows - baseline.portfolioResultRows,
    portfolioUniqueSourceIds: second.portfolioUniqueSourceIds - baseline.portfolioUniqueSourceIds,
  };
}

async function executeIngestion(root, label, directoryKey, logKey, commandKey) {
  const args = ['compose', 'run', '--rm', 'worker', 'npm', 'run', 'ingest:ecb'];
  const command = commandDocument('docker', args);
  writeJson(evidencePath(root, commandKey), command);
  const startedAt = new Date().toISOString();
  const execution = await runLoggedCommand('docker', args, evidencePath(root, logKey));
  const finishedAt = new Date().toISOString();
  if (execution.exitCode !== 0) throw new Error(`${label} ingestion exited with code ${execution.exitCode}${execution.signal ? ` (${execution.signal})` : ''}`);
  const parsed = parseIngestionSummary(execution.output);
  if (parsed.status !== 'COMPLETED') throw new Error(`${label} ingestion ended with status ${parsed.status}`);
  return { label, startedAt, finishedAt, ...parsed, command, sourceWatermarks: [] };
}

function runOfflineCheck(seed) {
  assertNoValidationErrors(validateSeedDocument(seed), 'acceptance seed validation');
  const misplacedCondoUnit = structuredClone(seed);
  const condo = misplacedCondoUnit.properties.find((fixture) => fixture.requirementTags.includes('condominium_unit'));
  condo.originalInput = '20 West Street Apt 12C, Manhattan, NY';
  if (!validateSeedDocument(misplacedCondoUnit).some((error) => error.includes('resolver-supported unit designator'))) {
    throw new Error('Seed validator self-check did not reject a non-terminal condo unit designator');
  }

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'nycpr-acceptance-contract-'));
  try {
    writeJson(evidencePath(temporaryDirectory, 'seed'), seed);
    const incompletePropertySnapshot = {
      properties: seed.properties.map((fixture) => ({
        fixtureId: fixture.id,
        propertyId: `property-${fixture.id}`,
        pages: [{ violations: [], page: {}, coverage: {} }],
      })),
    };
    writeJson(evidencePath(temporaryDirectory, 'baselineProperties'), incompletePropertySnapshot);
    writeJson(evidencePath(temporaryDirectory, 'secondProperties'), incompletePropertySnapshot);
    writeJson(evidencePath(temporaryDirectory, 'baselinePortfolio'), { pages: [{ violations: [], page: {} }] });
    writeJson(evidencePath(temporaryDirectory, 'secondPortfolio'), { pages: [{ violations: [], page: {} }] });
    writeJson(evidencePath(temporaryDirectory, 'duplicateAudit'), {
      baseline: { propertyResultRows: 0, portfolioResultRows: 0, portfolioUniqueSourceIds: 0, duplicateSourceIdCount: 0 },
      secondRun: { propertyResultRows: 0, portfolioResultRows: 0, portfolioUniqueSourceIds: 0, duplicateSourceIdCount: 0 },
      delta: { propertyResultRows: 0, portfolioResultRows: 0, portfolioUniqueSourceIds: 0 },
      idempotentNoDuplicateGrowth: false,
    });
    writeJson(evidencePath(temporaryDirectory, 'summary'), { rowCountDeltas: {} });

    const errors = validateEvidenceDirectory(temporaryDirectory);
    for (const expected of ['source-contract log', 'baseline ingestion log', 'second-run ingestion log', 'BIS spot-check evidence']) {
      if (!errors.some((error) => error.includes(expected))) throw new Error(`Evidence validator self-check did not reject missing ${expected}`);
    }
    for (const expected of [
      'pagination for empire-state-building page 1.limit',
      'coverage for empire-state-building page 1.status',
      'baseline property API snapshot for empire-state-building.requests must be a non-empty array',
      'baseline portfolio API snapshot.requests must be a non-empty array',
      'duplicate audit must demonstrate idempotent no-duplicate growth',
      'summary rowCountDeltas.propertyResultRows',
    ]) {
      if (!errors.some((error) => error.includes(expected))) throw new Error(`Evidence validator self-check did not reject incomplete ${expected}`);
    }

    const duplicatePortfolioSnapshot = {
      requests: [{
        pageNumber: 1,
        requestedAt: '2026-01-01T00:00:00.000Z',
        respondedAt: '2026-01-01T00:00:01.000Z',
        method: 'GET',
        url: 'http://localhost:3000/ecb-violations?limit=100',
        httpStatus: 200,
      }],
      pages: [{
        violations: [{ sourceId: 'duplicate-source-id' }, { sourceId: 'duplicate-source-id' }],
        page: { limit: 100, hasMore: false, nextCursor: null },
      }],
    };
    writeJson(evidencePath(temporaryDirectory, 'baselinePortfolio'), duplicatePortfolioSnapshot);
    const tamperedAuditErrors = validateEvidenceDirectory(temporaryDirectory);
    for (const expected of [
      'duplicate audit baseline.portfolioResultRows must match API snapshots',
      'duplicate audit baseline.portfolioUniqueSourceIds must match API snapshots',
      'duplicate audit baseline.duplicateSourceIdCount must match API snapshots',
      'duplicate audit baselineRunId must match baseline run',
    ]) {
      if (!tamperedAuditErrors.some((error) => error.includes(expected))) {
        throw new Error(`Evidence validator self-check did not reject tampered ${expected}`);
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`Small acceptance tooling check passed (${seed.properties.length} fixtures, no network activity).`);
}

async function runLive(options, seed) {
  const root = path.resolve(options.evidenceDirectory ?? defaultEvidenceDirectory());
  prepareEvidenceDirectory(root);
  const startedAt = new Date().toISOString();
  writeJson(evidencePath(root, 'seed'), seed);

  const commands = [];
  const sourceArgs = ['compose', 'run', '--rm', 'worker', 'npm', 'run', 'verify:ecb-source-contract'];
  const sourceCommand = commandDocument('docker', sourceArgs);
  commands.push(sourceCommand);
  writeJson(evidencePath(root, 'sourceCommand'), sourceCommand);
  const sourceExecution = await runLoggedCommand('docker', sourceArgs, evidencePath(root, 'sourceLog'));
  if (sourceExecution.exitCode !== 0) throw new Error(`ECB source-contract probe exited with code ${sourceExecution.exitCode}`);
  const sourceContract = parseSourceContract(sourceExecution.output);
  if (sourceContract.valid !== true) throw new Error('ECB source-contract probe reported an invalid source key');
  writeJson(evidencePath(root, 'sourceResult'), sourceContract);

  const health = await waitForHealth(options.apiBaseUrl);
  writeJson(evidencePath(root, 'health'), health);
  const registrations = await registerSeed(options.apiBaseUrl, seed);
  writeJson(evidencePath(root, 'registrations'), registrations);

  const baselineRun = await executeIngestion(root, 'baseline', 'baseline', 'baselineLog', 'baselineCommand');
  commands.push(baselineRun.command);
  const baselineSnapshot = await captureApiSnapshot(options.apiBaseUrl, registrations);
  baselineRun.sourceWatermarks = sourceWatermarks(baselineSnapshot.properties);
  writeJson(evidencePath(root, 'baselineRun'), baselineRun);
  writeJson(evidencePath(root, 'baselineProperties'), baselineSnapshot.properties);
  writeJson(evidencePath(root, 'baselinePortfolio'), baselineSnapshot.portfolio);

  const secondRun = await executeIngestion(root, 'second-run', 'secondRun', 'secondLog', 'secondCommand');
  commands.push(secondRun.command);
  const secondSnapshot = await captureApiSnapshot(options.apiBaseUrl, registrations);
  secondRun.sourceWatermarks = sourceWatermarks(secondSnapshot.properties);
  writeJson(evidencePath(root, 'secondRun'), secondRun);
  writeJson(evidencePath(root, 'secondProperties'), secondSnapshot.properties);
  writeJson(evidencePath(root, 'secondPortfolio'), secondSnapshot.portfolio);

  const baselineAudit = auditSnapshot(baselineSnapshot);
  const secondAudit = auditSnapshot(secondSnapshot);
  const delta = subtraction(secondAudit, baselineAudit);
  const duplicateAudit = {
    capturedAt: new Date().toISOString(),
    baselineRunId: baselineRun.runId,
    secondRunId: secondRun.runId,
    baseline: baselineAudit,
    secondRun: secondAudit,
    delta,
    idempotentNoDuplicateGrowth:
      baselineAudit.duplicateSourceIdCount === 0 &&
      secondAudit.duplicateSourceIdCount === 0 &&
      delta.portfolioResultRows === delta.portfolioUniqueSourceIds,
  };
  writeJson(evidencePath(root, 'duplicateAudit'), duplicateAudit);

  const summary = {
    schemaVersion: 1,
    status: 'acceptance-run-captured-awaiting-bis-spot-checks',
    startedAt,
    finishedAt: new Date().toISOString(),
    apiBaseUrl: options.apiBaseUrl,
    seed: { preparedAt: seed.preparedAt, fixtureCount: seed.properties.length, fixtureIds: seed.properties.map((fixture) => fixture.id) },
    sourceContract,
    runs: { baseline: baselineRun, secondRun },
    rowCountDeltas: delta,
    duplicateAudit: { idempotentNoDuplicateGrowth: duplicateAudit.idempotentNoDuplicateGrowth },
    commands,
  };
  writeJson(evidencePath(root, 'summary'), summary);

  console.log(`Small acceptance run evidence captured at ${root}`);
  console.log('BIS evidence was not created. Add two manual spot checks in S5-T2, then run acceptance:small:validate.');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const seed = readSeed();
  assertNoValidationErrors(validateSeedDocument(seed), 'acceptance seed validation');
  if (options.check) {
    runOfflineCheck(seed);
    return;
  }
  await runLive(options, seed);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
