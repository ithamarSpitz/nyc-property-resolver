import express, { NextFunction, Request, Response } from 'express';
import type { EcbViolation } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { createErrorMiddleware } from '../middleware/error.middleware';
import type {
  PortfolioViolationsQueryResult,
  PortfolioViolationsQueryService,
} from '../services/ecb/portfolio-violations-query.service';

export type PortfolioViolationResponse = {
  id: string;
  sourceId: string;
  socrataRowId: string;
  bin: string;
  violationNumber: string | null;
  issueDate: string | null;
  ecbViolationStatus: string | null;
  balanceDue: string | null;
  sourceRowUpdatedAt: string;
  lastSuccessRunId: string;
  isCurrent: boolean;
};

export type PortfolioViolationsHttpResponse = {
  violations: PortfolioViolationResponse[];
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type ViolationsRouterDependencies = {
  portfolioViolationsQuery: Pick<PortfolioViolationsQueryService, 'query'>;
};

function serializeDecimal(value: Prisma.Decimal | string | number | null): string | null {
  if (value === null) {
    return null;
  }

  return new Prisma.Decimal(value.toString()).toFixed(2);
}

function serializeIssueDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export function serializePortfolioViolation(
  violation: EcbViolation,
): PortfolioViolationResponse {
  return {
    id: violation.id,
    sourceId: violation.sourceId,
    socrataRowId: violation.socrataRowId,
    bin: violation.bin,
    violationNumber: violation.violationNumber,
    issueDate: serializeIssueDate(violation.issueDate),
    ecbViolationStatus: violation.ecbViolationStatus,
    balanceDue: serializeDecimal(violation.balanceDue),
    sourceRowUpdatedAt: violation.sourceRowUpdatedAt.toISOString(),
    lastSuccessRunId: violation.lastSuccessRunId,
    isCurrent: violation.isCurrent,
  };
}

export function serializePortfolioViolationsResponse(
  result: PortfolioViolationsQueryResult,
): PortfolioViolationsHttpResponse {
  return {
    violations: result.violations.map(serializePortfolioViolation),
    page: result.page,
  };
}

export function createViolationsRouter(
  dependencies: ViolationsRouterDependencies,
): express.Router {
  const router = express.Router();

  router.get('/ecb-violations', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const result = await dependencies.portfolioViolationsQuery.query(request.query);
      response.status(200).json(serializePortfolioViolationsResponse(result));
    } catch (error) {
      next(error);
    }
  });

  router.use(createErrorMiddleware());

  return router;
}
