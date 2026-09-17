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

import { createApp } from '../../../src/app';
import { BuildingFootprintsClient } from '../../../src/clients/building-footprints.client';
import { CondominiumsClient } from '../../../src/clients/condominiums.client';
import { CondoUnitsClient } from '../../../src/clients/condo-units.client';
import { GeoSearchClient } from '../../../src/clients/geosearch.client';
import { PlutoClient } from '../../../src/clients/pluto.client';
import { SocrataClient } from '../../../src/clients/socrata.client';
import { MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE } from '../../../src/schemas/portfolio-violations-query.schema';
import { MAX_PROPERTY_VIOLATIONS_PAGE_SIZE } from '../../../src/schemas/property-violations-query.schema';

const describeGate = process.env.API_OPERATIONS_GATE === '1' ? describe : describe.skip;

async function waitForApiHealth(apiBaseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(`${apiBaseUrl}/health`, { signal: controller.signal });
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') {
          return;
        }
      }
    } catch {
      // Retry until the Compose API is reachable.
    } finally {
      clearTimeout(requestTimeout);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`API health check failed for ${apiBaseUrl}`);
}

function externalClientSpies() {
  return [
    jest.spyOn(SocrataClient.prototype, 'getDatasetMetadata'),
    jest.spyOn(SocrataClient.prototype, 'getEcbDataPage'),
    jest.spyOn(GeoSearchClient.prototype, 'searchByAddress'),
    jest.spyOn(PlutoClient.prototype, 'lookupByBbl'),
    jest.spyOn(BuildingFootprintsClient.prototype, 'lookupByParcelBbl'),
    jest.spyOn(CondoUnitsClient.prototype, 'lookupByUnitBbl'),
    jest.spyOn(CondominiumsClient.prototype, 'lookupByCondoBaseBbl'),
  ];
}

