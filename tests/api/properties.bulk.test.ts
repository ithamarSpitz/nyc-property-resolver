import express from 'express';
import request from 'supertest';

import { BULK_BBL_MAX_COUNT } from '../../src/schemas/property-bulk.schema';
import { createPropertiesBulkRouter } from '../../src/routes/properties-bulk.routes';
import type { BulkPropertyRegistrationService } from '../../src/services/property-resolver/bulk-property-registration.service';

describe('POST /properties/bulk', () => {
  let app: express.Application;
  let bulkRegistrationService: {
    registerBbls: jest.Mock;
  };

  beforeEach(() => {
    bulkRegistrationService = {
      registerBbls: jest.fn(),
    };

    app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use(
      '/properties',
      createPropertiesBulkRouter({
        bulkRegistrationService: bulkRegistrationService as unknown as BulkPropertyRegistrationService,
      }),
    );
  });

  it('rejects payloads over 10,000 BBLs', async () => {
    const response = await request(app)
      .post('/properties/bulk')
      .send({
        bbls: Array.from({ length: BULK_BBL_MAX_COUNT + 1 }, (_, index) =>
          `1${String(index).padStart(9, '0')}`,
        ),
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'BULK_BBL_LIMIT_EXCEEDED',
    });
    expect(bulkRegistrationService.registerBbls).not.toHaveBeenCalled();
  });

  it('rejects empty payloads', async () => {
    const response = await request(app).post('/properties/bulk').send({ bbls: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(bulkRegistrationService.registerBbls).not.toHaveBeenCalled();
  });

  it('returns structured per-input outcomes from the bulk registration service', async () => {
    bulkRegistrationService.registerBbls.mockResolvedValue({
      summary: {
        submitted: 2,
        unique: 2,
        succeeded: 1,
        failed: 1,
        cached: 0,
      },
      results: [
        {
          inputBbl: '1008350041',
          canonicalBbl: '1008350041',
          status: 'succeeded',
          property: {
            id: 'property-1',
            bbl: '1008350041',
            bins: ['1012345'],
            borough: 1,
            block: 835,
            lot: 41,
            normalizedAddress: '350 5th Avenue',
            condoBaseBbl: null,
            condoBillingBbl: null,
            identifierVersion: 1,
            coverage: [],
          },
        },
        {
          inputBbl: 'bad-bbl',
          status: 'failed',
          error: {
            code: 'INVALID_BBL',
            message: 'BBL must be a 10-digit NYC parcel identifier',
          },
        },
      ],
    });

    const response = await request(app)
      .post('/properties/bulk')
      .send({ bbls: ['1008350041', 'bad-bbl'] });

    expect(response.status).toBe(200);
    expect(bulkRegistrationService.registerBbls).toHaveBeenCalledWith(['1008350041', 'bad-bbl']);
    expect(response.body.summary).toMatchObject({
      submitted: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[1]).toMatchObject({
      inputBbl: 'bad-bbl',
      status: 'failed',
      error: {
        code: 'INVALID_BBL',
      },
    });
  });
});
