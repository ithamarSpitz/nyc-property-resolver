import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import express from 'express';
import request from 'supertest';

import { BuildingFootprintsClient } from '../../src/clients/building-footprints.client';
import { CondominiumsClient } from '../../src/clients/condominiums.client';
import { CondoUnitsClient } from '../../src/clients/condo-units.client';
import { GeoSearchClient } from '../../src/clients/geosearch.client';
import { PlutoClient } from '../../src/clients/pluto.client';
import { SocrataClient } from '../../src/clients/socrata.client';
import { MAX_PROPERTY_VIOLATIONS_PAGE_SIZE } from '../../src/schemas/property-violations-query.schema';
import { createPropertiesRouter } from '../../src/routes/properties.routes';
import { createPropertyViolationsQueryService } from '../../src/services/ecb/property-violations-query.service';
import { createPropertyIdentityService } from '../../src/services/property-resolver/property-identity.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describeIntegration('GET /properties/:id/ecb-violations', () => {
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

    const propertyIdentity = createPropertyIdentityService(prisma);
    const propertyViolationsQuery = createPropertyViolationsQueryService(prisma);

    app = express();
    app.use(express.json());
    app.use(
      '/properties',
      createPropertiesRouter({
        propertyResolver: {
          resolveAddress: jest.fn(),
          resolveBbl: jest.fn(),
        },
        propertyIdentity,
        propertyViolationsQuery,
      }),
    );
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

  it('applies openOnly and unpaidOnly independently and together through HTTP', async () => {
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

    const open = await request(app)
      .get(`/properties/${property.id}/ecb-violations`)
      .query({ openOnly: 'true' });
    const unpaid = await request(app)
      .get(`/properties/${property.id}/ecb-violations`)
      .query({ unpaidOnly: 'true' });
    const both = await request(app)
      .get(`/properties/${property.id}/ecb-violations`)
      .query({ openOnly: 'true', unpaidOnly: 'true' });

    expect(open.status).toBe(200);
    expect(unpaid.status).toBe(200);
    expect(both.status).toBe(200);
    expect(open.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'active-paid',
      'active-zero',
    ]);
    expect(unpaid.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'active-paid',
      'closed-paid',
    ]);
    expect(both.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'active-paid',
    ]);
  });

  it('traverses newest-first ordering across dated rows and the NULL tail through HTTP pagination', async () => {
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
    const pages: string[][] = [];
    let nextCursor: string | undefined;

    do {
      const response = await request(app)
        .get(`/properties/${property.id}/ecb-violations`)
        .query({
          limit: '2',
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        });

      expect(response.status).toBe(200);
      const ids = response.body.violations.map((row: { sourceId: string }) => row.sourceId);
      pages.push(ids);
      traversed.push(...ids);
      nextCursor = response.body.page.nextCursor ?? undefined;
    } while (nextCursor !== undefined);

    expect(traversed).toEqual(canonicalOrder);
    expect(new Set(traversed).size).toBe(traversed.length);
    expect(pages).toEqual([
      ['dated-new-z', 'dated-new-a'],
      ['dated-old', 'null-z'],
      ['null-y', 'null-x'],
      ['null-a'],
    ]);
    expect(pages[0].length).toBe(2);
    expect(pages[3]).toEqual(['null-a']);
    expect(pages[2]).toEqual(['null-y', 'null-x']);
  });

  it('exposes nextCursor only when another page exists', async () => {
    const property = await seedProperty({ bbl: '1000010010', bin: '1000010' });
    await seedViolation({ sourceId: 'only-row', issueDate: '2026-01-01', bin: '1000010' });

    const response = await request(app).get(`/properties/${property.id}/ecb-violations`);

    expect(response.status).toBe(200);
    expect(response.body.page).toEqual({
      limit: 50,
      hasMore: false,
      nextCursor: null,
    });
  });

  it('distinguishes checked-empty, not-checked, and failed coverage metadata when violations are empty', async () => {
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

    const [checkedResponse, notCheckedResponse, failedResponse] = await Promise.all([
      request(app).get(`/properties/${checked.id}/ecb-violations`),
      request(app).get(`/properties/${notChecked.id}/ecb-violations`),
      request(app).get(`/properties/${failed.id}/ecb-violations`),
    ]);

    expect(checkedResponse.status).toBe(200);
    expect(notCheckedResponse.status).toBe(200);
    expect(failedResponse.status).toBe(200);
    expect(checkedResponse.body.violations).toEqual([]);
    expect(notCheckedResponse.body.violations).toEqual([]);
    expect(failedResponse.body.violations).toEqual([]);
    expect(checkedResponse.body.coverage).toMatchObject({
      status: CoverageStatus.CHECKED,
      lastSuccessAt: previousSuccessAt.toISOString(),
      sourceWatermarkAt: watermark.toISOString(),
    });
    expect(notCheckedResponse.body.coverage).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
      lastSuccessAt: null,
    });
    expect(failedResponse.body.coverage).toMatchObject({
      status: CoverageStatus.FAILED,
      lastAttemptAt: failedAttemptAt.toISOString(),
      lastSuccessAt: previousSuccessAt.toISOString(),
      sourceWatermarkAt: watermark.toISOString(),
      lastError: 'UPSTREAM_TIMEOUT',
    });
  });

  it.each([
    [{ openOnly: 'yes' }],
    [{ unpaidOnly: '1' }],
    [{ limit: '0' }],
    [{ limit: '-1' }],
    [{ limit: '1.5' }],
    [{ limit: String(MAX_PROPERTY_VIOLATIONS_PAGE_SIZE + 1) }],
    [{ cursor: 'not*a*cursor' }],
  ])('rejects malformed query parameters with safe client errors: %p', async (query) => {
    const property = await seedProperty({ bbl: '1000010006', bin: '1000006' });

    const response = await request(app)
      .get(`/properties/${property.id}/ecb-violations`)
      .query(query);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      },
    });
    expect(response.body.error.message.length).toBeGreaterThan(0);
    expect(response.body.stack).toBeUndefined();
  });

  it('returns a defined not-found response when the stored property does not exist', async () => {
    const response = await request(app).get(
      '/properties/00000000-0000-4000-8000-000000009999/ecb-violations',
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'PROPERTY_NOT_FOUND',
        message: 'Property not found',
      },
    });
  });

  it('rejects malformed property ids without querying violations', async () => {
    const response = await request(app).get('/properties/not-a-uuid/ecb-violations');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never invokes an external NYC client during the GET path', async () => {
    const property = await seedProperty({ bbl: '1000010007', bin: '1000007' });
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
      const response = await request(app).get(`/properties/${property.id}/ecb-violations`);

      expect(response.status).toBe(200);
      expect(response.body.coverage).toMatchObject({
        status: CoverageStatus.NOT_CHECKED,
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
});
