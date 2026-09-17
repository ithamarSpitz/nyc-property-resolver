import {
  Dataset,
  EcbViolation,
  Prisma,
  PrismaClient,
  PropertyDatasetCoverage,
} from '@prisma/client';

import type { PropertyViolationsQuery } from '../schemas/property-violations-query.schema';

export type PropertyViolationsPage = {
  violations: EcbViolation[];
  hasMore: boolean;
};

export type PropertyViolationsSnapshot = {
  page: PropertyViolationsPage;
  coverage: PropertyDatasetCoverage | null;
};

export interface PropertyViolationsQueryRepositoryPort {
  findSnapshot(
    propertyId: string,
    query: PropertyViolationsQuery,
  ): Promise<PropertyViolationsSnapshot>;
}

type QueryExecutor = Pick<Prisma.TransactionClient, '$queryRaw' | 'propertyDatasetCoverage'>;

function buildCursorPredicate(query: PropertyViolationsQuery): Prisma.Sql {
  if (query.cursor === undefined) {
    return Prisma.empty;
  }

  if (query.cursor.issueDate === null) {
    return Prisma.sql`
      AND live."issue_date" IS NULL
      AND live."source_id" < ${query.cursor.sourceId}
    `;
  }

  return Prisma.sql`
    AND (
      live."issue_date" < ${query.cursor.issueDate}::date
      OR (
        live."issue_date" = ${query.cursor.issueDate}::date
        AND live."source_id" < ${query.cursor.sourceId}
      )
      OR live."issue_date" IS NULL
    )
  `;
}

export class PropertyViolationsQueryRepository
  implements PropertyViolationsQueryRepositoryPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findSnapshot(
    propertyId: string,
    query: PropertyViolationsQuery,
  ): Promise<PropertyViolationsSnapshot> {
    return this.prisma.$transaction(
      async (transaction) => {
        const page = await this.findPageWithExecutor(transaction, propertyId, query);
        const coverage = await this.findCoverageWithExecutor(transaction, propertyId);

        return { page, coverage };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  protected async findPageWithExecutor(
    executor: QueryExecutor,
    propertyId: string,
    query: PropertyViolationsQuery,
  ): Promise<PropertyViolationsPage> {
    const openFilter = query.openOnly
      ? Prisma.sql`AND live."ecb_violation_status" = 'ACTIVE'`
      : Prisma.empty;
    const unpaidFilter = query.unpaidOnly
      ? Prisma.sql`AND live."balance_due" > 0`
      : Prisma.empty;
    const cursorPredicate = buildCursorPredicate(query);
    const requestedRows = query.limit + 1;

    const rows = await executor.$queryRaw<EcbViolation[]>(Prisma.sql`
      SELECT
        live."id",
        live."source_id" AS "sourceId",
        live."socrata_row_id" AS "socrataRowId",
        live."bin",
        live."violation_number" AS "violationNumber",
        live."issue_date" AS "issueDate",
        live."ecb_violation_status" AS "ecbViolationStatus",
        live."balance_due" AS "balanceDue",
        live."source_row_updated_at" AS "sourceRowUpdatedAt",
        live."last_success_run_id" AS "lastSuccessRunId",
        live."is_current" AS "isCurrent",
        live."created_at" AS "createdAt",
        live."updated_at" AS "updatedAt"
      FROM "ecb_violations" AS live
      WHERE live."is_current" = true
        AND EXISTS (
          SELECT 1
          FROM "property_bins" AS property_bin
          WHERE property_bin."property_id" = ${propertyId}::uuid
            AND property_bin."bin" = live."bin"
        )
        ${openFilter}
        ${unpaidFilter}
        ${cursorPredicate}
      ORDER BY live."issue_date" DESC NULLS LAST, live."source_id" DESC
      LIMIT ${requestedRows}
    `);

    return {
      violations: rows.slice(0, query.limit),
      hasMore: rows.length > query.limit,
    };
  }

  protected async findCoverageWithExecutor(
    executor: QueryExecutor,
    propertyId: string,
  ): Promise<PropertyDatasetCoverage | null> {
    return executor.propertyDatasetCoverage.findUnique({
      where: {
        propertyId_dataset: {
          propertyId,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
        },
      },
    });
  }
}

export function createPropertyViolationsQueryRepository(
  prisma: PrismaClient,
): PropertyViolationsQueryRepository {
  return new PropertyViolationsQueryRepository(prisma);
}
