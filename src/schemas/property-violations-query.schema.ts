import { z } from 'zod';

import { AppError } from '../errors';

export const DEFAULT_PROPERTY_VIOLATIONS_PAGE_SIZE = 50;
export const MAX_PROPERTY_VIOLATIONS_PAGE_SIZE = 100;

const issueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'cursor issueDate must be a calendar date')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'cursor issueDate must be a valid calendar date');

export const propertyViolationsCursorSchema = z
  .object({
    issueDate: issueDateSchema.nullable(),
    sourceId: z.string().min(1, 'cursor sourceId must be non-empty'),
  })
  .strict();

export type PropertyViolationsCursor = z.infer<typeof propertyViolationsCursorSchema>;

function cursorValidationError(message: string, cause?: unknown): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message,
    statusCode: 400,
    cause,
  });
}

export function encodePropertyViolationsCursor(cursor: PropertyViolationsCursor): string {
  const validated = propertyViolationsCursorSchema.parse(cursor);
  return Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
}

export function decodePropertyViolationsCursor(encoded: string): PropertyViolationsCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw cursorValidationError('cursor is malformed');
  }

  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) {
      throw new Error('cursor is not canonical base64url');
    }

    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    return propertyViolationsCursorSchema.parse(payload);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw cursorValidationError('cursor is malformed', error);
  }
}

const strictQueryBoolean = z
  .enum(['true', 'false'], {
    required_error: 'filter must be true or false',
    invalid_type_error: 'filter must be true or false',
  })
  .transform((value) => value === 'true');

const pageSizeSchema = z
  .string({
    required_error: 'limit is required',
    invalid_type_error: 'limit must be a positive integer',
  })
  .regex(/^[1-9]\d*$/, 'limit must be a positive integer')
  .transform((value) => Number(value))
  .refine(
    (value) => value <= MAX_PROPERTY_VIOLATIONS_PAGE_SIZE,
    `limit must be at most ${MAX_PROPERTY_VIOLATIONS_PAGE_SIZE}`,
  );

export const propertyViolationsQuerySchema = z
  .object({
    openOnly: strictQueryBoolean.optional().default('false'),
    unpaidOnly: strictQueryBoolean.optional().default('false'),
    cursor: z.string().min(1, 'cursor must be non-empty').transform(decodePropertyViolationsCursor).optional(),
    limit: pageSizeSchema.optional().default(String(DEFAULT_PROPERTY_VIOLATIONS_PAGE_SIZE)),
  })
  .strict();

export type PropertyViolationsQuery = z.infer<typeof propertyViolationsQuerySchema>;

export function parsePropertyViolationsQuery(input: unknown): PropertyViolationsQuery {
  try {
    return propertyViolationsQuerySchema.parse(input);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof z.ZodError) {
      throw cursorValidationError(
        error.issues.map((issue) => issue.message).join('; '),
        error,
      );
    }

    throw cursorValidationError('ECB violations query validation failed', error);
  }
}
