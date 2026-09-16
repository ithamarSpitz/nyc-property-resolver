import express from 'express';
import request from 'supertest';

import { AppError } from '../../src/errors';
import { createPropertiesRouter } from '../../src/routes/properties.routes';
import type { PropertyWithRelations } from '../../src/services/property-resolver/property-identity.service';

const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const RESOLVED_AT = new Date('2025-01-15T12:00:00.000Z');
const CREATED_AT = new Date('2025-01-15T11:00:00.000Z');

function buildStoredProperty(overrides: Partial<PropertyWithRelations> = {}): PropertyWithRelations {
  return {
    id: PROPERTY_ID,
    identifierVersion: 1,
    bbl: '1008350041',
    condoBaseBbl: null,
    condoBillingBbl: null,
    normalizedAddress: '350 5th Avenue',
    borough: 1,
    block: 835,
    lot: 41,
    createdAt: CREATED_AT,
    resolvedAt: RESOLVED_AT,
    bins: [{ propertyId: PROPERTY_ID, bin: '1012345' }],
    datasetCoverage: [],
    ...overrides,
  };
}

function createTestApp(
  propertyResolver: {
    resolveAddress: jest.Mock;
    resolveBbl: jest.Mock;
  },
  propertyIdentity: {
    findPropertyById: jest.Mock;
  },
): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/properties', createPropertiesRouter({ propertyResolver, propertyIdentity }));
  return app;
}

describe('single property HTTP API', () => {
  let propertyResolver: {
    resolveAddress: jest.Mock;
    resolveBbl: jest.Mock;
  };
  let propertyIdentity: {
    findPropertyById: jest.Mock;
  };
  let app: express.Application;

  beforeEach(() => {
    propertyResolver = {
      resolveAddress: jest.fn(),
      resolveBbl: jest.fn(),
    };
    propertyIdentity = {
      findPropertyById: jest.fn(),
    };
    app = createTestApp(propertyResolver, propertyIdentity);
  });

  it('creates or resolves a property by address and returns the canonical stored shape', async () => {
    const property = buildStoredProperty();
    propertyResolver.resolveAddress.mockResolvedValue({ property, cached: false });

    const response = await request(app)
      .post('/properties')
      .send({ address: '350 5th Avenue, Manhattan' });

    expect(response.status).toBe(200);
    expect(propertyResolver.resolveAddress).toHaveBeenCalledWith('350 5th Avenue, Manhattan');
    expect(propertyResolver.resolveBbl).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      id: PROPERTY_ID,
      identifierVersion: 1,
      bbl: '1008350041',
      condoBaseBbl: null,
      condoBillingBbl: null,
      normalizedAddress: '350 5th Avenue',
      borough: 1,
      block: 835,
      lot: 41,
      bins: ['1012345'],
      createdAt: CREATED_AT.toISOString(),
      resolvedAt: RESOLVED_AT.toISOString(),
    });
  });

  it('accepts unit-aware address input through the same address field', async () => {
    const property = buildStoredProperty({
      normalizedAddress: '419 E 84 St Apt 12C',
      bbl: '1012345678',
    });
    propertyResolver.resolveAddress.mockResolvedValue({ property, cached: false });

    const response = await request(app)
      .post('/properties')
      .send({ address: '419 E 84 St Apt 12C' });

    expect(response.status).toBe(200);
    expect(propertyResolver.resolveAddress).toHaveBeenCalledWith('419 E 84 St Apt 12C');
    expect(response.body.normalizedAddress).toBe('419 E 84 St Apt 12C');
  });

  it('creates or resolves a property by BBL and returns the canonical stored shape', async () => {
    const property = buildStoredProperty();
    propertyResolver.resolveBbl.mockResolvedValue({ property, cached: false });

    const response = await request(app).post('/properties').send({ bbl: '1008350041' });

    expect(response.status).toBe(200);
    expect(propertyResolver.resolveBbl).toHaveBeenCalledWith('1008350041');
    expect(propertyResolver.resolveAddress).not.toHaveBeenCalled();
    expect(response.body.bbl).toBe('1008350041');
    expect(response.body.bins).toEqual(['1012345']);
  });

  it('returns the same canonical property for repeated create requests without route-level duplication logic', async () => {
    const property = buildStoredProperty();
    propertyResolver.resolveAddress.mockResolvedValue({ property, cached: true });

    const first = await request(app).post('/properties').send({ address: '350 5th Avenue' });
    const second = await request(app).post('/properties').send({ address: '350 5th Avenue' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual(second.body);
    expect(propertyResolver.resolveAddress).toHaveBeenCalledTimes(2);
  });

  it('rejects empty, mixed, and missing create payloads without calling the resolver', async () => {
    const invalidPayloads = [
      {},
      { address: '', bbl: '' },
      { address: '350 5th Avenue', bbl: '1008350041' },
      { address: '   ' },
      { bbl: '   ' },
    ];

    for (const payload of invalidPayloads) {
      const response = await request(app).post('/properties').send(payload);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.any(String),
        },
      });
      expect(response.body.error.message.length).toBeGreaterThan(0);
    }

    expect(propertyResolver.resolveAddress).not.toHaveBeenCalled();
    expect(propertyResolver.resolveBbl).not.toHaveBeenCalled();
  });

  it('maps resolver AppError responses without leaking stack traces', async () => {
    propertyResolver.resolveAddress.mockRejectedValue(
      new AppError({
        code: 'RESOLVER_AMBIGUOUS_CONDO_UNIT',
        message: 'Condo unit address matched multiple units',
        statusCode: 422,
      }),
    );

    const response = await request(app)
      .post('/properties')
      .send({ address: '419 E 84 St Apt 12C' });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: {
        code: 'RESOLVER_AMBIGUOUS_CONDO_UNIT',
        message: 'Condo unit address matched multiple units',
      },
    });
    expect(response.body.stack).toBeUndefined();
  });

  it('returns a stored property by id from the local store', async () => {
    const property = buildStoredProperty();
    propertyIdentity.findPropertyById.mockResolvedValue(property);

    const response = await request(app).get(`/properties/${PROPERTY_ID}`);

    expect(response.status).toBe(200);
    expect(propertyIdentity.findPropertyById).toHaveBeenCalledWith(PROPERTY_ID);
    expect(propertyResolver.resolveAddress).not.toHaveBeenCalled();
    expect(propertyResolver.resolveBbl).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      id: PROPERTY_ID,
      identifierVersion: 1,
      bbl: '1008350041',
      condoBaseBbl: null,
      condoBillingBbl: null,
      normalizedAddress: '350 5th Avenue',
      borough: 1,
      block: 835,
      lot: 41,
      bins: ['1012345'],
      createdAt: CREATED_AT.toISOString(),
      resolvedAt: RESOLVED_AT.toISOString(),
    });
  });

  it('returns a defined not-found response when the stored property does not exist', async () => {
    propertyIdentity.findPropertyById.mockResolvedValue(null);

    const response = await request(app).get(`/properties/${PROPERTY_ID}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'PROPERTY_NOT_FOUND',
        message: 'Property not found',
      },
    });
  });

  it('rejects malformed property ids without calling the local store lookup', async () => {
    const response = await request(app).get('/properties/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(propertyIdentity.findPropertyById).not.toHaveBeenCalled();
  });
});
