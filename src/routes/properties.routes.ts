import type { EcbViolation, PropertyDatasetCoverage } from '@prisma/client';
import express, { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors';
import {
  parseCreatePropertyRequest,
  parsePropertyIdParam,
  serializeStoredProperty,
  toClientErrorResponse,
} from '../schemas/property-api.schema';
import type { PropertyViolationsQueryService } from '../services/ecb/property-violations-query.service';
import type { PropertyIdentityService } from '../services/property-resolver/property-identity.service';
import type { PropertyResolverService } from '../services/property-resolver/property-resolver.service';

export type PropertyEcbViolationResponse = {
  sourceId: string;
  bin: string;
  violationNumber: string | null;
  issueDate: string | null;
  ecbViolationStatus: string | null;
  balanceDue: string | null;
  sourceRowUpdatedAt: string;
};

export type PropertyEcbCoverageResponse = {
  status: string;
  statusReason: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  sourceWatermarkAt: string | null;
  lastError: string | null;
};

export type PropertyEcbViolationsHttpResponse = {
  violations: PropertyEcbViolationResponse[];
  coverage: PropertyEcbCoverageResponse | null;
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type PropertiesRouterDependencies = {
  propertyResolver: Pick<PropertyResolverService, 'resolveAddress' | 'resolveBbl'>;
  propertyIdentity: Pick<PropertyIdentityService, 'findPropertyById'>;
  propertyViolationsQuery?: Pick<PropertyViolationsQueryService, 'query'>;
};

function serializeEcbViolation(violation: EcbViolation): PropertyEcbViolationResponse {
  return {
    sourceId: violation.sourceId,
    bin: violation.bin,
    violationNumber: violation.violationNumber,
    issueDate: violation.issueDate?.toISOString().slice(0, 10) ?? null,
    ecbViolationStatus: violation.ecbViolationStatus,
    balanceDue: violation.balanceDue === null ? null : violation.balanceDue.toString(),
    sourceRowUpdatedAt: violation.sourceRowUpdatedAt.toISOString(),
  };
}

function serializePropertyEcbCoverage(
  coverage: PropertyDatasetCoverage | null,
): PropertyEcbCoverageResponse | null {
  if (coverage === null) {
    return null;
  }

  return {
    status: coverage.status,
    statusReason: coverage.statusReason,
    lastAttemptAt: coverage.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: coverage.lastSuccessAt?.toISOString() ?? null,
    sourceWatermarkAt: coverage.sourceWatermarkAt?.toISOString() ?? null,
    lastError: coverage.lastError,
  };
}

function sendAppError(response: Response, error: AppError): void {
  response.status(error.statusCode ?? 500).json(toClientErrorResponse(error));
}

function handleRouteError(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof AppError) {
    sendAppError(response, error);
    return;
  }

  next(error);
}

export function createPropertiesRouter(
  dependencies: PropertiesRouterDependencies,
): express.Router {
  const router = express.Router();

  router.post('/', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const payload = parseCreatePropertyRequest(request.body);

      const result =
        payload.address !== undefined
          ? await dependencies.propertyResolver.resolveAddress(payload.address)
          : await dependencies.propertyResolver.resolveBbl(payload.bbl!);

      response.status(200).json(serializeStoredProperty(result.property));
    } catch (error) {
      handleRouteError(error, response, next);
    }
  });

  if (dependencies.propertyViolationsQuery !== undefined) {
    router.get(
      '/:id/ecb-violations',
      async (request: Request, response: Response, next: NextFunction) => {
        try {
          const { id } = parsePropertyIdParam(request.params);
          const property = await dependencies.propertyIdentity.findPropertyById(id);

          if (property === null) {
            sendAppError(
              response,
              new AppError({
                code: 'PROPERTY_NOT_FOUND',
                message: 'Property not found',
                statusCode: 404,
              }),
            );
            return;
          }

          const result = await dependencies.propertyViolationsQuery!.query(id, request.query);

          response.status(200).json({
            violations: result.violations.map(serializeEcbViolation),
            coverage: serializePropertyEcbCoverage(result.coverage),
            page: {
              limit: result.page.limit,
              hasMore: result.page.hasMore,
              nextCursor: result.page.nextCursor,
            },
          });
        } catch (error) {
          handleRouteError(error, response, next);
        }
      },
    );
  }

  router.get('/:id', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const { id } = parsePropertyIdParam(request.params);
      const property = await dependencies.propertyIdentity.findPropertyById(id);

      if (property === null) {
        sendAppError(
          response,
          new AppError({
            code: 'PROPERTY_NOT_FOUND',
            message: 'Property not found',
            statusCode: 404,
          }),
        );
        return;
      }

      response.status(200).json(serializeStoredProperty(property));
    } catch (error) {
      handleRouteError(error, response, next);
    }
  });

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    sendAppError(
      response,
      new AppError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        statusCode: 500,
        cause: error,
        isOperational: false,
      }),
    );
  });

  return router;
}
