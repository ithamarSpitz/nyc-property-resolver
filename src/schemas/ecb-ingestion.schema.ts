import { z } from 'zod';

/** DOB ECB's proposed durable source identity field. */
export const ECB_SOURCE_ID_FIELD = 'ISN_DOB_BIS_EXTRACT' as const;
export const DOB_ECB_SOURCE_ID_FIELD = ECB_SOURCE_ID_FIELD;

/** Socrata system fields required for replay-safe source versions. */
export const SOCRATA_ROW_ID_FIELD = ':id' as const;
export const SOURCE_ROW_UPDATED_AT_FIELD = ':updated_at' as const;
export const SOCRATA_SOURCE_ROW_ID_FIELD = SOCRATA_ROW_ID_FIELD;
export const SOCRATA_SOURCE_ROW_UPDATED_AT_FIELD = SOURCE_ROW_UPDATED_AT_FIELD;

export type EcbSourceRow = Readonly<Record<string, unknown>>;

export type EcbSourceIdentity = {
  sourceId: string;
  socrataRowId: string;
  sourceRowUpdatedAt: string;
};

export const ecbSourceIdentitySchema = z.object({
  sourceId: z.string().trim().min(1),
  socrataRowId: z.string().trim().min(1),
  sourceRowUpdatedAt: z.string().trim().min(1),
});

export const sourceContractDuplicateGroupSchema = z.object({
  sourceId: z.string().nullable(),
  count: z.number().int().positive(),
});

export const sourceContractStatsSchema = z.object({
  totalRows: z.number().int().nonnegative(),
  distinctSourceIds: z.number().int().nonnegative(),
  nullSourceIds: z.number().int().nonnegative(),
  duplicateGroups: z.array(sourceContractDuplicateGroupSchema),
});

export type SourceContractDuplicateGroup = z.infer<typeof sourceContractDuplicateGroupSchema>;
export type SourceContractStats = z.infer<typeof sourceContractStatsSchema>;

/**
 * The query shape consumed by the future Socrata client. Keeping the source
 * field in one exported definition prevents a domain field from becoming an
 * ingestion key by accident.
 */
export const DOB_ECB_SOURCE_CONTRACT_QUERY = Object.freeze({
  sourceIdField: ECB_SOURCE_ID_FIELD,
  totalRows: 'count(*)',
  distinctSourceIds: `count(distinct ${ECB_SOURCE_ID_FIELD})`,
  nullSourceIds: `count(*) where ${ECB_SOURCE_ID_FIELD} is null`,
  duplicateGroups: `select ${ECB_SOURCE_ID_FIELD}, count(*) where ${ECB_SOURCE_ID_FIELD} is not null group by ${ECB_SOURCE_ID_FIELD} having count(*) > 1`,
});

export function parseSourceContractStats(input: unknown): SourceContractStats {
  return sourceContractStatsSchema.parse(input);
}
