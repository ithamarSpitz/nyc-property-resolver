import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { CONFIG_DEFAULTS } from '../../src/config/defaults';
import { createApp } from '../../src/app';
import { createBulkPropertyRegistrationService } from '../../src/services/property-resolver/bulk-property-registration.service';
import { createPropertyIdentityService } from '../../src/services/property-resolver/property-identity.service';
import { createPropertyResolverService } from '../../src/services/property-resolver/property-resolver.service';
import {
  CONDO_UNIT_ADDRESS,
  EMPIRE_STATE_BBL,
  EMPIRE_STATE_BIN,
  QUEENS_ADDRESS,
} from '../fixtures/property-resolution/constants';
import {
  createMockBulkClients,
  mockNonCondoBulkBatch,
} from '../fixtures/property-resolution/bulk-scenarios';
import {
  createMockResolverClients,
  mockQueensHyphenResolution,
  mockStandardNonCondoResolution,
} from '../fixtures/property-resolution/scenarios';

describe('property resolution HTTP e2e', () => {
  let prisma: PrismaClient;
  let resolverClients: ReturnType<typeof createMockResolverClients>;
  let bulkClients: ReturnType<typeof createMockBulkClients>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.propertyDatasetCoverage.deleteMany();
    await prisma.propertyResolutionInput.deleteMany();
    await prisma.propertyBin.deleteMany();
    await prisma.property.deleteMany();

    resolverClients = createMockResolverClients();
    bulkClients = createMockBulkClients();

    const propertyIdentity = createPropertyIdentityService(prisma);
    const propertyResolver = createPropertyResolverService({
      prisma,
      clients: resolverClients as never,
    });
    const bulkRegistrationService = createBulkPropertyRegistrationService({
      prisma,
      clients: bulkClients as never,
    });

    app = createApp({
      config: { apiBodyLimit: CONFIG_DEFAULTS.API_BODY_LIMIT },
      prisma,
      propertyIdentity,
      propertyResolver,
      bulkRegistrationService,
    });
  });

  it('resolves a property through POST /properties and returns the stored row from GET /properties/:id', async () => {
    mockStandardNonCondoResolution(resolverClients);

    const created = await request(app)
      .post('/properties')
      .send({ address: '350 5th Avenue, Manhattan' });

    expect(created.status).toBe(200);
    expect(created.body.bbl).toBe(EMPIRE_STATE_BBL);
    expect(created.body.bins).toEqual([EMPIRE_STATE_BIN]);

    const fetched = await request(app).get(`/properties/${created.body.id}`);

    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);
  });

  it('returns the same canonical property for duplicate create requests', async () => {
    mockStandardNonCondoResolution(resolverClients);

    const first = await request(app).post('/properties').send({ bbl: EMPIRE_STATE_BBL });
    const second = await request(app).post('/properties').send({ bbl: EMPIRE_STATE_BBL });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(resolverClients.pluto.lookupByBbl).toHaveBeenCalledTimes(1);
  });

  it('preserves Queens hyphenated addresses through the HTTP registration path', async () => {
    mockQueensHyphenResolution(resolverClients);

    const response = await request(app).post('/properties').send({ address: QUEENS_ADDRESS });

    expect(response.status).toBe(200);
    expect(response.body.normalizedAddress).toBe(QUEENS_ADDRESS);
    expect(response.body.normalizedAddress).toContain('37-15');
  });

  it('maps resolver failures to explicit HTTP error responses', async () => {
    resolverClients.geoSearch.searchByAddress.mockResolvedValue({
      queriedAddress: CONDO_UNIT_ADDRESS,
      candidates: [
        {
          label: '419 E 84 St, Manhattan',
          layer: 'address',
          confidence: 0.95,
          bbl: '1010067501',
          sourceId: 'feature-1',
        },
      ],
    });
    resolverClients.condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValue({
      matchCount: 'zero',
      matches: [],
    });

    const response = await request(app)
      .post('/properties')
      .send({ address: '419 E 84 St Apt 99Z' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('RESOLVER_CONDO_UNIT_NOT_FOUND');
  });

  it('accepts bulk BBL payloads larger than the Express default body limit using API_BODY_LIMIT', async () => {
    const bbls = Array.from({ length: 8_500 }, (_, index) => `invalid-${index}`);
    const payload = JSON.stringify({ bbls });
    expect(payload.length).toBeGreaterThan(100 * 1024);

    const response = await request(app)
      .post('/properties/bulk')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).not.toBe(413);
    expect(response.status).toBe(200);
    expect(response.body.summary.submitted).toBe(bbls.length);
    expect(response.body.summary.failed).toBe(bbls.length);
    expect(bulkClients.geoSearch.searchByAddress).not.toHaveBeenCalled();
  });

  it('deduplicates bulk BBL submissions and returns cached outcomes on replay', async () => {
    mockNonCondoBulkBatch(bulkClients, EMPIRE_STATE_BBL);

    const first = await request(app)
      .post('/properties/bulk')
      .send({ bbls: [EMPIRE_STATE_BBL, EMPIRE_STATE_BBL] });
    const second = await request(app)
      .post('/properties/bulk')
      .send({ bbls: [EMPIRE_STATE_BBL, EMPIRE_STATE_BBL] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.summary.succeeded).toBe(2);
    expect(second.body.summary.cached).toBe(2);
    expect(bulkClients.pluto.lookupByBbls).toHaveBeenCalledTimes(1);
  });
});
