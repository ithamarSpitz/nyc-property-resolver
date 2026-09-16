import { z } from 'zod';

import type { CoverageStatus, CoverageStatusReason } from '@prisma/client';

import type { PropertyWithRelations } from '../services/property-resolver/property-identity.service';

import { canonicalBblSchema } from './property-identifiers.schema';

export const BULK_BBL_MAX_COUNT = 10_000;

export const bulkPropertyRegistrationRequestSchema = z.object({
  bbls: z
    .array(z.string())
    .min(1, 'At least one BBL is required')
    .max(BULK_BBL_MAX_COUNT, `Maximum of ${BULK_BBL_MAX_COUNT} BBLs per request`),
});

export type BulkPropertyRegistrationRequest = z.infer<
  typeof bulkPropertyRegistrationRequestSchema
>;

export type BulkPropertyResultStatus = 'succeeded' | 'failed' | 'cached';

export type BulkPropertyCoveragePayload = {
  dataset: string;
  status: CoverageStatus;
  statusReason: CoverageStatusReason | null;
};

export type BulkPropertyPayload = {
  id: string;
  bbl: string;
  borough: number;
  block: number;
  lot: number;
  normalizedAddress: string | null;
  condoBaseBbl: string | null;
  condoBillingBbl: string | null;
  identifierVersion: number;
  bins: string[];
  coverage: BulkPropertyCoveragePayload[];
};

export type BulkPropertyInputResult = {
  inputBbl: string;
  canonicalBbl?: string;
  status: BulkPropertyResultStatus;
  property?: BulkPropertyPayload;
  error?: {
    code: string;
    message: string;
  };
};

export type BulkPropertyRegistrationResponse = {
  summary: {
    submitted: number;
    unique: number;
    succeeded: number;
    failed: number;
    cached: number;
  };
  results: BulkPropertyInputResult[];
};

export function tryCanonicalizeBulkBbl(input: string): z.SafeParseReturnType<string, string> {
  return canonicalBblSchema.safeParse(input);
}

export function toBulkPropertyPayload(property: PropertyWithRelations): BulkPropertyPayload {
  return {
    id: property.id,
    bbl: property.bbl,
    borough: property.borough,
    block: property.block,
    lot: property.lot,
    normalizedAddress: property.normalizedAddress,
    condoBaseBbl: property.condoBaseBbl,
    condoBillingBbl: property.condoBillingBbl,
    identifierVersion: property.identifierVersion,
    bins: property.bins.map((row) => row.bin),
    coverage: property.datasetCoverage.map((row) => ({
      dataset: row.dataset,
      status: row.status,
      statusReason: row.statusReason,
    })),
  };
}
