import express, { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors';
import {
  parseCreatePropertyRequest,
  parsePropertyIdParam,
  serializeStoredProperty,
  toClientErrorResponse,
} from '../schemas/property-api.schema';
import type { PropertyIdentityService } from '../services/property-resolver/property-identity.service';
import type { PropertyResolverService } from '../services/property-resolver/property-resolver.service';

export type PropertiesRouterDependencies = {
  propertyResolver: Pick<PropertyResolverService, 'resolveAddress' | 'resolveBbl'>;
  propertyIdentity: Pick<PropertyIdentityService, 'findPropertyById'>;
};

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
