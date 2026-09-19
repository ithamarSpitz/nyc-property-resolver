import { Prisma, PrismaClient, PropertyResolutionInputType } from '@prisma/client';

import type { BuildingFootprintsClient } from '../../clients/building-footprints.client';
import type { CondoUnitsClient } from '../../clients/condo-units.client';
import type { CondominiumsClient } from '../../clients/condominiums.client';
import type { GeoSearchClient } from '../../clients/geosearch.client';
import type { PlutoClient, PlutoParcelRecord } from '../../clients/pluto.client';
import { AppError } from '../../errors';
import {
  type BulkPropertyInputResult,
  type BulkPropertyRegistrationResponse,
  toBulkPropertyPayload,
  tryCanonicalizeBulkBbl,
} from '../../schemas/property-bulk.schema';
import {
  CanonicalBbl,
  CanonicalBin,
  assertValidBbl,
  parseBblComponents,
} from '../../schemas/property-identifiers.schema';

import { isCondoUnitLot } from './condo-resolution.service';
import {
  assertFootprintIdentifierAgreement,
  collectValidatedBins,
  validateFootprintCandidates,
} from './footprint-validation';
import {
  PropertyIdentityService,
  PropertyWithRelations,
  createPropertyIdentityService,
} from './property-identity.service';
import { persistResolutionInput } from './property-input.service';
import { requirePlutoParcel } from './require-pluto-parcel';

export const BULK_SOURCE_QUERY_CHUNK_SIZE = 500;

export type BulkPropertyRegistrationClients = {
  pluto: PlutoClient;
  buildingFootprints: BuildingFootprintsClient;
  condoUnits: CondoUnitsClient;
  condominiums: CondominiumsClient;
  geoSearch?: GeoSearchClient;
};

export type BulkPropertyRegistrationDependencies = {
  prisma: PrismaClient;
  clients: BulkPropertyRegistrationClients;
  propertyIdentity?: PropertyIdentityService;
};

type ParsedBulkInput = {
  inputBbl: string;
  canonicalBbl?: CanonicalBbl;
  validationError?: {
    code: string;
    message: string;
  };
};

type ResolvedNonCondoPayload = {
  canonicalBbl: CanonicalBbl;
  parcel: PlutoParcelRecord;
  candidateBins: CanonicalBin[];
  normalizedAddress: string;
};

type ResolvedCondoPayload = {
  unitBbl: CanonicalBbl;
  condoBaseBbl: CanonicalBbl;
  condoBillingBbl: CanonicalBbl;
  parcel: PlutoParcelRecord;
  candidateBins: CanonicalBin[];
};

function buildResolverMetadata(
  metadata: Record<string, Prisma.InputJsonValue | null | undefined>,
): Prisma.InputJsonValue {
  return metadata as Prisma.InputJsonValue;
}

