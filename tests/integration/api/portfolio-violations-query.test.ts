import {
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
  PortfolioViolationsQueryRepository,
  type PortfolioViolationsQueryRepositoryPort,
} from '../../../src/db/portfolio-violations-query.repository';
import { MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE } from '../../../src/schemas/portfolio-violations-query.schema';
import {
  PortfolioViolationsQueryService,
  createPortfolioViolationsQueryService,
} from '../../../src/services/ecb/portfolio-violations-query.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describe('portfolio ECB query validation', () => {
  it.each([
    [{ unpaidOnly: 'yes' }],
    [{ limit: '0' }],
    [{ limit: '-1' }],
    [{ limit: '1.5' }],
    [{ limit: String(MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE + 1) }],
    [{ cursor: 'not*a*cursor' }],
    [{ updatedSince: 'not-a-timestamp' }],
  ])('rejects malformed query input before repository execution: %p', async (rawQuery) => {
    const repository: jest.Mocked<PortfolioViolationsQueryRepositoryPort> = {
      findPage: jest.fn(),
    };
    const service = new PortfolioViolationsQueryService(repository);

    const result = service.query(rawQuery);

    await expect(result).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(repository.findPage).not.toHaveBeenCalled();
  });
});

describeIntegration('local-store portfolio ECB query', () => {
  let prisma: PrismaClient;
  let service: PortfolioViolationsQueryService;
  let liveStateRunId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    service = createPortfolioViolationsQueryService(prisma);
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

  async function seedProperty(bbl: string, bin: string) {
    return prisma.property.create({
      data: {
        bbl,
        borough: Number(bbl[0]),
        block: Number(bbl.slice(1, 6)),
        lot: Number(bbl.slice(6)),
        resolvedAt: new Date('2026-09-17T00:00:00.000Z'),
        bins: { create: { bin } },
      },
    });
  }

  async function seedViolation(options: {
    sourceId: string;
    bin: string;
    issueDate?: string | null;
    sourceRowUpdatedAt?: Date;
    balanceDue?: string | null;
    isCurrent?: boolean;
  }): Promise<void> {
    await prisma.ecbViolation.create({
      data: {
        sourceId: options.sourceId,
        socrataRowId: `row-${options.sourceId}`,
        bin: options.bin,
        violationNumber: `violation-${options.sourceId}`,
        issueDate:
          options.issueDate === undefined
            ? new Date('2026-09-15T00:00:00.000Z')
            : options.issueDate === null
              ? null
              : new Date(`${options.issueDate}T00:00:00.000Z`),
        ecbViolationStatus: 'ACTIVE',
        balanceDue:
          options.balanceDue === null
            ? null
            : new Prisma.Decimal(options.balanceDue ?? '10.00'),
        sourceRowUpdatedAt:
          options.sourceRowUpdatedAt ?? new Date('2026-09-17T01:00:00.000Z'),
        lastSuccessRunId: liveStateRunId,
        isCurrent: options.isCurrent ?? true,
      },
    });
  }

  it('excludes current violations whose BIN is no longer in live property_bins', async () => {
    await seedProperty('1000010001', '1000001');
    await seedViolation({ sourceId: 'tracked-bin', bin: '1000001' });
    await seedViolation({ sourceId: 'orphaned-bin', bin: '2000002' });

    const result = await service.query({});

    expect(result.violations.map((row) => row.sourceId)).toEqual(['tracked-bin']);
  });

  it('returns a shared-BIN violation exactly once across multiple tracked properties', async () => {
    await seedProperty('1000010001', '1000001');
    await seedProperty('1000010002', '1000001');
    await seedViolation({ sourceId: 'shared-bin-row', bin: '1000001' });

    const result = await service.query({});

    expect(result.violations.map((row) => row.sourceId)).toEqual(['shared-bin-row']);
    expect(result.violations).toHaveLength(1);
  });

  it('excludes is_current=false rows', async () => {
    await seedProperty('1000010003', '1000003');
    await seedViolation({ sourceId: 'current-row', bin: '1000003', isCurrent: true });
    await seedViolation({ sourceId: 'stale-row', bin: '1000003', isCurrent: false });

    const result = await service.query({});

    expect(result.violations.map((row) => row.sourceId)).toEqual(['current-row']);
  });

  it('applies unpaidOnly with exact balance_due > 0 semantics', async () => {
    await seedProperty('1000010004', '1000004');
    await seedViolation({
      sourceId: 'paid-positive',
      bin: '1000004',
      balanceDue: '25.00',
    });
    await seedViolation({
      sourceId: 'zero-balance',
      bin: '1000004',
      balanceDue: '0.00',
    });
    await seedViolation({
      sourceId: 'negative-balance',
      bin: '1000004',
      balanceDue: '-1.00',
    });

    const result = await service.query({ unpaidOnly: 'true' });

    expect(result.violations.map((row) => row.sourceId)).toEqual(['paid-positive']);
  });

  it('filters updatedSince using strict source_row_updated_at > semantics', async () => {
    await seedProperty('1000010005', '1000005');
    const boundary = new Date('2026-09-17T10:00:00.000Z');
    await seedViolation({
      sourceId: 'at-boundary',
      bin: '1000005',
      sourceRowUpdatedAt: boundary,
    });
    await seedViolation({
      sourceId: 'after-boundary',
      bin: '1000005',
      sourceRowUpdatedAt: new Date('2026-09-17T10:00:01.000Z'),
    });
    await seedViolation({
      sourceId: 'before-boundary',
      bin: '1000005',
      sourceRowUpdatedAt: new Date('2026-09-17T09:59:59.000Z'),
    });

    const result = await service.query({
      updatedSince: boundary.toISOString(),
    });

    expect(result.violations.map((row) => row.sourceId)).toEqual(['after-boundary']);
  });

  it('traverses one canonical updatedSince ordering across multiple pages', async () => {
    await seedProperty('1000010006', '1000006');
    const updatedSince = new Date('2026-09-17T00:00:00.000Z');
    const canonicalOrder = ['newer-z', 'newer-a', 'older'];
    const timestamps: Record<string, Date> = {
      'newer-z': new Date('2026-09-17T12:00:02.000Z'),
      'newer-a': new Date('2026-09-17T12:00:01.000Z'),
      older: new Date('2026-09-17T11:00:00.000Z'),
      excluded: new Date('2026-09-16T23:59:59.000Z'),
    };

    for (const sourceId of Object.keys(timestamps)) {
      await seedViolation({
        sourceId,
        bin: '1000006',
        sourceRowUpdatedAt: timestamps[sourceId],
      });
    }

    const traversed: string[] = [];
    let cursor: string | undefined;
    const pages: string[][] = [];
    do {
      const result = await service.query({
        updatedSince: updatedSince.toISOString(),
        limit: '1',
        ...(cursor === undefined ? {} : { cursor }),
      });
      const ids = result.violations.map((violation) => violation.sourceId);
      pages.push(ids);
      traversed.push(...ids);
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(traversed).toEqual(canonicalOrder);
    expect(new Set(traversed).size).toBe(traversed.length);
    expect(pages).toEqual([['newer-z'], ['newer-a'], ['older']]);
  });

  it('traverses one canonical default ordering across dated rows and the NULL tail', async () => {
    await seedProperty('1000010007', '1000007');
    const canonicalOrder = [
      'dated-new-z',
      'dated-new-a',
      'dated-old',
      'null-z',
      'null-y',
      'null-x',
      'null-a',
    ];

    await seedViolation({ sourceId: 'null-a', bin: '1000007', issueDate: null });
    await seedViolation({ sourceId: 'dated-new-a', bin: '1000007', issueDate: '2026-09-16' });
    await seedViolation({ sourceId: 'null-z', bin: '1000007', issueDate: null });
    await seedViolation({ sourceId: 'dated-old', bin: '1000007', issueDate: '2026-01-01' });
    await seedViolation({ sourceId: 'null-x', bin: '1000007', issueDate: null });
    await seedViolation({ sourceId: 'dated-new-z', bin: '1000007', issueDate: '2026-09-16' });
    await seedViolation({ sourceId: 'null-y', bin: '1000007', issueDate: null });

    const traversed: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await service.query({
        limit: '2',
        ...(cursor === undefined ? {} : { cursor }),
      });
      const ids = result.violations.map((violation) => violation.sourceId);
      traversed.push(...ids);
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(traversed).toEqual(canonicalOrder);
    expect(new Set(traversed).size).toBe(traversed.length);
  });

  it('uses only PostgreSQL and never invokes an external NYC client', async () => {
    await seedProperty('1000010008', '1000008');
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
      await expect(service.query({})).resolves.toMatchObject({
        violations: [],
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

  it('queries through the repository primitive with the same membership contract', async () => {
    await seedProperty('1000010009', '1000009');
    await seedViolation({ sourceId: 'tracked', bin: '1000009' });
    await seedViolation({ sourceId: 'orphaned', bin: '3000003' });
    const repository = new PortfolioViolationsQueryRepository(prisma);

    await expect(
      repository.findPage({
        unpaidOnly: false,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      violations: [{ sourceId: 'tracked' }],
      hasMore: false,
    });
  });
});
