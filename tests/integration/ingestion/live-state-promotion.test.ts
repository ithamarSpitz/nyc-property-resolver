import {
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import { promoteEcbLiveState } from '../../../src/services/ecb/live-state.repository';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describeIntegration('accepted ECB live-state promotion and reconciliation', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violations", "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  async function createFixture() {
    const previousRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    const run = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    const property = await prisma.property.create({
      data: {
        bbl: '1000010001',
        normalizedAddress: '1 TEST STREET, MANHATTAN',
        borough: 1,
        block: 1,
        lot: 1,
        resolvedAt: new Date('2026-09-16T10:00:00.000Z'),
        bins: { create: { bin: '1000001' } },
      },
    });

    await prisma.ingestionRunPropertyBin.create({
      data: {
        runId: run.id,
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bin: '1000001',
      },
    });

    // Mutate the live watchlist after the run snapshot. Reconciliation must
    // continue to use BIN 1000001, not this new current BIN.
    await prisma.propertyBin.delete({
      where: { propertyId_bin: { propertyId: property.id, bin: '1000001' } },
    });
    await prisma.propertyBin.create({ data: { propertyId: property.id, bin: '2000002' } });

    await prisma.ecbViolation.createMany({
      data: [
        {
          sourceId: 'existing-in-scope',
          socrataRowId: 'old-row-id',
          bin: '1000001',
          violationNumber: 'OLD-1',
          issueDate: new Date('2026-01-01T00:00:00.000Z'),
          ecbViolationStatus: 'ACTIVE',
          balanceDue: new Prisma.Decimal('100.00'),
          sourceRowUpdatedAt: new Date('2026-01-01T01:00:00.000Z'),
          lastSuccessRunId: previousRun.id,
          isCurrent: false,
        },
        {
          sourceId: 'missing-in-scope',
          socrataRowId: 'missing-row-id',
          bin: '1000001',
          violationNumber: 'OLD-2',
          sourceRowUpdatedAt: new Date('2026-01-01T01:00:00.000Z'),
          lastSuccessRunId: previousRun.id,
          isCurrent: true,
        },
        {
          sourceId: 'missing-outside-scope',
          socrataRowId: 'outside-row-id',
          bin: '2000002',
          violationNumber: 'OLD-3',
          sourceRowUpdatedAt: new Date('2026-01-01T01:00:00.000Z'),
          lastSuccessRunId: previousRun.id,
          isCurrent: true,
        },
      ],
    });

    await prisma.ecbViolationStaging.createMany({
      data: [
        {
          runId: run.id,
          sourceId: 'existing-in-scope',
          socrataRowId: 'new-row-id',
          bin: '1000001',
          violationNumber: 'NEW-1',
          issueDate: new Date('2026-02-02T00:00:00.000Z'),
          ecbViolationStatus: 'CLOSED',
          balanceDue: new Prisma.Decimal('0.00'),
          sourceRowUpdatedAt: new Date('2026-02-02T01:00:00.000Z'),
        },
        {
          runId: run.id,
          sourceId: 'new-in-scope',
          socrataRowId: 'new-source-row-id',
          bin: '1000001',
          violationNumber: 'NEW-2',
          sourceRowUpdatedAt: new Date('2026-02-02T01:00:00.000Z'),
        },
      ],
    });

    return { run };
  }

  it('upserts staging, reactivates promoted rows, and reconciles only snapshot BINs', async () => {
    const { run } = await createFixture();

    const first = await prisma.$transaction((tx) => promoteEcbLiveState(tx, run.id));
    expect(first).toEqual({ promotedCount: 2, reconciledCount: 1 });

    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'existing-in-scope' } }),
    ).resolves.toMatchObject({
      socrataRowId: 'new-row-id',
      violationNumber: 'NEW-1',
      ecbViolationStatus: 'CLOSED',
      lastSuccessRunId: run.id,
      isCurrent: true,
    });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'new-in-scope' } }),
    ).resolves.toMatchObject({ lastSuccessRunId: run.id, isCurrent: true });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'missing-in-scope' } }),
    ).resolves.toMatchObject({ isCurrent: false });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'missing-outside-scope' } }),
    ).resolves.toMatchObject({ isCurrent: true });

    const replay = await prisma.$transaction((tx) => promoteEcbLiveState(tx, run.id));
    expect(replay).toEqual({ promotedCount: 2, reconciledCount: 0 });
    expect(await prisma.ecbViolation.count({ where: { sourceId: 'existing-in-scope' } })).toBe(1);
    expect(await prisma.ecbViolation.count()).toBe(4);
  });

  it('uses the caller transaction and leaves no changes when that transaction rolls back', async () => {
    const { run } = await createFixture();
    const rollback = new Error('ROLLBACK_TEST_TRANSACTION');

    await expect(
      prisma.$transaction(async (tx) => {
        await promoteEcbLiveState(tx, run.id);
        expect(await tx.ecbViolation.count()).toBe(4);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(await prisma.ecbViolation.count()).toBe(3);
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'missing-in-scope' } }),
    ).resolves.toMatchObject({ isCurrent: true });
    expect(await prisma.ecbViolation.findUnique({ where: { sourceId: 'new-in-scope' } })).toBeNull();
  });
});
