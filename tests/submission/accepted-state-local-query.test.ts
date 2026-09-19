import {
  CoverageStatus,
  Dataset,
  IngestionRunStatus,
  IngestionTriggerType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import request from 'supertest';

import { createApp } from '../../src/app';
import { BuildingFootprintsClient } from '../../src/clients/building-footprints.client';
import { CondominiumsClient } from '../../src/clients/condominiums.client';
import { CondoUnitsClient } from '../../src/clients/condo-units.client';
import { GeoSearchClient } from '../../src/clients/geosearch.client';
import { PlutoClient } from '../../src/clients/pluto.client';
import { SocrataClient } from '../../src/clients/socrata.client';

const describeGate = process.env.API_OPERATIONS_GATE === '1' ? describe : describe.skip;

describeGate('final submission accepted-state local query proof', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('serves a CHECKED accepted violation without any request-time NYC fetch', async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violations", "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );

    const acceptedAt = new Date('2026-09-15T10:00:00.000Z');
    const watermark = new Date('2026-09-15T09:40:00.000Z');
    const run = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.COMPLETED,
        triggerType: IngestionTriggerType.MANUAL,
        initializationComplete: true,
        startedAt: new Date('2026-09-15T09:45:00.000Z'),
        finishedAt: acceptedAt,
        sourceWatermarkAtStart: watermark,
        sourceWatermarkAtEnd: watermark,
      },
    });
    const property = await prisma.property.create({
      data: {
        bbl: '1008350041',
        borough: 1,
        block: 835,
        lot: 41,
        resolvedAt: acceptedAt,
        bins: { create: { bin: '1015862' } },
        datasetCoverage: {
          create: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: CoverageStatus.CHECKED,
            lastAttemptRunId: run.id,
            lastSuccessRunId: run.id,
            lastAttemptAt: acceptedAt,
            lastSuccessAt: acceptedAt,
            sourceWatermarkAt: watermark,
          },
        },
      },
    });
    await prisma.ecbViolation.create({
      data: {
        sourceId: 'accepted-local-row',
        socrataRowId: 'accepted-local-socrata-row',
        bin: '1015862',
        violationNumber: 'ECB-LOCAL-1',
        issueDate: new Date('2026-09-10T00:00:00.000Z'),
        ecbViolationStatus: 'ACTIVE',
        balanceDue: new Prisma.Decimal('125.00'),
        sourceRowUpdatedAt: watermark,
        lastSuccessRunId: run.id,
        isCurrent: true,
      },
    });

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
      .mockRejectedValue(new Error('external HTTP is forbidden in accepted stored ECB queries'));

    try {
      const response = await request(createApp({ prisma })).get(
        `/properties/${property.id}/ecb-violations`,
      );

      expect(response.status).toBe(200);
      expect(response.body.violations.map((row: { sourceId: string }) => row.sourceId)).toEqual([
        'accepted-local-row',
      ]);
      expect(response.body.coverage).toMatchObject({
        status: CoverageStatus.CHECKED,
        lastSuccessAt: acceptedAt.toISOString(),
        sourceWatermarkAt: watermark.toISOString(),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const externalSpy of externalSpies) expect(externalSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      for (const externalSpy of externalSpies) externalSpy.mockRestore();
    }
  });
});
