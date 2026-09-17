import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import { BuildingFootprintsClient } from '../../../src/clients/building-footprints.client';
import { CondominiumsClient } from '../../../src/clients/condominiums.client';
import { CondoUnitsClient } from '../../../src/clients/condo-units.client';
import { GeoSearchClient } from '../../../src/clients/geosearch.client';
import { PlutoClient } from '../../../src/clients/pluto.client';
import { SocrataClient } from '../../../src/clients/socrata.client';
import {
  PropertyViolationsQueryRepository,
  type PropertyViolationsPage,
  type PropertyViolationsQueryRepositoryPort,
} from '../../../src/db/property-violations-query.repository';
import {
  MAX_PROPERTY_VIOLATIONS_PAGE_SIZE,
  type PropertyViolationsQuery,
} from '../../../src/schemas/property-violations-query.schema';
import {
  PropertyViolationsQueryService,
  createPropertyViolationsQueryService,
} from '../../../src/services/ecb/property-violations-query.service';
import { PropertyIdentityService } from '../../../src/services/property-resolver/property-identity.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describe('property ECB query validation', () => {
  it.each([
    [{ openOnly: 'yes' }],
    [{ unpaidOnly: '1' }],
    [{ limit: '0' }],
    [{ limit: '-1' }],
    [{ limit: '1.5' }],
    [{ limit: String(MAX_PROPERTY_VIOLATIONS_PAGE_SIZE + 1) }],
    [{ cursor: 'not*a*cursor' }],
  ])('rejects malformed query input before repository execution: %p', async (rawQuery) => {
    const repository: jest.Mocked<PropertyViolationsQueryRepositoryPort> = {
      findSnapshot: jest.fn(),
    };
    const service = new PropertyViolationsQueryService(repository);

    const result = service.query('00000000-0000-4000-8000-000000000001', rawQuery);

    await expect(result).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(repository.findSnapshot).not.toHaveBeenCalled();
  });
});

