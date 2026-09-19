import { Prisma, PrismaClient, PropertyResolutionInputType } from '@prisma/client';

import type { BuildingFootprintsClient } from '../../clients/building-footprints.client';
import type { CondoUnitsClient } from '../../clients/condo-units.client';
import type { CondominiumsClient } from '../../clients/condominiums.client';
import type { GeoSearchCandidate, GeoSearchClient } from '../../clients/geosearch.client';
import type { PlutoClient, PlutoParcelRecord } from '../../clients/pluto.client';
import { AppError } from '../../errors';
import {
  CanonicalBbl,
  CanonicalBin,
  assertValidBbl,
  parseBblComponents,
} from '../../schemas/property-identifiers.schema';

import { normalizeAddress } from './address-normalizer';
import {
  isCondoUnitLot,
  resolveCondoBaseContextFromParcelBbl,
  resolveCondoUnitBbl,
  resolveCondoUnitByAddressContext,
} from './condo-resolution.service';
import {
  assertFootprintIdentifierAgreement,
  assertGeoSearchBinCorroboratesFootprints,
  collectValidatedBins,
  validateFootprintCandidates,
} from './footprint-validation';
import {
  PropertyIdentityService,
  PropertyWithRelations,
  createPropertyIdentityService,
} from './property-identity.service';
import {
  findPropertyIdByResolutionInput,
  persistResolutionInput,
} from './property-input.service';
import { requirePlutoParcel } from './require-pluto-parcel';

export type PropertyResolverClients = {
  geoSearch: GeoSearchClient;
  pluto: PlutoClient;
  buildingFootprints: BuildingFootprintsClient;
  condoUnits: CondoUnitsClient;
  condominiums: CondominiumsClient;
};

export type PropertyResolverDependencies = {
  prisma: PrismaClient;
  clients: PropertyResolverClients;
  propertyIdentity?: PropertyIdentityService;
};

export type ResolvePropertyResult = {
  property: PropertyWithRelations;
  cached: boolean;
};

type SelectedGeoSearchCandidate = {
  candidate: GeoSearchCandidate;
  canonicalBbl: CanonicalBbl;
};

type NonCondoResolutionPayload = {
  canonicalBbl: CanonicalBbl;
  parcel: PlutoParcelRecord;
  candidateBins: CanonicalBin[];
  normalizedAddress: string;
  geosearchCandidate?: GeoSearchCandidate;
};

function compareNullableStrings(left?: string, right?: string): number {
  const leftValue = left ?? '';
  const rightValue = right ?? '';
  return leftValue.localeCompare(rightValue);
}

function compareNullableNumbers(left?: number, right?: number): number {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return rightValue - leftValue;
}

function sortGeoSearchCandidates(candidates: GeoSearchCandidate[]): GeoSearchCandidate[] {
  return [...candidates].sort((left, right) => {
    const confidenceCompare = compareNullableNumbers(left.confidence, right.confidence);
    if (confidenceCompare !== 0) {
      return confidenceCompare;
    }

    const labelCompare = compareNullableStrings(left.label, right.label);
    if (labelCompare !== 0) {
      return labelCompare;
    }

    return compareNullableStrings(left.sourceId, right.sourceId);
  });
}

const STREET_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  AVE: 'AVENUE',
  BLVD: 'BOULEVARD',
  CT: 'COURT',
  DR: 'DRIVE',
  E: 'EAST',
  HWY: 'HIGHWAY',
  LN: 'LANE',
  N: 'NORTH',
  PKWY: 'PARKWAY',
  PL: 'PLACE',
  RD: 'ROAD',
  S: 'SOUTH',
  ST: 'STREET',
  TPKE: 'TURNPIKE',
  W: 'WEST',
};

