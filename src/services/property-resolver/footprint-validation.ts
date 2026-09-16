import type { BuildingFootprintCandidate } from '../../clients/building-footprints.client';
import { AppError } from '../../errors';
import {
  CanonicalBbl,
  CanonicalBin,
  canonicalizeBin,
  filterValidBins,
} from '../../schemas/property-identifiers.schema';

export type FootprintValidationMode = 'non-condo' | 'condo';

export type FootprintValidationFailureReason =
  | 'MAPPLUTO_BBL_MISMATCH'
  | 'BASE_BBL_MISMATCH';

export type ValidatedFootprintCandidate = {
  candidate: BuildingFootprintCandidate;
  bin: CanonicalBin;
};

export type FootprintValidationResult = {
  accepted: ValidatedFootprintCandidate[];
  rejected: Array<{
    candidate: BuildingFootprintCandidate;
    reason: FootprintValidationFailureReason;
  }>;
};

function candidateHasMapplutoEvidence(candidate: BuildingFootprintCandidate): boolean {
  return Object.prototype.hasOwnProperty.call(candidate, 'mapplutoBbl');
}

export function validateFootprintCandidate(
  candidate: BuildingFootprintCandidate,
  canonicalBbl: CanonicalBbl,
  mode: FootprintValidationMode,
): ValidatedFootprintCandidate | FootprintValidationFailureReason {
  if (candidateHasMapplutoEvidence(candidate)) {
    if (candidate.mapplutoBbl === null || candidate.mapplutoBbl === undefined) {
      if (mode === 'condo') {
        return 'MAPPLUTO_BBL_MISMATCH';
      }

      if (candidate.baseBbl !== canonicalBbl) {
        return 'BASE_BBL_MISMATCH';
      }
    } else if (candidate.mapplutoBbl !== canonicalBbl) {
      return 'MAPPLUTO_BBL_MISMATCH';
    }
  } else if (candidate.baseBbl !== canonicalBbl) {
    return 'BASE_BBL_MISMATCH';
  }

  return {
    candidate,
    bin: candidate.bin,
  };
}

export function validateFootprintCandidates(
  candidates: readonly BuildingFootprintCandidate[],
  canonicalBbl: CanonicalBbl,
  mode: FootprintValidationMode,
): FootprintValidationResult {
  const accepted: ValidatedFootprintCandidate[] = [];
  const rejected: FootprintValidationResult['rejected'] = [];

  for (const candidate of candidates) {
    const validation = validateFootprintCandidate(candidate, canonicalBbl, mode);

    if (typeof validation === 'string') {
      rejected.push({ candidate, reason: validation });
      continue;
    }

    accepted.push(validation);
  }

  return { accepted, rejected };
}

export function collectValidatedBins(
  validationResult: FootprintValidationResult,
): CanonicalBin[] {
  return filterValidBins(validationResult.accepted.map((entry) => entry.bin));
}

export function assertGeoSearchBinCorroboratesFootprints(
  geosearchBin: string | undefined,
  validatedBins: readonly CanonicalBin[],
): void {
  if (geosearchBin === undefined) {
    return;
  }

  if (validatedBins.length === 0) {
    return;
  }

  let canonicalGeoSearchBin: CanonicalBin;
  try {
    canonicalGeoSearchBin = canonicalizeBin(geosearchBin);
  } catch {
    return;
  }

  if (validatedBins.includes(canonicalGeoSearchBin)) {
    return;
  }

  throw new AppError({
    code: 'RESOLVER_GEOSEARCH_BIN_CONFLICT',
    message:
      'GeoSearch BIN contradicts the validated Building Footprints mapping for the canonical parcel',
    statusCode: 422,
  });
}

export function assertFootprintIdentifierAgreement(
  validationResult: FootprintValidationResult,
  requireAcceptedCandidate: boolean,
): void {
  if (validationResult.accepted.length > 0) {
    return;
  }

  const mapplutoMismatch = validationResult.rejected.some(
    (entry) => entry.reason === 'MAPPLUTO_BBL_MISMATCH',
  );

  if (mapplutoMismatch) {
    throw new AppError({
      code: 'RESOLVER_FOOTPRINT_MAPPLUTO_BBL_MISMATCH',
      message: 'Building Footprints MAPPLUTO_BBL does not match the canonical parcel BBL',
      statusCode: 422,
    });
  }

  const baseMismatch = validationResult.rejected.some(
    (entry) => entry.reason === 'BASE_BBL_MISMATCH',
  );

  if (baseMismatch) {
    throw new AppError({
      code: 'RESOLVER_FOOTPRINT_BASE_BBL_MISMATCH',
      message: 'Building Footprints BASE_BBL does not match the canonical parcel BBL',
      statusCode: 422,
    });
  }

  if (requireAcceptedCandidate) {
    throw new AppError({
      code: 'RESOLVER_FOOTPRINT_NOT_FOUND',
      message: 'Building Footprints returned no candidates for the canonical parcel',
      statusCode: 422,
    });
  }
}
