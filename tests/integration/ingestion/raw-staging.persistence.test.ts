import {
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import { EcbRawStagingService } from '../../../src/services/ecb/raw-staging.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describeIntegration('ECB raw-before-normalization staging persistence', () => {
  let prisma: PrismaClient;
  let service: EcbRawStagingService;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    service = new EcbRawStagingService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  async function createRun() {
    return prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
  }

  /** Mirrors the `6bgk-3dad` Socrata JSON shape: lowercase API field names. */
  function row(overrides: Record<string, unknown> = {}) {
    return {
      isn_dob_bis_extract: 'ECB-1001',
      ':id': 'socrata-1001',
      ':updated_at': '2026-01-02T03:04:05.000Z',
      bin: '1012345',
      ecb_violation_number: 'ECB-42',
      issue_date: '20260203',
      ecb_violation_status: 'ACTIVE',
      balance_due: '-125.50',
      source_specific_value: 'preserve me',
      ...overrides,
    };
  }

  it('persists raw first, then normalizes and writes one staging candidate', async () => {
    const run = await createRun();

    const result = await service.processRow({ runId: run.id, row: row() });

    expect(result.staging.sourceId).toBe('ECB-1001');
    expect(Number(result.staging.balanceDue)).toBe(-125.5);
    expect(await prisma.ecbViolationRaw.count()).toBe(1);
    expect(await prisma.ecbViolationStaging.count()).toBe(1);
    expect(await prisma.ecbViolationRaw.findFirst()).toMatchObject({
      sourceId: 'ECB-1001',
      socrataRowId: 'socrata-1001',
      payload: expect.objectContaining({
        isn_dob_bis_extract: 'ECB-1001',
        source_specific_value: 'preserve me',
        balance_due: '-125.50',
      }),
    });
  });

  it('retains a minimally identifiable raw row when strict normalization fails', async () => {
    const run = await createRun();

    await expect(
      service.processRow({ runId: run.id, row: row({ bin: 'malformed' }) }),
    ).rejects.toMatchObject({
      code: 'ECB_NORMALIZATION_FAILED',
      stage: 'normalization',
      rawPersisted: true,
      sourceId: 'ECB-1001',
    });

    expect(await prisma.ecbViolationRaw.count()).toBe(1);
    expect(await prisma.ecbViolationStaging.count()).toBe(0);
  });

  it('rejects an invalid source timestamp before raw persistence', async () => {
    const run = await createRun();

    await expect(
      service.processRow({
        runId: run.id,
        row: row({ ':updated_at': '2026/02/30' }),
      }),
    ).rejects.toMatchObject({
      code: 'ECB_INVALID_TRANSPORT',
      stage: 'transport',
      rawPersisted: false,
    });

    expect(await prisma.ecbViolationRaw.count()).toBe(0);
  });

  it('replays raw versions and run/source candidates without duplicate rows', async () => {
    const run = await createRun();
    const first = row();
    const firstFetchedAt = new Date('2026-01-10T00:00:00.000Z');
    const replayFetchedAt = new Date('2026-01-11T00:00:00.000Z');

    await service.processRow({ runId: run.id, row: first, fetchedAt: firstFetchedAt });
    await service.processRow({
      runId: run.id,
      row: row({ ecb_violation_status: 'CLOSED', balance_due: '-25.00' }),
      fetchedAt: replayFetchedAt,
    });

    expect(await prisma.ecbViolationRaw.count()).toBe(1);
    expect(await prisma.ecbViolationRaw.findFirst()).toMatchObject({
      socrataRowId: 'socrata-1001',
      fetchedAt: firstFetchedAt,
      payload: expect.objectContaining({
        ecb_violation_status: 'ACTIVE',
        balance_due: '-125.50',
      }),
    });
    expect(await prisma.ecbViolationStaging.count()).toBe(1);
    expect((await prisma.ecbViolationStaging.findFirst())?.ecbViolationStatus).toBe('CLOSED');
    expect(Number((await prisma.ecbViolationStaging.findFirst())?.balanceDue)).toBe(-25);

    await service.processRow({
      runId: run.id,
      row: row({ ':updated_at': '2026-01-03T03:04:05.000Z' }),
    });
    expect(await prisma.ecbViolationRaw.count()).toBe(2);
    expect(await prisma.ecbViolationStaging.count()).toBe(1);
  });
});
