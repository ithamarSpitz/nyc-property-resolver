#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_EVIDENCE_DIRECTORY = path.join(REPOSITORY_ROOT, 'evidence/scale-10000');
const SEED_PATH = path.join(REPOSITORY_ROOT, 'seed/scale-10000-bbls.json');
const REQUIRED_PROPERTY_COUNT = 10_000;
const VALID_BBL = /^[1-5]\d{9}$/;
const VALID_BIN = /^[1-5]\d{6}$/;

function push(errors, condition, message) {
  if (!condition) errors.push(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isIsoTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function readJson(filePath, errors, label) {
  if (!existsSync(filePath)) {
    errors.push(`${label} is missing (${filePath})`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function requireNonEmptyFile(filePath, errors, label) {
  push(
    errors,
    existsSync(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 0,
    `${label} is missing or empty (${filePath})`,
  );
}

function extractJsonLines(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      values.push(JSON.parse(line.slice(start)));
    } catch {
      // Docker and npm output is retained verbatim; only JSON log lines are inspected.
    }
  }
  return values;
}

function parseEvidenceDirectory(argv) {
  if (argv.length > 1) throw new Error('Usage: validate-scale-evidence.mjs [evidence-directory]');
  return argv[0] ? path.resolve(argv[0]) : DEFAULT_EVIDENCE_DIRECTORY;
}

export function validateScaleEvidence(evidenceDirectory) {
  const errors = [];
  const summary = readJson(path.join(evidenceDirectory, 'summary.json'), errors, 'scale summary');
  const registration = readJson(
    path.join(evidenceDirectory, 'bulk-registration.json'),
    errors,
    'bulk-registration evidence',
  );
  const database = readJson(
    path.join(evidenceDirectory, 'database-run.json'),
    errors,
    'database run evidence',
  );
  const seed = readJson(SEED_PATH, errors, 'scale seed');
  const workerLogPath = path.join(evidenceDirectory, 'worker.log');
  const apiLogPath = path.join(evidenceDirectory, 'api.log');
  requireNonEmptyFile(workerLogPath, errors, 'raw worker log');
  requireNonEmptyFile(apiLogPath, errors, 'application log');

  push(errors, seed?.schemaVersion === 1, 'seed.schemaVersion must equal 1');
  push(errors, seed?.dataset?.id === '64uk-42ks', 'seed must identify PLUTO dataset 64uk-42ks');
  push(errors, seed?.dataset?.resourceUrl === 'https://data.cityofnewyork.us/resource/64uk-42ks.json', 'seed must record the PLUTO resource URL');
  push(errors, isIsoTimestamp(seed?.retrievedAt), 'seed.retrievedAt must be an ISO timestamp');
  push(errors, Array.isArray(seed?.communityDistricts) && seed.communityDistricts.length >= 1 && seed.communityDistricts.length <= 2, 'seed must record one or two community districts');
  push(errors, seed?.communityDistricts?.every((district) => /^\d{3}$/.test(district)), 'seed community districts must be three-digit strings');
  push(errors, isObject(seed?.query), 'seed.query provenance is required');
  push(errors, isNonEmptyString(seed?.query?.url), 'seed.query.url is required');
  push(errors, seed?.query?.parameters?.$order === 'bbl ASC', 'seed query must use deterministic bbl ASC ordering');
  push(errors, isNonEmptyString(seed?.query?.parameters?.$where), 'seed query must record its $where clause');
  push(errors, Array.isArray(seed?.bbls) && seed.bbls.length === REQUIRED_PROPERTY_COUNT, 'seed must contain exactly 10,000 BBLs');
  push(errors, seed?.bbls?.every((bbl) => VALID_BBL.test(bbl)), 'every seed BBL must be a valid canonical NYC BBL');
  push(errors, new Set(seed?.bbls ?? []).size === REQUIRED_PROPERTY_COUNT, 'seed BBLs must be unique');
  const sortedBbls = [...(seed?.bbls ?? [])].sort();
  push(errors, JSON.stringify(seed?.bbls ?? []) === JSON.stringify(sortedBbls), 'seed BBLs must preserve deterministic ascending order');
  push(errors, seed?.selection?.requestedCount === REQUIRED_PROPERTY_COUNT, 'seed selection requestedCount must equal 10,000');
  push(errors, seed?.selection?.selectedCount === REQUIRED_PROPERTY_COUNT, 'seed selection selectedCount must equal 10,000');
  push(errors, isPositiveInteger(seed?.selection?.sourceRecordCount) && seed.selection.sourceRecordCount >= REQUIRED_PROPERTY_COUNT, 'seed selection must record at least 10,000 source records');

  push(errors, summary?.schemaVersion === 1, 'summary.schemaVersion must equal 1');
  push(errors, summary?.status === 'complete', 'summary.status must be complete');
  for (const field of ['startedAt', 'finishedAt']) push(errors, isIsoTimestamp(summary?.[field]), `summary.${field} must be an ISO timestamp`);
  for (const field of ['wallTimeMs', 'registrationWallTimeMs', 'ingestionWallTimeMs']) push(errors, isPositiveInteger(summary?.[field]), `summary.${field} must be a positive integer`);
  push(errors, summary?.sample?.requestedProperties === REQUIRED_PROPERTY_COUNT, 'summary must record exactly 10,000 requested properties');
  push(errors, summary?.sample?.requestedUniqueBbls === REQUIRED_PROPERTY_COUNT, 'summary must record exactly 10,000 unique requested BBLs');
  const bulk = summary?.bulkRegistration;
  push(errors, summary?.sample?.uniqueProperties === bulk?.accepted, 'summary unique properties must equal accepted bulk properties');
  push(errors, JSON.stringify(summary?.sample?.communityDistricts) === JSON.stringify(seed?.communityDistricts), 'summary community districts must match the seed');

  push(errors, bulk?.endpoint === '/properties/bulk', 'bulk registration must use /properties/bulk');
  push(errors, isPositiveInteger(bulk?.bulkRequestSize) && bulk.bulkRequestSize > 1, 'bulk registration request size must prove a non-single-property path');
  push(errors, bulk?.httpRequestCount === Math.ceil(REQUIRED_PROPERTY_COUNT / (bulk?.bulkRequestSize ?? 1)), 'bulk registration HTTP request count must match its bounded chunk size');
  push(errors, bulk?.httpRequestCount < REQUIRED_PROPERTY_COUNT, 'bulk registration must not issue one application request per property');
  push(errors, bulk?.submitted === REQUIRED_PROPERTY_COUNT, 'bulk registration submitted count must equal 10,000');
  push(errors, bulk?.unique === REQUIRED_PROPERTY_COUNT, 'bulk registration unique count must equal 10,000');
  push(errors, bulk?.accepted + bulk?.failed === REQUIRED_PROPERTY_COUNT, 'bulk registration accepted plus failed must account for all 10,000 inputs');
  push(errors, bulk?.accepted === bulk?.succeeded + bulk?.cached, 'bulk accepted count must equal succeeded plus cached');
  push(errors, bulk?.accepted >= 0 && bulk?.failed >= 0, 'bulk registration accepted and failed counts must be non-negative');
  push(errors, registration?.request?.method === 'POST' && registration?.request?.path === '/properties/bulk', 'registration evidence must record POST /properties/bulk');
  push(errors, registration?.request?.bblCount === REQUIRED_PROPERTY_COUNT, 'registration evidence must record 10,000 input BBLs');
  push(errors, registration?.request?.bulkRequestSize === bulk?.bulkRequestSize, 'registration request size must match summary');
  push(errors, registration?.request?.requestCount === bulk?.httpRequestCount, 'registration request count must match summary');
  push(errors, Array.isArray(registration?.requests) && registration.requests.length === bulk?.httpRequestCount, 'registration evidence must contain one trace per bulk request');
  push(errors, registration?.requests?.every((request, index) => request.requestNumber === index + 1 && request.httpStatus === 200 && request.bblCount > 1 && request.bblCount <= bulk?.bulkRequestSize), 'every bulk registration request trace must be ordered, bounded, and successful');
  push(errors, registration?.requests?.every((request) => Array.isArray(request.failedResults)), 'every bulk registration request trace must preserve its failed per-BBL responses');
  push(errors, registration?.httpStatus === 200, 'bulk registration must return HTTP 200');
  push(errors, registration?.responseSummary?.submitted === bulk?.submitted, 'registration response submitted count must match summary');
  push(errors, registration?.responseSummary?.unique === bulk?.unique, 'registration response unique count must match summary');
  push(errors, registration?.responseSummary?.succeeded === bulk?.succeeded, 'registration response succeeded count must match summary');
  push(errors, registration?.responseSummary?.cached === bulk?.cached, 'registration response cached count must match summary');
  push(errors, registration?.responseSummary?.failed === bulk?.failed, 'registration response failed count must match summary');
  push(errors, registration?.resultAudit?.resultCount === REQUIRED_PROPERTY_COUNT, 'registration evidence must audit 10,000 results');
  push(errors, registration?.resultAudit?.acceptedResultCount === bulk?.accepted, 'registration accepted result count must match summary');
  push(errors, registration?.resultAudit?.uniquePropertyIds === bulk?.accepted, 'registration evidence unique property IDs must equal accepted properties');
  push(errors, registration?.resultAudit?.allBinsValid === true, 'registration result BINs must all be valid for accepted properties');
  push(errors, registration?.resultAudit?.uniqueBins?.every((bin) => VALID_BIN.test(bin)), 'registration evidence may only contain canonical valid BINs');
  const terminalResults = registration?.resultAudit?.terminalResults;
  push(errors, Array.isArray(terminalResults), 'registration evidence must preserve every per-BBL terminal result');
  push(errors, terminalResults?.length === REQUIRED_PROPERTY_COUNT, 'terminal registration result count must equal 10,000');
  push(
    errors,
    terminalResults?.every(
      (result) =>
        VALID_BBL.test(result?.inputBbl ?? '') &&
        VALID_BBL.test(result?.canonicalBbl ?? '') &&
        ['succeeded', 'cached', 'failed'].includes(result?.status),
    ),
    'every terminal registration result must retain canonical BBL identity and a supported status',
  );
  push(
    errors,
    JSON.stringify(terminalResults?.map((result) => result.inputBbl)) === JSON.stringify(seed?.bbls),
    'terminal registration results must contain exactly one ordered outcome for every seed BBL',
  );
  push(errors, terminalResults?.filter((result) => result.status === 'succeeded').length === bulk?.succeeded, 'terminal succeeded result count must match summary');
  push(errors, terminalResults?.filter((result) => result.status === 'cached').length === bulk?.cached, 'terminal cached result count must match summary');
  push(errors, terminalResults?.filter((result) => result.status === 'failed').length === bulk?.failed, 'terminal failed result count must match summary');
  const failedResults = registration?.resultAudit?.failedResults;
  push(errors, Array.isArray(failedResults), 'registration evidence must preserve failed per-BBL results');
  push(errors, failedResults?.length === bulk?.failed, 'preserved failed per-BBL result count must match bulk failed count');
  push(
    errors,
    failedResults?.every(
      (result) =>
        result?.status === 'failed' &&
        VALID_BBL.test(result?.inputBbl ?? '') &&
        VALID_BBL.test(result?.canonicalBbl ?? '') &&
        isNonEmptyString(result?.error?.code) &&
        isNonEmptyString(result?.error?.message),
    ),
    'every failed registration result must retain its BBL and exact structured application error',
  );
  push(errors, new Set((failedResults ?? []).map((result) => result.inputBbl)).size === (failedResults?.length ?? 0), 'failed registration BBLs must be unique');
  push(errors, failedResults?.every((result) => seed?.bbls?.includes(result.inputBbl)), 'every failed registration BBL must belong to the selected seed');
  const requestFailedResults = Array.isArray(registration?.requests)
    ? registration.requests.flatMap((request) => request.failedResults ?? [])
    : [];
  push(errors, JSON.stringify(requestFailedResults) === JSON.stringify(failedResults), 'per-request and audited failed registration results must match exactly');
  push(
    errors,
    JSON.stringify(terminalResults?.filter((result) => result.status === 'failed')) === JSON.stringify(failedResults),
    'terminal and audited failed registration results must match exactly',
  );
  const auditedFailureCounts = Object.fromEntries(
    Object.entries(
      (failedResults ?? []).reduce((counts, result) => {
        const code = result?.error?.code ?? 'UNKNOWN';
        counts[code] = (counts[code] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(),
  );
  push(errors, JSON.stringify(registration?.resultAudit?.failureCountsByCode) === JSON.stringify(auditedFailureCounts), 'failure counts by code must be derived from preserved failed per-BBL results');
  push(errors, JSON.stringify(summary?.failures?.bulkRegistrationByCode) === JSON.stringify(auditedFailureCounts), 'summary failure counts by code must equal preserved failed per-BBL results');

  const ingestion = summary?.ingestion;
  push(errors, isNonEmptyString(ingestion?.runId), 'ingestion.runId is required');
  push(errors, ingestion?.status === 'COMPLETED', 'ingestion final run status must be COMPLETED');
  push(errors, ingestion?.outcome === 'COMPLETED', 'ingestion outcome must be COMPLETED');
  push(errors, ingestion?.failures === 0, 'ingestion failures must equal zero');
  for (const field of ['uniqueValidBins', 'persistedBatchCount', 'socrataDataCalls', 'socrataMetadataCalls', 'socrataRetryCalls', 'socrataTotalCalls', 'rowsFetched', 'rowsPromoted', 'rowsStaged']) {
    push(errors, isNonNegativeInteger(ingestion?.[field]), `ingestion.${field} must be a non-negative integer`);
  }
  push(errors, ingestion?.uniqueValidBins > 0, 'ingestion must scan at least one valid BIN');
  push(errors, isIsoTimestamp(ingestion?.sourceWatermarkAtStart), 'ingestion start source watermark is required');
  push(errors, isIsoTimestamp(ingestion?.sourceWatermarkAtEnd), 'ingestion end source watermark is required');
  push(errors, ingestion?.sourceWatermarkAtStart === ingestion?.sourceWatermarkAtEnd, 'accepted run start/end watermarks must match');
  push(errors, ingestion?.rowsPromoted === ingestion?.rowsStaged, 'promoted rows must equal the accepted run staging rows');
  push(errors, ingestion?.rowsPromoted <= ingestion?.rowsFetched, 'promoted rows cannot exceed fetched rows');
  push(errors, ingestion?.uniqueValidBins === registration?.resultAudit?.uniqueBins?.length, 'ingestion BIN count must match registered unique valid BINs');

  const bounds = summary?.configuredBounds;
  for (const field of ['batchSize', 'pageSize', 'maxPagesPerBatch', 'concurrency', 'requestTimeoutMs', 'maxRetries', 'maxBatchAttemptsPerRun', 'acceptedPublicationTransactionTimeoutMs']) {
    push(errors, isPositiveInteger(bounds?.[field]), `configuredBounds.${field} must be a positive integer`);
  }
  push(errors, bounds?.pageSize <= 50_000, 'configured page size must be at most 50,000');
  const expectedBatches = Math.ceil((ingestion?.uniqueValidBins ?? 0) / (bounds?.batchSize ?? 1));
  push(errors, ingestion?.persistedBatchCount === expectedBatches, 'persisted batch count must equal ceil(unique valid BINs / batch size)');
  push(errors, database?.expectedBinCount === ingestion?.uniqueValidBins, 'database expected BIN count must match summary');
  push(errors, database?.persistedBatchCount === ingestion?.persistedBatchCount, 'database persisted batch count must match summary');
  push(errors, database?.expectedBatchCount === ingestion?.persistedBatchCount, 'database expected batch count must match persisted batch count');
  push(errors, database?.completedBatchCount === ingestion?.persistedBatchCount, 'every persisted batch must be completed');
  push(errors, database?.rowsFetchedFromBatches === ingestion?.rowsFetched, 'database fetched row count must match summary');
  push(errors, database?.rowsStaged === ingestion?.rowsStaged, 'database staged row count must match summary');
  push(errors, database?.rowsPromoted === ingestion?.rowsPromoted, 'database promoted row count must match summary');
  push(errors, database?.propertyCount === bulk?.accepted, 'database property count must match accepted bulk properties');
  // Compare complete associations, not just counts or the union of BINs: multiple
  // accepted properties may share the same BIN and must all be snapshotted.
  const acceptedResults = (terminalResults ?? []).filter((result) => ['succeeded', 'cached'].includes(result.status));
  const validMapping = (property) => isNonEmptyString(property?.id) &&
    Array.isArray(property?.bins) &&
    property.bins.every((bin) => VALID_BIN.test(bin) && !bin.endsWith('000000')) &&
    new Set(property.bins).size === property.bins.length;
  push(errors, acceptedResults.every((result) => validMapping(result.property)), 'accepted results must preserve property IDs and complete valid BIN mappings');
  const persisted = database?.persistedProperties;
  const snapshot = database?.snapshotProperties;
  push(errors, Array.isArray(persisted) && persisted.every((property) => validMapping(property) && VALID_BBL.test(property.bbl)), 'database must preserve every persisted property and its BIN mapping');
  push(errors, Array.isArray(snapshot) && snapshot.every((property) => validMapping(property) && property.bins.length > 0), 'database must preserve every snapshot property and its BIN mapping');
  const persistedRows = Array.isArray(persisted) ? persisted : [];
  const snapshotRows = Array.isArray(snapshot) ? snapshot : [];
  const acceptedRows = acceptedResults.map((result) => ({ ...result.property, bbl: result.canonicalBbl }));
  const canonicalMappings = (rows, includeBbl = false) => JSON.stringify(rows.map((row) => [
    row.id, ...(includeBbl ? [row.bbl] : []), Array.isArray(row.bins) ? [...row.bins].sort() : null,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  for (const [label, rows] of [['accepted', acceptedRows], ['persisted', persistedRows], ['snapshot', snapshotRows]]) {
    push(errors, new Set(rows.map((row) => row.id)).size === rows.length, `${label} property IDs must be unique`);
  }
  push(errors, canonicalMappings(acceptedRows, true) === canonicalMappings(persistedRows, true), 'persisted properties must exactly match accepted property IDs, BBLs and BIN mappings');
  push(errors, persistedRows.length === bulk?.accepted, 'persisted property mappings must account for every accepted property');
  const scannable = persistedRows.filter((property) => property.bins?.length > 0);
  const noValidBin = persistedRows.filter((property) => Array.isArray(property.bins) && property.bins.length === 0);
  push(errors, canonicalMappings(snapshotRows) === canonicalMappings(scannable), 'snapshot must contain the complete persisted accepted-property watchlist');
  push(errors, database?.snapshotPropertyCount === snapshotRows.length && snapshotRows.length + noValidBin.length === bulk?.accepted, 'snapshot properties plus exactly identified no-valid-BIN properties must equal accepted properties');
  push(errors, database?.propertyBinSnapshotCount === snapshotRows.reduce((count, property) => count + (property.bins?.length ?? 0), 0), 'snapshot association count must match preserved mappings');
  const mappedBins = [...new Set(persistedRows.flatMap((property) => property.bins ?? []))].sort();
  push(errors, JSON.stringify(mappedBins) === JSON.stringify(registration?.resultAudit?.uniqueBins), 'registered BIN union must match complete persisted property mappings');
  push(errors, database?.snapshotBinCount === ingestion?.uniqueValidBins, 'database snapshot BIN count must match summary');
  push(errors, database?.successfulCoverageCount === database?.snapshotPropertyCount, 'every snapshotted property must have successful coverage for this run');
  push(errors, database?.runId === ingestion?.runId && database?.status === ingestion?.status, 'database run identity/status must match summary');

  const arithmetic = summary?.callArithmetic;
  push(errors, arithmetic?.minimumDataPageCalls === ingestion?.persistedBatchCount, 'minimum data-page calls must equal persisted batch count');
  push(errors, arithmetic?.additionalDataPageCalls === ingestion?.socrataDataCalls - ingestion?.persistedBatchCount, 'additional data-page calls arithmetic is inconsistent');
  push(errors, arithmetic?.additionalDataPageCalls >= 0, 'observed data-page calls cannot be below persisted batch count');
  push(errors, arithmetic?.observedTotalCalls === ingestion?.socrataTotalCalls, 'call arithmetic observed total must match ingestion metrics');
  push(errors, ingestion?.socrataTotalCalls === ingestion?.socrataDataCalls + ingestion?.socrataMetadataCalls + ingestion?.socrataRetryCalls, 'Socrata total calls must equal data + metadata + retry calls');
  push(errors, summary?.failures?.bulkRegistration === bulk?.failed, 'summary bulk-registration failures must match registration');
  push(errors, summary?.failures?.ingestion === ingestion?.failures, 'summary ingestion failures must match ingestion');

  if (existsSync(workerLogPath)) {
    const workerLog = readFileSync(workerLogPath, 'utf8');
    const capture = readJson(path.join(evidenceDirectory, 'worker-capture.json'), errors, 'worker stream capture');
    push(errors, capture?.runId === ingestion?.runId && capture?.exitCode === 0, 'worker stream capture must identify the exact successful invocation');
    push(errors, capture?.byteLength === Buffer.byteLength(workerLog, 'utf8') &&
      capture?.sha256 === createHash('sha256').update(workerLog, 'utf8').digest('hex'),
      'raw worker log must match the complete captured stream byte length and SHA-256');
    const records = extractJsonLines(workerLog);
    const starts = records.filter((entry) => entry?.msg === 'ECB manual ingestion started');
    const completions = records.filter((entry) => entry?.msg === 'ECB manual ingestion completed');
    const start = starts[0];
    const completion = completions[0];
    push(errors, starts.length === 1 && start?.triggerType === 'MANUAL', 'raw worker log must retain the manual ingestion start record');
    push(errors, completions.length === 1 && completion?.runId === ingestion?.runId &&
      completion?.status === 'COMPLETED' && completion?.outcome === 'COMPLETED', 'raw worker log must retain the exact accepted run completion record');
    push(errors, workerLog.includes('> node dist/cli/ingest-ecb.js') && workerLog.includes(' ingest:ecb'), 'raw worker log must retain the npm invocation output');
    push(errors, Number.isFinite(start?.time) && Number.isFinite(completion?.time) &&
      records.indexOf(start) < records.indexOf(completion) &&
      start.time >= Date.parse(ingestion?.startedAt) && completion.time <= Date.parse(ingestion?.finishedAt) &&
      completion.time >= start.time && Math.abs(completion.time - start.time - completion.durationMs) <= 1000,
      'worker start/completion timestamps and duration must reconcile with the exact run');
    push(
      errors,
      Number.isFinite(Date.parse(ingestion?.startedAt)) &&
        Number.isFinite(Date.parse(ingestion?.finishedAt)) &&
        Math.abs(
          Date.parse(ingestion.finishedAt) -
            Date.parse(ingestion.startedAt) -
            completion?.durationMs
        ) <= 1000,
      'summary ingestion timestamps must reconcile with the raw worker duration',
    );
    push(
      errors,
      Number.isFinite(summary?.ingestionWallTimeMs) &&
        Number.isFinite(completion?.durationMs) &&
        Math.abs(summary.ingestionWallTimeMs - completion.durationMs) <= 1000,
      'summary ingestion wall time must reconcile with the raw worker duration',
    );
    const logSummary = records.findLast(
      (entry) => entry?.runId === ingestion?.runId && entry?.status !== undefined,
    );
    push(errors, logSummary !== undefined, 'worker log must contain the exact summarized run ID');
    for (const [summaryField, logField] of [
      ['socrataDataCalls', 'socrataDataCalls'],
      ['socrataMetadataCalls', 'socrataMetadataCalls'],
      ['socrataRetryCalls', 'socrataRetryCalls'],
      ['socrataTotalCalls', 'socrataTotalCalls'],
      ['rowsFetched', 'rowsFetched'],
      ['failures', 'failures'],
      ['workerReportedDurationMs', 'durationMs'],
      ['uniqueValidBins', 'binsScanned'],
      ['rowsPromoted', 'rowsWritten'],
    ]) {
      push(errors, ingestion?.[summaryField] === logSummary?.[logField], `worker log ${logField} must match summary`);
    }
    push(errors, !/(X-App-Token|SOCRATA_APP_TOKEN|DATABASE_URL)["'=:\s]+(?!\[Redacted\])\S+/i.test(workerLog), 'worker log appears to contain an unredacted secret');
  }

  return errors;
}

export function assertValidScaleEvidence(evidenceDirectory) {
  const errors = validateScaleEvidence(evidenceDirectory);
  if (errors.length > 0) throw new Error(`scale evidence validation failed:\n- ${errors.join('\n- ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidenceDirectory = parseEvidenceDirectory(process.argv.slice(2));
    assertValidScaleEvidence(evidenceDirectory);
    console.log(`Scale evidence is complete and internally consistent: ${evidenceDirectory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
