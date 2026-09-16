import type { BuildingFootprintsLookupResult } from '../../../src/clients/building-footprints.client';
import type { CondoUnitLookupResult } from '../../../src/clients/condo-units.client';
import type { CondominiumBillingLookupResult } from '../../../src/clients/condominiums.client';
import type { PlutoLookupResult } from '../../../src/clients/pluto.client';

import { EMPIRE_STATE_BIN, ZERO_BIN_BBL } from './constants';
import { plutoParcel } from './scenarios';

export type MockBulkClients = {
  pluto: {
    lookupByBbls: jest.Mock<Promise<Map<string, PlutoLookupResult>>, [readonly string[]]>;
  };
  buildingFootprints: {
    lookupByParcelBbls: jest.Mock<
      Promise<Map<string, BuildingFootprintsLookupResult>>,
      [readonly string[]]
    >;
    lookupByBaseBbls: jest.Mock<
      Promise<Map<string, BuildingFootprintsLookupResult>>,
      [readonly string[]]
    >;
  };
  condoUnits: {
    lookupByUnitBbls: jest.Mock<Promise<Map<string, CondoUnitLookupResult>>, [readonly string[]]>;
  };
  condominiums: {
    lookupByCondoBaseBbls: jest.Mock<
      Promise<Map<string, CondominiumBillingLookupResult>>,
      [readonly string[]]
    >;
  };
  geoSearch: {
    searchByAddress: jest.Mock;
  };
};

export function createMockBulkClients(): MockBulkClients {
  return {
    pluto: {
      lookupByBbls: jest.fn(),
    },
    buildingFootprints: {
      lookupByParcelBbls: jest.fn(),
      lookupByBaseBbls: jest.fn(),
    },
    condoUnits: {
      lookupByUnitBbls: jest.fn(),
    },
    condominiums: {
      lookupByCondoBaseBbls: jest.fn(),
    },
    geoSearch: {
      searchByAddress: jest.fn(),
    },
  };
}

export function mockNonCondoBulkBatch(
  clients: MockBulkClients,
  bbl: string,
  options: {
    bins?: string[];
    placeholderOnly?: boolean;
  } = {},
): void {
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

  clients.pluto.lookupByBbls.mockImplementation(async (inputs: readonly string[]) => {
    const results = new Map<string, PlutoLookupResult>();
    for (const input of inputs) {
      results.set(input, {
        status: 'found',
        parcel: plutoParcel(input, `Address for ${input}`),
      });
    }
    return results;
  });

  clients.buildingFootprints.lookupByParcelBbls.mockImplementation(async (inputs: readonly string[]) => {
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

  clients.condoUnits.lookupByUnitBbls.mockResolvedValue(new Map());
  clients.condominiums.lookupByCondoBaseBbls.mockResolvedValue(new Map());
  clients.buildingFootprints.lookupByBaseBbls.mockResolvedValue(new Map());
}

export function makeBulkBbl(index: number): string {
  return `1${String(index).padStart(9, '0')}`;
}

export { ZERO_BIN_BBL };
