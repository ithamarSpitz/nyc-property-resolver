import {
  CoverageStatus,
  CoverageStatusReason,
  PrismaClient,
  PropertyResolutionInputType,
} from '@prisma/client';

import type { BuildingFootprintsLookupResult } from '../../../src/clients/building-footprints.client';
import type { CondoUnitLookupResult } from '../../../src/clients/condo-units.client';
import type { CondominiumBillingLookupResult } from '../../../src/clients/condominiums.client';
import type { GeoSearchSearchResult } from '../../../src/clients/geosearch.client';
import type { PlutoLookupResult } from '../../../src/clients/pluto.client';
import { AppError } from '../../../src/errors';
import {
  PropertyResolverService,
  createPropertyResolverService,
} from '../../../src/services/property-resolver/property-resolver.service';

const EMPIRE_STATE_BBL = '1008350041';
const EMPIRE_STATE_BIN = '1012345';
const CONDO_BASE_BBL = '1010060001';
const CONDO_BILLING_BBL = '1010067501';
const CONDO_UNIT_BBL = '1012345678';

function plutoParcel(
  bbl: string,
  address: string,
  overrides: Partial<{ borough: number; block: number; lot: number }> = {},
) {
  return {
    bbl,
    borough: overrides.borough ?? Number.parseInt(bbl.slice(0, 1), 10),
    block: overrides.block ?? Number.parseInt(bbl.slice(1, 6), 10),
    lot: overrides.lot ?? Number.parseInt(bbl.slice(6, 10), 10),
    address,
    bldgclass: 'O4',
  };
}

function geoSearchResult(
  normalizedBaseAddress: string,
  options: {
    bbl?: string;
    bin?: string;
    label?: string;
  },
): GeoSearchSearchResult {
  return {
    queriedAddress: normalizedBaseAddress,
    candidates: [
      {
        label: options.label ?? `${normalizedBaseAddress}, Manhattan, New York, NY, USA`,
        layer: 'address',
        confidence: 0.95,
        bbl: options.bbl,
        bin: options.bin,
        sourceId: 'feature-1',
      },
    ],
  };
}

