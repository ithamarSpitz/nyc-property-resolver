import { z } from 'zod';

import {
  ECB_SOURCE_ID_FIELD,
  SOCRATA_ROW_ID_FIELD,
  SOURCE_ROW_UPDATED_AT_FIELD,
} from './ecb-ingestion.schema';

export { ECB_SOURCE_ID_FIELD, SOCRATA_ROW_ID_FIELD, SOURCE_ROW_UPDATED_AT_FIELD };

/**
 * Socrata JSON rows are keyed by dataset API field names, which `6bgk-3dad`
 * publishes in lowercase; the SoQL/display spelling used by the source-contract
 * query differs only in case. Source fields are therefore resolved
 * case-insensitively against these canonical API field names.
 */
export const ECB_SOURCE_ID_API_FIELD = 'isn_dob_bis_extract' as const;
export const ECB_BIN_API_FIELD = 'bin' as const;
export const ECB_VIOLATION_NUMBER_API_FIELD = 'ecb_violation_number' as const;
export const ECB_ISSUE_DATE_API_FIELD = 'issue_date' as const;
export const ECB_VIOLATION_STATUS_API_FIELD = 'ecb_violation_status' as const;
export const ECB_BALANCE_DUE_API_FIELD = 'balance_due' as const;

/** A row as received from Socrata, before any domain interpretation. */
export const ecbTransportRowSchema = z.record(z.unknown());

export type EcbTransportRow = z.infer<typeof ecbTransportRowSchema>;

const ECB_SOURCE_FIELDS = [
  ECB_SOURCE_ID_API_FIELD,
  SOCRATA_ROW_ID_FIELD,
  SOURCE_ROW_UPDATED_AT_FIELD,
  ECB_BIN_API_FIELD,
  ECB_VIOLATION_NUMBER_API_FIELD,
  ECB_ISSUE_DATE_API_FIELD,
  ECB_VIOLATION_STATUS_API_FIELD,
  ECB_BALANCE_DUE_API_FIELD,
] as const;

function readSourceField(row: Record<string, unknown>, field: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, field)) {
    return row[field];
  }

  const wanted = field.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === wanted) {
      return row[key];
    }
  }

  return undefined;
}

/**
 * Overlay the known source fields onto their canonical API field names while
 * keeping every original key, so unknown source columns stay available.
 */
function canonicalizeSourceFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }

  const row = input as Record<string, unknown>;
  const canonical: Record<string, unknown> = { ...row };
  for (const field of ECB_SOURCE_FIELDS) {
    const value = readSourceField(row, field);
    if (value !== undefined) {
      canonical[field] = value;
    }
  }

  return canonical;
}

const requiredSourceScalarSchema = z.union([
  z.string().trim().min(1),
  z.number().finite(),
]);

const nullableSourceScalarSchema = z
  .union([z.string(), z.number().finite()])
  .nullable()
  .optional();

/**
 * The fields needed to identify and persist a raw source version. This is
 * deliberately small: it does not attempt to validate the ECB domain row.
 */
export const ecbSourceIdentitySchema = z.preprocess(
  canonicalizeSourceFields,
  z.object({
    [ECB_SOURCE_ID_API_FIELD]: requiredSourceScalarSchema,
    [SOCRATA_ROW_ID_FIELD]: requiredSourceScalarSchema,
    [SOURCE_ROW_UPDATED_AT_FIELD]: z.string().trim().min(1),
  }),
);

export type EcbSourceIdentity = {
  sourceId: string;
  socrataRowId: string;
  sourceRowUpdatedAt: string;
};

function scalarToString(value: string | number, field: string): string {
  const normalized = String(value).trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty source identifier`);
  }
  return normalized;
}

/** Extract only source identity; callers can persist this before domain parsing. */
export function extractEcbSourceIdentity(input: unknown): EcbSourceIdentity {
  const row = ecbTransportRowSchema.parse(input);
  const identity = ecbSourceIdentitySchema.parse(row);

  return {
    sourceId: scalarToString(identity[ECB_SOURCE_ID_API_FIELD], ECB_SOURCE_ID_API_FIELD),
    socrataRowId: scalarToString(identity[SOCRATA_ROW_ID_FIELD], SOCRATA_ROW_ID_FIELD),
    sourceRowUpdatedAt: identity[SOURCE_ROW_UPDATED_AT_FIELD],
  };
}

export const extractSourceIdentity = extractEcbSourceIdentity;

/**
 * Strictly validates the fields used by the normalized application model.
 * Socrata supplies additional columns, so those are retained rather than
 * rejected; the fields below are not coerced by this schema.
 */
export const ecbViolationSchema = z.preprocess(
  canonicalizeSourceFields,
  z
    .object({
      [ECB_SOURCE_ID_API_FIELD]: requiredSourceScalarSchema,
      [SOCRATA_ROW_ID_FIELD]: requiredSourceScalarSchema,
      [SOURCE_ROW_UPDATED_AT_FIELD]: z.string().trim().min(1),
      [ECB_BIN_API_FIELD]: requiredSourceScalarSchema,
      [ECB_VIOLATION_NUMBER_API_FIELD]: nullableSourceScalarSchema,
      [ECB_ISSUE_DATE_API_FIELD]: nullableSourceScalarSchema,
      [ECB_VIOLATION_STATUS_API_FIELD]: nullableSourceScalarSchema,
      [ECB_BALANCE_DUE_API_FIELD]: nullableSourceScalarSchema,
    })
    .passthrough(),
);

export type EcbViolationSourceRow = z.infer<typeof ecbViolationSchema>;

export const ecbDomainSchema = ecbViolationSchema;
export const ecbRowSchema = ecbViolationSchema;

export function parseEcbViolationSourceRow(input: unknown): EcbViolationSourceRow {
  return ecbViolationSchema.parse(input);
}