function normalizeStreetAddressEvidence(value: string): string {
  return value
    .toUpperCase()
    .replace(/\b(\d+)(?:ST|ND|RD|TH)\b/g, '$1')
    .replace(/[^A-Z0-9-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((token) => STREET_TOKEN_ALIASES[token] ?? token)
    .join(' ');
}

function requestedBorough(normalizedBaseAddress: string): string | undefined {
  const boroughs = ['STATEN ISLAND', 'MANHATTAN', 'BROOKLYN', 'QUEENS', 'BRONX'];

  for (const localitySegment of normalizedBaseAddress.split(',').slice(1)) {
    const normalizedSegment = localitySegment.toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
    const borough = boroughs.find((candidate) => candidate === normalizedSegment);
    if (borough !== undefined) {
      return borough;
    }
  }

  return undefined;
}

function candidateStreetAddress(candidate: GeoSearchCandidate): string {
  return candidate.name ?? candidate.label.split(',')[0];
}

function narrowToSupportedCandidates(
  candidates: GeoSearchCandidate[],
  normalizedBaseAddress: string,
): GeoSearchCandidate[] {
  let supported = candidates;
  const borough = requestedBorough(normalizedBaseAddress);

  if (borough !== undefined) {
    const boroughMatches = supported.filter(
      (candidate) => candidate.borough?.trim().toUpperCase() === borough,
    );
    if (boroughMatches.length === 0) {
      throw new AppError({
        code: 'RESOLVER_GEOSEARCH_AMBIGUOUS',
        message: 'GeoSearch returned no parcel candidate matching the requested borough',
        statusCode: 422,
      });
    }
    supported = boroughMatches;
  }

  const requestedStreetAddress = normalizeStreetAddressEvidence(
    normalizedBaseAddress.split(',')[0],
  );
  const streetAddressMatches = supported.filter(
    (candidate) =>
      normalizeStreetAddressEvidence(candidateStreetAddress(candidate)) === requestedStreetAddress,
  );
  if (streetAddressMatches.length > 0) {
    supported = streetAddressMatches;
  }

  const addressLayerCandidates = supported.filter((candidate) => candidate.layer === 'address');
  return addressLayerCandidates.length > 0 ? addressLayerCandidates : supported;
}

function selectGeoSearchCandidate(
  candidates: GeoSearchCandidate[],
  normalizedBaseAddress: string,
): SelectedGeoSearchCandidate {
  const withBbl = candidates.filter((candidate) => candidate.bbl !== undefined);
  if (withBbl.length === 0) {
    throw new AppError({
      code: 'RESOLVER_GEOSEARCH_NO_IDENTIFIERS',
      message: 'GeoSearch returned no candidates with a usable BBL',
      statusCode: 422,
    });
  }

  const candidatePool = narrowToSupportedCandidates(withBbl, normalizedBaseAddress);
  const sorted = sortGeoSearchCandidates(candidatePool);
  const distinctBbls = new Set(
    sorted.map((candidate) => assertValidBbl(candidate.bbl!)),
  );

  if (distinctBbls.size > 1) {
    throw new AppError({
      code: 'RESOLVER_GEOSEARCH_AMBIGUOUS',
      message: 'GeoSearch returned multiple conflicting parcel candidates for the base address',
      statusCode: 422,
    });
  }

  const selected = sorted[0];
  return {
    candidate: selected,
    canonicalBbl: assertValidBbl(selected.bbl!),
  };
}

async function resolveNonCondoParcel(
  canonicalBbl: CanonicalBbl,
  clients: PropertyResolverClients,
  options: {
    geosearchBin?: string;
    normalizedAddress?: string;
    geosearchCandidate?: GeoSearchCandidate;
  } = {},
): Promise<NonCondoResolutionPayload> {
  const parcel = requirePlutoParcel(
    canonicalBbl,
    await clients.pluto.lookupByBbl(canonicalBbl),
  );
  const footprintLookup = await clients.buildingFootprints.lookupByParcelBbl(canonicalBbl);

  if (footprintLookup.status === 'not_found') {
    assertGeoSearchBinCorroboratesFootprints(options.geosearchBin, []);
    return {
      canonicalBbl,
      parcel,
      candidateBins: [],
      normalizedAddress: options.normalizedAddress ?? parcel.address,
      geosearchCandidate: options.geosearchCandidate,
    };
  }

  const validation = validateFootprintCandidates(
    footprintLookup.candidates,
    canonicalBbl,
    'non-condo',
  );
  assertFootprintIdentifierAgreement(validation, false);

  const candidateBins = collectValidatedBins(validation);
  assertGeoSearchBinCorroboratesFootprints(options.geosearchBin, candidateBins);

  return {
    canonicalBbl,
    parcel,
    candidateBins,
    normalizedAddress: options.normalizedAddress ?? parcel.address,
    geosearchCandidate: options.geosearchCandidate,
  };
}

function buildResolverMetadata(
  metadata: Record<string, Prisma.InputJsonValue | null | undefined>,
): Prisma.InputJsonValue {
  return metadata as Prisma.InputJsonValue;
}

export class PropertyResolverService {
  private readonly prisma: PrismaClient;
  private readonly clients: PropertyResolverClients;
  private readonly propertyIdentity: PropertyIdentityService;

  constructor(dependencies: PropertyResolverDependencies) {
    this.prisma = dependencies.prisma;
    this.clients = dependencies.clients;
    this.propertyIdentity =
      dependencies.propertyIdentity ?? createPropertyIdentityService(dependencies.prisma);
  }

  async resolveAddress(address: string): Promise<ResolvePropertyResult> {
    const normalized = normalizeAddress(address);

    const cachedPropertyId = await findPropertyIdByResolutionInput(
      this.prisma,
      PropertyResolutionInputType.ADDRESS,
      normalized.normalizedInput,
    );

    if (cachedPropertyId !== null) {
      const cachedProperty = await this.propertyIdentity.findPropertyById(cachedPropertyId);
      if (cachedProperty === null) {
        throw new AppError({
          code: 'RESOLVER_CACHED_PROPERTY_MISSING',
          message: 'Stored resolution input referenced a missing property row',
          statusCode: 500,
        });
      }

      return { property: cachedProperty, cached: true };
    }

    if (normalized.normalizedUnitDesignation !== null) {
      return this.resolveUnitAwareAddress(normalized.normalizedBaseAddress, normalized);
    }

    return this.resolveStandardAddress(normalized.normalizedBaseAddress, normalized);
  }

  async resolveBbl(bbl: string): Promise<ResolvePropertyResult> {
    const canonicalBbl = assertValidBbl(bbl);

    const cachedPropertyId = await findPropertyIdByResolutionInput(
      this.prisma,
      PropertyResolutionInputType.BBL,
      canonicalBbl,
    );

    if (cachedPropertyId !== null) {
      const cachedProperty = await this.propertyIdentity.findPropertyById(cachedPropertyId);
      if (cachedProperty === null) {
        throw new AppError({
          code: 'RESOLVER_CACHED_PROPERTY_MISSING',
          message: 'Stored resolution input referenced a missing property row',
          statusCode: 500,
        });
      }

      return { property: cachedProperty, cached: true };
    }

    const lot = parseBblComponents(canonicalBbl).lot;

    if (isCondoUnitLot(lot)) {
      return this.persistCondoResolution(
        await resolveCondoUnitBbl(canonicalBbl, this.clients),
        PropertyResolutionInputType.BBL,
        canonicalBbl,
      );
    }

    const payload = await resolveNonCondoParcel(canonicalBbl, this.clients);

    return this.persistNonCondoResolution(payload, PropertyResolutionInputType.BBL, canonicalBbl);
  }

  private async resolveStandardAddress(
    normalizedBaseAddress: string,
    normalized: ReturnType<typeof normalizeAddress>,
  ): Promise<ResolvePropertyResult> {
    const geoSearchResult = await this.clients.geoSearch.searchByAddress(normalizedBaseAddress);
    const selected = selectGeoSearchCandidate(
      geoSearchResult.candidates,
      geoSearchResult.queriedAddress,
    );
    const payload = await resolveNonCondoParcel(selected.canonicalBbl, this.clients, {
      geosearchBin: selected.candidate.bin,
      normalizedAddress: normalized.normalizedInput,
      geosearchCandidate: selected.candidate,
    });

    return this.persistNonCondoResolution(
      payload,
      PropertyResolutionInputType.ADDRESS,
      normalized.normalizedInput,
    );
  }

  private async resolveUnitAwareAddress(
    normalizedBaseAddress: string,
    normalized: ReturnType<typeof normalizeAddress>,
  ): Promise<ResolvePropertyResult> {
    const geoSearchResult = await this.clients.geoSearch.searchByAddress(normalizedBaseAddress);
    const selected = selectGeoSearchCandidate(
      geoSearchResult.candidates,
      geoSearchResult.queriedAddress,
    );
    const condoBaseBbl = await resolveCondoBaseContextFromParcelBbl(
      selected.canonicalBbl,
      this.clients.condominiums,
    );
    const condoResolution = await resolveCondoUnitByAddressContext(
      condoBaseBbl,
      normalized.normalizedUnitDesignation!,
      this.clients,
      { geosearchBin: selected.candidate.bin },
    );

    return this.persistCondoResolution(
      condoResolution,
      PropertyResolutionInputType.ADDRESS,
      normalized.normalizedInput,
      selected.candidate,
    );
  }

  private async persistNonCondoResolution(
    payload: NonCondoResolutionPayload,
    inputType: PropertyResolutionInputType,
    normalizedInput: string,
  ): Promise<ResolvePropertyResult> {
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
      inputType,
      normalizedInput,
      propertyId: refreshed.id,
      resolverConfidence: payload.geosearchCandidate?.confidence ?? null,
      resolverMetadata: buildResolverMetadata({
        flow: 'non-condo',
        canonicalBbl: payload.canonicalBbl,
        geosearch: payload.geosearchCandidate
          ? {
              label: payload.geosearchCandidate.label,
              layer: payload.geosearchCandidate.layer,
              bbl: payload.geosearchCandidate.bbl ?? null,
              bin: payload.geosearchCandidate.bin ?? null,
              confidence: payload.geosearchCandidate.confidence ?? null,
              sourceId: payload.geosearchCandidate.sourceId ?? null,
            }
          : null,
        candidateBinCount: payload.candidateBins.length,
      }),
    });

    return { property: refreshed, cached: false };
  }

  private async persistCondoResolution(
    payload: Awaited<ReturnType<typeof resolveCondoUnitBbl>>,
    inputType: PropertyResolutionInputType,
    normalizedInput: string,
    geosearchCandidate?: GeoSearchCandidate,
  ): Promise<ResolvePropertyResult> {
    const property = await this.propertyIdentity.findOrCreateProperty({
      bbl: payload.unitBbl,
      candidateBins: payload.candidateBins,
      normalizedAddress: payload.parcel.address,
      condoBaseBbl: payload.condoBaseBbl,
      condoBillingBbl: payload.condoBillingBbl,
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
      inputType,
      normalizedInput,
      propertyId: refreshed.id,
      resolverConfidence: geosearchCandidate?.confidence ?? null,
      resolverMetadata: buildResolverMetadata({
        flow: 'condo-unit',
        unitBbl: payload.unitBbl,
        condoBaseBbl: payload.condoBaseBbl,
        condoBillingBbl: payload.condoBillingBbl,
        footprintValidationBbl: payload.footprintValidationBbl,
        geosearch: geosearchCandidate
          ? {
              label: geosearchCandidate.label,
              layer: geosearchCandidate.layer,
              bbl: geosearchCandidate.bbl ?? null,
              bin: geosearchCandidate.bin ?? null,
              confidence: geosearchCandidate.confidence ?? null,
              sourceId: geosearchCandidate.sourceId ?? null,
            }
          : null,
        candidateBinCount: payload.candidateBins.length,
      }),
    });

    return { property: refreshed, cached: false };
  }
}

export function createPropertyResolverService(
  dependencies: PropertyResolverDependencies,
): PropertyResolverService {
  return new PropertyResolverService(dependencies);
}
