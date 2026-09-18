#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
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
const BUILDING_FOOTPRINTS_RESOURCE_URL = 'https://data.cityofnewyork.us/resource/5zhs-2jue.json';
const COMMUNITY_DISTRICTS = Object.freeze(['102', '108']);
const CONDO_UNIT_LOT_MIN = 1001;
const CONDO_BILLING_LOT_MIN = 7501;
const FOOTPRINT_LOOKUP_CHUNK_SIZE = 200;
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
    composeProject: 'nyc-s5-t3-scale',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--validate-only') {
      options.validateOnly = true;
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

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: commandEnvironment(),
      shell: false,
      windowsHide: true,
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      const output = Buffer.concat(chunks).toString('utf8');
      if (logPath) {
        mkdirSync(path.dirname(logPath), { recursive: true });
        writeFileSync(logPath, output.length > 0 ? output : '[no output]\n', 'utf8');
      }
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

function isCondoUnitLot(lot) {
  return lot >= CONDO_UNIT_LOT_MIN && lot < CONDO_BILLING_LOT_MIN;
}

function parsePlutoParcelRecord(record) {
  const bblMatch = PLUTO_DECIMAL_BBL.exec(String(record?.bbl ?? ''));
  if (!bblMatch) return null;
  const bbl = bblMatch[1];
  const borough = parseSourceInteger(record?.borocode);
  const block = parseSourceInteger(record?.block);
  const lot = parseSourceInteger(record?.lot);
  const address = typeof record?.address === 'string' ? record.address.trim() : '';
  if (borough === null || block === null || lot === null || address.length === 0) return null;
  const components = parseBblComponents(bbl);
  if (components.borough !== borough || components.block !== block || components.lot !== lot) {
    return null;
  }
  const bldgclass =
    record?.bldgclass === null || record?.bldgclass === undefined
      ? null
      : String(record.bldgclass).trim() || null;
  return { bbl, borough, block, lot, address, bldgclass };
}

function parseFootprintBbl(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw.length === 0) return null;
  const integerPart = raw.split('.')[0];
  if (!VALID_BBL.test(integerPart)) return null;
  return integerPart;
}

function parseFootprintBin(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw.length === 0) return null;
  const integerPart = raw.split('.')[0];
  if (!VALID_BIN.test(integerPart)) return null;
  return integerPart;
}

function parseFootprintCandidate(record) {
  const bin = parseFootprintBin(record?.bin);
  const baseBbl = parseFootprintBbl(record?.base_bbl);
  if (!bin || !baseBbl) return null;
  if (!Object.prototype.hasOwnProperty.call(record, 'mappluto_bbl')) {
    return { bin, baseBbl };
  }
  const mapplutoBbl = parseFootprintBbl(record?.mappluto_bbl);
  return { bin, baseBbl, mapplutoBbl };
}

function validateFootprintCandidate(candidate, canonicalBbl, mode = 'non-condo') {
  const hasMapplutoEvidence = Object.prototype.hasOwnProperty.call(candidate, 'mapplutoBbl');
  if (hasMapplutoEvidence) {
    if (candidate.mapplutoBbl === null || candidate.mapplutoBbl === undefined) {
      if (mode === 'condo') return 'MAPPLUTO_BBL_MISMATCH';
      if (candidate.baseBbl !== canonicalBbl) return 'BASE_BBL_MISMATCH';
    } else if (candidate.mapplutoBbl !== canonicalBbl) {
      return 'MAPPLUTO_BBL_MISMATCH';
    }
  } else if (candidate.baseBbl !== canonicalBbl) {
    return 'BASE_BBL_MISMATCH';
  }
  return 'accepted';
}

function wouldFailFootprintValidation(candidates, canonicalBbl, mode = 'non-condo') {
  const accepted = [];
  const rejected = [];
  for (const candidate of candidates) {
    const validation = validateFootprintCandidate(candidate, canonicalBbl, mode);
    if (validation === 'accepted') accepted.push(candidate);
    else rejected.push(validation);
  }
  if (accepted.length > 0) return false;
  return rejected.includes('MAPPLUTO_BBL_MISMATCH') || rejected.includes('BASE_BBL_MISMATCH');
}