describeGate('S4 API operations integration gate', () => {
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
    app = createApp({ prisma });
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
    bin: string;
    issueDate?: string | null;
    sourceRowUpdatedAt?: Date;
    status?: string | null;
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
        ecbViolationStatus: options.status ?? 'ACTIVE',
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

  it('serves accepted live property ECB rows with explicit coverage and freshness metadata', async () => {
    const watermark = new Date('2026-09-15T09:40:00.000Z');
    const lastSuccessAt = new Date('2026-09-15T10:00:00.000Z');
    const property = await seedProperty({
      bbl: '1000010100',
      bin: '1000100',
      status: CoverageStatus.CHECKED,
      statusReason: null,
      lastAttemptAt: lastSuccessAt,
      lastSuccessAt,
      sourceWatermarkAt: watermark,
    });
    await seedViolation({
      sourceId: 'live-row',
      bin: '1000100',
      issueDate: '2026-09-10',
    });
    await seedViolation({
      sourceId: 'stale-row',
      bin: '1000100',
      issueDate: '2027-01-01',
      isCurrent: false,
    });

    const response = await request(app).get(`/properties/${property.id}/ecb-violations`);

    expect(response.status).toBe(200);
    expect(response.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'live-row',
    ]);
    expect(response.body.coverage).toMatchObject({
      status: CoverageStatus.CHECKED,
      lastSuccessAt: lastSuccessAt.toISOString(),
      sourceWatermarkAt: watermark.toISOString(),
    });
  });

  it('distinguishes checked-empty, not-checked, and failed-fetch coverage at the HTTP boundary', async () => {
    const previousSuccessAt = new Date('2026-09-15T10:00:00.000Z');
    const failedAttemptAt = new Date('2026-09-17T10:00:00.000Z');
    const watermark = new Date('2026-09-15T09:40:00.000Z');
    const checked = await seedProperty({
      bbl: '1000010101',
      bin: '1000101',
      status: CoverageStatus.CHECKED,
      statusReason: null,
      lastAttemptAt: previousSuccessAt,
      lastSuccessAt: previousSuccessAt,
      sourceWatermarkAt: watermark,
    });
    const notChecked = await seedProperty({
      bbl: '1000010102',
      bin: '1000102',
    });
    const failed = await seedProperty({
      bbl: '1000010103',
      bin: '1000103',
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

    expect(checkedResponse.body.violations).toEqual([]);
    expect(checkedResponse.body.coverage.status).toBe(CoverageStatus.CHECKED);
    expect(notCheckedResponse.body.violations).toEqual([]);
    expect(notCheckedResponse.body.coverage).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
    });
    expect(failedResponse.body.violations).toEqual([]);
    expect(failedResponse.body.coverage).toMatchObject({
      status: CoverageStatus.FAILED,
      lastError: 'UPSTREAM_TIMEOUT',
    });
  });

  it('applies openOnly and unpaidOnly with exact ACTIVE and balance_due > 0 semantics', async () => {
    const property = await seedProperty({ bbl: '1000010104', bin: '1000104' });
    await seedViolation({
      sourceId: 'active-paid',
      bin: '1000104',
      issueDate: '2026-04-04',
      status: 'ACTIVE',
      balanceDue: '25.00',
    });
    await seedViolation({
      sourceId: 'active-zero',
      bin: '1000104',
      issueDate: '2026-03-03',
      status: 'ACTIVE',
      balanceDue: '0.00',
    });
    await seedViolation({
      sourceId: 'closed-paid',
      bin: '1000104',
      issueDate: '2026-02-02',
      status: 'CLOSED',
      balanceDue: '5.00',
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

  it('paginates property ECB rows in issue_date DESC NULLS LAST, source_id DESC order without gaps or duplicates', async () => {
    const property = await seedProperty({
      bbl: '1000010105',
      bin: '1000105',
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

    await seedViolation({ sourceId: 'null-a', bin: '1000105', issueDate: null });
    await seedViolation({ sourceId: 'dated-new-a', bin: '1000105', issueDate: '2026-09-16' });
    await seedViolation({ sourceId: 'null-z', bin: '1000105', issueDate: null });
    await seedViolation({ sourceId: 'dated-old', bin: '1000105', issueDate: '2026-01-01' });
    await seedViolation({ sourceId: 'null-x', bin: '1000105', issueDate: null });
    await seedViolation({ sourceId: 'dated-new-z', bin: '1000105', issueDate: '2026-09-16' });
    await seedViolation({ sourceId: 'null-y', bin: '1000105', issueDate: null });

    const expectedPages = [
      ['dated-new-z', 'dated-new-a'],
      ['dated-old', 'null-z'],
      ['null-y', 'null-x'],
      ['null-a'],
    ];
    const pages: string[][] = [];
    let nextCursor: string | undefined;

    do {
      const pageIndex = pages.length;
      const expectedPage = expectedPages[pageIndex];
      expect(expectedPage).toBeDefined();

      const response = await request(app)
        .get(`/properties/${property.id}/ecb-violations`)
        .query({
          limit: '2',
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        });

      expect(response.status).toBe(200);
      const ids = response.body.violations.map((row: { sourceId: string }) => row.sourceId);
      const isLastPage = pageIndex === expectedPages.length - 1;

      expect(ids).toEqual(expectedPage);
      expect(ids).toHaveLength(expectedPage!.length);
      expect(response.body.page.limit).toBe(2);
      expect(response.body.page.hasMore).toBe(!isLastPage);
      if (isLastPage) {
        expect(response.body.page.nextCursor).toBeNull();
      } else {
        expect(typeof response.body.page.nextCursor).toBe('string');
        expect(response.body.page.nextCursor.length).toBeGreaterThan(0);
      }

      pages.push(ids);
      nextCursor = response.body.page.nextCursor ?? undefined;
    } while (nextCursor !== undefined);

    const traversed = pages.flat();
    expect(pages).toEqual(expectedPages);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 1]);
    expect(traversed).toEqual(canonicalOrder);
    expect(new Set(traversed).size).toBe(traversed.length);
  });

  it('filters portfolio rows by current property_bins membership and de-duplicates shared BINs', async () => {
    await seedProperty({ bbl: '1000010106', bin: '1000106' });
    await seedProperty({ bbl: '1000010107', bin: '1000106' });
    await seedViolation({ sourceId: 'shared-bin-row', bin: '1000106' });
    await seedViolation({ sourceId: 'orphaned-bin', bin: '2000200' });

    const response = await request(app).get('/ecb-violations');

    expect(response.status).toBe(200);
    expect(response.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'shared-bin-row',
    ]);
    expect(response.body.violations).toHaveLength(1);
  });

  it('applies updatedSince with strict source_row_updated_at > semantics and stable cursor order', async () => {
    await seedProperty({ bbl: '1000010108', bin: '1000108' });
    const boundary = new Date('2026-09-17T10:00:00.000Z');
    const timestamps: Record<string, Date> = {
      'newer-z': new Date('2026-09-17T12:00:02.000Z'),
      'newer-a': new Date('2026-09-17T12:00:01.000Z'),
      older: new Date('2026-09-17T11:00:00.000Z'),
      'at-boundary': boundary,
      excluded: new Date('2026-09-16T23:59:59.000Z'),
    };

    for (const [sourceId, sourceRowUpdatedAt] of Object.entries(timestamps)) {
      await seedViolation({
        sourceId,
        bin: '1000108',
        sourceRowUpdatedAt,
      });
    }

    const expectedPages = [['newer-z'], ['newer-a'], ['older']];
    const pages: string[][] = [];
    let nextCursor: string | undefined;

    do {
      const pageIndex = pages.length;
      const expectedPage = expectedPages[pageIndex];
      expect(expectedPage).toBeDefined();

      const response = await request(app)
        .get('/ecb-violations')
        .query({
          updatedSince: boundary.toISOString(),
          limit: '1',
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        });

      expect(response.status).toBe(200);
      const ids = response.body.violations.map((row: { sourceId: string }) => row.sourceId);
      const isLastPage = pageIndex === expectedPages.length - 1;

      expect(ids).toEqual(expectedPage);
      expect(ids).toHaveLength(1);
      expect(response.body.page.limit).toBe(1);
      expect(response.body.page.hasMore).toBe(!isLastPage);
      if (isLastPage) {
        expect(response.body.page.nextCursor).toBeNull();
      } else {
        expect(typeof response.body.page.nextCursor).toBe('string');
        expect(response.body.page.nextCursor.length).toBeGreaterThan(0);
      }

      pages.push(ids);
      nextCursor = response.body.page.nextCursor ?? undefined;
    } while (nextCursor !== undefined);

    const traversed = pages.flat();
    expect(pages).toEqual(expectedPages);
    expect(pages.map((page) => page.length)).toEqual([1, 1, 1]);
    expect(traversed).toEqual(['newer-z', 'newer-a', 'older']);
    expect(new Set(traversed).size).toBe(traversed.length);
  });

  it('returns safe client validation errors for malformed property and portfolio query input', async () => {
    const property = await seedProperty({ bbl: '1000010111', bin: '1000111' });

    const propertyCursor = await request(app)
      .get(`/properties/${property.id}/ecb-violations`)
      .query({ cursor: 'bad' });
    const propertyLimit = await request(app)
      .get(`/properties/${property.id}/ecb-violations`)
      .query({ limit: String(MAX_PROPERTY_VIOLATIONS_PAGE_SIZE + 1) });
    const portfolioCursor = await request(app).get('/ecb-violations').query({ cursor: 'bad' });
    const portfolioUpdatedSince = await request(app)
      .get('/ecb-violations')
      .query({ updatedSince: 'not-a-timestamp' });
    const portfolioLimit = await request(app)
      .get('/ecb-violations')
      .query({ limit: String(MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE + 1) });

    for (const response of [
      propertyCursor,
      propertyLimit,
      portfolioCursor,
      portfolioUpdatedSince,
      portfolioLimit,
    ]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('stack');
    }
  });

  it('never invokes external NYC clients during assembled ECB query requests', async () => {
    const property = await seedProperty({ bbl: '1000010109', bin: '1000109' });
    const spies = externalClientSpies();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('external HTTP is forbidden in stored ECB queries'));

    try {
      const [propertyResponse, portfolioResponse] = await Promise.all([
        request(app).get(`/properties/${property.id}/ecb-violations`),
        request(app).get('/ecb-violations'),
      ]);

      expect(propertyResponse.status).toBe(200);
      expect(portfolioResponse.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      fetchSpy.mockRestore();
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it(
    'serves seeded ECB data from the running Compose API after migration-backed startup',
    async () => {
      const apiBaseUrl = process.env.API_OPERATIONS_GATE_API_URL ?? 'http://api:3000';
      const property = await seedProperty({ bbl: '1000010110', bin: '1000110' });
      await seedViolation({
        sourceId: 'compose-runtime-row',
        bin: '1000110',
        issueDate: '2026-09-12',
      });

      await waitForApiHealth(apiBaseUrl);

      const response = await fetch(`${apiBaseUrl}/properties/${property.id}/ecb-violations`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        violations: Array<{ sourceId: string }>;
        coverage: { status: string };
      };
      expect(body.violations.map((row) => row.sourceId)).toEqual(['compose-runtime-row']);
      expect(body.coverage.status).toBe(CoverageStatus.NOT_CHECKED);
    },
    60_000,
  );
});