describe('PropertyResolverService integration', () => {
  let prisma: PrismaClient;
  let resolver: PropertyResolverService;
  let geoSearch: { searchByAddress: jest.Mock<Promise<GeoSearchSearchResult>, [string]> };
  let pluto: { lookupByBbl: jest.Mock<Promise<PlutoLookupResult>, [string]> };
  let buildingFootprints: {
    lookupByParcelBbl: jest.Mock<Promise<BuildingFootprintsLookupResult>, [string]>;
    lookupByBaseBbl: jest.Mock<Promise<BuildingFootprintsLookupResult>, [string]>;
  };
  let condoUnits: {
    lookupByUnitBbl: jest.Mock<Promise<CondoUnitLookupResult>, [string]>;
    lookupByCondoBaseAndUnitDesignation: jest.Mock<
      Promise<CondoUnitLookupResult>,
      [string, string]
    >;
  };
  let condominiums: {
    lookupByCondoBaseBbl: jest.Mock<Promise<CondominiumBillingLookupResult>, [string]>;
  };

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

    geoSearch = {
      searchByAddress: jest.fn(),
    };
    pluto = {
      lookupByBbl: jest.fn(),
    };
    buildingFootprints = {
      lookupByParcelBbl: jest.fn(),
      lookupByBaseBbl: jest.fn(),
    };
    condoUnits = {
      lookupByUnitBbl: jest.fn(),
      lookupByCondoBaseAndUnitDesignation: jest.fn(),
    };
    condominiums = {
      lookupByCondoBaseBbl: jest.fn(),
    };

    resolver = createPropertyResolverService({
      prisma,
      clients: {
        geoSearch: geoSearch as never,
        pluto: pluto as never,
        buildingFootprints: buildingFootprints as never,
        condoUnits: condoUnits as never,
        condominiums: condominiums as never,
      },
    });
  });

  function mockStandardNonCondoResolution(options?: {
    bbl?: string;
    bin?: string;
    footprintBin?: string;
    mapplutoBbl?: string | null;
    includeMapplutoField?: boolean;
    baseBbl?: string;
    extraBins?: string[];
  }) {
    const bbl = options?.bbl ?? EMPIRE_STATE_BBL;
    const bin = options?.bin ?? EMPIRE_STATE_BIN;
    const footprintBin = options?.footprintBin ?? EMPIRE_STATE_BIN;
    const baseBbl = options?.baseBbl ?? bbl;
    const includeMapplutoField = options?.includeMapplutoField ?? true;
    const mapplutoBbl = options?.mapplutoBbl ?? bbl;

    geoSearch.searchByAddress.mockResolvedValue(
      geoSearchResult('350 5th Avenue', { bbl, bin, label: '350 5th Avenue, Manhattan' }),
    );
    pluto.lookupByBbl.mockResolvedValue({
      status: 'found',
      parcel: plutoParcel(bbl, '350 5th Avenue'),
    });
    buildingFootprints.lookupByParcelBbl.mockResolvedValue({
      status: 'found',
      queriedBbl: bbl,
      lookupMode: 'parcel',
      candidates: [
        {
          bin: footprintBin,
          baseBbl,
          ...(includeMapplutoField ? { mapplutoBbl } : {}),
        },
        ...(options?.extraBins ?? []).map((extraBin) => ({
          bin: extraBin,
          baseBbl,
          ...(includeMapplutoField ? { mapplutoBbl } : {}),
        })),
      ],
    });
  }

  it('returns the stored property without a second external resolution for the same normalized address', async () => {
    mockStandardNonCondoResolution();

    const first = await resolver.resolveAddress('350 5th Avenue');
    const second = await resolver.resolveAddress('350   5th avenue');

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.property.id).toBe(first.property.id);
    expect(geoSearch.searchByAddress).toHaveBeenCalledTimes(1);
    expect(pluto.lookupByBbl).toHaveBeenCalledTimes(1);
    expect(buildingFootprints.lookupByParcelBbl).toHaveBeenCalledTimes(1);
  });

  it('resolves a direct BBL without invoking GeoSearch', async () => {
    pluto.lookupByBbl.mockResolvedValue({
      status: 'found',
      parcel: plutoParcel(EMPIRE_STATE_BBL, '350 5th Avenue'),
    });
    buildingFootprints.lookupByParcelBbl.mockResolvedValue({
      status: 'found',
      queriedBbl: EMPIRE_STATE_BBL,
      lookupMode: 'parcel',
      candidates: [
        {
          bin: EMPIRE_STATE_BIN,
          baseBbl: EMPIRE_STATE_BBL,
          mapplutoBbl: EMPIRE_STATE_BBL,
        },
      ],
    });

    const result = await resolver.resolveBbl(EMPIRE_STATE_BBL);

    expect(result.cached).toBe(false);
    expect(result.property.bbl).toBe(EMPIRE_STATE_BBL);
    expect(result.property.bins.map((row) => row.bin)).toEqual([EMPIRE_STATE_BIN]);
    expect(geoSearch.searchByAddress).not.toHaveBeenCalled();
  });

  it('persists all valid non-condo BINs when PLUTO and footprint identifiers agree', async () => {
    mockStandardNonCondoResolution({ extraBins: ['1022334'] });

    const result = await resolver.resolveAddress('350 5th Avenue');

    expect(result.property.bins.map((row) => row.bin)).toEqual(['1012345', '1022334']);
    expect(result.property.identifierVersion).toBe(1);
  });

  it('fails explicitly when MAPPLUTO_BBL mismatches the canonical PLUTO BBL', async () => {
    mockStandardNonCondoResolution({ mapplutoBbl: '1008350042' });

    await expect(resolver.resolveAddress('350 5th Avenue')).rejects.toMatchObject({
      code: 'RESOLVER_FOOTPRINT_MAPPLUTO_BBL_MISMATCH',
    });
  });

  it('fails explicitly when MAPPLUTO evidence is absent and BASE_BBL mismatches', async () => {
    mockStandardNonCondoResolution({
      includeMapplutoField: false,
      baseBbl: '1008350042',
    });

    await expect(resolver.resolveAddress('350 5th Avenue')).rejects.toMatchObject({
      code: 'RESOLVER_FOOTPRINT_BASE_BBL_MISMATCH',
    });
  });

  it('fails explicitly when GeoSearch BIN contradicts validated footprint evidence', async () => {
    mockStandardNonCondoResolution({ bin: '1099999' });

    await expect(resolver.resolveAddress('350 5th Avenue')).rejects.toMatchObject({
      code: 'RESOLVER_GEOSEARCH_BIN_CONFLICT',
    });
  });

  it('resolves a condo unit BBL through unit/base/billing context and persists building BINs', async () => {
    condoUnits.lookupByUnitBbl.mockResolvedValue({
      matchCount: 'one',
      matches: [
        {
          unitBbl: CONDO_UNIT_BBL,
          condoBaseBbl: CONDO_BASE_BBL,
          unitDesignation: '12C',
        },
      ],
    });
    condominiums.lookupByCondoBaseBbl.mockResolvedValue({
      matchCount: 'one',
      matches: [
        {
          condoBaseBbl: CONDO_BASE_BBL,
          condoBillingBbl: CONDO_BILLING_BBL,
        },
      ],
    });
    pluto.lookupByBbl.mockResolvedValue({
      status: 'found',
      parcel: plutoParcel(CONDO_UNIT_BBL, '419 E 84 St Apt 12C', { lot: 5678 }),
    });
    buildingFootprints.lookupByBaseBbl.mockResolvedValue({
      status: 'found',
      queriedBbl: CONDO_BASE_BBL,
      lookupMode: 'base',
      candidates: [
        {
          bin: '1045678',
          baseBbl: CONDO_BASE_BBL,
          mapplutoBbl: CONDO_BILLING_BBL,
        },
      ],
    });

    const result = await resolver.resolveBbl(CONDO_UNIT_BBL);

    expect(result.property).toMatchObject({
      bbl: CONDO_UNIT_BBL,
      condoBaseBbl: CONDO_BASE_BBL,
      condoBillingBbl: CONDO_BILLING_BBL,
    });
    expect(result.property.bins.map((row) => row.bin)).toEqual(['1045678']);
    expect(geoSearch.searchByAddress).not.toHaveBeenCalled();
  });

  it('resolves a unit-aware address when exactly one condo unit matches', async () => {
    geoSearch.searchByAddress.mockResolvedValue(
      geoSearchResult('419 E 84 St', {
        bbl: CONDO_BILLING_BBL,
        bin: '1045678',
        label: '419 E 84 St, Manhattan',
      }),
    );
    condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValue({
      matchCount: 'one',
      matches: [
        {
          unitBbl: CONDO_UNIT_BBL,
          condoBaseBbl: CONDO_BASE_BBL,
          unitDesignation: '12C',
        },
      ],
    });
    condoUnits.lookupByUnitBbl.mockResolvedValue({
      matchCount: 'one',
      matches: [
        {
          unitBbl: CONDO_UNIT_BBL,
          condoBaseBbl: CONDO_BASE_BBL,
          unitDesignation: '12C',
        },
      ],
    });
    condominiums.lookupByCondoBaseBbl.mockResolvedValue({
      matchCount: 'one',
      matches: [
        {
          condoBaseBbl: CONDO_BASE_BBL,
          condoBillingBbl: CONDO_BILLING_BBL,
        },
      ],
    });
    pluto.lookupByBbl.mockResolvedValue({
      status: 'found',
      parcel: plutoParcel(CONDO_UNIT_BBL, '419 E 84 St Apt 12C', { lot: 5678 }),
    });
    buildingFootprints.lookupByBaseBbl.mockResolvedValue({
      status: 'found',
      queriedBbl: CONDO_BASE_BBL,
      lookupMode: 'base',
      candidates: [
        {
          bin: '1045678',
          baseBbl: CONDO_BASE_BBL,
          mapplutoBbl: CONDO_BILLING_BBL,
        },
      ],
    });

    const result = await resolver.resolveAddress('419 E 84 St Apt 12C');

    expect(result.property.bbl).toBe(CONDO_UNIT_BBL);
    expect(condoUnits.lookupByCondoBaseAndUnitDesignation).toHaveBeenCalledWith(
      CONDO_BASE_BBL,
      '12C',
    );
  });

  it('fails explicitly when a unit-aware address has zero matching condo units', async () => {
    geoSearch.searchByAddress.mockResolvedValue(
      geoSearchResult('419 E 84 St', {
        bbl: CONDO_BILLING_BBL,
        label: '419 E 84 St, Manhattan',
      }),
    );
    condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValue({
      matchCount: 'zero',
      matches: [],
    });

    await expect(resolver.resolveAddress('419 E 84 St Apt 99Z')).rejects.toMatchObject({
      code: 'RESOLVER_CONDO_UNIT_NOT_FOUND',
    });
  });

  it('fails explicitly when a unit-aware address matches multiple condo units', async () => {
    geoSearch.searchByAddress.mockResolvedValue(
      geoSearchResult('419 E 84 St', {
        bbl: CONDO_BILLING_BBL,
        label: '419 E 84 St, Manhattan',
      }),
    );
    condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValue({
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

  it('keeps two different units in the same building as distinct normalized resolution inputs', async () => {
    const setupUnit = (unitDesignation: string, unitBbl: string) => {
      geoSearch.searchByAddress.mockResolvedValueOnce(
        geoSearchResult('419 E 84 St', {
          bbl: CONDO_BILLING_BBL,
          bin: '1045678',
          label: '419 E 84 St, Manhattan',
        }),
      );
      condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValueOnce({
        matchCount: 'one',
        matches: [
          {
            unitBbl,
            condoBaseBbl: CONDO_BASE_BBL,
            unitDesignation,
          },
        ],
      });
      condoUnits.lookupByUnitBbl.mockResolvedValueOnce({
        matchCount: 'one',
        matches: [
          {
            unitBbl,
            condoBaseBbl: CONDO_BASE_BBL,
            unitDesignation,
          },
        ],
      });
      condominiums.lookupByCondoBaseBbl.mockResolvedValueOnce({
        matchCount: 'one',
        matches: [
          {
            condoBaseBbl: CONDO_BASE_BBL,
            condoBillingBbl: CONDO_BILLING_BBL,
          },
        ],
      });
      pluto.lookupByBbl.mockResolvedValueOnce({
        status: 'found',
        parcel: plutoParcel(unitBbl, `419 E 84 St Apt ${unitDesignation}`, {
          lot: Number.parseInt(unitBbl.slice(6, 10), 10),
        }),
      });
      buildingFootprints.lookupByBaseBbl.mockResolvedValueOnce({
        status: 'found',
        queriedBbl: CONDO_BASE_BBL,
        lookupMode: 'base',
        candidates: [
          {
            bin: '1045678',
            baseBbl: CONDO_BASE_BBL,
            mapplutoBbl: CONDO_BILLING_BBL,
          },
        ],
      });
    };

    setupUnit('12C', CONDO_UNIT_BBL);
    setupUnit('12D', '1012345679');

    const unit12C = await resolver.resolveAddress('419 E 84 St Apt 12C');
    const unit12D = await resolver.resolveAddress('419 E 84 St Apt 12D');

    expect(unit12C.property.id).not.toBe(unit12D.property.id);
    expect(unit12C.property.bbl).toBe(CONDO_UNIT_BBL);
    expect(unit12D.property.bbl).toBe('1012345679');

    const mappings = await prisma.propertyResolutionInput.findMany({
      where: { inputType: PropertyResolutionInputType.ADDRESS },
      orderBy: { normalizedInput: 'asc' },
    });

    expect(mappings).toHaveLength(2);
    expect(mappings.map((row) => row.normalizedInput)).toEqual([
      '419 E 84 St Apt 12C',
      '419 E 84 St Apt 12D',
    ]);
  });

  it('persists NOT_CHECKED / NO_VALID_BIN coverage when only placeholder BINs are discovered', async () => {
    pluto.lookupByBbl.mockResolvedValue({
      status: 'found',
      parcel: plutoParcel('1000750001', 'Vacant Lot'),
    });
    buildingFootprints.lookupByParcelBbl.mockResolvedValue({
      status: 'found',
      queriedBbl: '1000750001',
      lookupMode: 'parcel',
      candidates: [
        {
          bin: '3000000',
          baseBbl: '1000750001',
          mapplutoBbl: '1000750001',
        },
      ],
    });

    const result = await resolver.resolveBbl('1000750001');

    expect(result.property.bins).toHaveLength(0);
    expect(result.property.datasetCoverage[0]).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NO_VALID_BIN,
    });
  });

  it('uses mocked client dependencies rather than hidden global state', () => {
    expect(geoSearch.searchByAddress).toBeDefined();
    expect(pluto.lookupByBbl).toBeDefined();
    expect(buildingFootprints.lookupByParcelBbl).toBeDefined();
    expect(condoUnits.lookupByUnitBbl).toBeDefined();
    expect(condominiums.lookupByCondoBaseBbl).toBeDefined();
  });

  it('resolves the uniquely supported parcel from a multi-BBL GeoSearch response', async () => {
    mockStandardNonCondoResolution();
    geoSearch.searchByAddress.mockResolvedValue({
      queriedAddress: '350 5th Avenue, Manhattan, NY',
      candidates: [
        {
          label: '350 5 AVENUE, New York, NY, USA',
          name: '350 5 AVENUE',
          layer: 'venue',
          confidence: 0.8,
          bbl: EMPIRE_STATE_BBL,
          bin: EMPIRE_STATE_BIN,
          borough: 'Manhattan',
          sourceId: 'feature-1',
        },
        {
          label: '350 5 AVENUE, Brooklyn, NY, USA',
          name: '350 5 AVENUE',
          layer: 'venue',
          confidence: 0.8,
          bbl: '3009810111',
          bin: '3021057',
          borough: 'Brooklyn',
          sourceId: 'feature-2',
        },
        {
          label: '43 5 AVENUE, New York, NY, USA',
          name: '43 5 AVENUE',
          layer: 'venue',
          confidence: 0.8,
          bbl: '1005690001',
          bin: '1009272',
          borough: 'Manhattan',
          sourceId: 'feature-3',
        },
      ],
    });

    const result = await resolver.resolveAddress('350 5th Avenue, Manhattan, NY');

    expect(result.property.bbl).toBe(EMPIRE_STATE_BBL);
    expect(pluto.lookupByBbl).toHaveBeenCalledWith(EMPIRE_STATE_BBL);
    expect(buildingFootprints.lookupByParcelBbl).toHaveBeenCalledWith(EMPIRE_STATE_BBL);
  });

  it('uses the explicit locality borough instead of a borough name in the street', async () => {
    const brooklynBbl = '3012340056';
    const brooklynBin = '3012345';
    mockStandardNonCondoResolution({
      bbl: brooklynBbl,
      bin: brooklynBin,
      footprintBin: brooklynBin,
    });
    geoSearch.searchByAddress.mockResolvedValue({
      queriedAddress: '100 Manhattan Avenue, Brooklyn, NY',
      candidates: [
        {
          label: '100 MANHATTAN AVENUE, New York, NY, USA',
          name: '100 MANHATTAN AVENUE',
          layer: 'address',
          confidence: 0.99,
          bbl: EMPIRE_STATE_BBL,
          bin: EMPIRE_STATE_BIN,
          borough: 'Manhattan',
          sourceId: 'feature-1',
        },
        {
          label: '100 MANHATTAN AVENUE, Brooklyn, NY, USA',
          name: '100 MANHATTAN AVENUE',
          layer: 'address',
          confidence: 0.9,
          bbl: brooklynBbl,
          bin: brooklynBin,
          borough: 'Brooklyn',
          sourceId: 'feature-2',
        },
      ],
    });

    const result = await resolver.resolveAddress('100 Manhattan Avenue, Brooklyn, NY');

    expect(result.property.bbl).toBe(brooklynBbl);
    expect(pluto.lookupByBbl).toHaveBeenCalledWith(brooklynBbl);
  });

  it('rejects candidates that contradict an explicit locality borough', async () => {
    geoSearch.searchByAddress.mockResolvedValue({
      queriedAddress: '100 Manhattan Avenue, Brooklyn, NY',
      candidates: [
        {
          label: '100 MANHATTAN AVENUE, New York, NY, USA',
          name: '100 MANHATTAN AVENUE',
          layer: 'address',
          confidence: 0.99,
          bbl: EMPIRE_STATE_BBL,
          bin: EMPIRE_STATE_BIN,
          borough: 'Manhattan',
          sourceId: 'feature-1',
        },
      ],
    });

    await expect(
      resolver.resolveAddress('100 Manhattan Avenue, Brooklyn, NY'),
    ).rejects.toMatchObject({
      code: 'RESOLVER_GEOSEARCH_AMBIGUOUS',
    });
    expect(pluto.lookupByBbl).not.toHaveBeenCalled();
  });

  it('surfaces GeoSearch ambiguity explicitly instead of guessing', async () => {
    geoSearch.searchByAddress.mockResolvedValue({
      queriedAddress: '120 Broadway',
      candidates: [
        {
          label: '120 Broadway, Manhattan',
          layer: 'address',
          confidence: 0.95,
          bbl: '1000477501',
          sourceId: 'feature-1',
        },
        {
          label: '120 Broadway, Brooklyn',
          layer: 'address',
          confidence: 0.94,
          bbl: '3000477501',
          sourceId: 'feature-2',
        },
      ],
    });

    await expect(resolver.resolveAddress('120 Broadway')).rejects.toBeInstanceOf(AppError);
    await expect(resolver.resolveAddress('120 Broadway')).rejects.toMatchObject({
      code: 'RESOLVER_GEOSEARCH_AMBIGUOUS',
    });
  });
});
