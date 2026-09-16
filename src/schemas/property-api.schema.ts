import { z } from 'zod';

import { AppError } from '../errors';
import type { PropertyWithRelations } from '../services/property-resolver/property-identity.service';

const createPropertyRequestBaseSchema = z.object({
  address: z.string().trim().min(1, 'address must be a non-empty string').optional(),
  bbl: z.string().trim().min(1, 'bbl must be a non-empty string').optional(),
});

export const createPropertyRequestSchema = createPropertyRequestBaseSchema.superRefine(
  (value, context) => {
    const hasAddress = value.address !== undefined;
    const hasBbl = value.bbl !== undefined;

    if (hasAddress === hasBbl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Request must include exactly one of address or bbl',
        path: [],
      });
    }
  },
);

export const propertyIdParamSchema = z.object({
  id: z.string().uuid('Property id must be a valid UUID'),
});

export type CreatePropertyRequest = z.infer<typeof createPropertyRequestSchema>;

export type StoredPropertyResponse = {
  id: string;
  identifierVersion: number;
  bbl: string;
  condoBaseBbl: string | null;
  condoBillingBbl: string | null;
  normalizedAddress: string | null;
  borough: number;
  block: number;
  lot: number;
  bins: string[];
  createdAt: string;
  resolvedAt: string;
};

export type ClientErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export function parseCreatePropertyRequest(input: unknown): CreatePropertyRequest {
  try {
    return createPropertyRequestSchema.parse(input);
  } catch (error) {
    throw toValidationAppError(error);
  }
}

export function parsePropertyIdParam(input: unknown): z.infer<typeof propertyIdParamSchema> {
  try {
    return propertyIdParamSchema.parse(input);
  } catch (error) {
    throw toValidationAppError(error);
  }
}

export function serializeStoredProperty(property: PropertyWithRelations): StoredPropertyResponse {
  return {
    id: property.id,
    identifierVersion: property.identifierVersion,
    bbl: property.bbl,
    condoBaseBbl: property.condoBaseBbl,
    condoBillingBbl: property.condoBillingBbl,
    normalizedAddress: property.normalizedAddress,
    borough: property.borough,
    block: property.block,
    lot: property.lot,
    bins: property.bins.map((row) => row.bin),
    createdAt: property.createdAt.toISOString(),
    resolvedAt: property.resolvedAt.toISOString(),
  };
}

function toValidationAppError(error: unknown): AppError {
  if (error instanceof z.ZodError) {
    const message = error.issues.map((issue) => issue.message).join('; ');
    return new AppError({
      code: 'VALIDATION_ERROR',
      message,
      statusCode: 400,
      cause: error,
    });
  }

  return new AppError({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    statusCode: 400,
    cause: error,
  });
}

export function toClientErrorResponse(error: AppError): ClientErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}
