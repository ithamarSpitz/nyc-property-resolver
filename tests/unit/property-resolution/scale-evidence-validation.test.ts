import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');
const SEED_PATH = path.join(REPOSITORY_ROOT, 'seed/scale-10000-bbls.json');
const temporaryDirectories: string[] = [];
function createEvidenceDirectory(): string {
  const directory = mkdtempSync(path.join(REPOSITORY_ROOT, 'evidence/scale-10000/test-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const VALIDATOR_PATH = path.join(REPOSITORY_ROOT, 'scripts/acceptance/validate-scale-evidence.mjs');

function readSeedBbls(count = 10_000): string[] {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { bbls: string[] };
  return seed.bbls.slice(0, count);
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runValidator(evidenceDirectory: string): string[] {
  const result = spawnSync(process.execPath, [VALIDATOR_PATH, evidenceDirectory], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return [];
  }

  const message = (result.stderr || result.stdout || '').trim();
  const marker = 'scale evidence validation failed:\n- ';
  if (!message.includes(marker)) {
    return message.length > 0 ? [message] : ['validator subprocess failed'];
  }

  return message
    .slice(message.indexOf(marker) + marker.length)
    .split('\n- ')
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildValidEvidence(options: {
  accepted: number;
  failed: number;
  failedResults: Array<{
    inputBbl: string;
    canonicalBbl: string;
    code: string;
    message: string;
  }>;
}) {
  const seedBbls = readSeedBbls();
  const failedResults = options.failedResults.map((failure) => ({
    inputBbl: failure.inputBbl,
    canonicalBbl: failure.canonicalBbl,
    status: 'failed',
    error: {
      code: failure.code,
      message: failure.message,
    },
  }));
  const uniqueBins = Array.from({ length: Math.min(options.accepted, 100) }, (_, index) =>
    `100${String(index + 1).padStart(4, '0')}`,
  );
  const failureCountsByCode = Object.fromEntries(
    Object.entries(
      failedResults.reduce<Record<string, number>>((counts, result) => {
        const code = result.error.code;
        counts[code] = (counts[code] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(),
  );
  const failuresByBbl = new Map(failedResults.map((result) => [result.inputBbl, result]));
  const terminalResults = seedBbls.map((bbl, index) =>
    failuresByBbl.get(bbl) ?? {
      inputBbl: bbl,
      canonicalBbl: bbl,
      status: 'succeeded',
      property: { id: `property-${bbl}`, bins: index % 40 === 0 ? [] : [uniqueBins[index % uniqueBins.length]] },
    },
  );

  const persistedProperties = terminalResults.flatMap((result) => 'property' in result
    ? [{ ...result.property, bbl: result.canonicalBbl }] : []);
  const snapshotProperties = persistedProperties.filter((property) => property.bins.length > 0)
    .map(({ id, bins }) => ({ id, bins }));

  return {
    summary: {
      schemaVersion: 1,
      status: 'complete',
      startedAt: '2026-09-18T10:00:00.000Z',
      finishedAt: '2026-09-18T10:30:00.000Z',
      wallTimeMs: 1_800_000,
      registrationWallTimeMs: 900_000,
      ingestionWallTimeMs: 900_000,
      sample: {
        datasetId: '64uk-42ks',
        communityDistricts: ['102', '108'],
        requestedProperties: 10_000,
        requestedUniqueBbls: 10_000,
        uniqueProperties: options.accepted,
      },
      bulkRegistration: {
        endpoint: '/properties/bulk',
        bulkRequestSize: 200,
        httpRequestCount: 50,
        submitted: 10_000,
        unique: 10_000,
        succeeded: options.accepted,
        cached: 0,
        accepted: options.accepted,
        failed: options.failed,
      },
      configuredBounds: {
        batchSize: 1_000,
        pageSize: 50_000,
        maxPagesPerBatch: 100,
        concurrency: 10,
        requestTimeoutMs: 15_000,
        maxRetries: 3,
        maxBatchAttemptsPerRun: 3,
        acceptedPublicationTransactionTimeoutMs: 60_000,
      },
      ingestion: {
        runId: '11111111-1111-1111-1111-111111111111',
        outcome: 'COMPLETED',
        status: 'COMPLETED',
        startedAt: '2026-09-18T10:15:00.000Z',
        finishedAt: '2026-09-18T10:30:00.000Z',
        sourceWatermarkAtStart: '2026-09-18T09:00:00.000Z',
        sourceWatermarkAtEnd: '2026-09-18T09:00:00.000Z',
        uniqueValidBins: uniqueBins.length,
        persistedBatchCount: 1,
        socrataDataCalls: 1,
        socrataMetadataCalls: 2,
        socrataRetryCalls: 0,
        socrataTotalCalls: 3,
        rowsFetched: 10,
        rowsStaged: 10,
        rowsPromoted: 10,
        failures: 0,
        workerReportedDurationMs: 900_000,
      },
      callArithmetic: {
        formula: 'total = data-page calls + metadata calls + retry calls',
        batchFormula: 'persisted batches = ceil(unique valid BINs / configured batch size)',
        minimumDataPageCalls: 1,
        additionalDataPageCalls: 0,
        observedTotalCalls: 3,
        substituted: '3 = 1 + 2 + 0',
      },
      failures: {
        bulkRegistration: options.failed,
        bulkRegistrationByCode: failureCountsByCode,
        ingestion: 0,
      },
      commands: [],
      artifacts: {},
    },
    registration: {
      startedAt: '2026-09-18T10:00:00.000Z',
      finishedAt: '2026-09-18T10:15:00.000Z',
      wallTimeMs: 900_000,
      request: {
        method: 'POST',
        url: 'http://localhost:3000/properties/bulk',
        path: '/properties/bulk',
        bblCount: 10_000,
        bulkRequestSize: 200,
        requestCount: 50,
      },
      requests: Array.from({ length: 50 }, (_, index) => {
        const isLastRequest = index === 49;
        const requestFailedResults = isLastRequest ? failedResults : [];
        const requestSucceeded = 200 - requestFailedResults.length;
        return {
          requestNumber: index + 1,
          startedAt: '2026-09-18T10:00:00.000Z',
          finishedAt: '2026-09-18T10:00:01.000Z',
          bblCount: 200,
          firstBbl: seedBbls[index * 200],
          lastBbl: seedBbls[index * 200 + 199],
          httpStatus: 200,
          responseSummary: {
            submitted: 200,
            unique: 200,
            succeeded: requestSucceeded,
            failed: requestFailedResults.length,
            cached: 0,
          },
          failedResults: requestFailedResults,
        };
      }),
      httpStatus: 200,
      responseSummary: {
        submitted: 10_000,
        unique: 10_000,
        succeeded: options.accepted,
        cached: 0,
        failed: options.failed,
      },
      resultAudit: {
        resultCount: 10_000,
        acceptedResultCount: options.accepted,
        uniquePropertyIds: options.accepted,
        uniqueBins,
        allBinsValid: true,
        terminalResults,
        failedResults,
        failureCountsByCode,
      },
    },
    database: {
      runId: '11111111-1111-1111-1111-111111111111',
      status: 'COMPLETED',
      expectedBinCount: uniqueBins.length,
      expectedBatchCount: 1,
      sourceWatermarkAtStart: '2026-09-18T09:00:00.000Z',
      sourceWatermarkAtEnd: '2026-09-18T09:00:00.000Z',
      failureStage: null,
      lastError: null,
      propertyCount: options.accepted,
      snapshotPropertyCount: snapshotProperties.length,
      persistedProperties,
      snapshotProperties,
      snapshotBinCount: uniqueBins.length,
      propertyBinSnapshotCount: snapshotProperties.length,
      persistedBatchCount: 1,
      completedBatchCount: 1,
      rowsFetchedFromBatches: 10,
      rowsStaged: 10,
      rowsPromoted: 10,
      successfulCoverageCount: snapshotProperties.length,
    },
    workerLog: `> nyc-property-resolver@0.1.0 ingest:ecb
> node dist/cli/ingest-ecb.js
${JSON.stringify({ time: Date.parse('2026-09-18T10:15:00.000Z'), triggerType: 'MANUAL', msg: 'ECB manual ingestion started' })}
${JSON.stringify({ time: Date.parse('2026-09-18T10:30:00.000Z'), msg: 'ECB manual ingestion completed', outcome: 'COMPLETED', runId: '11111111-1111-1111-1111-111111111111', status: 'COMPLETED', binsScanned: uniqueBins.length, rowsWritten: 10, socrataDataCalls: 1, socrataMetadataCalls: 2, socrataRetryCalls: 0, socrataTotalCalls: 3, rowsFetched: 10, failures: 0, durationMs: 900000 })}
`,
    apiLog: 'api started\n',
  };
}

function writeEvidence(evidenceDirectory: string, evidence: ReturnType<typeof buildValidEvidence>): void {
  writeJson(path.join(evidenceDirectory, 'summary.json'), evidence.summary);
  writeJson(path.join(evidenceDirectory, 'bulk-registration.json'), evidence.registration);
  writeJson(path.join(evidenceDirectory, 'database-run.json'), evidence.database);
  writeFileSync(path.join(evidenceDirectory, 'worker.log'), evidence.workerLog, 'utf8');
  writeJson(path.join(evidenceDirectory, 'worker-capture.json'), {
    runId: evidence.summary.ingestion.runId,
    exitCode: 0,
    byteLength: Buffer.byteLength(evidence.workerLog, 'utf8'),
    sha256: createHash('sha256').update(evidence.workerLog, 'utf8').digest('hex'),
  });
  writeFileSync(path.join(evidenceDirectory, 'api.log'), evidence.apiLog, 'utf8');
}

describe('scale evidence validation', () => {
  it('accepts internally consistent evidence with measured resolver failures', () => {
    const seedBbls = readSeedBbls();
    const evidenceDirectory = createEvidenceDirectory();
    writeEvidence(
      evidenceDirectory,
      buildValidEvidence({
        accepted: 9_986,
        failed: 14,
        failedResults: seedBbls.slice(0, 14).map((bbl) => ({
          inputBbl: bbl,
          canonicalBbl: bbl,
          code: 'RESOLVER_PLUTO_INCOMPLETE',
          message: `PLUTO contained parcel ${bbl} but required resolver attributes are missing or inconsistent: missing_address`,
        })),
      }),
    );

    expect(runValidator(evidenceDirectory)).toEqual([]);
  });

  it('rejects accepted/failed totals that do not reconcile to 10,000', () => {
    const evidenceDirectory = createEvidenceDirectory();
    writeEvidence(
      evidenceDirectory,
      buildValidEvidence({
        accepted: 9_990,
        failed: 5,
        failedResults: [],
      }),
    );

    const errors = runValidator(evidenceDirectory);
    expect(errors.some((error) => error.includes('accepted plus failed must account for all 10,000 inputs'))).toBe(
      true,
    );
  });

  it('rejects missing or unstructured failure detail', () => {
    const seedBbls = readSeedBbls();
    const evidenceDirectory = createEvidenceDirectory();
    writeEvidence(
      evidenceDirectory,
      buildValidEvidence({
        accepted: 9_998,
        failed: 2,
        failedResults: [
          {
            inputBbl: seedBbls[0],
            canonicalBbl: seedBbls[0],
            code: 'RESOLVER_PLUTO_INCOMPLETE',
            message: 'missing address',
          },
          {
            inputBbl: seedBbls[1],
            canonicalBbl: seedBbls[1],
            code: '',
            message: '',
          },
        ],
      }),
    );

    const errors = runValidator(evidenceDirectory);
    expect(errors.some((error) => error.includes('exact structured application error'))).toBe(true);
  });

  it('rejects duplicate failed registration BBLs', () => {
    const seedBbls = readSeedBbls();
    const evidenceDirectory = createEvidenceDirectory();
    const duplicateFailure = {
      inputBbl: seedBbls[0],
      canonicalBbl: seedBbls[0],
      code: 'RESOLVER_PLUTO_INCOMPLETE',
      message: `PLUTO contained parcel ${seedBbls[0]} but required resolver attributes are missing or inconsistent: missing_address`,
    };
    writeEvidence(
      evidenceDirectory,
      buildValidEvidence({
        accepted: 9_998,
        failed: 2,
        failedResults: [duplicateFailure, duplicateFailure],
      }),
    );

    const errors = runValidator(evidenceDirectory);
    expect(errors.some((error) => error.includes('failed registration BBLs must be unique'))).toBe(true);
  });

  it('rejects summary failure counts by code that do not match preserved failures', () => {
    const seedBbls = readSeedBbls();
    const evidenceDirectory = createEvidenceDirectory();
    const evidence = buildValidEvidence({
      accepted: 9_999,
      failed: 1,
      failedResults: [
        {
          inputBbl: seedBbls[0],
          canonicalBbl: seedBbls[0],
          code: 'RESOLVER_PLUTO_INCOMPLETE',
          message: 'missing address',
        },
      ],
    });
    evidence.summary.failures.bulkRegistrationByCode = {};
    writeEvidence(evidenceDirectory, evidence);

    const errors = runValidator(evidenceDirectory);
    expect(errors.some((error) => error.includes('summary failure counts by code'))).toBe(true);
  });

  it('rejects a missing terminal outcome for a seed BBL', () => {
    const evidenceDirectory = createEvidenceDirectory();
    const evidence = buildValidEvidence({ accepted: 10_000, failed: 0, failedResults: [] });
    evidence.registration.resultAudit.terminalResults.pop();
    writeEvidence(evidenceDirectory, evidence);

    const errors = runValidator(evidenceDirectory);
    expect(errors.some((error) => error.includes('terminal registration result count must equal 10,000'))).toBe(true);
  });

  it('rejects an incomplete snapshot even when the BIN union is unchanged', () => {
    const directory = createEvidenceDirectory();
    const evidence = buildValidEvidence({ accepted: 10_000, failed: 0, failedResults: [] });
    evidence.database.snapshotProperties.pop();
    evidence.database.snapshotPropertyCount -= 1;
    evidence.database.successfulCoverageCount -= 1;
    evidence.database.propertyBinSnapshotCount -= 1;
    writeEvidence(directory, evidence);
    expect(runValidator(directory)).toContain('snapshot must contain the complete persisted accepted-property watchlist');
  });

  it('rejects missing accepted property mappings', () => {
    const directory = createEvidenceDirectory();
    const evidence = buildValidEvidence({ accepted: 10_000, failed: 0, failedResults: [] });
    const result = evidence.registration.resultAudit.terminalResults[1];
    if ('property' in result) Reflect.deleteProperty(result, 'property');
    writeEvidence(directory, evidence);
    expect(runValidator(directory)).toContain('accepted results must preserve property IDs and complete valid BIN mappings');
  });

  it('rejects substituted snapshot property IDs with unchanged counts and BINs', () => {
    const directory = createEvidenceDirectory();
    const evidence = buildValidEvidence({ accepted: 10_000, failed: 0, failedResults: [] });
    evidence.database.snapshotProperties[0].id = 'unregistered-property';
    writeEvidence(directory, evidence);
    expect(runValidator(directory)).toContain('snapshot must contain the complete persisted accepted-property watchlist');
  });

  it('rejects worker stream edits even when lifecycle records remain intact', () => {
    const directory = createEvidenceDirectory();
    const evidence = buildValidEvidence({ accepted: 10_000, failed: 0, failedResults: [] });
    evidence.workerLog += 'original command output\n';
    writeEvidence(directory, evidence);
    writeFileSync(path.join(directory, 'worker.log'), evidence.workerLog.replace('original command output\n', ''), 'utf8');
    expect(runValidator(directory)).toContain('raw worker log must match the complete captured stream byte length and SHA-256');
  });

  it.each(['summary-only', 'missing-npm', 'wrong-time', 'wrong-run'])('rejects %s worker output', (mode) => {
    const directory = createEvidenceDirectory();
    const evidence = buildValidEvidence({ accepted: 10_000, failed: 0, failedResults: [] });
    if (mode === 'summary-only') evidence.workerLog = evidence.workerLog.trim().split('\n').at(-1)!;
    if (mode === 'missing-npm') evidence.workerLog = evidence.workerLog.split('\n').slice(2).join('\n');
    if (mode === 'wrong-time') evidence.workerLog = evidence.workerLog.replace(String(Date.parse('2026-09-18T10:15:00.000Z')), '1');
    if (mode === 'wrong-run') evidence.workerLog = evidence.workerLog.replace('11111111-1111-1111-1111-111111111111', 'different-run');
    writeEvidence(directory, evidence);
    expect(runValidator(directory).some((error) => error.includes('worker'))).toBe(true);
  });

  it.each([
    ['expectedBinCount', 'database expected BIN count must match summary'],
    ['persistedBatchCount', 'database persisted batch count must match summary'],
    ['rowsFetchedFromBatches', 'database fetched row count must match summary'],
    ['rowsStaged', 'database staged row count must match summary'],
    ['rowsPromoted', 'database promoted row count must match summary'],
  ] as const)('rejects database %s evidence that disagrees with the summary', (field, expectedError) => {
    const evidenceDirectory = createEvidenceDirectory();
    const evidence = buildValidEvidence({ accepted: 10_000, failed: 0, failedResults: [] });
    evidence.database[field] += 1;
    writeEvidence(evidenceDirectory, evidence);

    const errors = runValidator(evidenceDirectory);
    expect(errors.some((error) => error.includes(expectedError))).toBe(true);
  });
});
