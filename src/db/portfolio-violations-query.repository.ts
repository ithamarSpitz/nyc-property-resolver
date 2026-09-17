import { EcbViolation, Prisma, PrismaClient } from '@prisma/client';

import type { PortfolioViolationsQuery } from '../schemas/portfolio-violations-query.schema';

export type PortfolioViolationsPage = {
  violations: EcbViolation[];
  hasMore: boolean;
};

export interface PortfolioViolationsQueryRepositoryPort {
  findPage(query: PortfolioViolationsQuery): Promise<PortfolioViolationsPage>;
}

type QueryExecutor = Pick<Prisma.TransactionClient, '$queryRaw'>;

function buildDefaultCursorPredicate(query: PortfolioViolationsQuery): Prisma.Sql {
  if (query.cursor === undefined || query.updatedSince !== undefined) {
    return Prisma.empty;
  }

  const cursor = query.cursor;
  if (!('issueDate' in cursor)) {
    return Prisma.empty;
  }

  if (cursor.issueDate === null) {
    return Prisma.sql`
      AND live."issue_date" IS NULL
      AND live."source_id" < ${cursor.sourceId}
    `;
  }

  return Prisma.sql`
    AND (
      live."issue_date" < ${cursor.issueDate}::date
      OR (
        live."issue_date" = ${cursor.issueDate}::date
        AND live."source_id" < ${cursor.sourceId}
      )
      OR live."issue_date" IS NULL
    )
  `;
}

function buildUpdatedSinceCursorPredicate(query: PortfolioViolationsQuery): Prisma.Sql {
  if (query.cursor === undefined || query.updatedSince === undefined) {
    return Prisma.empty;
  }

  const cursor = query.cursor;
  if (!('sourceRowUpdatedAt' in cursor)) {
    return Prisma.empty;
  }

  return Prisma.sql`
    AND (
      live."source_row_updated_at" < ${cursor.sourceRowUpdatedAt}::timestamptz
      OR (
        live."source_row_updated_at" = ${cursor.sourceRowUpdatedAt}::timestamptz
        AND live."source_id" < ${cursor.sourceId}
      )
    )
  `;
}

export class PortfolioViolationsQueryRepository implements PortfolioViolationsQueryRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findPage(query: PortfolioViolationsQuery): Promise<PortfolioViolationsPage> {
    return this.findPageWithExecutor(this.prisma, query);
  }

  protected async findPageWithExecutor(
    executor: QueryExecutor,
    query: PortfolioViolationsQuery,
  ): Promise<PortfolioViolationsPage> {
    const unpaidFilter = query.unpaidOnly
      ? Prisma.sql`AND live."balance_due" > 0`
      : Prisma.empty;
    const updatedSinceFilter =
      query.updatedSince === undefined
        ? Prisma.empty
        : Prisma.sql`AND live."source_row_updated_at" > ${query.updatedSince}::timestamptz`;
    const cursorPredicate =
      query.updatedSince === undefined
        ? buildDefaultCursorPredicate(query)
        : buildUpdatedSinceCursorPredicate(query);
    const orderBy =
      query.updatedSince === undefined
        ? Prisma.sql`ORDER BY live."issue_date" DESC NULLS LAST, live."source_id" DESC`
        : Prisma.sql`ORDER BY live."source_row_updated_at" DESC, live."source_id" DESC`;
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
          WHERE property_bin."bin" = live."bin"
        )
        ${unpaidFilter}
        ${updatedSinceFilter}
        ${cursorPredicate}
      ${orderBy}
      LIMIT ${requestedRows}
    `);

    return {
      violations: rows.slice(0, query.limit),
      hasMore: rows.length > query.limit,
    };
  }
}

export function createPortfolioViolationsQueryRepository(
  prisma: PrismaClient,
): PortfolioViolationsQueryRepository {
  return new PortfolioViolationsQueryRepository(prisma);
}
