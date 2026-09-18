#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertValidScaleEvidence } from './validate-scale-evidence.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const SEED_PATH = path.join(REPOSITORY_ROOT, 'seed/scale-10000-bbls.json');
const DEFAULT_EVIDENCE_DIRECTORY = path.join(REPOSITORY_ROOT, 'evidence/scale-10000');
const PLUTO_RESOURCE_URL = 'https://data.cityofnewyork.us/resource/64uk-42ks.json';
const COMMUNITY_DISTRICTS = Object.freeze(['102', '108']);
const REQUIRED_PROPERTY_COUNT = 10_000;
const BULK_REQUEST_SIZE = 200;
const VALID_BBL = /^[1-5]\d{9}$/;
const PLUTO_DECIMAL_BBL = /^([1-5]\d{9})(?:\.0+)?$/;
const VALID_BIN = /^[1-5]\d{6}$/;
const HTTP_TIMEOUT_MS = 30 * 60 * 1000;
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CONFIGURED_BOUNDS = Object.freeze({
  batchSize: 1_000,
  pageSize: 50_000,
  maxPagesPerBatch: 100,
  concurrency: 10,
  requestTimeoutMs: 15_000,
  maxRetries: 3,
  maxBatchAttemptsPerRun: 3,
  acceptedPublicationTransactionTimeoutMs: 60_000,
});

function parseArguments(argv) {
  const options = {
    evidenceDirectory: DEFAULT_EVIDENCE_DIRECTORY,
    apiBaseUrl: 'http://localhost:3000',
    composeProject: 'nyc-s5-t12-scale',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--validate-only') {
      options.validateOnly = true;
    } else if (argument === '--finalize-evidence') {
      options.finalizeEvidence = true;
    } else if (argument === '--evidence-dir') {
      options.evidenceDirectory = path.resolve(argv[++index]);
    } else if (argument.startsWith('--evidence-dir=')) {
      options.evidenceDirectory = path.resolve(argument.slice('--evidence-dir='.length));
    } else if (argument === '--api-base-url') {
      options.apiBaseUrl = argv[++index];
    } else if (argument.startsWith('--api-base-url=')) {
      options.apiBaseUrl = argument.slice('--api-base-url='.length);
    } else if (argument === '--compose-project') {
      options.composeProject = argv[++index];
    } else if (argument.startsWith('--compose-project=')) {
      options.composeProject = argument.slice('--compose-project='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.evidenceDirectory) throw new Error('--evidence-dir requires a value');
  if (!options.apiBaseUrl) throw new Error('--api-base-url requires a value');
  if (!COMPOSE_PROJECT_PATTERN.test(options.composeProject ?? '')) {
    throw new Error('--compose-project must contain only lowercase letters, numbers, underscores, or hyphens');
  }
  const apiUrl = new URL(options.apiBaseUrl);
  if (apiUrl.protocol !== 'http:' || apiUrl.hostname !== 'localhost' || apiUrl.port !== '3000') {
    throw new Error('The committed scale run must use http://localhost:3000');
  }
  return options;
}

function logProgress(message) {
  process.stdout.write(`[scale-10000] ${new Date().toISOString()} ${message}\n`);
}

function startHeartbeat(label) {
  logProgress(label);
  const timer = setInterval(() => {
    logProgress(`still ${label}`);
  }, 20_000);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return () => clearInterval(timer);
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function archiveExistingEvidence(directory) {
  if (!existsSync(directory)) return;
  const existingEntries = readdirSync(directory).filter((entry) => entry !== 'diagnostics');
  if (existingEntries.length === 0) return;

  const diagnosticsDirectory = path.join(directory, 'diagnostics');
  mkdirSync(diagnosticsDirectory, { recursive: true });
  const attemptPrefix = 'attempt-';
  const nextAttempt =
    readdirSync(diagnosticsDirectory)
      .filter((entry) => entry.startsWith(attemptPrefix))
      .map((entry) => Number.parseInt(entry.slice(attemptPrefix.length), 10))
      .filter((value) => Number.isInteger(value))
      .reduce((max, value) => Math.max(max, value), 0) + 1;
  const archiveDirectory = path.join(
    diagnosticsDirectory,
    `${attemptPrefix}${String(nextAttempt).padStart(2, '0')}`,
  );
  mkdirSync(archiveDirectory, { recursive: true });
  for (const entry of existingEntries) {
    const sourcePath = path.join(directory, entry);
    const destinationPath = path.join(archiveDirectory, entry);
    if (existsSync(destinationPath)) {
      throw new Error(`Cannot archive evidence because ${destinationPath} already exists`);
    }
    renameSync(sourcePath, destinationPath);
  }
}

function prepareEvidenceDirectory(directory) {
  archiveExistingEvidence(directory);
  mkdirSync(directory, { recursive: true });
}

function commandDocument(command, args) {
  const quote = (value) => (/^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value));
  return { command, args, display: [command, ...args].map(quote).join(' ') };
}

function commandEnvironment() {
  return {
    ...process.env,
    API_HOST_PORT: '3000',
    INGEST_INTERVAL_MS: '604800000',
    ECB_BATCH_SIZE: String(CONFIGURED_BOUNDS.batchSize),
    SOCRATA_PAGE_SIZE: String(CONFIGURED_BOUNDS.pageSize),
    SOCRATA_MAX_PAGES_PER_BATCH: String(CONFIGURED_BOUNDS.maxPagesPerBatch),
    SOCRATA_CONCURRENCY: String(CONFIGURED_BOUNDS.concurrency),
    SOCRATA_REQUEST_TIMEOUT_MS: String(CONFIGURED_BOUNDS.requestTimeoutMs),
    SOCRATA_MAX_RETRIES: String(CONFIGURED_BOUNDS.maxRetries),
    MAX_BATCH_ATTEMPTS_PER_RUN: String(CONFIGURED_BOUNDS.maxBatchAttemptsPerRun),
    ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS: String(
      CONFIGURED_BOUNDS.acceptedPublicationTransactionTimeoutMs,
    ),
  };
}

function runCommand(command, args, { logPath, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    logProgress(`starting ${command} ${args.join(' ')}`);
    if (logPath) {
      mkdirSync(path.dirname(logPath), { recursive: true });
      writeFileSync(logPath, '', 'utf8');
    }
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: commandEnvironment(),
      shell: false,
      windowsHide: true,
    });
    const chunks = [];
    const handleChunk = (chunk) => {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      process.stdout.write(buffer);
      if (logPath) {
        appendFileSync(logPath, buffer);
      }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      const output = Buffer.concat(chunks).toString('utf8');
      if (logPath && output.length === 0) {
        writeFileSync(logPath, '[no output]\n', 'utf8');
      }
      logProgress(`finished ${command} with code ${exitCode}${signal ? ` (${signal})` : ''}`);
      if (!allowFailure && exitCode !== 0) {
        reject(new Error(`${command} exited with code ${exitCode}${signal ? ` (${signal})` : ''}\n${output.slice(-4000)}`));
        return;
      }
      resolve({ exitCode, signal, output });
    });
  });
}

