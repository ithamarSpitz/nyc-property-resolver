import {
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describeIntegration('ingestion persistence contracts', () => {
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
      'TRUNCATE TABLE "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  async function createRun(status: IngestionRunStatus = IngestionRunStatus.QUEUED) {
    return prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status,
        triggerType: IngestionTriggerType.MANUAL,
        ...(status === IngestionRunStatus.RUNNING
          ? {
              initializationComplete: true,
              sourceWatermarkAtStart: new Date('2026-01-01T00:00:00.000Z'),
            }
          : {}),
      },
    });
  }

  it('allows only one queued or running run per dataset', async () => {
    const queuedRun = await createRun();

    await expect(createRun()).rejects.toThrow();
    await expect(createRun(IngestionRunStatus.RUNNING)).rejects.toThrow();
    await expect(createRun(IngestionRunStatus.FAILED)).resolves.toBeTruthy();

    await prisma.ingestionRun.update({
      where: { id: queuedRun.id },
      data: { status: IngestionRunStatus.FAILED },
    });
    await expect(createRun(IngestionRunStatus.RUNNING)).resolves.toBeTruthy();
    await expect(createRun()).rejects.toThrow();
  });

  it('rejects running state without initialized snapshot and start watermark', async () => {
    await expect(
      prisma.ingestionRun.create({
        data: {
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status: IngestionRunStatus.RUNNING,
          triggerType: IngestionTriggerType.MANUAL,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.ingestionRun.create({
        data: {
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status: IngestionRunStatus.QUEUED,
          triggerType: IngestionTriggerType.MANUAL,
          sourceWatermarkAtStart: new Date('2026-01-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();

    await expect(createRun(IngestionRunStatus.RUNNING)).resolves.toBeTruthy();
  });

  it('enforces raw source-version and run/source staging identity', async () => {
    const run = await createRun();
    const updatedAt = new Date('2026-01-02T00:00:00.000Z');

    await prisma.ecbViolationRaw.create({
      data: {
        sourceId: 'ECB-1',
        socrataRowId: 'socrata-1',
        sourceRowUpdatedAt: updatedAt,
        firstSeenRunId: run.id,
        payload: { ISN_DOB_BIS_EXTRACT: 'ECB-1' },
      },
    });
    await expect(
      prisma.ecbViolationRaw.create({
        data: {
          sourceId: 'ECB-1',
          socrataRowId: 'socrata-1-replay',
          sourceRowUpdatedAt: updatedAt,
          firstSeenRunId: run.id,
          payload: { ISN_DOB_BIS_EXTRACT: 'ECB-1' },
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.ecbViolationRaw.create({
        data: {
          sourceId: 'ECB-1',
          socrataRowId: 'socrata-1-new-version',
          sourceRowUpdatedAt: new Date('2026-01-03T00:00:00.000Z'),
          firstSeenRunId: run.id,
          payload: { ISN_DOB_BIS_EXTRACT: 'ECB-1' },
        },
      }),
    ).resolves.toBeTruthy();

    const stagingData = {
      runId: run.id,
      sourceId: 'ECB-1',
      socrataRowId: 'socrata-1',
      bin: '1012345',
      sourceRowUpdatedAt: updatedAt,
    };
    await prisma.ecbViolationStaging.create({ data: stagingData });
    await expect(prisma.ecbViolationStaging.create({ data: stagingData })).rejects.toThrow();

    const otherRun = await createRun(IngestionRunStatus.FAILED);
    await expect(
      prisma.ecbViolationStaging.create({
        data: {
          ...stagingData,
          runId: otherRun.id,
          socrataRowId: 'socrata-1-other-run',
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('round-trips snapshot identifier versions and immutable batch definitions', async () => {
    const run = await createRun();
    const property = await prisma.property.create({
      data: {
        bbl: '1000750001',
        borough: 1,
        block: 75,
        lot: 1,
        resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    await prisma.ingestionRunPropertyBin.create({
      data: {
        runId: run.id,
        propertyId: property.id,
        propertyIdentifierVersion: 7,
        bin: '1012345',
      },
    });
    const definition = { bins: ['1012345'], pageSize: 50000 };
    const batch = await prisma.ingestionBatch.create({
      data: {
        runId: run.id,
        batchNumber: 1,
        batchDefinition: definition,
      },
    });

    expect(
      (await prisma.ingestionRunPropertyBin.findUnique({
        where: {
          runId_propertyId_bin: {
            runId: run.id,
            propertyId: property.id,
            bin: '1012345',
          },
        },
      }))?.propertyIdentifierVersion,
    ).toBe(7);
    expect((await prisma.ingestionBatch.findUnique({ where: { id: batch.id } }))?.batchDefinition).toEqual(
      definition,
    );

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: { initializationComplete: true },
    });
    await expect(
      prisma.ingestionRun.update({
        where: { id: run.id },
        data: { initializationComplete: false },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.ingestionRunPropertyBin.update({
        where: {
          runId_propertyId_bin: {
            runId: run.id,
            propertyId: property.id,
            bin: '1012345',
          },
        },
        data: { propertyIdentifierVersion: 8 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.ingestionBatch.update({
        where: { id: batch.id },
        data: { batchDefinition: { bins: ['9999999'] } },
      }),
    ).rejects.toThrow();
    await expect(prisma.ingestionBatch.delete({ where: { id: batch.id } })).rejects.toThrow();
    await expect(
      prisma.ingestionBatch.create({
        data: {
          runId: run.id,
          batchNumber: 2,
          batchDefinition: definition,
        },
      }),
    ).rejects.toThrow();

    const otherRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    await expect(
      prisma.ingestionRunPropertyBin.update({
        where: {
          runId_propertyId_bin: {
            runId: run.id,
            propertyId: property.id,
            bin: '1012345',
          },
        },
        data: { runId: otherRun.id },
      }),
    ).rejects.toThrow();
  });
});
