import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const REQUIRED_FIXTURE_TAGS = Object.freeze([
  'reference_empire_state',
  'queens_hyphenated_house_number',
  'condominium_unit',
  'small_2_3_family',
  'unpaid_ecb_balance',
]);

export const EVIDENCE_PATHS = Object.freeze({
  seed: 'seed.json',
  health: 'registration/api-health.json',
  registrations: 'registration/requests-responses.json',
  sourceCommand: 'source-contract/command.json',
  sourceLog: 'source-contract/output.log',
  sourceResult: 'source-contract/result.json',
  baselineCommand: 'baseline/command.json',
  baselineLog: 'baseline/ingestion.log',
  baselineRun: 'baseline/run.json',
  baselineProperties: 'baseline/api/properties.json',
  baselinePortfolio: 'baseline/api/portfolio.json',
  secondCommand: 'second-run/command.json',
  secondLog: 'second-run/ingestion.log',
  secondRun: 'second-run/run.json',
  secondProperties: 'second-run/api/properties.json',
  secondPortfolio: 'second-run/api/portfolio.json',
  duplicateAudit: 'duplicate-audit.json',
  summary: 'summary.json',
  bis: 'bis/spot-checks.json',
});

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isHttpUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function push(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validateSeedDocument(seed) {
  const errors = [];
  push(errors, isObject(seed), 'seed must be a JSON object');
  if (!isObject(seed)) return errors;

  push(errors, seed.schemaVersion === 1, 'seed.schemaVersion must equal 1');
  push(errors, /^\d{4}-\d{2}-\d{2}$/.test(seed.preparedAt ?? ''), 'seed.preparedAt must be YYYY-MM-DD');
  push(
    errors,
    Array.isArray(seed.properties) && seed.properties.length >= 5 && seed.properties.length <= 8,
    'seed.properties must contain 5-8 entries',
  );
  if (!Array.isArray(seed.properties)) return errors;

  const ids = new Set();
  const seenTags = new Map(REQUIRED_FIXTURE_TAGS.map((tag) => [tag, 0]));

  seed.properties.forEach((fixture, index) => {
    const prefix = `seed.properties[${index}]`;
    push(errors, isObject(fixture), `${prefix} must be an object`);
    if (!isObject(fixture)) return;

    push(errors, isNonEmptyString(fixture.id), `${prefix}.id is required`);
    push(errors, !ids.has(fixture.id), `${prefix}.id must be unique`);
    ids.add(fixture.id);
    push(errors, isNonEmptyString(fixture.label), `${prefix}.label is required`);
    push(errors, fixture.inputType === 'address' || fixture.inputType === 'bbl', `${prefix}.inputType must be address or bbl`);
    push(errors, isNonEmptyString(fixture.originalInput), `${prefix}.originalInput is required`);
    push(errors, Array.isArray(fixture.requirementTags) && fixture.requirementTags.length > 0, `${prefix}.requirementTags is required`);
    push(errors, Array.isArray(fixture.provenance) && fixture.provenance.length > 0, `${prefix}.provenance is required`);
    push(errors, fixture.bbl === undefined && fixture.bin === undefined && fixture.bins === undefined, `${prefix} must not hard-code resolved identifiers as input truth`);

    for (const tag of fixture.requirementTags ?? []) {
      if (seenTags.has(tag)) seenTags.set(tag, seenTags.get(tag) + 1);
    }
    (fixture.provenance ?? []).forEach((source, sourceIndex) => {
      push(errors, isObject(source), `${prefix}.provenance[${sourceIndex}] must be an object`);
      if (!isObject(source)) return;
      push(errors, isNonEmptyString(source.note), `${prefix}.provenance[${sourceIndex}].note is required`);
      push(errors, isHttpUrl(source.url), `${prefix}.provenance[${sourceIndex}].url must be HTTP(S)`);
      push(errors, /^\d{4}-\d{2}-\d{2}$/.test(source.accessedAt ?? ''), `${prefix}.provenance[${sourceIndex}].accessedAt must be YYYY-MM-DD`);
    });
  });

  for (const [tag, count] of seenTags) {
    push(errors, count >= 1, `seed is missing required tag ${tag}`);
  }

  const empire = seed.properties.find((fixture) => fixture.requirementTags?.includes('reference_empire_state'));
  push(errors, /350\s+5th\s+avenue/i.test(empire?.originalInput ?? ''), 'Empire State fixture must retain 350 5th Avenue');
  const queens = seed.properties.find((fixture) => fixture.requirementTags?.includes('queens_hyphenated_house_number'));
  push(errors, /^37-15\b/.test(queens?.originalInput ?? ''), 'Queens fixture must retain the 37-15 hyphenated house number');
  const condo = seed.properties.find((fixture) => fixture.requirementTags?.includes('condominium_unit'));
  push(errors, /\s(?:(?:apt|apartment|unit|suite|ste|floor|fl)\.?\s+|#\s*)[a-z0-9][a-z0-9-]*\s*$/i.test(condo?.originalInput ?? ''), 'condominium fixture must end with a resolver-supported unit designator');
  const small = seed.properties.find((fixture) => fixture.requirementTags?.includes('small_2_3_family'));
  push(errors, small?.provenance?.some((source) => /(?:two|three|2|3)[ -]?family/i.test(source.note ?? '')), 'small-property provenance must state two- or three-family classification');
  const unpaid = seed.properties.find((fixture) => fixture.requirementTags?.includes('unpaid_ecb_balance'));
  push(errors, unpaid?.provenance?.some((source) => /balance_due.+(?:greater than zero|>\s*0)/i.test(source.note ?? '')), 'unpaid fixture provenance must state balance_due > 0 selection');

  return errors;
}

export function readJson(filePath, errors, label) {
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

function requireNonEmptyFile(root, relativePath, errors, label) {
  const filePath = path.join(root, relativePath);
  push(errors, existsSync(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 0, `${label} is missing or empty (${relativePath})`);
}

function validateCommand(document, errors, label) {
  push(errors, isObject(document), `${label} must be an object`);
  if (!isObject(document)) return;
  push(errors, isNonEmptyString(document.command), `${label}.command is required`);
  push(errors, Array.isArray(document.args) && document.args.every(isNonEmptyString), `${label}.args must be a string array`);
  push(errors, isNonEmptyString(document.display), `${label}.display is required`);
}

function validateRun(run, errors, label) {
  push(errors, isObject(run), `${label} must be an object`);
  if (!isObject(run)) return;
  push(errors, isNonEmptyString(run.runId), `${label}.runId is required`);
  push(errors, run.status === 'COMPLETED', `${label}.status must be COMPLETED`);
  push(errors, isIsoTimestamp(run.startedAt), `${label}.startedAt must be a timestamp`);
  push(errors, isIsoTimestamp(run.finishedAt), `${label}.finishedAt must be a timestamp`);
  push(errors, Array.isArray(run.sourceWatermarks) && run.sourceWatermarks.length > 0 && run.sourceWatermarks.every(isIsoTimestamp), `${label}.sourceWatermarks must contain timestamps`);
  push(errors, isObject(run.metrics), `${label}.metrics is required`);
  for (const field of ['binsScanned', 'socrataDataCalls', 'socrataMetadataCalls', 'socrataRetryCalls', 'socrataTotalCalls', 'rowsFetched', 'rowsWritten', 'failures']) {
    push(errors, Number.isInteger(run.metrics?.[field]) && run.metrics[field] >= 0, `${label}.metrics.${field} must be a non-negative integer`);
  }
}

function validatePageMetadata(page, errors, label) {
  push(errors, isObject(page), `${label} must be an object`);
  if (!isObject(page)) return;
  push(errors, Number.isInteger(page.limit) && page.limit > 0, `${label}.limit must be a positive integer`);
  push(errors, typeof page.hasMore === 'boolean', `${label}.hasMore must be boolean`);
  push(
    errors,
    page.hasMore === true ? isNonEmptyString(page.nextCursor) : page.nextCursor === null,
    `${label}.nextCursor must be non-empty exactly when hasMore is true`,
  );
}

function validateCoverage(coverage, errors, label) {
  push(errors, isObject(coverage), `${label} must be an object`);
  if (!isObject(coverage)) return;
  push(errors, coverage.status === 'CHECKED', `${label}.status must be CHECKED`);
  push(errors, coverage.statusReason === null || isNonEmptyString(coverage.statusReason), `${label}.statusReason must be null or a non-empty string`);
  for (const field of ['lastAttemptAt', 'lastSuccessAt', 'sourceWatermarkAt']) {
    push(errors, isIsoTimestamp(coverage[field]), `${label}.${field} must be a timestamp`);
  }
  push(errors, coverage.lastError === null, `${label}.lastError must be null for CHECKED coverage`);
}

function validateRequestTraces(requests, pages, errors, label, expectedPath) {
  push(errors, Array.isArray(requests) && requests.length > 0, `${label}.requests must be a non-empty array`);
  if (!Array.isArray(requests)) return;

  push(errors, requests.length === pages.length, `${label}.requests must contain exactly one trace per response page`);
  for (const [index, request] of requests.entries()) {
    const requestLabel = `${label}.requests[${index}]`;
    push(errors, isObject(request), `${requestLabel} must be an object`);
    if (!isObject(request)) continue;

    push(errors, request.pageNumber === index + 1, `${requestLabel}.pageNumber must be ${index + 1}`);
    push(errors, isIsoTimestamp(request.requestedAt), `${requestLabel}.requestedAt must be a timestamp`);
    push(errors, isIsoTimestamp(request.respondedAt), `${requestLabel}.respondedAt must be a timestamp`);
    push(
      errors,
      isIsoTimestamp(request.requestedAt) &&
        isIsoTimestamp(request.respondedAt) &&
        Date.parse(request.respondedAt) >= Date.parse(request.requestedAt),
      `${requestLabel}.respondedAt must not precede requestedAt`,
    );
    push(errors, request.method === 'GET', `${requestLabel}.method must be GET`);
    push(errors, isHttpUrl(request.url), `${requestLabel}.url must be HTTP(S)`);
    push(errors, request.httpStatus === 200, `${requestLabel}.httpStatus must be 200`);

    if (isHttpUrl(request.url)) {
      const url = new URL(request.url);
      push(errors, url.pathname === expectedPath, `${requestLabel}.url must target ${expectedPath}`);
      const requestedLimit = Number(url.searchParams.get('limit'));
      push(
        errors,
        Number.isInteger(requestedLimit) && requestedLimit > 0 && requestedLimit === pages[index]?.page?.limit,
        `${requestLabel}.url limit must match the response page limit`,
      );
      const expectedCursor = index === 0 ? null : pages[index - 1]?.page?.nextCursor;
      push(
        errors,
        url.searchParams.get('cursor') === expectedCursor,
        `${requestLabel}.url cursor must continue the preceding response page`,
      );
    }
  }
}

function validatePropertySnapshots(document, seedIds, errors, label) {
  push(errors, isObject(document) && Array.isArray(document.properties), `${label}.properties must be an array`);
  if (!Array.isArray(document?.properties)) return;
  const capturedIds = new Set();
  for (const property of document.properties) {
    capturedIds.add(property.fixtureId);
    push(errors, seedIds.has(property.fixtureId), `${label} contains unknown fixture ${property.fixtureId}`);
    push(errors, isNonEmptyString(property.propertyId), `${label} propertyId is required for ${property.fixtureId}`);
    push(errors, Array.isArray(property.pages) && property.pages.length > 0, `${label} pages are required for ${property.fixtureId}`);
    const pages = Array.isArray(property.pages) ? property.pages : [];
    validateRequestTraces(property.requests, pages, errors, `${label} for ${property.fixtureId}`, `/properties/${encodeURIComponent(property.propertyId)}/ecb-violations`);
    for (const [pageIndex, page] of pages.entries()) {
      push(errors, Array.isArray(page.violations), `${label} violations must be an array for ${property.fixtureId}`);
      for (const [violationIndex, violation] of (Array.isArray(page.violations) ? page.violations : []).entries()) {
        push(errors, isNonEmptyString(violation?.sourceId), `${label} sourceId is required for ${property.fixtureId} page ${pageIndex + 1} violation ${violationIndex + 1}`);
      }
      validatePageMetadata(page.page, errors, `${label} pagination for ${property.fixtureId} page ${pageIndex + 1}`);
      validateCoverage(page.coverage, errors, `${label} coverage for ${property.fixtureId} page ${pageIndex + 1}`);
    }
  }
  for (const id of seedIds) push(errors, capturedIds.has(id), `${label} is missing fixture ${id}`);
}

function validatePortfolioSnapshot(document, errors, label) {
  push(errors, isObject(document) && Array.isArray(document.pages) && document.pages.length > 0, `${label}.pages must be non-empty`);
  const pages = Array.isArray(document?.pages) ? document.pages : [];
  validateRequestTraces(document?.requests, pages, errors, label, '/ecb-violations');
  for (const [pageIndex, page] of pages.entries()) {
    push(errors, Array.isArray(page.violations), `${label} violations must be an array`);
    for (const [violationIndex, violation] of (Array.isArray(page.violations) ? page.violations : []).entries()) {
      push(errors, isNonEmptyString(violation?.sourceId), `${label} sourceId is required for page ${pageIndex + 1} violation ${violationIndex + 1}`);
    }
    validatePageMetadata(page.page, errors, `${label} pagination for page ${pageIndex + 1}`);
  }
}

function auditApiSnapshots(propertySnapshot, portfolioSnapshot) {
  const propertyResultRows = (propertySnapshot?.properties ?? []).reduce(
    (total, property) => total + (property.pages ?? []).reduce(
      (pageTotal, page) => pageTotal + (Array.isArray(page.violations) ? page.violations.length : 0),
      0,
    ),
    0,
  );
  const portfolioSourceIds = (portfolioSnapshot?.pages ?? []).flatMap((page) =>
    Array.isArray(page.violations) ? page.violations.map((violation) => violation?.sourceId) : [],
  );
  const portfolioUniqueSourceIds = new Set(portfolioSourceIds).size;
  return {
    propertyResultRows,
    portfolioResultRows: portfolioSourceIds.length,
    portfolioUniqueSourceIds,
    duplicateSourceIdCount: portfolioSourceIds.length - portfolioUniqueSourceIds,
  };
}

export function validateEvidenceDirectory(root) {
  const errors = [];
  const load = (key, label) => readJson(path.join(root, EVIDENCE_PATHS[key]), errors, label);
  const seed = load('seed', 'seed evidence');
  errors.push(...validateSeedDocument(seed));
  const seedIds = new Set(seed?.properties?.map((fixture) => fixture.id) ?? []);

  requireNonEmptyFile(root, EVIDENCE_PATHS.sourceLog, errors, 'source-contract log');
  requireNonEmptyFile(root, EVIDENCE_PATHS.baselineLog, errors, 'baseline ingestion log');
  requireNonEmptyFile(root, EVIDENCE_PATHS.secondLog, errors, 'second-run ingestion log');

  const health = load('health', 'API health snapshot');
  push(errors, health?.response?.status === 'ok' && health?.httpStatus === 200, 'API health snapshot must record HTTP 200 {status:"ok"}');

  const sourceCommand = load('sourceCommand', 'source-contract command');
  const baselineCommand = load('baselineCommand', 'baseline command');
  const secondCommand = load('secondCommand', 'second-run command');
  validateCommand(sourceCommand, errors, 'source-contract command');
  validateCommand(baselineCommand, errors, 'baseline command');
  validateCommand(secondCommand, errors, 'second-run command');
  push(errors, sourceCommand?.args?.includes('verify:ecb-source-contract'), 'source-contract command must use the explicit probe');
  push(errors, baselineCommand?.args?.includes('ingest:ecb'), 'baseline command must use the documented ingestion CLI');
  push(errors, secondCommand?.args?.includes('ingest:ecb'), 'second-run command must use the documented ingestion CLI');

  const source = load('sourceResult', 'source-contract result');
  push(errors, source?.valid === true, 'source-contract result must be valid');
  for (const field of ['sourceIdField', 'socrataRowIdField', 'sourceRowUpdatedAtField']) push(errors, isNonEmptyString(source?.[field]), `source-contract ${field} is required`);
  for (const field of ['totalRowCount', 'distinctSourceIdCount', 'nullSourceIdCount']) push(errors, Number.isInteger(source?.[field]) && source[field] >= 0, `source-contract ${field} must be a non-negative integer`);
  push(errors, Array.isArray(source?.duplicateGroups), 'source-contract duplicateGroups must be an array');
  push(errors, source?.nullSourceIdCount === 0, 'source-contract must contain no NULL source IDs');
  push(errors, source?.duplicateGroups?.length === 0, 'source-contract must contain no duplicate source-ID groups');
  push(errors, source?.totalRowCount === source?.distinctSourceIdCount, 'source-contract total and distinct source-ID counts must match');

  const registrations = load('registrations', 'registration evidence');
  push(errors, Array.isArray(registrations?.entries), 'registration evidence entries must be an array');
  const registrationIds = new Set();
  const fixturesById = new Map(seed?.properties?.map((fixture) => [fixture.id, fixture]) ?? []);
  for (const entry of registrations?.entries ?? []) {
    registrationIds.add(entry.fixtureId);
    const fixture = fixturesById.get(entry.fixtureId);
    push(errors, entry.httpStatus === 200, `registration for ${entry.fixtureId} must be HTTP 200`);
    push(errors, isObject(entry.request), `registration request is required for ${entry.fixtureId}`);
    push(errors, entry.request?.method === 'POST' && isHttpUrl(entry.request?.url), `registration request method/URL is required for ${entry.fixtureId}`);
    push(errors, fixture !== undefined && entry.request?.body?.[fixture.inputType] === fixture.originalInput, `registration request must preserve the seed input for ${entry.fixtureId}`);
    push(errors, isNonEmptyString(entry.response?.id), `registration response property id is required for ${entry.fixtureId}`);
    push(errors, /^\d{10}$/.test(entry.response?.bbl ?? ''), `registration response BBL is required for ${entry.fixtureId}`);
    push(errors, Array.isArray(entry.response?.bins), `registration response BIN list is required for ${entry.fixtureId}`);
  }
  for (const id of seedIds) push(errors, registrationIds.has(id), `registration evidence is missing fixture ${id}`);

  const baselineRun = load('baselineRun', 'baseline run');
  const secondRun = load('secondRun', 'second run');
  validateRun(baselineRun, errors, 'baseline run');
  validateRun(secondRun, errors, 'second run');
  push(errors, baselineRun?.runId !== secondRun?.runId, 'baseline and second-run IDs must be distinct');

  const baselineProperties = load('baselineProperties', 'baseline property API snapshot');
  const secondProperties = load('secondProperties', 'second property API snapshot');
  const baselinePortfolio = load('baselinePortfolio', 'baseline portfolio API snapshot');
  const secondPortfolio = load('secondPortfolio', 'second portfolio API snapshot');
  validatePropertySnapshots(baselineProperties, seedIds, errors, 'baseline property API snapshot');
  validatePropertySnapshots(secondProperties, seedIds, errors, 'second property API snapshot');
  validatePortfolioSnapshot(baselinePortfolio, errors, 'baseline portfolio API snapshot');
  validatePortfolioSnapshot(secondPortfolio, errors, 'second portfolio API snapshot');

  const audit = load('duplicateAudit', 'duplicate audit');
  push(errors, isObject(audit?.baseline) && isObject(audit?.secondRun) && isObject(audit?.delta), 'duplicate audit must contain baseline, secondRun, and delta');
  push(errors, isNonEmptyString(audit?.baselineRunId) && audit.baselineRunId === baselineRun?.runId, 'duplicate audit baselineRunId must match baseline run');
  push(errors, isNonEmptyString(audit?.secondRunId) && audit.secondRunId === secondRun?.runId, 'duplicate audit secondRunId must match second run');
  const snapshotAudits = {
    baseline: auditApiSnapshots(baselineProperties, baselinePortfolio),
    secondRun: auditApiSnapshots(secondProperties, secondPortfolio),
  };
  for (const side of ['baseline', 'secondRun']) {
    for (const field of ['propertyResultRows', 'portfolioResultRows', 'portfolioUniqueSourceIds', 'duplicateSourceIdCount']) {
      push(errors, Number.isInteger(audit?.[side]?.[field]) && audit[side][field] >= 0, `duplicate audit ${side}.${field} must be a non-negative integer`);
      push(errors, audit?.[side]?.[field] === snapshotAudits[side][field], `duplicate audit ${side}.${field} must match API snapshots`);
    }
    push(errors, audit?.[side]?.portfolioUniqueSourceIds <= audit?.[side]?.portfolioResultRows, `duplicate audit ${side} unique source IDs cannot exceed result rows`);
    push(errors, audit?.[side]?.duplicateSourceIdCount === audit?.[side]?.portfolioResultRows - audit?.[side]?.portfolioUniqueSourceIds, `duplicate audit ${side} duplicate count must equal result rows minus unique source IDs`);
    push(errors, audit?.[side]?.duplicateSourceIdCount === 0, `duplicate audit ${side} must contain no duplicate portfolio source IDs`);
  }
  for (const field of ['propertyResultRows', 'portfolioResultRows', 'portfolioUniqueSourceIds']) {
    push(errors, Number.isInteger(audit?.delta?.[field]), `duplicate audit delta.${field} must be an integer`);
    push(errors, audit?.delta?.[field] === audit?.secondRun?.[field] - audit?.baseline?.[field], `duplicate audit delta.${field} must match recorded counts`);
  }
  const calculatedIdempotency =
    audit?.baseline?.duplicateSourceIdCount === 0 &&
    audit?.secondRun?.duplicateSourceIdCount === 0 &&
    audit?.delta?.portfolioResultRows === audit?.delta?.portfolioUniqueSourceIds;
  push(errors, audit?.idempotentNoDuplicateGrowth === calculatedIdempotency, 'duplicate audit idempotentNoDuplicateGrowth must match recorded counts');
  push(errors, audit?.idempotentNoDuplicateGrowth === true, 'duplicate audit must demonstrate idempotent no-duplicate growth');

  const summary = load('summary', 'machine-readable summary');
  push(errors, summary?.schemaVersion === 1, 'summary.schemaVersion must equal 1');
  push(errors, isIsoTimestamp(summary?.startedAt) && isIsoTimestamp(summary?.finishedAt), 'summary timestamps are required');
  push(errors, summary?.runs?.baseline?.runId === baselineRun?.runId, 'summary baseline run ID must match baseline evidence');
  push(errors, summary?.runs?.secondRun?.runId === secondRun?.runId, 'summary second-run ID must match second-run evidence');
  push(errors, Array.isArray(summary?.commands) && summary.commands.length >= 3, 'summary must record commands used');
  push(errors, isObject(summary?.rowCountDeltas), 'summary row/count deltas are required');
  for (const field of ['propertyResultRows', 'portfolioResultRows', 'portfolioUniqueSourceIds']) {
    push(errors, Number.isInteger(summary?.rowCountDeltas?.[field]), `summary rowCountDeltas.${field} must be an integer`);
    push(errors, summary?.rowCountDeltas?.[field] === audit?.delta?.[field], `summary rowCountDeltas.${field} must match duplicate audit`);
  }
  push(errors, summary?.duplicateAudit?.idempotentNoDuplicateGrowth === true, 'summary must record successful idempotency');

  const bis = load('bis', 'BIS spot-check evidence');
  push(errors, Array.isArray(bis?.checks) && bis.checks.length >= 2, 'at least two BIS spot-check records are required');
  const bisFixtureIds = new Set();
  for (const [index, check] of (bis?.checks ?? []).entries()) {
    bisFixtureIds.add(check.fixtureId);
    push(errors, seedIds.has(check.fixtureId), `BIS check ${index} must reference a seed fixture`);
    push(errors, isIsoTimestamp(check.checkedAt), `BIS check ${index}.checkedAt is required`);
    push(errors, isHttpUrl(check.bisUrl) && new URL(check.bisUrl).hostname === 'a810-bisweb.nyc.gov', `BIS check ${index}.bisUrl must use the BIS Property Profile host`);
    push(errors, isNonEmptyString(check.localObservation), `BIS check ${index}.localObservation is required`);
    push(errors, isNonEmptyString(check.bisObservation), `BIS check ${index}.bisObservation is required`);
    push(errors, typeof check.matches === 'boolean', `BIS check ${index}.matches must be boolean`);
    push(errors, isNonEmptyString(check.notes), `BIS check ${index}.notes is required`);
  }
  push(errors, bisFixtureIds.size >= 2, 'BIS spot checks must cover two distinct fixtures');

  return errors;
}

export function assertNoValidationErrors(errors, label) {
  if (errors.length > 0) {
    throw new Error(`${label} failed:\n- ${errors.join('\n- ')}`);
  }
}
