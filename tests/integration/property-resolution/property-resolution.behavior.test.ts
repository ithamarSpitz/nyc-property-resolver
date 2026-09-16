import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  PrismaClient,
  PropertyResolutionInputType,
} from '@prisma/client';

import type { PlutoLookupResult } from '../../../src/clients/pluto.client';
import { normalizeAddress } from '../../../src/services/property-resolver/address-normalizer';
import {
  createBulkPropertyRegistrationService,
  type BulkPropertyRegistrationService,
} from '../../../src/services/property-resolver/bulk-property-registration.service';
import {
  createPropertyIdentityService,
  type PropertyIdentityService,
} from '../../../src/services/property-resolver/property-identity.service';
import {
  createPropertyResolverService,
  type PropertyResolverService,
} from '../../../src/services/property-resolver/property-resolver.service';
import { persistResolutionInput } from '../../../src/services/property-resolver/property-input.service';
import {
  CONDO_BASE_BBL,
  CONDO_BILLING_BBL,
  CONDO_UNIT_ADDRESS,
  CONDO_UNIT_BBL,
  EMPIRE_STATE_BBL,
  EMPIRE_STATE_BIN,
  QUEENS_ADDRESS,
  ZERO_BIN_BBL,
} from '../../fixtures/property-resolution/constants';
import {
  createMockBulkClients,
  makeBulkBbl,
  mockNonCondoBulkBatch,
} from '../../fixtures/property-resolution/bulk-scenarios';
import {
  createMockResolverClients,
  geoSearchResult,
  mockCondoUnitAddressResolution,
  mockQueensHyphenResolution,
  mockStandardNonCondoResolution,
  plutoParcel,
} from '../../fixtures/property-resolution/scenarios';

