import {
  BuildingFootprintsClient,
  BUILDING_FOOTPRINTS_BULK_LOOKUP_CHUNK_SIZE,
  type BuildingFootprintsLookupResult,
} from '../../../src/clients/building-footprints.client';
import type { CondoUnitLookupResult } from '../../../src/clients/condo-units.client';
import type { CondominiumBillingLookupResult } from '../../../src/clients/condominiums.client';
import type { GeoSearchSearchResult } from '../../../src/clients/geosearch.client';
import {
  PLUTO_BULK_LOOKUP_CHUNK_SIZE,
  PlutoClient,
  type PlutoLookupResult,
  type PlutoParcelRecord,
} from '../../../src/clients/pluto.client';
import {
  BULK_SOURCE_QUERY_CHUNK_SIZE,
  BulkPropertyRegistrationService,
  createBulkPropertyRegistrationService,
} from '../../../src/services/property-resolver/bulk-property-registration.service';

function makeBbl(index: number): string {
  return `1${String(index).padStart(9, '0')}`;
}

function plutoParcel(bbl: string): PlutoParcelRecord {
  return {
    bbl,
    borough: Number.parseInt(bbl.slice(0, 1), 10),
    block: Number.parseInt(bbl.slice(1, 6), 10),
    lot: Number.parseInt(bbl.slice(6, 10), 10),
    address: `Address for ${bbl}`,
    bldgclass: 'O4',
  };
}

