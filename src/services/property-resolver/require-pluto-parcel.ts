import type { PlutoLookupResult, PlutoParcelRecord } from '../../clients/pluto.client';
import { AppError } from '../../errors';
import type { CanonicalBbl } from '../../schemas/property-identifiers.schema';

function formatIncompleteReasons(reasons: readonly string[]): string {
  return reasons.join(', ');
}

export function requirePlutoParcel(
  canonicalBbl: CanonicalBbl,
  lookup: PlutoLookupResult | undefined,
): PlutoParcelRecord {
  if (lookup === undefined || lookup.status === 'not_found') {
    throw new AppError({
      code: 'RESOLVER_PLUTO_NOT_FOUND',
      message: `PLUTO did not contain parcel ${canonicalBbl}`,
      statusCode: 422,
    });
  }

  if (lookup.status === 'incomplete') {
    throw new AppError({
      code: 'RESOLVER_PLUTO_INCOMPLETE',
      message: `PLUTO contained parcel ${canonicalBbl} but required resolver attributes are missing or inconsistent: ${formatIncompleteReasons(lookup.reasons)}`,
      statusCode: 422,
    });
  }

  if (lookup.status === 'multiple') {
    throw new AppError({
      code: 'RESOLVER_PLUTO_MULTIPLE',
      message: `PLUTO returned multiple parcels for BBL ${canonicalBbl}`,
      statusCode: 422,
    });
  }

  return lookup.parcel;
}
