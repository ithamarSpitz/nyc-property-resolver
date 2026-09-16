import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from '@prisma/client';

import { IngestionExecutionAuthority } from '../../../src/services/ecb/ingestion-lock.service';
import type { IngestionTerminalPublicationRequest } from '../../../src/services/ecb/ingestion-terminal-publication.port';
import {
  TERMINAL_COVERAGE_ERRORS,
  TerminalPublicationError,
  TerminalPublicationService,
} from '../../../src/services/ecb/terminal-publication.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

const STARTED_AT = new Date('2026-09-16T10:00:00.000Z');
const FINISHED_AT = new Date('2026-09-16T10:05:00.000Z');
const WATERMARK = new Date('2026-09-16T09:55:00.000Z');

describeIntegration('atomic terminal-failure publication', () => {
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

  function service(
    testHooks: ConstructorParameters<typeof TerminalPublicationService>[0]['testHooks'] = {},
  ): TerminalPublicationService {
    return new TerminalPublicationService({ prisma, testHooks });
  }

  async function seedPreScopeRun() {
    const property = await prisma.property.create({
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
    });
    const run = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    return { property, run };
  }

  async function seedPostScopeRun() {
    const previousRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.COMPLETED,
        triggerType: IngestionTriggerType.MANUAL,
        initializationComplete: true,
        expectedPropertyBinCount: 0,
        expectedBinCount: 0,
        expectedBatchCount: 0,
        startedAt: new Date(STARTED_AT.getTime() - 60_000),
        finishedAt: new Date(STARTED_AT.getTime() - 30_000),
        sourceWatermarkAtStart: WATERMARK,
        sourceWatermarkAtEnd: WATERMARK,
      },
    });
    const properties = await Promise.all(
      [
        { bbl: '1000010001', lot: 1, bins: ['1000001', '1000003'] },
        { bbl: '1000010002', lot: 2, bins: ['1000002'] },
        { bbl: '1000010003', lot: 3, bins: ['1000004'] },
      ].map((input) =>
        prisma.property.create({
          data: {
            bbl: input.bbl,
            borough: 1,
            block: 1,
            lot: input.lot,
            resolvedAt: STARTED_AT,
            bins: { create: input.bins.map((bin) => ({ bin })) },
            datasetCoverage: {
              create: {
                dataset: Dataset.DOB_ECB_VIOLATIONS,
                status: CoverageStatus.CHECKED,
                lastAttemptRunId: previousRun.id,
                lastSuccessRunId: previousRun.id,
                lastAttemptAt: previousRun.finishedAt,
                lastSuccessAt: previousRun.finishedAt,
                sourceWatermarkAt: WATERMARK,
              },
            },
          },
        }),
      ),
    );
    const run = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    await prisma.ingestionRunPropertyBin.createMany({
      data: properties.flatMap((property, index) => {
        const bins = index === 0 ? ['1000001', '1000003'] : [index === 1 ? '1000002' : '1000004'];
        return bins.map((bin) => ({
          runId: run.id,
          propertyId: property.id,
          propertyIdentifierVersion: property.identifierVersion,
          bin,
        }));
      }),
    });
    await prisma.ingestionBatch.createMany({
      data: [
        {
          runId: run.id,
          batchNumber: 1,
          status: IngestionBatchStatus.COMPLETED,
          batchDefinition: { bins: ['1000001', '1000002', '1000004'] },
          completedAt: FINISHED_AT,
        },
        {
          runId: run.id,
          batchNumber: 2,
          status: IngestionBatchStatus.FAILED,
          batchDefinition: { bins: ['1000003'] },
          lastError: 'NORMALIZATION_FAILED: invalid balance',
        },
      ],
    });
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: IngestionRunStatus.RUNNING,
        initializationComplete: true,
        expectedPropertyBinCount: 4,
        expectedBinCount: 4,
        expectedBatchCount: 2,
        startedAt: STARTED_AT,
        sourceWatermarkAtStart: WATERMARK,
      },
    });
    await prisma.ecbViolation.create({
      data: {
        sourceId: 'accepted-live-row',
        socrataRowId: 'accepted-live-row',
        bin: '1000001',
        violationNumber: 'OLD-1',
        sourceRowUpdatedAt: WATERMARK,
        lastSuccessRunId: previousRun.id,
        isCurrent: true,
      },
    });
    await prisma.ecbViolationStaging.create({
      data: {
        runId: run.id,
        sourceId: 'candidate-row',
        socrataRowId: 'candidate-row',
        bin: '1000001',
        violationNumber: 'NEW-1',
        sourceRowUpdatedAt: FINISHED_AT,
      },
    });
    return { previousRun, properties, run };
  }

  it('terminalizes a pre-scope failure without publishing property coverage', async () => {
    const { property, run } = await seedPreScopeRun();

    await expect(
      service().publishTerminalFailure(
        {
          runId: run.id,
          status: IngestionRunStatus.FAILED,
          failureStage: 'initialization',
          lastError: 'START_WATERMARK_FETCH_FAILED',
          finishedAt: FINISHED_AT,
        },
        new IngestionExecutionAuthority(),
      ),
    ).resolves.toMatchObject({
      status: IngestionRunStatus.FAILED,
      failureStage: 'initialization',
      lastError: 'START_WATERMARK_FETCH_FAILED',
      finishedAt: FINISHED_AT,
    });

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
      statusReason: CoverageStatusReason.NEVER_INGESTED,
      lastAttemptRunId: null,
    });
  });

  it('publishes snapshot-attributed failures while preserving accepted state and success metadata', async () => {
    const { previousRun, properties, run } = await seedPostScopeRun();
    await prisma.property.update({
      where: { id: properties[2].id },
      data: { identifierVersion: { increment: 1 } },
    });
    await prisma.propertyDatasetCoverage.update({
      where: {
        propertyId_dataset: {
          propertyId: properties[2].id,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
        },
      },
      data: {
        status: CoverageStatus.NOT_CHECKED,
        statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
      },
    });

    await service().publishTerminalFailure(
      {
        runId: run.id,
        status: IngestionRunStatus.FAILED,
        failureStage: 'batch_processing',
        lastError: 'BATCH_TERMINAL_FAILURE',
        finishedAt: FINISHED_AT,
      },
      new IngestionExecutionAuthority(),
    );

    const coverage = await prisma.propertyDatasetCoverage.findMany();
    expect(coverage.find((row) => row.propertyId === properties[0].id)).toMatchObject({
      status: CoverageStatus.FAILED,
      statusReason: null,
      lastAttemptRunId: run.id,
      lastAttemptAt: FINISHED_AT,
      lastError: 'NORMALIZATION_FAILED: invalid balance',
      lastSuccessRunId: previousRun.id,
      sourceWatermarkAt: WATERMARK,
    });
    expect(coverage.find((row) => row.propertyId === properties[1].id)).toMatchObject({
      status: CoverageStatus.FAILED,
      lastAttemptRunId: run.id,
      lastError: TERMINAL_COVERAGE_ERRORS.RUN_NOT_PROMOTED,
      lastSuccessRunId: previousRun.id,
      sourceWatermarkAt: WATERMARK,
    });
    expect(coverage.find((row) => row.propertyId === properties[2].id)).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
      lastAttemptRunId: previousRun.id,
      lastSuccessRunId: previousRun.id,
    });
    expect(await prisma.ecbViolation.count()).toBe(1);
    await expect(
      prisma.ecbViolation.findUniqueOrThrow({ where: { sourceId: 'accepted-live-row' } }),
    ).resolves.toMatchObject({ lastSuccessRunId: previousRun.id, isCurrent: true });
    expect(await prisma.ecbViolationStaging.count({ where: { runId: run.id } })).toBe(1);
  });

  it('publishes SOURCE_CHANGED for every eligible property without promoting staging', async () => {
    const { previousRun, properties, run } = await seedPostScopeRun();

    await service().publishTerminalFailure(
      {
        runId: run.id,
        status: IngestionRunStatus.SOURCE_CHANGED,
        failureStage: 'watermark_guard',
        lastError: TERMINAL_COVERAGE_ERRORS.SOURCE_CHANGED,
        finishedAt: FINISHED_AT,
      },
      new IngestionExecutionAuthority(),
    );

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
        status: CoverageStatus.FAILED,
        lastAttemptRunId: run.id,
        lastSuccessRunId: previousRun.id,
        sourceWatermarkAt: WATERMARK,
        lastError: TERMINAL_COVERAGE_ERRORS.SOURCE_CHANGED,
      });
    }
    expect(await prisma.ecbViolation.count()).toBe(1);
    expect(await prisma.ecbViolationStaging.count({ where: { runId: run.id } })).toBe(1);
  });

  it('rolls the run transition back when coverage publication fails', async () => {
    const { properties, run } = await seedPostScopeRun();
    const injectedFailure = new Error('injected failure after run update');

    await expect(
      service({ afterRunUpdate: async () => Promise.reject(injectedFailure) }).publishTerminalFailure(
        {
          runId: run.id,
          status: IngestionRunStatus.FAILED,
          failureStage: 'batch_processing',
          lastError: 'BATCH_TERMINAL_FAILURE',
          finishedAt: FINISHED_AT,
        },
        new IngestionExecutionAuthority(),
      ),
    ).rejects.toBe(injectedFailure);

    await expect(
      prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({ status: IngestionRunStatus.RUNNING, finishedAt: null });
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
        status: CoverageStatus.CHECKED,
        lastAttemptRunId: expect.not.stringMatching(run.id),
      });
    }
  });

  it('requires live execution authority and rejects unsupported source-change data', async () => {
    const { run } = await seedPreScopeRun();
    const revoked = new IngestionExecutionAuthority();
    revoked.revoke('test lock loss');
    const request: IngestionTerminalPublicationRequest = {
      runId: run.id,
      status: IngestionRunStatus.FAILED,
      failureStage: 'initialization',
      lastError: 'FAILED',
      finishedAt: FINISHED_AT,
    };

    await expect(service().publishTerminalFailure(request)).rejects.toThrow(
      'execution authority is required',
    );
    await expect(service().publishTerminalFailure(request, revoked)).rejects.toMatchObject({
      code: 'INGESTION_AUTHORITY_LOST',
    });
    await expect(
      service().publishTerminalFailure(
        { ...request, status: IngestionRunStatus.SOURCE_CHANGED },
        new IngestionExecutionAuthority(),
      ),
    ).rejects.toThrow(TerminalPublicationError);
    await expect(
      prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({ status: IngestionRunStatus.QUEUED });
  });
});
