import { Prisma } from '@prisma/client';

import type { PrismaExecutor } from './ingestion-run.repository';

export type LiveStatePromotionResult = {
  promotedCount: number;
  reconciledCount: number;
};

/**
 * Promotes one accepted run's normalized candidates and reconciles absences.
 *
 * The caller owns the transaction. In particular, this primitive must be
 * composed with successful coverage publication and the COMPLETED transition.
 */
export async function promoteEcbLiveState(
  executor: PrismaExecutor,
  runId: string,
): Promise<LiveStatePromotionResult> {
  const promotedCount = await executor.$executeRaw(Prisma.sql`
    INSERT INTO "ecb_violations" (
      "id",
      "source_id",
      "socrata_row_id",
      "bin",
      "violation_number",
      "issue_date",
      "ecb_violation_status",
      "balance_due",
      "source_row_updated_at",
      "last_success_run_id",
      "is_current",
      "created_at",
      "updated_at"
    )
    SELECT
      staging."id",
      staging."source_id",
      staging."socrata_row_id",
      staging."bin",
      staging."violation_number",
      staging."issue_date",
      staging."ecb_violation_status",
      staging."balance_due",
      staging."source_row_updated_at",
      ${runId}::uuid,
      true,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "ecb_violation_staging" AS staging
    WHERE staging."run_id" = ${runId}::uuid
    ON CONFLICT ("source_id") DO UPDATE SET
      "socrata_row_id" = EXCLUDED."socrata_row_id",
      "bin" = EXCLUDED."bin",
      "violation_number" = EXCLUDED."violation_number",
      "issue_date" = EXCLUDED."issue_date",
      "ecb_violation_status" = EXCLUDED."ecb_violation_status",
      "balance_due" = EXCLUDED."balance_due",
      "source_row_updated_at" = EXCLUDED."source_row_updated_at",
      "last_success_run_id" = EXCLUDED."last_success_run_id",
      "is_current" = true,
      "updated_at" = CURRENT_TIMESTAMP
  `);

  const reconciledCount = await executor.$executeRaw(Prisma.sql`
    UPDATE "ecb_violations" AS live
    SET
      "is_current" = false,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE live."is_current" = true
      AND EXISTS (
        SELECT 1
        FROM "ingestion_run_property_bins" AS snapshot
        WHERE snapshot."run_id" = ${runId}::uuid
          AND snapshot."bin" = live."bin"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "ecb_violation_staging" AS staging
        WHERE staging."run_id" = ${runId}::uuid
          AND staging."source_id" = live."source_id"
      )
  `);

  return { promotedCount, reconciledCount };
}

export class LiveStateRepository {
  async promoteAndReconcile(
    executor: PrismaExecutor,
    runId: string,
  ): Promise<LiveStatePromotionResult> {
    return promoteEcbLiveState(executor, runId);
  }
}
