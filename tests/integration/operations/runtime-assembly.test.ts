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
import { SocrataRequestExecutor } from '../../../src/clients/socrata-request-executor';
import { runManualIngestion } from '../../../src/cli/ingest-ecb';
import {
  createProductionIngestionRunner,
  startIngestionWorker,
} from '../../../src/workers/ingestion.worker';
import {
  INGESTION_RUNNER_OUTCOMES,
  type IngestionRunnerResult,
} from '../../../src/services/ecb/ingestion-runner.service';
import type { IngestionExecutor } from '../../../src/workers/scheduler';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

type ExpressLayer = {
  name?: string;
  regexp: RegExp;
};

function countMountedRouters(app: express.Application, pathFragment: string): number {
  const stack = (app as express.Application & { _router?: { stack?: ExpressLayer[] } })._router
    ?.stack;
  if (stack === undefined) {
    return 0;
  }

  return stack.filter(
    (layer: ExpressLayer) => layer.name === 'router' && layer.regexp.source.includes(pathFragment),
  ).length;
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

describeIntegration('runtime assembly', () => {
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
    app = createApp();
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
        datasetCoverage: {
          create: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: CoverageStatus.NOT_CHECKED,
            statusReason: CoverageStatusReason.NEVER_INGESTED,
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
          options.sourceRowUpdatedAt ?? new Date('2026-09-16T12:00:00.000Z'),
        lastSuccessRunId: liveStateRunId,
        isCurrent: options.isCurrent ?? true,
      },
    });
  }

  it('mounts property and portfolio ECB routes exactly once in the assembled app', () => {
    expect(countMountedRouters(app, 'properties')).toBe(2);
    expect(countMountedRouters(app, '^\\/?(?=\\/|$)')).toBe(1);
  });

  it('installs security middleware before routes and returns Helmet headers', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('serves seeded property ECB data from the assembled local-store routes', async () => {
    const property = await seedProperty('1000010001', '1000001');
    await seedViolation({
      sourceId: 'runtime-property-violation',
      bin: '1000001',
      issueDate: '2026-09-10',
    });

    const response = await request(app).get(`/properties/${property.id}/ecb-violations`);

    expect(response.status).toBe(200);
    expect(response.body.violations).toEqual([
      expect.objectContaining({
        sourceId: 'runtime-property-violation',
        bin: '1000001',
      }),
    ]);
    expect(response.body.coverage).toEqual(
      expect.objectContaining({
        status: CoverageStatus.NOT_CHECKED,
      }),
    );
  });

  it('serves seeded portfolio ECB data from the assembled local-store routes', async () => {
    await seedProperty('1000010002', '1000002');
    await seedViolation({
      sourceId: 'runtime-portfolio-violation',
      bin: '1000002',
      issueDate: '2026-09-11',
    });

    const response = await request(app).get('/ecb-violations');

    expect(response.status).toBe(200);
    expect(response.body.violations).toEqual([
      expect.objectContaining({
        sourceId: 'runtime-portfolio-violation',
        bin: '1000002',
      }),
    ]);
  });

  it('never invokes external NYC clients during assembled ECB query requests', async () => {
    const property = await seedProperty('1000010003', '1000003');
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

  it('responds from the running Compose API service after migration-backed startup', async () => {
    const apiBaseUrl = process.env.RUNTIME_ASSEMBLY_API_URL ?? 'http://api:3000';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await fetch(`${apiBaseUrl}/health`, { signal: controller.signal });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    } finally {
      clearTimeout(timeout);
    }
  });
});

describeIntegration('operational entrypoints', () => {
  it('exposes the manual ingestion npm script in the worker image', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const packageJson = require('../../../package.json') as { scripts: Record<string, string> };

    expect(packageJson.scripts['ingest:ecb']).toBe('node dist/cli/ingest-ecb.js');
  });

  it('routes scheduled worker and manual CLI execution through the same injectable ingestion boundary', async () => {
    const execute = jest.fn<ReturnType<IngestionExecutor['execute']>, Parameters<IngestionExecutor['execute']>>();
    const requestExecutor = {
      getMetrics: () => ({ requestCalls: 0, retryCalls: 0 }),
    } as unknown as SocrataRequestExecutor;
    const productionDependencies = {
      prisma: {} as PrismaClient,
      runner: { execute },
      dataRequestExecutor: requestExecutor,
      metadataRequestExecutor: requestExecutor,
      loadCounts: async () => ({ rowsFetched: 4, rowsWritten: 4, failedBatches: 0 }),
    };

    execute
      .mockResolvedValueOnce({
        outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
        run: {
          id: 'scheduled-run',
          status: IngestionRunStatus.COMPLETED,
        },
      } as IngestionRunnerResult)
      .mockResolvedValueOnce({
        outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
        run: {
          id: 'manual-run',
          status: IngestionRunStatus.COMPLETED,
        },
      } as IngestionRunnerResult);

    const scheduledService = createProductionIngestionRunner(undefined, productionDependencies);
    const worker = startIngestionWorker({
      ingestionService: scheduledService,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as never,
      disconnect: jest.fn().mockResolvedValue(undefined),
      registerProcessHandlers: false,
      config: {
        ingestIntervalMs: 60_000,
      } as never,
    });

    await worker.shutdown('TEST');

    const manualExitCode = await runManualIngestion({
      ingestionService: createProductionIngestionRunner(undefined, productionDependencies),
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as never,
    });

    expect(manualExitCode).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, {
      triggerType: IngestionTriggerType.SCHEDULED,
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      triggerType: IngestionTriggerType.MANUAL,
    });
  });
});
