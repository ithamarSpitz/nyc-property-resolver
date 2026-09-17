import express from 'express';
import {
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import request from 'supertest';

import { BuildingFootprintsClient } from '../../src/clients/building-footprints.client';
import { CondominiumsClient } from '../../src/clients/condominiums.client';
import { CondoUnitsClient } from '../../src/clients/condo-units.client';
import { GeoSearchClient } from '../../src/clients/geosearch.client';
import { PlutoClient } from '../../src/clients/pluto.client';
import { SocrataClient } from '../../src/clients/socrata.client';
import { MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE } from '../../src/schemas/portfolio-violations-query.schema';
import { createViolationsRouter } from '../../src/routes/violations.routes';
import { createPortfolioViolationsQueryService } from '../../src/services/ecb/portfolio-violations-query.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

function createTestApp(prisma: PrismaClient): express.Application {
  const app = express();
  app.use(
    createViolationsRouter({
      portfolioViolationsQuery: createPortfolioViolationsQueryService(prisma),
    }),
  );
  return app;
}

describeIntegration('GET /ecb-violations HTTP API', () => {
  let prisma: PrismaClient;
  let app: express.Application;
  let liveStateRunId: string;

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

    const liveStateRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    liveStateRunId = liveStateRun.id;
    app = createTestApp(prisma);
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

  it('excludes violations whose BIN no longer has current property_bins membership', async () => {
    const property = await seedProperty('1000010001', '1000001');
    await seedViolation({ sourceId: 'tracked-bin', bin: '1000001' });
    await seedViolation({ sourceId: 'orphaned-bin', bin: '2000002' });

    const beforeRemoval = await request(app).get('/ecb-violations');
    expect(beforeRemoval.status).toBe(200);
    expect(beforeRemoval.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'tracked-bin',
    ]);

    await prisma.propertyBin.deleteMany({ where: { propertyId: property.id } });

    const afterRemoval = await request(app).get('/ecb-violations');
    expect(afterRemoval.status).toBe(200);
    expect(afterRemoval.body.violations).toEqual([]);
  });

  it('returns a shared-BIN violation exactly once across multiple tracked properties', async () => {
    await seedProperty('1000010001', '1000001');
    await seedProperty('1000010002', '1000001');
    await seedViolation({ sourceId: 'shared-bin-row', bin: '1000001' });

    const response = await request(app).get('/ecb-violations');

    expect(response.status).toBe(200);
    expect(response.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'shared-bin-row',
    ]);
    expect(response.body.violations).toHaveLength(1);
  });

  it('excludes is_current=false rows', async () => {
    await seedProperty('1000010003', '1000003');
    await seedViolation({ sourceId: 'current-row', bin: '1000003', isCurrent: true });
    await seedViolation({ sourceId: 'stale-row', bin: '1000003', isCurrent: false });

    const response = await request(app).get('/ecb-violations');

    expect(response.status).toBe(200);
    expect(response.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'current-row',
    ]);
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

    const response = await request(app).get('/ecb-violations').query({
      updatedSince: boundary.toISOString(),
    });

    expect(response.status).toBe(200);
    expect(response.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'after-boundary',
    ]);
    expect(response.body.violations[0]).toMatchObject({
      sourceId: 'after-boundary',
      sourceRowUpdatedAt: '2026-09-17T10:00:01.000Z',
    });
    expect(response.body.violations[0]).not.toHaveProperty('updatedAt');
  });

  it('applies unpaidOnly and cursor pagination together', async () => {
    await seedProperty('1000010004', '1000004');
    await seedViolation({
      sourceId: 'paid-newer',
      bin: '1000004',
      balanceDue: '25.00',
      issueDate: '2026-09-16',
    });
    await seedViolation({
      sourceId: 'paid-older',
      bin: '1000004',
      balanceDue: '15.00',
      issueDate: '2026-09-10',
    });
    await seedViolation({
      sourceId: 'zero-balance',
      bin: '1000004',
      balanceDue: '0.00',
      issueDate: '2026-09-17',
    });

    const firstPage = await request(app).get('/ecb-violations').query({
      unpaidOnly: 'true',
      limit: '1',
    });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'paid-newer',
    ]);
    expect(firstPage.body.page).toMatchObject({
      limit: 1,
      hasMore: true,
      nextCursor: expect.any(String),
    });

    const secondPage = await request(app).get('/ecb-violations').query({
      unpaidOnly: 'true',
      limit: '1',
      cursor: firstPage.body.page.nextCursor,
    });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'paid-older',
    ]);
    expect(secondPage.body.page).toMatchObject({
      limit: 1,
      hasMore: false,
      nextCursor: null,
    });
  });

  it.each([
    [{ unpaidOnly: 'yes' }],
    [{ limit: '0' }],
    [{ limit: '-1' }],
    [{ limit: '1.5' }],
    [{ limit: String(MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE + 1) }],
    [{ cursor: 'not*a*cursor' }],
    [{ updatedSince: 'not-a-timestamp' }],
  ])('returns safe validation errors for malformed query input: %p', async (query) => {
    await seedProperty('1000010099', '1000099');

    const response = await request(app).get('/ecb-violations').query(query);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('stack');
    expect(JSON.stringify(response.body)).not.toContain('ZodError');
  });

  it('never invokes an external NYC client', async () => {
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
      const response = await request(app).get('/ecb-violations');

      expect(response.status).toBe(200);
      expect(response.body.violations).toEqual([]);
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
});
