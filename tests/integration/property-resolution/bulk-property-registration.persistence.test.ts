import {
  CoverageStatus,
  CoverageStatusReason,
  PrismaClient,
  PropertyResolutionInputType,
} from '@prisma/client';

import type { BuildingFootprintsLookupResult } from '../../../src/clients/building-footprints.client';
import type { CondoUnitLookupResult } from '../../../src/clients/condo-units.client';
import type { CondominiumBillingLookupResult } from '../../../src/clients/condominiums.client';
import type { PlutoLookupResult } from '../../../src/clients/pluto.client';
import {
  BulkPropertyRegistrationService,
  createBulkPropertyRegistrationService,
} from '../../../src/services/property-resolver/bulk-property-registration.service';

const EMPIRE_STATE_BBL = '1008350041';
const EMPIRE_STATE_BIN = '1012345';
const ZERO_BIN_BBL = '1000750001';
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

describe('bulk property registration persistence', () => {
  let prisma: PrismaClient;
  let service: BulkPropertyRegistrationService;
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

    service = createBulkPropertyRegistrationService({
      prisma,
      clients: {
        pluto: pluto as never,
        buildingFootprints: buildingFootprints as never,
        condoUnits: condoUnits as never,
        condominiums: condominiums as never,
      },
    });
  });

  function mockNonCondoBatch(
    bbl: string,
    options: {
      bins?: string[];
      placeholderOnly?: boolean;
    } = {},
  ) {
    const bins = options.placeholderOnly ? [] : (options.bins ?? [EMPIRE_STATE_BIN]);
    const candidates = bins.map((bin) => ({
      bin,
      baseBbl: bbl,
      mapplutoBbl: bbl,
    }));

    if (options.placeholderOnly) {
      candidates.push({
        bin: '3000000',
        baseBbl: bbl,
        mapplutoBbl: bbl,
      });
    }

    pluto.lookupByBbls.mockImplementation(async (inputs: readonly string[]) => {
      const results = new Map<string, PlutoLookupResult>();
      for (const input of inputs) {
        results.set(input, {
          status: 'found',
          parcel: plutoParcel(input, `Address for ${input}`),
        });
      }
      return results;
    });

    buildingFootprints.lookupByParcelBbls.mockImplementation(async (inputs: readonly string[]) => {
      const results = new Map<string, BuildingFootprintsLookupResult>();
      for (const input of inputs) {
        results.set(input, {
          status: 'found',
          queriedBbl: input,
          lookupMode: 'parcel',
          candidates: input === bbl ? candidates : [],
        });
      }
      return results;
    });

    condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());
  }

  it('persists properties idempotently when the same batch is replayed', async () => {
    mockNonCondoBatch(EMPIRE_STATE_BBL);

    const first = await service.registerBbls([EMPIRE_STATE_BBL, EMPIRE_STATE_BBL]);
    const second = await service.registerBbls([EMPIRE_STATE_BBL, EMPIRE_STATE_BBL]);

    expect(first.summary.succeeded).toBe(2);
    expect(second.summary.cached).toBe(2);
    expect(pluto.lookupByBbls).toHaveBeenCalledTimes(1);

    const properties = await prisma.property.findMany();
    const inputs = await prisma.propertyResolutionInput.findMany();
    const bins = await prisma.propertyBin.findMany();

    expect(properties).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(bins).toHaveLength(1);
    expect(second.results[0].property?.id).toBe(first.results[0].property?.id);
  });

  it('persists multi-BIN properties with NEVER_INGESTED coverage', async () => {
    mockNonCondoBatch(EMPIRE_STATE_BBL, { bins: [EMPIRE_STATE_BIN, '1022334'] });

    const response = await service.registerBbls([EMPIRE_STATE_BBL]);

    expect(response.results[0].property?.bins).toEqual([EMPIRE_STATE_BIN, '1022334']);

    const property = await prisma.property.findUnique({
      where: { bbl: EMPIRE_STATE_BBL },
      include: {
        bins: true,
        datasetCoverage: true,
      },
    });

    expect(property?.bins.map((row) => row.bin).sort()).toEqual([EMPIRE_STATE_BIN, '1022334']);
    expect(property?.datasetCoverage[0]).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
    });
  });

  it('persists zero-valid-BIN properties with NO_VALID_BIN coverage', async () => {
    mockNonCondoBatch(ZERO_BIN_BBL, { placeholderOnly: true });

    const response = await service.registerBbls([ZERO_BIN_BBL]);

    expect(response.results[0].property?.bins).toEqual([]);

    const property = await prisma.property.findUnique({
      where: { bbl: ZERO_BIN_BBL },
      include: {
        bins: true,
        datasetCoverage: true,
      },
    });

    expect(property?.bins).toHaveLength(0);
    expect(property?.datasetCoverage[0]).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NO_VALID_BIN,
    });
  });

  it('persists condo unit BBLs through the bulk condo mapping flow', async () => {
    pluto.lookupByBbls.mockImplementation(async (inputs: readonly string[]) => {
      const results = new Map<string, PlutoLookupResult>();
      for (const input of inputs) {
        results.set(input, {
          status: 'found',
          parcel: plutoParcel(input, '419 E 84 St Apt 12C', {
            lot: Number.parseInt(input.slice(6, 10), 10),
          }),
        });
      }
      return results;
    });
    condoUnits.lookupByUnitBbls.mockResolvedValue(
      new Map([
        [
          CONDO_UNIT_BBL,
          {
            matchCount: 'one',
            matches: [
              {
                unitBbl: CONDO_UNIT_BBL,
                condoBaseBbl: CONDO_BASE_BBL,
                unitDesignation: '12C',
              },
            ],
          },
        ],
      ]),
    );
    condominiums.lookupByCondoBaseBbls.mockResolvedValue(
      new Map([
        [
          CONDO_BASE_BBL,
          {
            matchCount: 'one',
            matches: [
              {
                condoBaseBbl: CONDO_BASE_BBL,
                condoBillingBbl: CONDO_BILLING_BBL,
              },
            ],
          },
        ],
      ]),
    );
    buildingFootprints.lookupByParcelBbls.mockResolvedValue(new Map());
    buildingFootprints.lookupByBaseBbls.mockResolvedValue(
      new Map([
        [
          CONDO_BASE_BBL,
          {
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
          },
        ],
      ]),
    );

    const response = await service.registerBbls([CONDO_UNIT_BBL]);

    expect(response.results[0]).toMatchObject({
      status: 'succeeded',
      property: {
        bbl: CONDO_UNIT_BBL,
        condoBaseBbl: CONDO_BASE_BBL,
        condoBillingBbl: CONDO_BILLING_BBL,
        bins: ['1045678'],
      },
    });

    const input = await prisma.propertyResolutionInput.findUnique({
      where: {
        inputType_normalizedInput: {
          inputType: PropertyResolutionInputType.BBL,
          normalizedInput: CONDO_UNIT_BBL,
        },
      },
    });

    expect(input).not.toBeNull();
  });
});