describeIntegration('local-store property ECB query', () => {
  let prisma: PrismaClient;
  let service: PropertyViolationsQueryService;
  let liveStateRunId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    service = createPropertyViolationsQueryService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violations", "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );

    const liveStateRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    liveStateRunId = liveStateRun.id;
  });

  async function seedProperty(options: {
    bbl: string;
    bin: string;
    status?: CoverageStatus;
    statusReason?: CoverageStatusReason | null;
    lastAttemptAt?: Date | null;
    lastSuccessAt?: Date | null;
    sourceWatermarkAt?: Date | null;
    lastError?: string | null;
  }) {
    return prisma.property.create({
      data: {
        bbl: options.bbl,
        borough: Number(options.bbl[0]),
        block: Number(options.bbl.slice(1, 6)),
        lot: Number(options.bbl.slice(6)),
        resolvedAt: new Date('2026-09-17T00:00:00.000Z'),
        bins: { create: { bin: options.bin } },
        datasetCoverage: {
          create: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: options.status ?? CoverageStatus.NOT_CHECKED,
            statusReason:
              options.statusReason === undefined
                ? CoverageStatusReason.NEVER_INGESTED
                : options.statusReason,
            lastAttemptRunId:
              options.lastAttemptAt === undefined ? null : liveStateRunId,
            lastSuccessRunId:
              options.lastSuccessAt === undefined ? null : liveStateRunId,
            lastAttemptAt: options.lastAttemptAt,
            lastSuccessAt: options.lastSuccessAt,
            sourceWatermarkAt: options.sourceWatermarkAt,
            lastError: options.lastError,
          },
        },
      },
    });
  }

  async function seedViolation(options: {
    sourceId: string;
    bin?: string;
    issueDate: string | null;
    status?: string | null;
    balanceDue?: string | null;
    isCurrent?: boolean;
  }): Promise<void> {
    await prisma.ecbViolation.create({
      data: {
        sourceId: options.sourceId,
        socrataRowId: `row-${options.sourceId}`,
        bin: options.bin ?? '1000001',
        violationNumber: `violation-${options.sourceId}`,
        issueDate:
          options.issueDate === null
            ? null
            : new Date(`${options.issueDate}T00:00:00.000Z`),
        ecbViolationStatus: options.status ?? 'ACTIVE',
        balanceDue:
          options.balanceDue === null
            ? null
            : new Prisma.Decimal(options.balanceDue ?? '10.00'),
        sourceRowUpdatedAt: new Date('2026-09-17T01:00:00.000Z'),
        lastSuccessRunId: liveStateRunId,
        isCurrent: options.isCurrent ?? true,
      },
    });
  }

  it('traverses one canonical ordering across dated rows and multiple NULL-tail pages', async () => {
    const property = await seedProperty({
      bbl: '1000010001',
      bin: '1000001',
      status: CoverageStatus.CHECKED,
      statusReason: null,
    });
    const canonicalOrder = [
      'dated-new-z',
      'dated-new-a',
      'dated-old',
      'null-z',
      'null-y',
      'null-x',
      'null-a',
    ];

    await seedViolation({ sourceId: 'null-a', issueDate: null });
    await seedViolation({ sourceId: 'dated-new-a', issueDate: '2026-09-16' });
    await seedViolation({ sourceId: 'null-z', issueDate: null });
    await seedViolation({ sourceId: 'dated-old', issueDate: '2026-01-01' });
    await seedViolation({ sourceId: 'null-x', issueDate: null });
    await seedViolation({ sourceId: 'dated-new-z', issueDate: '2026-09-16' });
    await seedViolation({ sourceId: 'null-y', issueDate: null });
    await seedViolation({
      sourceId: 'not-current',
      issueDate: '2027-01-01',
      isCurrent: false,
    });
    await seedViolation({
      sourceId: 'other-property-bin',
      bin: '2000002',
      issueDate: '2027-01-01',
    });

    const traversed: string[] = [];
    let cursor: string | undefined;
    const pages: string[][] = [];
    do {
      const result = await service.query(property.id, {
        limit: '2',
        ...(cursor === undefined ? {} : { cursor }),
      });
      const ids = result.violations.map((violation) => violation.sourceId);
      pages.push(ids);
      traversed.push(...ids);
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(traversed).toEqual(canonicalOrder);
    expect(new Set(traversed).size).toBe(traversed.length);
    expect(pages).toEqual([
      ['dated-new-z', 'dated-new-a'],
      ['dated-old', 'null-z'],
      ['null-y', 'null-x'],
      ['null-a'],
    ]);
  });

  it('applies openOnly and unpaidOnly independently and together', async () => {
    const property = await seedProperty({ bbl: '1000010002', bin: '1000001' });
    await seedViolation({
      sourceId: 'active-paid',
      issueDate: '2026-04-04',
      status: 'ACTIVE',
      balanceDue: '25.00',
    });
    await seedViolation({
      sourceId: 'active-zero',
      issueDate: '2026-03-03',
      status: 'ACTIVE',
      balanceDue: '0.00',
    });
    await seedViolation({
      sourceId: 'closed-paid',
      issueDate: '2026-02-02',
      status: 'CLOSED',
      balanceDue: '5.00',
    });
    await seedViolation({
      sourceId: 'closed-negative',
      issueDate: '2026-01-01',
      status: 'CLOSED',
      balanceDue: '-1.00',
    });

    const open = await service.query(property.id, { openOnly: 'true' });
    const unpaid = await service.query(property.id, { unpaidOnly: 'true' });
    const both = await service.query(property.id, {
      openOnly: 'true',
      unpaidOnly: 'true',
    });

    expect(open.violations.map((row) => row.sourceId)).toEqual([
      'active-paid',
      'active-zero',
    ]);
    expect(unpaid.violations.map((row) => row.sourceId)).toEqual([
      'active-paid',
      'closed-paid',
    ]);
    expect(both.violations.map((row) => row.sourceId)).toEqual(['active-paid']);
  });

  it('loads checked-empty, not-checked, and failed coverage independently of rows', async () => {
    const previousSuccessAt = new Date('2026-09-15T10:00:00.000Z');
    const failedAttemptAt = new Date('2026-09-17T10:00:00.000Z');
    const watermark = new Date('2026-09-15T09:40:00.000Z');
    const checked = await seedProperty({
      bbl: '1000010003',
      bin: '1000003',
      status: CoverageStatus.CHECKED,
      statusReason: null,
      lastAttemptAt: previousSuccessAt,
      lastSuccessAt: previousSuccessAt,
      sourceWatermarkAt: watermark,
    });
    const notChecked = await seedProperty({
      bbl: '1000010004',
      bin: '1000004',
    });
    const failed = await seedProperty({
      bbl: '1000010005',
      bin: '1000005',
      status: CoverageStatus.FAILED,
      statusReason: null,
      lastAttemptAt: failedAttemptAt,
      lastSuccessAt: previousSuccessAt,
      sourceWatermarkAt: watermark,
      lastError: 'UPSTREAM_TIMEOUT',
    });

    const [checkedResult, notCheckedResult, failedResult] = await Promise.all([
      service.query(checked.id, {}),
      service.query(notChecked.id, {}),
      service.query(failed.id, {}),
    ]);

    expect(checkedResult.violations).toEqual([]);
    expect(checkedResult.coverage).toMatchObject({
      status: CoverageStatus.CHECKED,
      lastSuccessAt: previousSuccessAt,
      sourceWatermarkAt: watermark,
    });
    expect(notCheckedResult.violations).toEqual([]);
    expect(notCheckedResult.coverage).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
      lastSuccessAt: null,
    });
    expect(failedResult.violations).toEqual([]);
    expect(failedResult.coverage).toMatchObject({
      status: CoverageStatus.FAILED,
      lastAttemptAt: failedAttemptAt,
      lastSuccessAt: previousSuccessAt,
      sourceWatermarkAt: watermark,
      lastError: 'UPSTREAM_TIMEOUT',
    });
  });

  it('reads violations and coverage from one snapshot during atomic BIN invalidation', async () => {
    const property = await seedProperty({
      bbl: '1000010008',
      bin: '1000008',
      status: CoverageStatus.CHECKED,
      statusReason: null,
      lastAttemptAt: new Date('2026-09-15T10:00:00.000Z'),
      lastSuccessAt: new Date('2026-09-15T10:00:00.000Z'),
    });
    await seedViolation({
      sourceId: 'old-bin-row',
      bin: '1000008',
      issueDate: '2026-09-15',
    });
    await seedViolation({
      sourceId: 'new-bin-row',
      bin: '1000009',
      issueDate: '2026-09-16',
    });

    let signalPageRead!: () => void;
    let resumeSnapshotRead!: () => void;
    const pageRead = new Promise<void>((resolve) => {
      signalPageRead = resolve;
    });
    const snapshotMayContinue = new Promise<void>((resolve) => {
      resumeSnapshotRead = resolve;
    });

    class PausingPropertyViolationsRepository extends PropertyViolationsQueryRepository {
      protected override async findPageWithExecutor(
        executor: Pick<
          Prisma.TransactionClient,
          '$queryRaw' | 'propertyDatasetCoverage'
        >,
        propertyId: string,
        query: PropertyViolationsQuery,
      ): Promise<PropertyViolationsPage> {
        const page = await super.findPageWithExecutor(executor, propertyId, query);
        signalPageRead();
        await snapshotMayContinue;
        return page;
      }
    }

    const snapshotService = new PropertyViolationsQueryService(
      new PausingPropertyViolationsRepository(prisma),
    );
    const pendingQuery = snapshotService.query(property.id, {});

    await pageRead;
    try {
      await new PropertyIdentityService(prisma).applyEffectiveBinSet(property.id, ['1000009']);
    } finally {
      resumeSnapshotRead();
    }

    const resultDuringMutation = await pendingQuery;
    expect(resultDuringMutation.violations.map((row) => row.sourceId)).toEqual([
      'old-bin-row',
    ]);
    expect(resultDuringMutation.coverage).toMatchObject({
      status: CoverageStatus.CHECKED,
      statusReason: null,
    });

    await expect(snapshotService.query(property.id, {})).resolves.toMatchObject({
      violations: [{ sourceId: 'new-bin-row' }],
      coverage: {
        status: CoverageStatus.NOT_CHECKED,
        statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
      },
    });
  });

  it('uses only PostgreSQL and never invokes an external NYC client', async () => {
    const property = await seedProperty({ bbl: '1000010006', bin: '1000006' });
    const externalSpies = [
      jest.spyOn(SocrataClient.prototype, 'getDatasetMetadata'),
      jest.spyOn(SocrataClient.prototype, 'getEcbDataPage'),
      jest.spyOn(GeoSearchClient.prototype, 'searchByAddress'),
      jest.spyOn(PlutoClient.prototype, 'lookupByBbl'),
      jest.spyOn(BuildingFootprintsClient.prototype, 'lookupByParcelBbl'),
      jest.spyOn(CondoUnitsClient.prototype, 'lookupByUnitBbl'),
      jest.spyOn(CondominiumsClient.prototype, 'lookupByCondoBaseBbl'),
    ];
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('external HTTP is forbidden in stored ECB queries'));

    try {
      await expect(service.query(property.id, {})).resolves.toMatchObject({
        violations: [],
        coverage: { status: CoverageStatus.NOT_CHECKED },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const externalSpy of externalSpies) {
        expect(externalSpy).not.toHaveBeenCalled();
      }
    } finally {
      fetchSpy.mockRestore();
      for (const externalSpy of externalSpies) {
        externalSpy.mockRestore();
      }
    }
  });

  it('queries through the repository primitive with the same ordering contract', async () => {
    const property = await seedProperty({ bbl: '1000010007', bin: '1000007' });
    await seedViolation({ sourceId: 'null-row', bin: '1000007', issueDate: null });
    await seedViolation({
      sourceId: 'dated-row',
      bin: '1000007',
      issueDate: '2026-01-01',
    });
    const repository = new PropertyViolationsQueryRepository(prisma);

    await expect(
      repository.findSnapshot(property.id, {
        openOnly: false,
        unpaidOnly: false,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      page: {
        violations: [{ sourceId: 'dated-row' }, { sourceId: 'null-row' }],
        hasMore: false,
      },
    });
  });
});