function composeArgs(project, ...args) {
  return ['compose', '-p', project, ...args];
}

function extractJsonLines(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      values.push(JSON.parse(line.slice(start)));
    } catch {
      // Preserve non-JSON command output in raw logs.
    }
  }
  return values;
}

async function fetchJson(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${url} returned non-JSON HTTP ${response.status}`);
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

function parseSourceInteger(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw.length === 0) return null;
  const integerPart = raw.split('.')[0];
  if (!/^\d+$/.test(integerPart)) return null;
  const parsed = Number.parseInt(integerPart, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBblComponents(bbl) {
  return {
    bbl,
    borough: Number.parseInt(bbl.slice(0, 1), 10),
    block: Number.parseInt(bbl.slice(1, 6), 10),
    lot: Number.parseInt(bbl.slice(6, 10), 10),
  };
}

function parsePlutoSeedRecord(record) {
  const bblMatch = PLUTO_DECIMAL_BBL.exec(String(record?.bbl ?? ''));
  if (!bblMatch) return null;
  const bbl = bblMatch[1];
  const borough = parseSourceInteger(record?.borocode);
  const block = parseSourceInteger(record?.block);
  const lot = parseSourceInteger(record?.lot);
  if (borough === null || block === null || lot === null) return null;
  const components = parseBblComponents(bbl);
  if (components.borough !== borough || components.block !== block || components.lot !== lot) {
    return null;
  }
  return { bbl, borough, block, lot };
}

async function selectScaleSeed() {
  logProgress('selecting 10,000 deterministic PLUTO BBLs');
  const queryParameters = {
    $select: 'bbl,cd,borocode,block,lot',
    $where:
      `cd in (${COMMUNITY_DISTRICTS.map((district) => `'${district}'`).join(',')})` +
      ' and bbl is not null and borocode is not null and block is not null and lot is not null',
    $order: 'bbl ASC',
    $limit: '50000',
  };
  const queryUrl = new URL(PLUTO_RESOURCE_URL);
  for (const [key, value] of Object.entries(queryParameters)) queryUrl.searchParams.set(key, value);
  const requestedAt = new Date().toISOString();
  const result = await fetchJson(queryUrl, {}, 60_000);
  const retrievedAt = new Date().toISOString();
  if (result.status !== 200 || !Array.isArray(result.body)) {
    throw new Error(`PLUTO scale selection failed with HTTP ${result.status}`);
  }

  const bbls = [];
  const seen = new Set();
  for (const row of result.body) {
    const communityDistrict = String(row?.cd ?? '').padStart(3, '0');
    if (!COMMUNITY_DISTRICTS.includes(communityDistrict)) continue;
    const seedRecord = parsePlutoSeedRecord(row);
    if (!seedRecord || seen.has(seedRecord.bbl)) continue;
    seen.add(seedRecord.bbl);
    bbls.push(seedRecord.bbl);
    if (bbls.length === REQUIRED_PROPERTY_COUNT) break;
  }
  if (bbls.length !== REQUIRED_PROPERTY_COUNT) {
    throw new Error(
      `Deterministic PLUTO query produced ${bbls.length} unique canonical BBLs; exactly 10,000 are required`,
    );
  }

  const seed = {
    schemaVersion: 1,
    dataset: {
      name: 'Primary Land Use Tax Lot Output (PLUTO)',
      id: '64uk-42ks',
      resourceUrl: PLUTO_RESOURCE_URL,
    },
    retrievedAt,
    requestedAt,
    communityDistricts: [...COMMUNITY_DISTRICTS],
    query: {
      url: queryUrl.toString(),
      parameters: queryParameters,
      selectionRule:
        'Select the first 10,000 unique canonical BBLs from live PLUTO in deterministic bbl ASC order using PLUTO-only parcel identity checks. Do not pre-screen with Building Footprints or downstream resolver success.',
    },
    selection: {
      requestedCount: REQUIRED_PROPERTY_COUNT,
      sourceRecordCount: result.body.length,
      selectedCount: bbls.length,
    },
    bbls,
  };
  writeJson(SEED_PATH, seed);
  logProgress(`selected ${seed.bbls.length} unique BBLs from ${seed.selection.sourceRecordCount} PLUTO rows`);
  return seed;
}

async function waitForHealth(apiBaseUrl) {
  const healthUrl = new URL('/health', apiBaseUrl).toString();
  const deadline = Date.now() + 120_000;
  const stopHeartbeat = startHeartbeat('waiting for API health');
  let lastError;
  try {
    while (Date.now() < deadline) {
    try {
      const result = await fetchJson(healthUrl, {}, 10_000);
      if (result.status === 200 && result.body?.status === 'ok') return result.body;
      lastError = new Error(`health returned HTTP ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`API did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  } finally {
    stopHeartbeat();
  }
}

async function registerProperties(apiBaseUrl, seed, evidenceDirectory) {
  const endpoint = new URL('/properties/bulk', apiBaseUrl).toString();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const requests = [];
  const results = [];
  const responseSummary = { submitted: 0, unique: 0, succeeded: 0, failed: 0, cached: 0 };
  let terminalHttpStatus = 200;

  for (let offset = 0; offset < seed.bbls.length; offset += BULK_REQUEST_SIZE) {
    const bbls = seed.bbls.slice(offset, offset + BULK_REQUEST_SIZE);
    const requestNumber = requests.length + 1;
    const totalRequests = Math.ceil(seed.bbls.length / BULK_REQUEST_SIZE);
    const requestStartedAt = new Date().toISOString();
    logProgress(`bulk registration request ${requestNumber}/${totalRequests} (${bbls.length} BBLs)`);
    const stopHeartbeat = startHeartbeat(`bulk registration request ${requestNumber}/${totalRequests}`);
    let result;
    try {
      result = await fetchJson(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bbls }),
        },
        HTTP_TIMEOUT_MS,
      );
    } finally {
      stopHeartbeat();
    }
    const requestEvidence = {
      requestNumber,
      startedAt: requestStartedAt,
      finishedAt: new Date().toISOString(),
      bblCount: bbls.length,
      firstBbl: bbls[0],
      lastBbl: bbls.at(-1),
      httpStatus: result.status,
      responseSummary: result.body?.summary,
      responseError: result.body?.error,
      failedResults: Array.isArray(result.body?.results)
        ? result.body.results.filter((entry) => entry?.status === 'failed')
        : [],
    };
    requests.push(requestEvidence);
    terminalHttpStatus = result.status;
    if (result.status !== 200 || !result.body?.summary || !Array.isArray(result.body?.results)) {
      break;
    }
    for (const field of Object.keys(responseSummary)) responseSummary[field] += result.body.summary[field];
    results.push(...result.body.results);
  }
  const finishedAt = new Date().toISOString();
  const wallTimeMs = Date.now() - startedMs;
  const acceptedResults = results.filter((entry) => entry.status === 'succeeded' || entry.status === 'cached');
  const terminalResults = results.map((entry) => {
    const terminalResult = {
      inputBbl: entry.inputBbl,
      canonicalBbl: entry.canonicalBbl,
      status: entry.status,
    };
    if (entry.status === 'failed') terminalResult.error = entry.error;
    else terminalResult.property = { id: entry.property?.id, bins: entry.property?.bins };
    return terminalResult;
  });
  const propertyIds = acceptedResults.map((entry) => entry.property?.id).filter(Boolean);
  const allBins = acceptedResults.flatMap((entry) => entry.property?.bins ?? []);
  const uniqueBins = [...new Set(allBins)].sort();
  const evidence = {
    startedAt,
    finishedAt,
    wallTimeMs,
    request: {
      method: 'POST',
      url: endpoint,
      path: '/properties/bulk',
      bblCount: seed.bbls.length,
      bulkRequestSize: BULK_REQUEST_SIZE,
      requestCount: requests.length,
    },
    requests,
    httpStatus: terminalHttpStatus,
    responseSummary,
    resultAudit: {
      resultCount: results.length,
      acceptedResultCount: acceptedResults.length,
      uniquePropertyIds: new Set(propertyIds).size,
      uniqueBins,
      allBinsValid: acceptedResults.length === 0 || allBins.every((bin) => VALID_BIN.test(bin)),
      terminalResults,
      failedResults: results.filter((entry) => entry.status === 'failed'),
      failureCountsByCode: Object.fromEntries(
        Object.entries(
          results
            .filter((entry) => entry.status === 'failed')
            .reduce((counts, entry) => {
              const code = entry.error?.code ?? 'UNKNOWN';
              counts[code] = (counts[code] ?? 0) + 1;
              return counts;
            }, {}),
        ).sort(),
      ),
    },
  };
  writeJson(path.join(evidenceDirectory, 'bulk-registration.json'), evidence);
  if (terminalHttpStatus !== 200 || requests.length !== Math.ceil(seed.bbls.length / BULK_REQUEST_SIZE)) {
    throw new Error(`Bulk registration stopped after ${requests.length} requests with HTTP ${terminalHttpStatus}`);
  }
  if (
    responseSummary?.submitted !== REQUIRED_PROPERTY_COUNT ||
    responseSummary?.unique !== REQUIRED_PROPERTY_COUNT ||
    results.length !== REQUIRED_PROPERTY_COUNT ||
    responseSummary.succeeded + responseSummary.cached + responseSummary.failed !== REQUIRED_PROPERTY_COUNT ||
    new Set(propertyIds).size !== acceptedResults.length
  ) {
    throw new Error(`Bulk registration did not account for all 10,000 unique BBLs: ${JSON.stringify(responseSummary)}`);
  }
  if (acceptedResults.length > 0 && !evidence.resultAudit.allBinsValid) {
    throw new Error('Bulk registration produced invalid BINs for accepted properties');
  }
  return evidence;
}

async function queryDatabase(project, runId) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Worker summary emitted an invalid run ID');
  const sql = `
    SELECT json_build_object(
      'runId', r.id,
      'status', r.status,
      'expectedBinCount', r.expected_bin_count,
      'expectedBatchCount', r.expected_batch_count,
      'sourceWatermarkAtStart', r.source_watermark_at_start,
      'sourceWatermarkAtEnd', r.source_watermark_at_end,
      'failureStage', r.failure_stage,
      'lastError', r.last_error,
      'propertyCount', (SELECT count(*) FROM properties),
      'persistedProperties', (SELECT COALESCE(json_agg(p ORDER BY p.id), '[]'::json) FROM (
        SELECT p.id, p.bbl,
          ARRAY(SELECT pb.bin FROM property_bins pb WHERE pb.property_id = p.id ORDER BY pb.bin) AS bins
        FROM properties p
      ) p),
      'snapshotProperties', (SELECT COALESCE(json_agg(s ORDER BY s.id), '[]'::json) FROM (
        SELECT property_id AS id, array_agg(bin ORDER BY bin) AS bins
        FROM ingestion_run_property_bins WHERE run_id = r.id GROUP BY property_id
      ) s),
      'snapshotPropertyCount', (SELECT count(DISTINCT property_id) FROM ingestion_run_property_bins WHERE run_id = r.id),
      'snapshotBinCount', (SELECT count(DISTINCT bin) FROM ingestion_run_property_bins WHERE run_id = r.id),
      'propertyBinSnapshotCount', (SELECT count(*) FROM ingestion_run_property_bins WHERE run_id = r.id),
      'persistedBatchCount', (SELECT count(*) FROM ingestion_batches WHERE run_id = r.id),
      'completedBatchCount', (SELECT count(*) FROM ingestion_batches WHERE run_id = r.id AND status = 'COMPLETED'),
      'rowsFetchedFromBatches', (SELECT COALESCE(sum(rows_fetched), 0) FROM ingestion_batches WHERE run_id = r.id),
      'rowsStaged', (SELECT count(*) FROM ecb_violation_staging WHERE run_id = r.id),
      'rowsPromoted', (SELECT count(*) FROM ecb_violations WHERE last_success_run_id = r.id),
      'successfulCoverageCount', (SELECT count(*) FROM property_dataset_coverage WHERE last_success_run_id = r.id AND status = 'CHECKED')
    )
    FROM ingestion_runs r
    WHERE r.id = '${runId}'::uuid;
  `;
  const args = composeArgs(
    project,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'nycpr',
    '-d',
    'nyc_property_resolver',
    '-At',
    '-c',
    sql,
  );
  const result = await runCommand('docker', args);

  // runCommand intentionally preserves the combined stdout/stderr stream for
  // human diagnostics. Docker/psql diagnostics can therefore be adjacent to
  // the machine-readable JSON. Extract one complete balanced JSON object
  // instead of assuming the entire physical line is JSON.
  for (let start = result.output.indexOf('{'); start >= 0; start = result.output.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < result.output.length; index += 1) {
      const character = result.output[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = result.output.slice(start, index + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed?.runId === runId) return parsed;
          } catch {
            // This brace-delimited fragment was not the psql JSON row.
          }
          break;
        }
      }
    }
  }

  throw new Error('Database evidence query did not return parseable JSON for the requested run');
}

async function captureApiLogs(project, evidenceDirectory) {
  const result = await runCommand('docker', composeArgs(project, 'logs', '--no-color', 'api'), {
    allowFailure: true,
  });
  writeFileSync(
    path.join(evidenceDirectory, 'api.log'),
    result.output.length > 0 ? result.output : '[no output]\n',
    'utf8',
  );
}

async function runBenchmark(options) {
  prepareEvidenceDirectory(options.evidenceDirectory);
  const benchmarkStartedAt = new Date().toISOString();
  const benchmarkStartedMs = Date.now();
  const commands = [];
  try {
    const seed = await selectScaleSeed();
    const downArgs = composeArgs(options.composeProject, 'down', '--volumes', '--remove-orphans');
    commands.push(commandDocument('docker', downArgs));
    await runCommand('docker', downArgs, {
      logPath: path.join(options.evidenceDirectory, 'compose-clean.log'),
      allowFailure: true,
    });

    const upArgs = composeArgs(options.composeProject, 'up', '-d', '--build', 'postgres', 'api');
    commands.push(commandDocument('docker', upArgs));
    await runCommand('docker', upArgs, {
      logPath: path.join(options.evidenceDirectory, 'compose-start.log'),
    });
    const health = await waitForHealth(options.apiBaseUrl);
    writeJson(path.join(options.evidenceDirectory, 'health.json'), {
      checkedAt: new Date().toISOString(),
      url: new URL('/health', options.apiBaseUrl).toString(),
      response: health,
    });

    const registration = await registerProperties(
      options.apiBaseUrl,
      seed,
      options.evidenceDirectory,
    );
    await captureApiLogs(options.composeProject, options.evidenceDirectory);

    const ingestionArgs = composeArgs(
      options.composeProject,
      'run',
      '--rm',
      'worker',
      'npm',
      'run',
      'ingest:ecb',
    );
    commands.push(commandDocument('docker', ingestionArgs));
    const stopIngestHeartbeat = startHeartbeat('ECB ingestion');
    let ingestionExecution;
    try {
      ingestionExecution = await runCommand('docker', ingestionArgs, {
        logPath: path.join(options.evidenceDirectory, 'worker.log'),
        allowFailure: true,
      });
    } finally {
      stopIngestHeartbeat();
    }
    const workerRecords = extractJsonLines(ingestionExecution.output);
    const workerStart = workerRecords.find(
      (entry) => entry?.msg === 'ECB manual ingestion started',
    );
    const workerSummary = workerRecords.findLast(
      (entry) => entry?.runId && entry?.status && entry?.rowsFetched !== undefined,
    );
    if (!workerSummary) throw new Error('Worker did not emit its fixed-field structured run summary');
    if (!Number.isFinite(workerStart?.time) || !Number.isFinite(workerSummary?.time)) {
      throw new Error('Worker log did not preserve measured ingestion start/completion timestamps');
    }
    const ingestionStartedAt = new Date(workerStart.time).toISOString();
    const ingestionFinishedAt = new Date(workerSummary.time).toISOString();
    const ingestionWallTimeMs =
      Number.isFinite(workerSummary.durationMs) && workerSummary.durationMs > 0
        ? Math.round(workerSummary.durationMs)
        : Math.max(1, workerSummary.time - workerStart.time);
    // Seal the complete captured stream before any post-run evidence processing.
    writeJson(path.join(options.evidenceDirectory, 'worker-capture.json'), {
      runId: workerSummary.runId,
      exitCode: ingestionExecution.exitCode,
      byteLength: Buffer.byteLength(ingestionExecution.output, 'utf8'),
      sha256: createHash('sha256').update(ingestionExecution.output, 'utf8').digest('hex'),
    });
    const database = await queryDatabase(options.composeProject, workerSummary.runId);
    writeJson(path.join(options.evidenceDirectory, 'database-run.json'), database);

    const accepted = registration.responseSummary.succeeded + registration.responseSummary.cached;
    const uniqueValidBins = registration.resultAudit.uniqueBins.length;
    const persistedBatchCount = Number(database.persistedBatchCount);
    const summary = {
      schemaVersion: 1,
      status: 'complete',
      startedAt: benchmarkStartedAt,
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - benchmarkStartedMs,
      registrationWallTimeMs: registration.wallTimeMs,
      ingestionWallTimeMs,
      sample: {
        datasetId: seed.dataset.id,
        communityDistricts: seed.communityDistricts,
        requestedProperties: seed.bbls.length,
        requestedUniqueBbls: new Set(seed.bbls).size,
        uniqueProperties: accepted,
      },
      bulkRegistration: {
        endpoint: '/properties/bulk',
        bulkRequestSize: BULK_REQUEST_SIZE,
        httpRequestCount: registration.requests.length,
        submitted: registration.responseSummary.submitted,
        unique: registration.responseSummary.unique,
        succeeded: registration.responseSummary.succeeded,
        cached: registration.responseSummary.cached,
        accepted,
        failed: registration.responseSummary.failed,
      },
      configuredBounds: CONFIGURED_BOUNDS,
      ingestion: {
        runId: workerSummary.runId,
        outcome: workerSummary.outcome,
        status: database.status,
        startedAt: ingestionStartedAt,
        finishedAt: ingestionFinishedAt,
        sourceWatermarkAtStart: database.sourceWatermarkAtStart,
        sourceWatermarkAtEnd: database.sourceWatermarkAtEnd,
        uniqueValidBins,
        persistedBatchCount,
        socrataDataCalls: workerSummary.socrataDataCalls,
        socrataMetadataCalls: workerSummary.socrataMetadataCalls,
        socrataRetryCalls: workerSummary.socrataRetryCalls,
        socrataTotalCalls: workerSummary.socrataTotalCalls,
        rowsFetched: workerSummary.rowsFetched,
        rowsStaged: Number(database.rowsStaged),
        rowsPromoted: Number(database.rowsPromoted),
        failures: workerSummary.failures,
        workerReportedDurationMs: workerSummary.durationMs,
      },
      callArithmetic: {
        formula: 'total = data-page calls + metadata calls + retry calls',
        batchFormula: 'persisted batches = ceil(unique valid BINs / configured batch size)',
        minimumDataPageCalls: persistedBatchCount,
        additionalDataPageCalls: workerSummary.socrataDataCalls - persistedBatchCount,
        observedTotalCalls: workerSummary.socrataTotalCalls,
        substituted: `${workerSummary.socrataTotalCalls} = ${workerSummary.socrataDataCalls} + ${workerSummary.socrataMetadataCalls} + ${workerSummary.socrataRetryCalls}`,
      },
      failures: {
        bulkRegistration: registration.responseSummary.failed,
        bulkRegistrationByCode: registration.resultAudit.failureCountsByCode,
        ingestion: workerSummary.failures,
      },
      commands,
      artifacts: {
        seed: 'seed/scale-10000-bbls.json',
        registration: 'evidence/scale-10000/bulk-registration.json',
        workerLog: 'evidence/scale-10000/worker.log',
        applicationLog: 'evidence/scale-10000/api.log',
        databaseRun: 'evidence/scale-10000/database-run.json',
      },
    };
    writeJson(path.join(options.evidenceDirectory, 'summary.json'), summary);
    if (ingestionExecution.exitCode !== 0) {
      throw new Error(`Scale ingestion exited with code ${ingestionExecution.exitCode}`);
    }
    if (
      workerSummary.outcome !== 'COMPLETED' ||
      database.status !== 'COMPLETED' ||
      workerSummary.failures !== 0
    ) {
      throw new Error(`Scale ingestion did not reach an accepted terminal state: ${JSON.stringify(workerSummary)}`);
    }
    assertValidScaleEvidence(options.evidenceDirectory);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await captureApiLogs(options.composeProject, options.evidenceDirectory).catch(() => undefined);
    writeJson(path.join(options.evidenceDirectory, 'failure.json'), {
      failedAt: new Date().toISOString(),
      errorType: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
      commands,
    });
    throw error;
  }
}

async function finalizeFromExistingRun(options) {
  logProgress('finalizing scale evidence from the existing registration and worker log');
  const seed = readJsonFile(SEED_PATH);
  const registration = readJsonFile(path.join(options.evidenceDirectory, 'bulk-registration.json'));
  const workerLogPath = path.join(options.evidenceDirectory, 'worker.log');
  if (!existsSync(workerLogPath)) {
    throw new Error(`worker log is missing at ${workerLogPath}`);
  }
  const workerLog = readFileSync(workerLogPath, 'utf8');
  const workerRecords = extractJsonLines(workerLog);
  const workerStart = workerRecords.find(
    (entry) => entry?.msg === 'ECB manual ingestion started',
  );
  const workerSummary = workerRecords.findLast(
    (entry) => entry?.runId && entry?.status && entry?.rowsFetched !== undefined,
  );
  if (!workerSummary) {
    throw new Error('Worker did not emit its fixed-field structured run summary');
  }
  if (!Number.isFinite(workerStart?.time) || !Number.isFinite(workerSummary?.time)) {
    throw new Error('Worker log did not preserve measured ingestion start/completion timestamps');
  }

  await captureApiLogs(options.composeProject, options.evidenceDirectory);
  const database = await queryDatabase(options.composeProject, workerSummary.runId);
  writeJson(path.join(options.evidenceDirectory, 'database-run.json'), database);

  const benchmarkStartedAt = seed.requestedAt ?? registration.startedAt;
  const benchmarkStartedMs = Date.parse(benchmarkStartedAt);
  const ingestionStartedAt = new Date(workerStart.time).toISOString();
  const ingestionFinishedAt = new Date(workerSummary.time).toISOString();
  const ingestionWallTimeMs =
    Number.isFinite(workerSummary.durationMs) && workerSummary.durationMs > 0
      ? Math.round(workerSummary.durationMs)
      : Math.max(1, workerSummary.time - workerStart.time);
  const commands = [
    commandDocument('docker', composeArgs(options.composeProject, 'down', '--volumes', '--remove-orphans')),
    commandDocument('docker', composeArgs(options.composeProject, 'up', '-d', '--build', 'postgres', 'api')),
    commandDocument(
      'docker',
      composeArgs(options.composeProject, 'run', '--rm', 'worker', 'npm', 'run', 'ingest:ecb'),
    ),
  ];

  const accepted = registration.responseSummary.succeeded + registration.responseSummary.cached;
  const uniqueValidBins = registration.resultAudit.uniqueBins.length;
  const persistedBatchCount = Number(database.persistedBatchCount);
  const summary = {
    schemaVersion: 1,
    status: 'complete',
    startedAt: benchmarkStartedAt,
    finishedAt: ingestionFinishedAt,
    wallTimeMs: Number.isFinite(benchmarkStartedMs)
      ? Math.max(1, Date.parse(ingestionFinishedAt) - benchmarkStartedMs)
      : registration.wallTimeMs + ingestionWallTimeMs,
    registrationWallTimeMs: registration.wallTimeMs,
    ingestionWallTimeMs,
    sample: {
      datasetId: seed.dataset.id,
      communityDistricts: seed.communityDistricts,
      requestedProperties: seed.bbls.length,
      requestedUniqueBbls: new Set(seed.bbls).size,
      uniqueProperties: accepted,
    },
    bulkRegistration: {
      endpoint: '/properties/bulk',
      bulkRequestSize: BULK_REQUEST_SIZE,
      httpRequestCount: registration.requests.length,
      submitted: registration.responseSummary.submitted,
      unique: registration.responseSummary.unique,
      succeeded: registration.responseSummary.succeeded,
      cached: registration.responseSummary.cached,
      accepted,
      failed: registration.responseSummary.failed,
    },
    configuredBounds: CONFIGURED_BOUNDS,
    ingestion: {
      runId: workerSummary.runId,
      outcome: workerSummary.outcome,
      status: database.status,
      startedAt: ingestionStartedAt,
      finishedAt: ingestionFinishedAt,
      sourceWatermarkAtStart: database.sourceWatermarkAtStart,
      sourceWatermarkAtEnd: database.sourceWatermarkAtEnd,
      uniqueValidBins,
      persistedBatchCount,
      socrataDataCalls: workerSummary.socrataDataCalls,
      socrataMetadataCalls: workerSummary.socrataMetadataCalls,
      socrataRetryCalls: workerSummary.socrataRetryCalls,
      socrataTotalCalls: workerSummary.socrataTotalCalls,
      rowsFetched: workerSummary.rowsFetched,
      rowsStaged: Number(database.rowsStaged),
      rowsPromoted: Number(database.rowsPromoted),
      failures: workerSummary.failures,
      workerReportedDurationMs: workerSummary.durationMs,
    },
    callArithmetic: {
      formula: 'total = data-page calls + metadata calls + retry calls',
      batchFormula: 'persisted batches = ceil(unique valid BINs / configured batch size)',
      minimumDataPageCalls: persistedBatchCount,
      additionalDataPageCalls: workerSummary.socrataDataCalls - persistedBatchCount,
      observedTotalCalls: workerSummary.socrataTotalCalls,
      substituted: `${workerSummary.socrataTotalCalls} = ${workerSummary.socrataDataCalls} + ${workerSummary.socrataMetadataCalls} + ${workerSummary.socrataRetryCalls}`,
    },
    failures: {
      bulkRegistration: registration.responseSummary.failed,
      bulkRegistrationByCode: registration.resultAudit.failureCountsByCode,
      ingestion: workerSummary.failures,
    },
    commands,
    artifacts: {
      seed: 'seed/scale-10000-bbls.json',
      registration: 'evidence/scale-10000/bulk-registration.json',
      workerLog: 'evidence/scale-10000/worker.log',
      applicationLog: 'evidence/scale-10000/api.log',
      databaseRun: 'evidence/scale-10000/database-run.json',
    },
  };
  writeJson(path.join(options.evidenceDirectory, 'summary.json'), summary);
  if (
    workerSummary.outcome !== 'COMPLETED' ||
    database.status !== 'COMPLETED' ||
    workerSummary.failures !== 0
  ) {
    throw new Error(`Scale ingestion did not reach an accepted terminal state: ${JSON.stringify(workerSummary)}`);
  }
  assertValidScaleEvidence(options.evidenceDirectory);
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.validateOnly) {
    assertValidScaleEvidence(options.evidenceDirectory);
    console.log(`Scale evidence is complete and internally consistent: ${options.evidenceDirectory}`);
    return;
  }
  if (options.finalizeEvidence) {
    await finalizeFromExistingRun(options);
    return;
  }
  await runBenchmark(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
