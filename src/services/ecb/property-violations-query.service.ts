import type { EcbViolation, PrismaClient, PropertyDatasetCoverage } from '@prisma/client';

import {
  createPropertyViolationsQueryRepository,
  type PropertyViolationsQueryRepositoryPort,
} from '../../db/property-violations-query.repository';
import {
  encodePropertyViolationsCursor,
  parsePropertyViolationsQuery,
} from '../../schemas/property-violations-query.schema';

export type PropertyViolationsQueryResult = {
  violations: EcbViolation[];
  coverage: PropertyDatasetCoverage | null;
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export class PropertyViolationsQueryService {
  constructor(private readonly repository: PropertyViolationsQueryRepositoryPort) {}

  async query(propertyId: string, rawQuery: unknown): Promise<PropertyViolationsQueryResult> {
    // Validation deliberately precedes every repository operation so malformed
    // input cannot reach PostgreSQL (or any future dependency).
    const query = parsePropertyViolationsQuery(rawQuery);

    // Coverage remains independent of page contents, while both facts are
    // loaded from one database snapshot so publication or identifier changes
    // cannot produce a hybrid response.
    const { page, coverage } = await this.repository.findSnapshot(propertyId, query);

    const lastViolation = page.violations.at(-1);
    const nextCursor =
      page.hasMore && lastViolation !== undefined
        ? encodePropertyViolationsCursor({
            issueDate: lastViolation.issueDate?.toISOString().slice(0, 10) ?? null,
            sourceId: lastViolation.sourceId,
          })
        : null;

    return {
      violations: page.violations,
      coverage,
      page: {
        limit: query.limit,
        hasMore: page.hasMore,
        nextCursor,
      },
    };
  }

  async getPropertyViolations(
    propertyId: string,
    rawQuery: unknown,
  ): Promise<PropertyViolationsQueryResult> {
    return this.query(propertyId, rawQuery);
  }
}

export function createPropertyViolationsQueryService(
  prisma: PrismaClient,
): PropertyViolationsQueryService {
  return new PropertyViolationsQueryService(createPropertyViolationsQueryRepository(prisma));
}
