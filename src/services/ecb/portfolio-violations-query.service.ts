import type { EcbViolation, PrismaClient } from '@prisma/client';

import {
  createPortfolioViolationsQueryRepository,
  type PortfolioViolationsQueryRepositoryPort,
} from '../../db/portfolio-violations-query.repository';
import {
  encodePortfolioDefaultCursor,
  encodePortfolioUpdatedSinceCursor,
  parsePortfolioViolationsQuery,
} from '../../schemas/portfolio-violations-query.schema';

export type PortfolioViolationsQueryResult = {
  violations: EcbViolation[];
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export class PortfolioViolationsQueryService {
  constructor(private readonly repository: PortfolioViolationsQueryRepositoryPort) {}

  async query(rawQuery: unknown): Promise<PortfolioViolationsQueryResult> {
    const query = parsePortfolioViolationsQuery(rawQuery);
    const page = await this.repository.findPage(query);

    const lastViolation = page.violations.at(-1);
    const nextCursor =
      page.hasMore && lastViolation !== undefined
        ? query.updatedSince === undefined
          ? encodePortfolioDefaultCursor({
              issueDate: lastViolation.issueDate?.toISOString().slice(0, 10) ?? null,
              sourceId: lastViolation.sourceId,
            })
          : encodePortfolioUpdatedSinceCursor({
              sourceRowUpdatedAt: lastViolation.sourceRowUpdatedAt.toISOString(),
              sourceId: lastViolation.sourceId,
            })
        : null;

    return {
      violations: page.violations,
      page: {
        limit: query.limit,
        hasMore: page.hasMore,
        nextCursor,
      },
    };
  }
}

export function createPortfolioViolationsQueryService(
  prisma: PrismaClient,
): PortfolioViolationsQueryService {
  return new PortfolioViolationsQueryService(createPortfolioViolationsQueryRepository(prisma));
}
