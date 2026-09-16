import type { BuildingFootprintsLookupResult } from '../../../src/clients/building-footprints.client';
import type { CondoUnitLookupResult } from '../../../src/clients/condo-units.client';
import type { CondominiumBillingLookupResult } from '../../../src/clients/condominiums.client';
import type { GeoSearchSearchResult } from '../../../src/clients/geosearch.client';
import type { PlutoLookupResult, PlutoParcelRecord } from '../../../src/clients/pluto.client';

import {
  CONDO_BASE_BBL,
  CONDO_BILLING_BBL,
  CONDO_UNIT_BBL,
  EMPIRE_STATE_BBL,
  EMPIRE_STATE_BIN,
  QUEENS_ADDRESS,
  QUEENS_BBL,
} from './constants';

export function plutoParcel(
  bbl: string,
  address: string,
  overrides: Partial<{ borough: number; block: number; lot: number }> = {},
): PlutoParcelRecord {
  return {
    bbl,
    borough: overrides.borough ?? Number.parseInt(bbl.slice(0, 1), 10),
    block: overrides.block ?? Number.parseInt(bbl.slice(1, 6), 10),
    lot: overrides.lot ?? Number.parseInt(bbl.slice(6, 10), 10),
    address,
    bldgclass: 'O4',
  };
}

export function geoSearchResult(
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
        label: options.label ?? `${normalizedBaseAddress}, New York, NY, USA`,
        layer: 'address',
        confidence: 0.95,
        bbl: options.bbl,
        bin: options.bin,
        sourceId: 'feature-1',
      },
    ],
  };
}

export type MockResolverClients = {
  geoSearch: { searchByAddress: jest.Mock<Promise<GeoSearchSearchResult>, [string]> };
  pluto: { lookupByBbl: jest.Mock<Promise<PlutoLookupResult>, [string]> };
  buildingFootprints: {
    lookupByParcelBbl: jest.Mock<Promise<BuildingFootprintsLookupResult>, [string]>;
    lookupByBaseBbl: jest.Mock<Promise<BuildingFootprintsLookupResult>, [string]>;
  };
  condoUnits: {
    lookupByUnitBbl: jest.Mock<Promise<CondoUnitLookupResult>, [string]>;
    lookupByCondoBaseAndUnitDesignation: jest.Mock<
      Promise<CondoUnitLookupResult>,
      [string, string]
    >;
  };
  condominiums: {
    lookupByCondoBaseBbl: jest.Mock<Promise<CondominiumBillingLookupResult>, [string]>;
  };
};

export function createMockResolverClients(): MockResolverClients {
  return {
    geoSearch: {
      searchByAddress: jest.fn(),
    },
    pluto: {
      lookupByBbl: jest.fn(),
    },
    buildingFootprints: {
      lookupByParcelBbl: jest.fn(),
      lookupByBaseBbl: jest.fn(),
    },
    condoUnits: {
      lookupByUnitBbl: jest.fn(),
      lookupByCondoBaseAndUnitDesignation: jest.fn(),
    },
    condominiums: {
      lookupByCondoBaseBbl: jest.fn(),
    },
  };
}

export function mockStandardNonCondoResolution(
  clients: MockResolverClients,
  options?: {
    bbl?: string;
    bin?: string;
    footprintBin?: string;
    mapplutoBbl?: string | null;
    includeMapplutoField?: boolean;
    baseBbl?: string;
    extraBins?: string[];
    address?: string;
    geoSearchBaseAddress?: string;
  },
): void {
  const bbl = options?.bbl ?? EMPIRE_STATE_BBL;
  const bin = options?.bin ?? EMPIRE_STATE_BIN;
  const footprintBin = options?.footprintBin ?? EMPIRE_STATE_BIN;
  const baseBbl = options?.baseBbl ?? bbl;
  const includeMapplutoField = options?.includeMapplutoField ?? true;
  const mapplutoBbl = options?.mapplutoBbl ?? bbl;
  const address = options?.address ?? '350 5th Avenue';
  const geoSearchBaseAddress = options?.geoSearchBaseAddress ?? address;

  clients.geoSearch.searchByAddress.mockResolvedValue(
    geoSearchResult(geoSearchBaseAddress, { bbl, bin, label: `${address}, Manhattan` }),
  );
  clients.pluto.lookupByBbl.mockResolvedValue({
    status: 'found',
    parcel: plutoParcel(bbl, address),
  });
  clients.buildingFootprints.lookupByParcelBbl.mockResolvedValue({
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

export function mockQueensHyphenResolution(clients: MockResolverClients): void {
  mockStandardNonCondoResolution(clients, {
    bbl: QUEENS_BBL,
    address: QUEENS_ADDRESS,
    geoSearchBaseAddress: QUEENS_ADDRESS,
  });
}

export function mockCondoUnitAddressResolution(clients: MockResolverClients): void {
  clients.geoSearch.searchByAddress.mockResolvedValue(
    geoSearchResult('419 E 84 St', {
      bbl: CONDO_BILLING_BBL,
      bin: '1045678',
      label: '419 E 84 St, Manhattan',
    }),
  );
  clients.condoUnits.lookupByCondoBaseAndUnitDesignation.mockResolvedValue({
    matchCount: 'one',
    matches: [
      {
        unitBbl: CONDO_UNIT_BBL,
        condoBaseBbl: CONDO_BASE_BBL,
        unitDesignation: '12C',
      },
    ],
  });
  clients.condoUnits.lookupByUnitBbl.mockResolvedValue({
    matchCount: 'one',
    matches: [
      {
        unitBbl: CONDO_UNIT_BBL,
        condoBaseBbl: CONDO_BASE_BBL,
        unitDesignation: '12C',
      },
    ],
  });
  clients.condominiums.lookupByCondoBaseBbl.mockResolvedValue({
    matchCount: 'one',
    matches: [
      {
        condoBaseBbl: CONDO_BASE_BBL,
        condoBillingBbl: CONDO_BILLING_BBL,
      },
    ],
  });
  clients.pluto.lookupByBbl.mockResolvedValue({
    status: 'found',
    parcel: plutoParcel(CONDO_UNIT_BBL, '419 E 84 St Apt 12C', { lot: 5678 }),
  });
  clients.buildingFootprints.lookupByBaseBbl.mockResolvedValue({
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
}
