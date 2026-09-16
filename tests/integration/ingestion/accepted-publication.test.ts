import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import {
  ACCEPTED_PUBLICATION_OUTCOMES,
  AcceptedPublicationError,
  AcceptedPublicationService,
} from '../../../src/services/ecb/accepted-publication.service';
import { IngestionExecutionAuthority } from '../../../src/services/ecb/ingestion-lock.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

const STARTED_AT = new Date('2026-09-16T10:00:00.000Z');
const WATERMARK = new Date('2026-09-16T09:55:00.000Z');
const ACCEPTED_AT = new Date('2026-09-16T10:05:00.000Z');

describeIntegration('atomic accepted-run publication', () => {
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

  async function seedReadyRun() {
    const previousRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    const properties = await Promise.all([
      prisma.property.create({
        data: {
          bbl: '1000010001',
          borough: 1,
          block: 1,
          lot: 1,
          resolvedAt: STARTED_AT,
          bins: { create: { bin: '1000001' } },
          datasetCoverage: {
            create: {
              dataset: Dataset.DOB_ECB_VIOLATIONS,
              status: CoverageStatus.NOT_CHECKED,
              statusReason: CoverageStatusReason.NEVER_INGESTED,
            },
          },
        },
      }),
      prisma.property.create({
        data: {
          bbl: '1000010002',
          borough: 1,
          block: 1,
          lot: 2,
          resolvedAt: STARTED_AT,
          bins: { create: { bin: '1000002' } },
          datasetCoverage: {
            create: {
              dataset: Dataset.DOB_ECB_VIOLATIONS,
              status: CoverageStatus.NOT_CHECKED,
              statusReason: CoverageStatusReason.NEVER_INGESTED,
            },
          },
        },
      }),
    ]);
    const run = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });

    await prisma.ingestionRunPropertyBin.createMany({
      data: properties.map((property, index) => ({
        runId: run.id,
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bin: `100000${index + 1}`,
      })),
    });
    await prisma.ingestionBatch.create({
      data: {
        runId: run.id,
        batchNumber: 1,
        status: IngestionBatchStatus.COMPLETED,
        batchDefinition: { bins: ['1000001', '1000002'], pageSize: 50_000 },
        completedAt: ACCEPTED_AT,
      },
    });
    const readyRun = await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: IngestionRunStatus.RUNNING,
        initializationComplete: true,
        expectedPropertyBinCount: 2,
        expectedBinCount: 2,
        expectedBatchCount: 1,
        startedAt: STARTED_AT,
        sourceWatermarkAtStart: WATERMARK,
        sourceWatermarkAtEnd: WATERMARK,
      },
    });

    await prisma.ecbViolation.createMany({
      data: [
        {
          sourceId: 'promoted-row',
          socrataRowId: 'old-promoted-row',
          bin: '1000001',
          violationNumber: 'OLD-1',
          sourceRowUpdatedAt: STARTED_AT,
          lastSuccessRunId: previousRun.id,
          isCurrent: true,
        },
        {
          sourceId: 'missing-row',
          socrataRowId: 'old-missing-row',
          bin: '1000001',
          violationNumber: 'OLD-2',
          sourceRowUpdatedAt: STARTED_AT,
          lastSuccessRunId: previousRun.id,
          isCurrent: true,
        },
        {
          sourceId: 'outside-row',
          socrataRowId: 'outside-row',
          bin: '9000009',
          violationNumber: 'OUTSIDE',
          sourceRowUpdatedAt: STARTED_AT,
          lastSuccessRunId: previousRun.id,
          isCurrent: true,
        },
      ],
    });
    await prisma.ecbViolationStaging.createMany({
      data: [
        {
          runId: run.id,
          sourceId: 'promoted-row',
          socrataRowId: 'new-promoted-row',
          bin: '1000001',
          violationNumber: 'NEW-1',
          sourceRowUpdatedAt: ACCEPTED_AT,
        },
        {
          runId: run.id,
          sourceId: 'new-row',
          socrataRowId: 'new-row',
          bin: '1000001',
          violationNumber: 'NEW-2',
          sourceRowUpdatedAt: ACCEPTED_AT,
        },
      ],
    });

    return { run: readyRun, properties };
  }

  function service(testHooks: ConstructorParameters<typeof AcceptedPublicationService>[0]['testHooks'] = {}) {
    return new AcceptedPublicationService({ prisma, testHooks, now: () => ACCEPTED_AT });
  }

  it('atomically promotes, reconciles, publishes eligible coverage, completes, and replays explicitly', async () => {
    const { run, properties } = await seedReadyRun();
    await prisma.property.update({
      where: { id: properties[1].id },
      data: { identifierVersion: { increment: 1 } },
    });

    const publisher = service();
    const authority = new IngestionExecutionAuthority();
    const result = await publisher.publish(run.id, authority);

    expect(result).toMatchObject({
      outcome: ACCEPTED_PUBLICATION_OUTCOMES.COMPLETED,
      liveState: { promotedCount: 2, reconciledCount: 1 },
      coverage: { checkedCount: 1, identifiersChangedCount: 1 },
      run: { status: IngestionRunStatus.COMPLETED, finishedAt: ACCEPTED_AT },
    });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'promoted-row' } }),
    ).resolves.toMatchObject({
      socrataRowId: 'new-promoted-row',
      lastSuccessRunId: run.id,
      isCurrent: true,
    });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'missing-row' } }),
    ).resolves.toMatchObject({ isCurrent: false });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'outside-row' } }),
    ).resolves.toMatchObject({ isCurrent: true });

    const coverage = await prisma.propertyDatasetCoverage.findMany({ orderBy: { propertyId: 'asc' } });
    const matchingCoverage = coverage.find((row) => row.propertyId === properties[0].id);
    const changedCoverage = coverage.find((row) => row.propertyId === properties[1].id);
    expect(matchingCoverage).toMatchObject({
      status: CoverageStatus.CHECKED,
      lastAttemptRunId: run.id,
      lastSuccessRunId: run.id,
      sourceWatermarkAt: WATERMARK,
    });
    expect(changedCoverage).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED_AFTER_SNAPSHOT,
      lastSuccessRunId: null,
    });

    await expect(publisher.publish(run.id, authority)).resolves.toMatchObject({
      outcome: ACCEPTED_PUBLICATION_OUTCOMES.ALREADY_COMPLETED,
      run: { id: run.id, status: IngestionRunStatus.COMPLETED },
    });
    expect(await prisma.ecbViolation.count()).toBe(4);
  });

  it.each([
    ['after live-state work', 'afterLiveState'],
    ['after coverage work', 'afterCoverage'],
  ] as const)('rolls every accepted-state write back on failure %s', async (_label, hook) => {
    const { run, properties } = await seedReadyRun();
    const injectedFailure = new Error(`failure ${hook}`);
    const publisher = service({ [hook]: async () => Promise.reject(injectedFailure) });

    await expect(
      publisher.publish(run.id, new IngestionExecutionAuthority()),
    ).rejects.toBe(injectedFailure);

    await expect(prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } })).resolves.toMatchObject({
      status: IngestionRunStatus.RUNNING,
      finishedAt: null,
    });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'promoted-row' } }),
    ).resolves.toMatchObject({ socrataRowId: 'old-promoted-row', isCurrent: true });
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'missing-row' } }),
    ).resolves.toMatchObject({ isCurrent: true });
    expect(await prisma.ecbViolation.findUnique({ where: { sourceId: 'new-row' } })).toBeNull();
    for (const property of properties) {
      await expect(
        prisma.propertyDatasetCoverage.findUniqueOrThrow({
          where: {
            propertyId_dataset: {
              propertyId: property.id,
              dataset: Dataset.DOB_ECB_VIOLATIONS,
            },
          },
        }),
      ).resolves.toMatchObject({
        status: CoverageStatus.NOT_CHECKED,
        lastAttemptRunId: null,
        lastSuccessRunId: null,
      });
    }
  });

  it('rejects incomplete batches and changed watermarks without accepted-state mutation', async () => {
    const { run } = await seedReadyRun();
    await prisma.ingestionBatch.updateMany({
      where: { runId: run.id },
      data: { status: IngestionBatchStatus.FAILED, lastError: 'source failed' },
    });

    await expect(
      service().publish(run.id, new IngestionExecutionAuthority()),
    ).rejects.toThrow(AcceptedPublicationError);
    expect(await prisma.ecbViolation.count()).toBe(3);

    await prisma.ingestionBatch.updateMany({
      where: { runId: run.id },
      data: { status: IngestionBatchStatus.COMPLETED, lastError: null },
    });
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: { sourceWatermarkAtEnd: new Date(WATERMARK.getTime() + 1_000) },
    });
    await expect(
      service().publish(run.id, new IngestionExecutionAuthority()),
    ).rejects.toThrow('failed the source watermark guard');
    expect(await prisma.ecbViolation.count()).toBe(3);
  });

  it('rolls back when execution authority is revoked at the final boundary', async () => {
    const { run } = await seedReadyRun();
    const authority = new IngestionExecutionAuthority();
    const publisher = service({
      afterCoverage: async () => {
        authority.revoke('test lock session loss');
      },
    });

    await expect(publisher.publish(run.id, authority)).rejects.toMatchObject({
      code: 'INGESTION_AUTHORITY_LOST',
    });
    await expect(prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } })).resolves.toMatchObject({
      status: IngestionRunStatus.RUNNING,
      finishedAt: null,
    });
    expect(await prisma.ecbViolation.count()).toBe(3);
    expect(await prisma.propertyDatasetCoverage.count({ where: { status: CoverageStatus.CHECKED } })).toBe(0);
  });
});