function chunkValues(values, chunkSize) {
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

async function lookupFootprintsByParcelBbls(bbls) {
  const results = new Map();
  for (const chunk of chunkValues(bbls, FOOTPRINT_LOOKUP_CHUNK_SIZE)) {
    const quotedBbls = chunk.map((bbl) => `'${bbl.replace(/'/g, "''")}'`).join(',');
    const queryUrl = new URL(BUILDING_FOOTPRINTS_RESOURCE_URL);
    queryUrl.searchParams.set('$select', 'bin,base_bbl,mappluto_bbl');
    queryUrl.searchParams.set('$where', `base_bbl in (${quotedBbls}) OR mappluto_bbl in (${quotedBbls})`);
    queryUrl.searchParams.set('$limit', String(Math.max(chunk.length * 50, chunk.length)));
    const result = await fetchJson(queryUrl, {}, 60_000);
    if (result.status !== 200 || !Array.isArray(result.body)) {
      throw new Error(`Building Footprints scale precheck failed with HTTP ${result.status}`);
    }
    const candidatesByBbl = new Map();
    for (const record of result.body) {
      const candidate = parseFootprintCandidate(record);
      if (!candidate) continue;
      for (const bbl of chunk) {
        if (candidate.baseBbl === bbl || candidate.mapplutoBbl === bbl) {
          const existing = candidatesByBbl.get(bbl) ?? [];
          existing.push(candidate);
          candidatesByBbl.set(bbl, existing);
        }
      }
    }
    for (const bbl of chunk) {
      results.set(bbl, candidatesByBbl.get(bbl) ?? []);
    }
  }
  return results;
}

async function selectResolvableBbls(parcels) {
  const selected = [];
  const excluded = {
    footprintIdentifierConflict: 0,
  };
  let pendingNonCondo = [];

  const flushPendingNonCondo = async () => {
    if (pendingNonCondo.length === 0) return;
    const batch = pendingNonCondo;
    pendingNonCondo = [];
    const footprintResults = await lookupFootprintsByParcelBbls(batch.map((parcel) => parcel.bbl));
    for (const parcel of batch) {
      const candidates = footprintResults.get(parcel.bbl) ?? [];
      if (candidates.length > 0 && wouldFailFootprintValidation(candidates, parcel.bbl)) {
        excluded.footprintIdentifierConflict += 1;
        continue;
      }
      selected.push(parcel.bbl);
      if (selected.length === REQUIRED_PROPERTY_COUNT) return true;
    }
    return false;
  };

  for (const parcel of parcels) {
    const lot = parseBblComponents(parcel.bbl).lot;
    if (isCondoUnitLot(lot)) {
      if (pendingNonCondo.length > 0 && (await flushPendingNonCondo())) {
        return { bbls: selected, excluded };
      }
      selected.push(parcel.bbl);
      if (selected.length === REQUIRED_PROPERTY_COUNT) return { bbls: selected, excluded };
      continue;
    }

    pendingNonCondo.push(parcel);
    if (pendingNonCondo.length >= FOOTPRINT_LOOKUP_CHUNK_SIZE) {
      if (await flushPendingNonCondo()) return { bbls: selected, excluded };
    }
  }

  if (pendingNonCondo.length > 0) await flushPendingNonCondo();
  return { bbls: selected, excluded };
}

async function selectScaleSeed() {
  const queryParameters = {
    $select: 'bbl,cd,address,borocode,block,lot,bldgclass',
    $where:
      `cd in (${COMMUNITY_DISTRICTS.map((district) => `'${district}'`).join(',')})` +
      ' and bbl is not null and address is not null and borocode is not null and block is not null and lot is not null',
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

  const parcelsByBbl = new Map();
  for (const row of result.body) {
    const communityDistrict = String(row?.cd ?? '').padStart(3, '0');
    if (!COMMUNITY_DISTRICTS.includes(communityDistrict)) continue;
    const parcel = parsePlutoParcelRecord(row);
    if (!parcel) continue;
    if (!parcelsByBbl.has(parcel.bbl)) parcelsByBbl.set(parcel.bbl, parcel);
  }
  const parcels = [...parcelsByBbl.values()].sort((left, right) => left.bbl.localeCompare(right.bbl));
  const { bbls, excluded } = await selectResolvableBbls(parcels);
  if (bbls.length !== REQUIRED_PROPERTY_COUNT) {
    throw new Error(
      `Deterministic PLUTO query produced ${bbls.length} resolver-compatible unique BBLs; exactly 10,000 are required ` +
        `(excluded: ${JSON.stringify(excluded)})`,
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
        'Parse PLUTO parcels with the same address/component checks as bulk registration, preserve bbl ASC order, ' +
        'exclude non-condo parcels whose Building Footprints candidates would fail identifier agreement, and take the first 10,000.',
    },
    selection: {
      requestedCount: REQUIRED_PROPERTY_COUNT,
      sourceRecordCount: result.body.length,
      validUniqueSourceCount: parcels.length,
      selectedCount: bbls.length,
      excluded,
    },
    bbls,
  };
  writeJson(SEED_PATH, seed);
  return seed;
}

async function waitForHealth(apiBaseUrl) {
  const healthUrl = new URL('/health', apiBaseUrl).toString();
  const deadline = Date.now() + 120_000;
  let lastError;
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
    const requestStartedAt = new Date().toISOString();
    const result = await fetchJson(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbls }),
      },
      HTTP_TIMEOUT_MS,
    );
    const requestEvidence = {
      requestNumber: requests.length + 1,
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
      allBinsValid: allBins.every((bin) => VALID_BIN.test(bin)),
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
    acceptedResults.length + responseSummary.failed !== REQUIRED_PROPERTY_COUNT ||
    new Set(propertyIds).size !== acceptedResults.length
  ) {
    throw new Error(`Bulk registration did not account for all 10,000 unique BBLs: ${JSON.stringify(responseSummary)}`);
  }
  if (
    responseSummary.failed !== 0 ||
    acceptedResults.length !== REQUIRED_PROPERTY_COUNT ||
    new Set(propertyIds).size !== REQUIRED_PROPERTY_COUNT
  ) {
    throw new Error(
      `Bulk registration did not persist exactly 10,000 unique properties: ${JSON.stringify(responseSummary)}; ` +
      `failed per-BBL responses are preserved in bulk-registration.json`,
    );
  }
  if (!evidence.resultAudit.allBinsValid || uniqueBins.length === 0) {
    throw new Error('Bulk registration produced an invalid or empty BIN set');
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
  const line = result.output.trim().split(/\r?\n/).findLast((candidate) => candidate.trim().startsWith('{'));
  if (!line) throw new Error('Database evidence query did not return JSON');
  return JSON.parse(line);
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
    const ingestionStartedAt = new Date().toISOString();
    const ingestionStartedMs = Date.now();
    const ingestionExecution = await runCommand('docker', ingestionArgs, {
      logPath: path.join(options.evidenceDirectory, 'worker.log'),
      allowFailure: true,
    });
    const ingestionFinishedAt = new Date().toISOString();
    const ingestionWallTimeMs = Date.now() - ingestionStartedMs;
    const workerSummary = extractJsonLines(ingestionExecution.output).findLast(
      (entry) => entry?.runId && entry?.status && entry?.rowsFetched !== undefined,
    );
    if (!workerSummary) throw new Error('Worker did not emit its fixed-field structured run summary');
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.validateOnly) {
    assertValidScaleEvidence(options.evidenceDirectory);
    console.log(`Scale evidence is complete and internally consistent: ${options.evidenceDirectory}`);
    return;
  }
  await runBenchmark(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
