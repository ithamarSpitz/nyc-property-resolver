import { z } from 'zod';

import { AppError } from '../errors';

const BBL_DIGITS_PATTERN = /^\d{10}$/;
const BIN_DIGITS_PATTERN = /^\d{7}$/;
const PLACEHOLDER_BIN_SUFFIX = '000000';

export const canonicalBblSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ''))
  .refine((value) => BBL_DIGITS_PATTERN.test(value), {
    message: 'BBL must be a 10-digit NYC parcel identifier',
  });

export const canonicalBinSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ''))
  .refine((value) => BIN_DIGITS_PATTERN.test(value), {
    message: 'BIN must be a 7-digit NYC building identifier',
  });

export type CanonicalBbl = z.infer<typeof canonicalBblSchema>;
export type CanonicalBin = z.infer<typeof canonicalBinSchema>;

export type BblComponents = {
  bbl: CanonicalBbl;
  borough: number;
  block: number;
  lot: number;
};

export function canonicalizeBbl(input: string): CanonicalBbl {
  return canonicalBblSchema.parse(input);
}

export function canonicalizeBin(input: string): CanonicalBin {
  return canonicalBinSchema.parse(input);
}

export function parseBblComponents(input: string): BblComponents {
  const bbl = canonicalizeBbl(input);

  return {
    bbl,
    borough: Number.parseInt(bbl.slice(0, 1), 10),
    block: Number.parseInt(bbl.slice(1, 6), 10),
    lot: Number.parseInt(bbl.slice(6, 10), 10),
  };
}

export function isPlaceholderBin(bin: string): boolean {
  const canonical = canonicalizeBin(bin);
  return canonical.endsWith(PLACEHOLDER_BIN_SUFFIX);
}

export function filterValidBins(candidateBins: readonly string[]): CanonicalBin[] {
  const validBins = new Set<CanonicalBin>();

  for (const candidate of candidateBins) {
    try {
      const canonical = canonicalizeBin(candidate);
      if (!isPlaceholderBin(canonical)) {
        validBins.add(canonical);
      }
    } catch {
      continue;
    }
  }

  return [...validBins].sort();
}

export function assertValidBbl(input: string): CanonicalBbl {
  try {
    return canonicalizeBbl(input);
  } catch (error) {
    throw new AppError({
      code: 'INVALID_BBL',
      message: 'BBL must be a 10-digit NYC parcel identifier',
      statusCode: 400,
      cause: error,
    });
  }
}

export function assertValidBin(input: string): CanonicalBin {
  try {
    return canonicalizeBin(input);
  } catch (error) {
    throw new AppError({
      code: 'INVALID_BIN',
      message: 'BIN must be a 7-digit NYC building identifier',
      statusCode: 400,
      cause: error,
    });
  }
}
