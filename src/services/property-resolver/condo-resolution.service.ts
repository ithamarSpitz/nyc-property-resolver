import type { BuildingFootprintsClient } from '../../clients/building-footprints.client';
import type { CondoUnitsClient } from '../../clients/condo-units.client';
import type { CondominiumsClient } from '../../clients/condominiums.client';
import type { PlutoClient, PlutoParcelRecord } from '../../clients/pluto.client';
import { AppError } from '../../errors';
import {
  CanonicalBbl,
  CanonicalBin,
  assertValidBbl,
  parseBblComponents,
} from '../../schemas/property-identifiers.schema';

import {
  assertFootprintIdentifierAgreement,
  assertGeoSearchBinCorroboratesFootprints,
  collectValidatedBins,
  validateFootprintCandidates,
} from './footprint-validation';
import { requirePlutoParcel } from './require-pluto-parcel';

export type CondoResolutionClients = {
  condoUnits: CondoUnitsClient;
  condominiums: CondominiumsClient;
  buildingFootprints: BuildingFootprintsClient;
  pluto: PlutoClient;
};

export type CondoResolutionResult = {
  unitBbl: CanonicalBbl;
  condoBaseBbl: CanonicalBbl;
  condoBillingBbl: CanonicalBbl;
  parcel: PlutoParcelRecord;
  candidateBins: CanonicalBin[];
  footprintValidationBbl: CanonicalBbl;
};

const CONDO_UNIT_LOT_MIN = 1001;
const CONDO_BILLING_LOT_MIN = 7501;

export function isCondoUnitLot(lot: number): boolean {
  return lot >= CONDO_UNIT_LOT_MIN && lot < CONDO_BILLING_LOT_MIN;
}

export function isCondoBillingLot(lot: number): boolean {
  return lot >= CONDO_BILLING_LOT_MIN;
}

export async function resolveCondoBaseContextFromParcelBbl(
  parcelBbl: CanonicalBbl,
  condominiums: CondominiumsClient,
): Promise<CanonicalBbl> {
  const components = parseBblComponents(parcelBbl);

  if (!isCondoBillingLot(components.lot)) {
    return parcelBbl;
  }

  const lookup = await condominiums.lookupByCondoBillingBbl(parcelBbl);

  if (lookup.matchCount === 'zero') {
    throw new AppError({
      code: 'RESOLVER_CONDO_BASE_NOT_FOUND',
      message: `No condo base BBL was found for condo billing BBL ${parcelBbl}`,
      statusCode: 422,
    });
  }

  if (lookup.matchCount === 'multiple') {
    throw new AppError({
      code: 'RESOLVER_CONDO_BASE_AMBIGUOUS',
      message: `Multiple condo base BBLs were found for condo billing BBL ${parcelBbl}`,
      statusCode: 422,
    });
  }

  return lookup.matches[0].condoBaseBbl;
}

async function resolveCondoBillingBbl(
  condominiums: CondominiumsClient,
  condoBaseBbl: CanonicalBbl,
): Promise<CanonicalBbl> {
  const lookup = await condominiums.lookupByCondoBaseBbl(condoBaseBbl);

  if (lookup.matchCount === 'zero') {
    throw new AppError({
      code: 'RESOLVER_CONDO_BILLING_NOT_FOUND',
      message: `No condo billing BBL was found for condo base ${condoBaseBbl}`,
      statusCode: 422,
    });
  }

  if (lookup.matchCount === 'multiple') {
    throw new AppError({
      code: 'RESOLVER_CONDO_BILLING_AMBIGUOUS',
      message: `Multiple condo billing BBLs were found for condo base ${condoBaseBbl}`,
      statusCode: 422,
    });
  }

  return lookup.matches[0].condoBillingBbl;
}

async function resolveFootprintBinsForCondoBase(
  buildingFootprints: BuildingFootprintsClient,
  condoBaseBbl: CanonicalBbl,
  footprintValidationBbl: CanonicalBbl,
  geosearchBin?: string,
): Promise<CanonicalBin[]> {
  const lookup = await buildingFootprints.lookupByBaseBbl(condoBaseBbl);

  if (lookup.status === 'not_found') {
    return [];
  }

  const validation = validateFootprintCandidates(
    lookup.candidates,
    footprintValidationBbl,
    'condo',
  );
  assertFootprintIdentifierAgreement(validation, false);

  const validatedBins = collectValidatedBins(validation);
  assertGeoSearchBinCorroboratesFootprints(geosearchBin, validatedBins);

  return validatedBins;
}

export async function resolveCondoUnitBbl(
  unitBblInput: string,
  clients: CondoResolutionClients,
  options: { geosearchBin?: string } = {},
): Promise<CondoResolutionResult> {
  const unitBbl = assertValidBbl(unitBblInput);
  const unitLookup = await clients.condoUnits.lookupByUnitBbl(unitBbl);

  if (unitLookup.matchCount === 'zero') {
    throw new AppError({
      code: 'RESOLVER_CONDO_UNIT_NOT_FOUND',
      message: `No condominium unit mapping was found for unit BBL ${unitBbl}`,
      statusCode: 422,
    });
  }

  if (unitLookup.matchCount === 'multiple') {
    throw new AppError({
      code: 'RESOLVER_CONDO_UNIT_AMBIGUOUS',
      message: `Multiple condominium unit mappings were found for unit BBL ${unitBbl}`,
      statusCode: 422,
    });
  }

  const condoBaseBbl = unitLookup.matches[0].condoBaseBbl;
  const condoBillingBbl = await resolveCondoBillingBbl(clients.condominiums, condoBaseBbl);
  const parcel = requirePlutoParcel(
    condoBillingBbl,
    await clients.pluto.lookupByBbl(condoBillingBbl),
  );
  const candidateBins = await resolveFootprintBinsForCondoBase(
    clients.buildingFootprints,
    condoBaseBbl,
    condoBillingBbl,
    options.geosearchBin,
  );

  return {
    unitBbl,
    condoBaseBbl,
    condoBillingBbl,
    parcel,
    candidateBins,
    footprintValidationBbl: condoBillingBbl,
  };
}

export async function resolveCondoUnitByAddressContext(
  condoBaseBblInput: string,
  unitDesignation: string,
  clients: CondoResolutionClients,
  options: { geosearchBin?: string } = {},
): Promise<CondoResolutionResult> {
  const condoBaseBbl = assertValidBbl(condoBaseBblInput);
  const unitLookup = await clients.condoUnits.lookupByCondoBaseAndUnitDesignation(
    condoBaseBbl,
    unitDesignation,
  );

  if (unitLookup.matchCount === 'zero') {
    throw new AppError({
      code: 'RESOLVER_CONDO_UNIT_NOT_FOUND',
      message: `No condominium unit matched condo base ${condoBaseBbl} and unit ${unitDesignation}`,
      statusCode: 422,
    });
  }

  if (unitLookup.matchCount === 'multiple') {
    throw new AppError({
      code: 'RESOLVER_CONDO_UNIT_AMBIGUOUS',
      message: `Multiple condominium units matched condo base ${condoBaseBbl} and unit ${unitDesignation}`,
      statusCode: 422,
    });
  }

  return resolveCondoUnitBbl(unitLookup.matches[0].unitBbl, clients, options);
}