function toInputFailure(
  inputBbl: string,
  canonicalBbl: CanonicalBbl | undefined,
  error: AppError,
): BulkPropertyInputResult {
  return {
    inputBbl,
    canonicalBbl,
    status: 'failed',
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

function toInputSuccess(
  inputBbl: string,
  canonicalBbl: CanonicalBbl,
  property: PropertyWithRelations,
  status: 'succeeded' | 'cached',
): BulkPropertyInputResult {
  return {
    inputBbl,
    canonicalBbl,
    status,
    property: toBulkPropertyPayload(property),
  };
}

function parseBulkInputs(bbls: readonly string[]): ParsedBulkInput[] {
  return bbls.map((inputBbl) => {
    const parsed = tryCanonicalizeBulkBbl(inputBbl);
    if (!parsed.success) {
      return {
        inputBbl,
        validationError: {
          code: 'INVALID_BBL',
          message: 'BBL must be a 10-digit NYC parcel identifier',
        },
      };
    }

    return {
      inputBbl,
      canonicalBbl: assertValidBbl(parsed.data),
    };
  });
}

function uniqueCanonicalBbls(parsedInputs: readonly ParsedBulkInput[]): CanonicalBbl[] {
  const unique = new Set<CanonicalBbl>();

  for (const input of parsedInputs) {
    if (input.canonicalBbl !== undefined) {
      unique.add(input.canonicalBbl);
    }
  }

  return [...unique].sort();
}

function resolveNonCondoBins(
  canonicalBbl: CanonicalBbl,
  footprintCandidates: readonly import('../../clients/building-footprints.client').BuildingFootprintCandidate[],
): CanonicalBin[] {
  if (footprintCandidates.length === 0) {
    return [];
  }

  const validation = validateFootprintCandidates(footprintCandidates, canonicalBbl, 'non-condo');
  assertFootprintIdentifierAgreement(validation, false);
  return collectValidatedBins(validation);
}

function resolveCondoBins(
  footprintValidationBbl: CanonicalBbl,
  footprintCandidates: readonly import('../../clients/building-footprints.client').BuildingFootprintCandidate[],
): CanonicalBin[] {
  if (footprintCandidates.length === 0) {
    return [];
  }

  const validation = validateFootprintCandidates(
    footprintCandidates,
    footprintValidationBbl,
    'condo',
  );
  assertFootprintIdentifierAgreement(validation, false);
  return collectValidatedBins(validation);
}

export class BulkPropertyRegistrationService {
  private readonly prisma: PrismaClient;
  private readonly clients: BulkPropertyRegistrationClients;
  private readonly propertyIdentity: PropertyIdentityService;

  constructor(dependencies: BulkPropertyRegistrationDependencies) {
    this.prisma = dependencies.prisma;
    this.clients = dependencies.clients;
    this.propertyIdentity =
      dependencies.propertyIdentity ?? createPropertyIdentityService(dependencies.prisma);
  }

  async registerBbls(bbls: readonly string[]): Promise<BulkPropertyRegistrationResponse> {
    const parsedInputs = parseBulkInputs(bbls);
    const uniqueBbls = uniqueCanonicalBbls(parsedInputs);
    const cachedByBbl = await this.propertyIdentity.findCachedBblRegistrations(uniqueBbls);
    const uncachedBbls = uniqueBbls.filter((bbl) => !cachedByBbl.has(bbl));

    const resolvedByBbl = new Map<CanonicalBbl, PropertyWithRelations>();
    for (const [bbl, property] of cachedByBbl) {
      resolvedByBbl.set(bbl, property);
    }

    const resolutionFailures = new Map<CanonicalBbl, AppError>();

    if (uncachedBbls.length > 0) {
      const condoUnitBbls = uncachedBbls.filter((bbl) => isCondoUnitLot(parseBblComponents(bbl).lot));
      const nonCondoBbls = uncachedBbls.filter((bbl) => !isCondoUnitLot(parseBblComponents(bbl).lot));

      const parcelFootprintResults = await this.clients.buildingFootprints.lookupByParcelBbls(
        nonCondoBbls,
      );
      const condoUnitResults = await this.clients.condoUnits.lookupByUnitBbls(condoUnitBbls);

      const condoBaseBbls = new Set<CanonicalBbl>();
      for (const unitBbl of condoUnitBbls) {
        const unitLookup = condoUnitResults.get(unitBbl);
        if (unitLookup?.matchCount === 'one') {
          condoBaseBbls.add(unitLookup.matches[0].condoBaseBbl);
        }
      }

      const condoBillingResults = await this.clients.condominiums.lookupByCondoBaseBbls([
        ...condoBaseBbls,
      ]);
      const condoBillingBbls = new Set<CanonicalBbl>();
      for (const lookup of condoBillingResults.values()) {
        if (lookup.matchCount === 'one') {
          condoBillingBbls.add(lookup.matches[0].condoBillingBbl);
        }
      }

      const plutoResults = await this.clients.pluto.lookupByBbls([
        ...nonCondoBbls,
        ...condoBillingBbls,
      ]);
      const condoBaseFootprintResults = await this.clients.buildingFootprints.lookupByBaseBbls([
        ...condoBaseBbls,
      ]);

      const nonCondoPayloads = new Map<CanonicalBbl, ResolvedNonCondoPayload>();
      for (const canonicalBbl of nonCondoBbls) {
        try {
          const parcel = requirePlutoParcel(canonicalBbl, plutoResults.get(canonicalBbl));
          const footprintLookup = parcelFootprintResults.get(canonicalBbl);
          const candidateBins =
            footprintLookup?.status === 'found'
              ? resolveNonCondoBins(canonicalBbl, footprintLookup.candidates)
              : [];

          nonCondoPayloads.set(canonicalBbl, {
            canonicalBbl,
            parcel,
            candidateBins,
            normalizedAddress: parcel.address,
          });
        } catch (error) {
          if (error instanceof AppError) {
            resolutionFailures.set(canonicalBbl, error);
          } else {
            throw error;
          }
        }
      }

      const condoPayloads = new Map<CanonicalBbl, ResolvedCondoPayload>();
      for (const unitBbl of condoUnitBbls) {
        try {
          const unitLookup = condoUnitResults.get(unitBbl);
          if (unitLookup?.matchCount === 'zero') {
            throw new AppError({
              code: 'RESOLVER_CONDO_UNIT_NOT_FOUND',
              message: `No condominium unit mapping was found for unit BBL ${unitBbl}`,
              statusCode: 422,
            });
          }

          if (unitLookup?.matchCount === 'multiple') {
            throw new AppError({
              code: 'RESOLVER_CONDO_UNIT_AMBIGUOUS',
              message: `Multiple condominium unit mappings were found for unit BBL ${unitBbl}`,
              statusCode: 422,
            });
          }

          const condoBaseBbl = unitLookup!.matches[0].condoBaseBbl;
          const billingLookup = condoBillingResults.get(condoBaseBbl);
          if (billingLookup?.matchCount === 'zero') {
            throw new AppError({
              code: 'RESOLVER_CONDO_BILLING_NOT_FOUND',
              message: `No condo billing BBL was found for condo base ${condoBaseBbl}`,
              statusCode: 422,
            });
          }

          if (billingLookup?.matchCount === 'multiple') {
            throw new AppError({
              code: 'RESOLVER_CONDO_BILLING_AMBIGUOUS',
              message: `Multiple condo billing BBLs were found for condo base ${condoBaseBbl}`,
              statusCode: 422,
            });
          }

          const condoBillingBbl = billingLookup!.matches[0].condoBillingBbl;
          const parcel = requirePlutoParcel(
            condoBillingBbl,
            plutoResults.get(condoBillingBbl),
          );
          const footprintLookup = condoBaseFootprintResults.get(condoBaseBbl);
          const candidateBins =
            footprintLookup?.status === 'found'
              ? resolveCondoBins(condoBillingBbl, footprintLookup.candidates)
              : [];

          condoPayloads.set(unitBbl, {
            unitBbl,
            condoBaseBbl,
            condoBillingBbl,
            parcel,
            candidateBins,
          });
        } catch (error) {
          if (error instanceof AppError) {
            resolutionFailures.set(unitBbl, error);
          } else {
            throw error;
          }
        }
      }

      for (const payload of nonCondoPayloads.values()) {
        try {
          const property = await this.persistNonCondoProperty(payload);
          resolvedByBbl.set(payload.canonicalBbl, property);
        } catch (error) {
          if (error instanceof AppError) {
            resolutionFailures.set(payload.canonicalBbl, error);
          } else {
            throw error;
          }
        }
      }

      for (const payload of condoPayloads.values()) {
        try {
          const property = await this.persistCondoProperty(payload);
          resolvedByBbl.set(payload.unitBbl, property);
        } catch (error) {
          if (error instanceof AppError) {
            resolutionFailures.set(payload.unitBbl, error);
          } else {
            throw error;
          }
        }
      }
    }

    const results: BulkPropertyInputResult[] = [];
    let succeeded = 0;
    let failed = 0;
    let cached = 0;

    for (const input of parsedInputs) {
      if (input.validationError !== undefined) {
        results.push({
          inputBbl: input.inputBbl,
          status: 'failed',
          error: input.validationError,
        });
        failed += 1;
        continue;
      }

      const canonicalBbl = input.canonicalBbl!;
      const wasCached = cachedByBbl.has(canonicalBbl);
      const resolutionFailure = resolutionFailures.get(canonicalBbl);

      if (resolutionFailure !== undefined) {
        results.push(toInputFailure(input.inputBbl, canonicalBbl, resolutionFailure));
        failed += 1;
        continue;
      }

      const property = resolvedByBbl.get(canonicalBbl);
      if (property === undefined) {
        results.push(
          toInputFailure(
            input.inputBbl,
            canonicalBbl,
            new AppError({
              code: 'BULK_REGISTRATION_UNRESOLVED',
              message: `Bulk registration did not produce a property for BBL ${canonicalBbl}`,
              statusCode: 500,
            }),
          ),
        );
        failed += 1;
        continue;
      }

      if (wasCached) {
        results.push(toInputSuccess(input.inputBbl, canonicalBbl, property, 'cached'));
        cached += 1;
      } else {
        results.push(toInputSuccess(input.inputBbl, canonicalBbl, property, 'succeeded'));
        succeeded += 1;
      }
    }

    return {
      summary: {
        submitted: bbls.length,
        unique: uniqueBbls.length,
        succeeded,
        failed,
        cached,
      },
      results,
    };
  }

  private async persistNonCondoProperty(
    payload: ResolvedNonCondoPayload,
  ): Promise<PropertyWithRelations> {
    const property = await this.propertyIdentity.findOrCreateProperty({
      bbl: payload.canonicalBbl,
      candidateBins: payload.candidateBins,
      normalizedAddress: payload.normalizedAddress,
      borough: payload.parcel.borough,
      block: payload.parcel.block,
      lot: payload.parcel.lot,
    });

    const refreshed =
      payload.candidateBins.length > 0
        ? (await this.propertyIdentity.applyEffectiveBinSet(property.id, payload.candidateBins))
            .property
        : property;

    await persistResolutionInput(this.prisma, {
      inputType: PropertyResolutionInputType.BBL,
      normalizedInput: payload.canonicalBbl,
      propertyId: refreshed.id,
      resolverMetadata: buildResolverMetadata({
        flow: 'bulk-non-condo',
        canonicalBbl: payload.canonicalBbl,
        candidateBinCount: payload.candidateBins.length,
      }),
    });

    return refreshed;
  }

  private async persistCondoProperty(payload: ResolvedCondoPayload): Promise<PropertyWithRelations> {
    const unitComponents = parseBblComponents(payload.unitBbl);
    const property = await this.propertyIdentity.findOrCreateProperty({
      bbl: payload.unitBbl,
      candidateBins: payload.candidateBins,
      normalizedAddress: payload.parcel.address,
      condoBaseBbl: payload.condoBaseBbl,
      condoBillingBbl: payload.condoBillingBbl,
      borough: unitComponents.borough,
      block: unitComponents.block,
      lot: unitComponents.lot,
    });

    const refreshed =
      payload.candidateBins.length > 0
        ? (await this.propertyIdentity.applyEffectiveBinSet(property.id, payload.candidateBins))
            .property
        : property;

    await persistResolutionInput(this.prisma, {
      inputType: PropertyResolutionInputType.BBL,
      normalizedInput: payload.unitBbl,
      propertyId: refreshed.id,
      resolverMetadata: buildResolverMetadata({
        flow: 'bulk-condo-unit',
        unitBbl: payload.unitBbl,
        condoBaseBbl: payload.condoBaseBbl,
        condoBillingBbl: payload.condoBillingBbl,
        candidateBinCount: payload.candidateBins.length,
      }),
    });

    return refreshed;
  }
}

export function createBulkPropertyRegistrationService(
  dependencies: BulkPropertyRegistrationDependencies,
): BulkPropertyRegistrationService {
  return new BulkPropertyRegistrationService(dependencies);
}
