import { z } from 'zod';

import { AppError } from '../errors';

export const DEFAULT_PORTFOLIO_VIOLATIONS_PAGE_SIZE = 50;
export const MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE = 100;

const issueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'cursor issueDate must be a calendar date')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'cursor issueDate must be a valid calendar date');

export const portfolioDefaultCursorSchema = z
  .object({
    issueDate: issueDateSchema.nullable(),
    sourceId: z.string().min(1, 'cursor sourceId must be non-empty'),
  })
  .strict();

export type PortfolioDefaultCursor = z.infer<typeof portfolioDefaultCursorSchema>;

export const portfolioUpdatedSinceCursorSchema = z
  .object({
    sourceRowUpdatedAt: z
      .string()
      .min(1, 'cursor sourceRowUpdatedAt must be non-empty')
      .refine(
        (value) => !Number.isNaN(new Date(value).getTime()),
        'cursor sourceRowUpdatedAt must be a valid timestamp',
      ),
    sourceId: z.string().min(1, 'cursor sourceId must be non-empty'),
  })
  .strict();

export type PortfolioUpdatedSinceCursor = z.infer<typeof portfolioUpdatedSinceCursorSchema>;

export type PortfolioViolationsCursor =
  | PortfolioDefaultCursor
  | PortfolioUpdatedSinceCursor;

function cursorValidationError(message: string, cause?: unknown): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message,
    statusCode: 400,
    cause,
  });
}

export function encodePortfolioDefaultCursor(cursor: PortfolioDefaultCursor): string {
  const validated = portfolioDefaultCursorSchema.parse(cursor);
  return Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
}

export function encodePortfolioUpdatedSinceCursor(
  cursor: PortfolioUpdatedSinceCursor,
): string {
  const validated = portfolioUpdatedSinceCursorSchema.parse(cursor);
  return Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
}

export function decodePortfolioViolationsCursor(
  encoded: string,
  useUpdatedSinceOrdering: boolean,
): PortfolioViolationsCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw cursorValidationError('cursor is malformed');
  }

  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) {
      throw new Error('cursor is not canonical base64url');
    }

    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    return useUpdatedSinceOrdering
      ? portfolioUpdatedSinceCursorSchema.parse(payload)
      : portfolioDefaultCursorSchema.parse(payload);
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

const updatedSinceSchema = z
  .string({
    required_error: 'updatedSince is required',
    invalid_type_error: 'updatedSince must be an ISO 8601 timestamp',
  })
  .min(1, 'updatedSince must be a non-empty timestamp')
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    'updatedSince must be a valid timestamp',
  )
  .transform((value) => new Date(value));

const pageSizeSchema = z
  .string({
    required_error: 'limit is required',
    invalid_type_error: 'limit must be a positive integer',
  })
  .regex(/^[1-9]\d*$/, 'limit must be a positive integer')
  .transform((value) => Number(value))
  .refine(
    (value) => value <= MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE,
    `limit must be at most ${MAX_PORTFOLIO_VIOLATIONS_PAGE_SIZE}`,
  );

const portfolioViolationsQueryBaseSchema = z
  .object({
    unpaidOnly: strictQueryBoolean.optional().default('false'),
    updatedSince: updatedSinceSchema.optional(),
    cursor: z.string().min(1, 'cursor must be non-empty').optional(),
    limit: pageSizeSchema.optional().default(String(DEFAULT_PORTFOLIO_VIOLATIONS_PAGE_SIZE)),
  })
  .strict();

export type PortfolioViolationsQuery = {
  unpaidOnly: boolean;
  updatedSince?: Date;
  cursor?: PortfolioViolationsCursor;
  limit: number;
};

export function parsePortfolioViolationsQuery(input: unknown): PortfolioViolationsQuery {
  try {
    const parsed = portfolioViolationsQueryBaseSchema.parse(input);
    const useUpdatedSinceOrdering = parsed.updatedSince !== undefined;

    return {
      unpaidOnly: parsed.unpaidOnly,
      updatedSince: parsed.updatedSince,
      cursor:
        parsed.cursor === undefined
          ? undefined
          : decodePortfolioViolationsCursor(parsed.cursor, useUpdatedSinceOrdering),
      limit: parsed.limit,
    };
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

    throw cursorValidationError('portfolio ECB violations query validation failed', error);
  }
}