describe('BulkPropertyRegistrationService', () => {
  let service: BulkPropertyRegistrationService;
  let geoSearch: { searchByAddress: jest.Mock<Promise<GeoSearchSearchResult>, [string]> };
  let pluto: {
    lookupByBbl: jest.Mock<Promise<PlutoLookupResult>, [string]>;
    lookupByBbls: jest.Mock<Promise<Map<string, PlutoLookupResult>>, [readonly string[]]>;
  };
  let buildingFootprints: {
    lookupByParcelBbl: jest.Mock<Promise<BuildingFootprintsLookupResult>, [string]>;
    lookupByParcelBbls: jest.Mock<
      Promise<Map<string, BuildingFootprintsLookupResult>>,
      [readonly string[]]
    >;
    lookupByBaseBbl: jest.Mock<Promise<BuildingFootprintsLookupResult>, [string]>;
    lookupByBaseBbls: jest.Mock<
      Promise<Map<string, BuildingFootprintsLookupResult>>,
      [readonly string[]]
    >;
  };
  let condoUnits: {
    lookupByUnitBbl: jest.Mock<Promise<CondoUnitLookupResult>, [string]>;
    lookupByUnitBbls: jest.Mock<Promise<Map<string, CondoUnitLookupResult>>, [readonly string[]]>;
  };
  let condominiums: {
    lookupByCondoBaseBbl: jest.Mock<Promise<CondominiumBillingLookupResult>, [string]>;
    lookupByCondoBaseBbls: jest.Mock<
      Promise<Map<string, CondominiumBillingLookupResult>>,
      [readonly string[]]
    >;
  };
  let propertyIdentity: {
    findCachedBblRegistrations: jest.Mock;
    findOrCreateProperty: jest.Mock;
    applyEffectiveBinSet: jest.Mock;
  };
  let prisma: { propertyResolutionInput: { upsert: jest.Mock } };

  beforeEach(() => {
    geoSearch = {
      searchByAddress: jest.fn(),
    };
    pluto = {
      lookupByBbl: jest.fn(),
      lookupByBbls: jest.fn(),
    };
    buildingFootprints = {
      lookupByParcelBbl: jest.fn(),
      lookupByParcelBbls: jest.fn(),
      lookupByBaseBbl: jest.fn(),
      lookupByBaseBbls: jest.fn(),
    };
    condoUnits = {
      lookupByUnitBbl: jest.fn(),
      lookupByUnitBbls: jest.fn(),
    };
    condominiums = {
      lookupByCondoBaseBbl: jest.fn(),
      lookupByCondoBaseBbls: jest.fn(),
    };
    propertyIdentity = {
      findCachedBblRegistrations: jest.fn(async () => new Map()),
      findOrCreateProperty: jest.fn(async (input: { bbl: string; candidateBins: string[] }) => ({
        id: `property-${input.bbl}`,
        bbl: input.bbl,
        borough: 1,
        block: 1,
        lot: 1,
        normalizedAddress: `Address for ${input.bbl}`,
        condoBaseBbl: null,
        condoBillingBbl: null,
        identifierVersion: 1,
        createdAt: new Date(),
        resolvedAt: new Date(),
        bins: input.candidateBins.map((bin) => ({ propertyId: `property-${input.bbl}`, bin })),
        datasetCoverage: [
          {
            propertyId: `property-${input.bbl}`,
            dataset: 'DOB_ECB_VIOLATIONS',
            status: input.candidateBins.length > 0 ? 'NOT_CHECKED' : 'NOT_CHECKED',
            statusReason: input.candidateBins.length > 0 ? 'NEVER_INGESTED' : 'NO_VALID_BIN',
            lastAttemptRunId: null,
            lastSuccessRunId: null,
            lastAttemptAt: null,
            lastSuccessAt: null,
            sourceWatermarkAt: null,
            lastError: null,
          },
        ],
      })),
      applyEffectiveBinSet: jest.fn(async (_propertyId: string, candidateBins: string[]) => ({
        changed: true,
        property: {
          id: 'property-id',
          bbl: '1008350041',
          borough: 1,
          block: 835,
          lot: 41,
          normalizedAddress: '350 5th Avenue',
          condoBaseBbl: null,
          condoBillingBbl: null,
          identifierVersion: 1,
          createdAt: new Date(),
          resolvedAt: new Date(),
          bins: candidateBins.map((bin) => ({ propertyId: 'property-id', bin })),
          datasetCoverage: [],
        },
      })),
    };
    prisma = {
      propertyResolutionInput: {
        upsert: jest.fn(async () => ({ id: 'input-id' })),
      },
    };

    service = createBulkPropertyRegistrationService({
      prisma: prisma as never,
      clients: {
        geoSearch: geoSearch as never,
        pluto: pluto as never,
        buildingFootprints: buildingFootprints as never,
        condoUnits: condoUnits as never,
        condominiums: condominiums as never,
      },
      propertyIdentity: propertyIdentity as never,
    });
  });

  function mockChunkedPlutoLookup(_bbls: readonly string[]) {
    pluto.lookupByBbls.mockImplementation(async (inputs: readonly string[]) => {
      const results = new Map<string, PlutoLookupResult>();
      for (const bbl of inputs) {
        results.set(bbl, {
          status: 'found',
          parcel: plutoParcel(bbl),
        });
      }
      return results;
    });
  }

  function mockChunkedParcelFootprints(_bbls: readonly string[]) {
    buildingFootprints.lookupByParcelBbls.mockImplementation(async (inputs: readonly string[]) => {
      const results = new Map<string, BuildingFootprintsLookupResult>();
      for (const bbl of inputs) {
        results.set(bbl, {
          status: 'found',
          queriedBbl: bbl,
          lookupMode: 'parcel',
          candidates: [
            {
              bin: '1012345',
              baseBbl: bbl,
              mapplutoBbl: bbl,
            },
          ],
        });
      }
      return results;
    });
  }

  it('uses bounded PLUTO and footprint chunk calls instead of one request per BBL', async () => {
    const bblCount = PLUTO_BULK_LOOKUP_CHUNK_SIZE + 1;
    const bbls = Array.from({ length: bblCount }, (_, index) => makeBbl(index + 1));
    const plutoFetch = jest.fn(async (url: string) => {
      const parsedUrl = new URL(url);
      const whereClause = parsedUrl.searchParams.get('$where') ?? '';
      const chunkBbls = [...whereClause.matchAll(/'(\d{10})'/g)].map((match) => match[1]);

      return {
        ok: true,
        status: 200,
        json: async () =>
          chunkBbls.map((bbl) => ({
            borocode: '1',
            block: bbl.slice(1, 6),
            lot: bbl.slice(6, 10),
            address: `Address for ${bbl}`,
            bldgclass: 'O4',
            bbl: `${bbl}.00000000`,
          })),
      };
    });
    const footprintFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));

    const chunkedService = createBulkPropertyRegistrationService({
      prisma: prisma as never,
      clients: {
        geoSearch: geoSearch as never,
        pluto: new PlutoClient({ fetchImpl: plutoFetch as unknown as typeof fetch }),
        buildingFootprints: new BuildingFootprintsClient({
          fetchImpl: footprintFetch as unknown as typeof fetch,
        }),
        condoUnits: condoUnits as never,
        condominiums: condominiums as never,
      },
      propertyIdentity: propertyIdentity as never,
    });

    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());

    const response = await chunkedService.registerBbls(bbls);

    expect(response.summary.submitted).toBe(bblCount);
    expect(response.summary.unique).toBe(bblCount);
    expect(response.summary.succeeded).toBe(bblCount);
    expect(plutoFetch).toHaveBeenCalledTimes(2);
    expect(footprintFetch).toHaveBeenCalledTimes(2);
    expect(geoSearch.searchByAddress).not.toHaveBeenCalled();
    expect(pluto.lookupByBbl).not.toHaveBeenCalled();
    expect(buildingFootprints.lookupByParcelBbl).not.toHaveBeenCalled();
  });

  it('deduplicates canonical BBLs before external source access', async () => {
    const bbl = '1008350041';

    mockChunkedPlutoLookup([bbl]);
    mockChunkedParcelFootprints([bbl]);
    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());

    const response = await service.registerBbls([bbl, bbl, ` ${bbl} `]);

    expect(response.summary.submitted).toBe(3);
    expect(response.summary.unique).toBe(1);
    expect(response.summary.succeeded).toBe(3);
    expect(pluto.lookupByBbls).toHaveBeenCalledWith(['1008350041']);
    expect(response.results.every((result) => result.status === 'succeeded')).toBe(true);
  });

  it('returns cached status for previously registered BBL inputs without source calls', async () => {
    const bbl = '1008350041';
    const cachedProperty = {
      id: 'cached-property',
      bbl,
      borough: 1,
      block: 835,
      lot: 41,
      normalizedAddress: '350 5th Avenue',
      condoBaseBbl: null,
      condoBillingBbl: null,
      identifierVersion: 1,
      createdAt: new Date(),
      resolvedAt: new Date(),
      bins: [{ propertyId: 'cached-property', bin: '1012345' }],
      datasetCoverage: [],
    };

    propertyIdentity.findCachedBblRegistrations.mockResolvedValue(
      new Map([[bbl, cachedProperty]]),
    );

    const response = await service.registerBbls([bbl]);

    expect(response.summary.cached).toBe(1);
    expect(response.results[0]).toMatchObject({
      inputBbl: bbl,
      status: 'cached',
      property: {
        id: 'cached-property',
        bbl,
      },
    });
    expect(pluto.lookupByBbls).not.toHaveBeenCalled();
    expect(buildingFootprints.lookupByParcelBbls).not.toHaveBeenCalled();
  });

  it('reports per-input validation failures without calling external sources', async () => {
    mockChunkedPlutoLookup(['1008350041']);
    mockChunkedParcelFootprints(['1008350041']);
    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());

    const response = await service.registerBbls(['not-a-bbl', '1008350041']);

    expect(response.summary.failed).toBe(1);
    expect(response.summary.succeeded).toBe(1);
    expect(response.results[0]).toMatchObject({
      inputBbl: 'not-a-bbl',
      status: 'failed',
      error: {
        code: 'INVALID_BBL',
      },
    });
    expect(pluto.lookupByBbls).toHaveBeenCalledWith(['1008350041']);
    expect(geoSearch.searchByAddress).not.toHaveBeenCalled();
  });

  it('surfaces incomplete PLUTO rows distinctly from absent parcels', async () => {
    const foundBbl = '1008350041';
    const incompleteBbl = '1008350042';

    pluto.lookupByBbls.mockResolvedValue(
      new Map([
        [foundBbl, { status: 'found', parcel: plutoParcel(foundBbl) }],
        [incompleteBbl, { status: 'incomplete', reasons: ['missing_address'] }],
      ]),
    );
    buildingFootprints.lookupByParcelBbls.mockImplementation(async (inputs: readonly string[]) => {
      const results = new Map<string, BuildingFootprintsLookupResult>();
      for (const bbl of inputs) {
        results.set(bbl, {
          status: 'found',
          queriedBbl: bbl,
          lookupMode: 'parcel',
          candidates: [
            {
              bin: '1012345',
              baseBbl: bbl,
              mapplutoBbl: bbl,
            },
          ],
        });
      }
      return results;
    });
    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());

    const response = await service.registerBbls([foundBbl, incompleteBbl]);

    expect(response.summary.succeeded).toBe(1);
    expect(response.summary.failed).toBe(1);
    expect(response.results.find((result) => result.inputBbl === incompleteBbl)).toMatchObject({
      status: 'failed',
      error: {
        code: 'RESOLVER_PLUTO_INCOMPLETE',
        message: expect.stringContaining('missing_address'),
      },
    });
    expect(propertyIdentity.findOrCreateProperty).toHaveBeenCalledTimes(1);
  });

  it('surfaces partial source resolution failures per input', async () => {
    const foundBbl = '1008350041';
    const missingBbl = '1008350042';

    pluto.lookupByBbls.mockResolvedValue(
      new Map([
        [foundBbl, { status: 'found', parcel: plutoParcel(foundBbl) }],
        [missingBbl, { status: 'not_found' }],
      ]),
    );
    buildingFootprints.lookupByParcelBbls.mockImplementation(async (inputs: readonly string[]) => {
      const results = new Map<string, BuildingFootprintsLookupResult>();
      for (const bbl of inputs) {
        results.set(bbl, {
          status: 'found',
          queriedBbl: bbl,
          lookupMode: 'parcel',
          candidates: [
            {
              bin: '1012345',
              baseBbl: bbl,
              mapplutoBbl: bbl,
            },
          ],
        });
      }
      return results;
    });
    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());

    const response = await service.registerBbls([foundBbl, missingBbl]);

    expect(response.summary.succeeded).toBe(1);
    expect(response.summary.failed).toBe(1);
    expect(response.results.find((result) => result.inputBbl === missingBbl)).toMatchObject({
      status: 'failed',
      error: {
        code: 'RESOLVER_PLUTO_NOT_FOUND',
      },
    });
  });

  it('persists NO_VALID_BIN coverage when footprints are absent without treating it as identifier conflict', async () => {
    const bbl = '1008350041';

    pluto.lookupByBbls.mockResolvedValue(
      new Map([[bbl, { status: 'found', parcel: plutoParcel(bbl) }]]),
    );
    buildingFootprints.lookupByParcelBbls.mockResolvedValue(
      new Map([
        [
          bbl,
          {
            status: 'not_found',
            queriedBbl: bbl,
            lookupMode: 'parcel',
            candidates: [],
          },
        ],
      ]),
    );
    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());

    const response = await service.registerBbls([bbl]);

    expect(response.summary.succeeded).toBe(1);
    expect(propertyIdentity.findOrCreateProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        bbl,
        candidateBins: [],
      }),
    );
    expect(propertyIdentity.applyEffectiveBinSet).not.toHaveBeenCalled();
  });

  it('fails explicitly on footprint identifier contradiction without silently treating it as no BIN', async () => {
    const bbl = '1008350041';

    pluto.lookupByBbls.mockResolvedValue(
      new Map([[bbl, { status: 'found', parcel: plutoParcel(bbl) }]]),
    );
    buildingFootprints.lookupByParcelBbls.mockResolvedValue(
      new Map([
        [
          bbl,
          {
            status: 'found',
            queriedBbl: bbl,
            lookupMode: 'parcel',
            candidates: [
              {
                bin: '1012345',
                baseBbl: bbl,
                mapplutoBbl: '1008350042',
              },
            ],
          },
        ],
      ]),
    );
    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());

    const response = await service.registerBbls([bbl]);

    expect(response.summary.failed).toBe(1);
    expect(response.results[0]).toMatchObject({
      status: 'failed',
      error: {
        code: 'RESOLVER_FOOTPRINT_MAPPLUTO_BBL_MISMATCH',
      },
    });
    expect(propertyIdentity.findOrCreateProperty).not.toHaveBeenCalled();
  });

  it('exposes the configured bulk chunk size for bounded-query tests', () => {
    expect(BULK_SOURCE_QUERY_CHUNK_SIZE).toBe(PLUTO_BULK_LOOKUP_CHUNK_SIZE);
    expect(BULK_SOURCE_QUERY_CHUNK_SIZE).toBe(BUILDING_FOOTPRINTS_BULK_LOOKUP_CHUNK_SIZE);
  });
});