describe('S1 property resolution behavior gate', () => {
  let prisma: PrismaClient;
  let resolver: PropertyResolverService;
  let identityService: PropertyIdentityService;
  let bulkService: BulkPropertyRegistrationService;
  let resolverClients: ReturnType<typeof createMockResolverClients>;
  let bulkClients: ReturnType<typeof createMockBulkClients>;

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

    resolver = createPropertyResolverService({
      prisma,
      clients: resolverClients as never,
    });
    identityService = createPropertyIdentityService(prisma);
    bulkService = createBulkPropertyRegistrationService({
      prisma,
      clients: bulkClients as never,
    });
  });

  describe('normalized input idempotency and Queens hyphen preservation', () => {
    it('preserves Queens hyphenated house numbers and reuses stored properties for normalized input', async () => {
      mockQueensHyphenResolution(resolverClients);

      const normalized = normalizeAddress('37-15  82nd   street');
      expect(normalized.normalizedInput).toBe(QUEENS_ADDRESS);
      expect(normalized.normalizedBaseAddress).toContain('37-15');

      const first = await resolver.resolveAddress('37-15  82nd   street');
      const second = await resolver.resolveAddress(QUEENS_ADDRESS);

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.property.id).toBe(first.property.id);
      expect(second.property.normalizedAddress).toBe(QUEENS_ADDRESS);
      expect(resolverClients.geoSearch.searchByAddress).toHaveBeenCalledTimes(1);
    });
  });

  describe('condo unit resolution', () => {
    it('resolves an exact unit match through the unit-aware address flow', async () => {
      mockCondoUnitAddressResolution(resolverClients);

      const resolved = await resolver.resolveAddress(CONDO_UNIT_ADDRESS);
      expect(resolved.property.bbl).toBe(CONDO_UNIT_BBL);
    });

    it('fails explicitly when a unit-aware address has zero matching condo units', async () => {
      resolverClients.geoSearch.searchByAddress.mockResolvedValue(
        geoSearchResult('419 E 84 St', {
          bbl: CONDO_BILLING_BBL,
          label: '419 E 84 St, Manhattan',
        }),
      );
      resolverClients.condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValue({
        matchCount: 'zero',
        matches: [],
      });
      await expect(resolver.resolveAddress('419 E 84 St Apt 99Z')).rejects.toMatchObject({
        code: 'RESOLVER_CONDO_UNIT_NOT_FOUND',
      });
    });

    it('fails explicitly when a unit-aware address matches multiple condo units', async () => {
      resolverClients.geoSearch.searchByAddress.mockResolvedValue(
        geoSearchResult('419 E 84 St', {
          bbl: CONDO_BILLING_BBL,
          label: '419 E 84 St, Manhattan',
        }),
      );
      resolverClients.condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValue({
        matchCount: 'multiple',
        matches: [
          {
            unitBbl: CONDO_UNIT_BBL,
            condoBaseBbl: CONDO_BASE_BBL,
            unitDesignation: '12C',
          },
          {
            unitBbl: '1012345679',
            condoBaseBbl: CONDO_BASE_BBL,
            unitDesignation: '12C',
          },
        ],
      });
      await expect(resolver.resolveAddress('419 E 84 St Apt 12C')).rejects.toMatchObject({
        code: 'RESOLVER_CONDO_UNIT_AMBIGUOUS',
      });
    });
  });

  describe('footprint parcel evidence and GeoSearch BIN corroboration', () => {
    it('accepts matching MAPPLUTO evidence for non-condo parcels', async () => {
      mockStandardNonCondoResolution(resolverClients, { extraBins: ['1022334'] });
      const matching = await resolver.resolveAddress('350 5th Avenue');
      expect(matching.property.bins.map((row) => row.bin)).toEqual(['1012345', '1022334']);
    });

    it('rejects MAPPLUTO_BBL mismatches against the canonical PLUTO parcel', async () => {
      mockStandardNonCondoResolution(resolverClients, { mapplutoBbl: '1008350042' });
      await expect(resolver.resolveAddress('200 Park Avenue')).rejects.toMatchObject({
        code: 'RESOLVER_FOOTPRINT_MAPPLUTO_BBL_MISMATCH',
      });
    });

    it('rejects BASE_BBL mismatches when MAPPLUTO evidence is absent', async () => {
      mockStandardNonCondoResolution(resolverClients, {
        includeMapplutoField: false,
        baseBbl: '1008350042',
        address: '1 Wall Street',
        geoSearchBaseAddress: '1 Wall Street',
      });
      await expect(resolver.resolveAddress('1 Wall Street')).rejects.toMatchObject({
        code: 'RESOLVER_FOOTPRINT_BASE_BBL_MISMATCH',
      });
    });

    it('rejects GeoSearch BIN values that contradict validated footprint evidence', async () => {
      mockStandardNonCondoResolution(resolverClients, {
        bin: '1099999',
        address: '11 Madison Avenue',
        geoSearchBaseAddress: '11 Madison Avenue',
      });
      await expect(resolver.resolveAddress('11 Madison Avenue')).rejects.toMatchObject({
        code: 'RESOLVER_GEOSEARCH_BIN_CONFLICT',
      });
    });
  });

  describe('coverage initialization and identifier versioning', () => {
    it('initializes NEVER_INGESTED coverage for valid BINs and NO_VALID_BIN for placeholder-only properties', async () => {
      mockStandardNonCondoResolution(resolverClients);
      const withBins = await resolver.resolveAddress('350 5th Avenue');
      expect(identityService.getEcbCoverage(withBins.property)).toMatchObject({
        status: CoverageStatus.NOT_CHECKED,
        statusReason: CoverageStatusReason.NEVER_INGESTED,
      });

      resolverClients.pluto.lookupByBbl.mockResolvedValue({
        status: 'found',
        parcel: plutoParcel(ZERO_BIN_BBL, 'Vacant Lot'),
      });
      resolverClients.buildingFootprints.lookupByParcelBbl.mockResolvedValue({
        status: 'found',
        queriedBbl: ZERO_BIN_BBL,
        lookupMode: 'parcel',
        candidates: [
          {
            bin: '3000000',
            baseBbl: ZERO_BIN_BBL,
            mapplutoBbl: ZERO_BIN_BBL,
          },
        ],
      });

      const zeroBins = await resolver.resolveBbl(ZERO_BIN_BBL);
      expect(zeroBins.property.bins).toHaveLength(0);
      expect(identityService.getEcbCoverage(zeroBins.property)).toMatchObject({
        status: CoverageStatus.NOT_CHECKED,
        statusReason: CoverageStatusReason.NO_VALID_BIN,
      });
    });

    it('preserves identifier version and coverage for alias-only registration', async () => {
      const property = await identityService.findOrCreateProperty({
        bbl: EMPIRE_STATE_BBL,
        candidateBins: [EMPIRE_STATE_BIN, '1022334'],
      });

      await persistResolutionInput(prisma, {
        inputType: PropertyResolutionInputType.ADDRESS,
        normalizedInput: '350 5th Avenue',
        propertyId: property.id,
      });

      const reloaded = await identityService.findPropertyById(property.id);
      expect(reloaded?.identifierVersion).toBe(1);
      expect(identityService.getEcbCoverage(reloaded!)).toMatchObject({
        status: CoverageStatus.NOT_CHECKED,
        statusReason: CoverageStatusReason.NEVER_INGESTED,
      });
    });

    it('atomically increments identifier_version and invalidates coverage when the effective BIN set changes', async () => {
      const property = await identityService.findOrCreateProperty({
        bbl: EMPIRE_STATE_BBL,
        candidateBins: [EMPIRE_STATE_BIN],
      });

      const result = await identityService.applyEffectiveBinSet(property.id, [
        EMPIRE_STATE_BIN,
        '1022334',
      ]);

      expect(result.changed).toBe(true);
      expect(result.property.identifierVersion).toBe(2);

      const coverage = await prisma.propertyDatasetCoverage.findUnique({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      });

      expect(coverage).toMatchObject({
        status: CoverageStatus.NOT_CHECKED,
        statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
      });
    });
  });

  describe('bulk BBL registration', () => {
    it('deduplicates inputs, uses bounded source-call shape, and persists idempotently without GeoSearch', async () => {
      mockNonCondoBulkBatch(bulkClients, EMPIRE_STATE_BBL);

      const first = await bulkService.registerBbls([EMPIRE_STATE_BBL, EMPIRE_STATE_BBL]);
      const second = await bulkService.registerBbls([EMPIRE_STATE_BBL, EMPIRE_STATE_BBL]);

      expect(first.summary.succeeded).toBe(2);
      expect(second.summary.cached).toBe(2);
      expect(bulkClients.pluto.lookupByBbls).toHaveBeenCalledTimes(1);
      expect(bulkClients.geoSearch.searchByAddress).not.toHaveBeenCalled();

      const properties = await prisma.property.findMany();
      const inputs = await prisma.propertyResolutionInput.findMany();
      expect(properties).toHaveLength(1);
      expect(inputs).toHaveLength(1);
    });

    it('uses one bulk PLUTO lookup per uncached batch instead of per-property GeoSearch calls', async () => {
      const bbls = Array.from({ length: 12 }, (_, index) => makeBulkBbl(index + 1));

      bulkClients.pluto.lookupByBbls.mockImplementation(async (inputs: readonly string[]) => {
        const results = new Map<string, PlutoLookupResult>();
        for (const bbl of inputs) {
          results.set(bbl, {
            status: 'found',
            parcel: plutoParcel(bbl, `Address for ${bbl}`),
          });
        }
        return results;
      });
      bulkClients.buildingFootprints.lookupByParcelBbls.mockImplementation(
        async (inputs: readonly string[]) => {
          const results = new Map();
          for (const bbl of inputs) {
            results.set(bbl, {
              status: 'found',
              queriedBbl: bbl,
              lookupMode: 'parcel',
              candidates: [
                {
                  bin: EMPIRE_STATE_BIN,
                  baseBbl: bbl,
                  mapplutoBbl: bbl,
                },
              ],
            });
          }
          return results;
        },
      );
      bulkClients.condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
      bulkClients.condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
      bulkClients.buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());

      const response = await bulkService.registerBbls(bbls);

      expect(response.summary.unique).toBe(bbls.length);
      expect(bulkClients.pluto.lookupByBbls).toHaveBeenCalledTimes(1);
      expect(bulkClients.pluto.lookupByBbls).toHaveBeenCalledWith(bbls);
      expect(bulkClients.geoSearch.searchByAddress).not.toHaveBeenCalled();
    });
  });
});
