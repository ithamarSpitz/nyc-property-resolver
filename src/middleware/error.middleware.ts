import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

import { AppError } from '../errors';
import { getLogger } from '../logging/logger';

type ClientError = {
  status: number;
  body: {
    error: {
      code: string;
      message: string;
    };
  };
};

type HttpLikeError = Error & {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
};

const INTERNAL_ERROR: ClientError = {
  status: 500,
  body: {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  },
};

const CLIENT_ERROR_BODY: ClientError['body'] = {
  error: {
    code: 'CLIENT_ERROR',
    message: 'The request could not be completed',
  },
};

function zodClientError(error: ZodError): ClientError {
  return {
    status: 400,
    body: {
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues.map((issue) => issue.message).join('; ') || 'Request validation failed',
      },
    },
  };
}

function appClientError(error: AppError): ClientError {
  const status = error.statusCode;

  if (error.isOperational && status === 400 && error.code === 'VALIDATION_ERROR') {
    if (error.cause instanceof ZodError) {
      return zodClientError(error.cause);
    }

    return {
      status,
      body: {
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' },
      },
    };
  }

  // AppError is also used by upstream clients, including for upstream 4xx
  // responses, so other codes and messages are not safe at the HTTP boundary.
  if (error.isOperational && status !== undefined && status >= 400 && status < 500) {
    return {
      status,
      body: CLIENT_ERROR_BODY,
    };
  }

  return {
    ...INTERNAL_ERROR,
    status: status !== undefined && status >= 500 && status <= 599 ? status : INTERNAL_ERROR.status,
  };
}

function httpParserClientError(error: HttpLikeError): ClientError | undefined {
  if (error.type === 'entity.too.large' || error.status === 413 || error.statusCode === 413) {
    return {
      status: 413,
      body: {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds the configured limit',
        },
      },
    };
  }

  if (
    error instanceof SyntaxError &&
    (error.status === 400 || error.statusCode === 400 || error.type === 'entity.parse.failed')
  ) {
    return {
      status: 400,
      body: {
        error: {
          code: 'INVALID_JSON',
          message: 'Request body contains invalid JSON',
        },
      },
    };
  }

  return undefined;
}

function toClientError(error: unknown): ClientError {
  if (error instanceof ZodError) {
    return zodClientError(error);
  }

  if (error instanceof AppError) {
    return appClientError(error);
  }

  if (error instanceof Error) {
    return httpParserClientError(error as HttpLikeError) ?? INTERNAL_ERROR;
  }

  return INTERNAL_ERROR;
}

function errorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof ZodError) {
    return {
      category: 'validation',
      type: 'ZodError',
      issueCount: error.issues.length,
      issues: error.issues.map((issue) => ({
        code: issue.code,
        pathDepth: issue.path.length,
      })),
    };
  }

  if (error instanceof AppError) {
    return {
      category: 'application',
      type: 'AppError',
      code: error.code,
      statusCode: error.statusCode,
      isOperational: error.isOperational,
      hasCause: error.cause !== undefined,
    };
  }

  if (error instanceof Error) {
    const parserError = error as HttpLikeError;
    const parserType =
      parserError.type === 'entity.too.large' || parserError.type === 'entity.parse.failed'
        ? parserError.type
        : undefined;

    return {
      category: parserType === undefined ? 'unexpected' : 'request-parser',
      type: error instanceof SyntaxError ? 'SyntaxError' : 'Error',
      ...(parserType === undefined ? {} : { parserType }),
    };
  }

  return {
    category: 'unexpected',
    type: typeof error,
  };
}

function matchedRoute(request: Request): string | undefined {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? route.path : undefined;
}

function logError(
  logger: Pick<Logger, 'error'>,
  error: unknown,
  request: Request,
  responseStatus: number,
): void {
  const route = matchedRoute(request);
  const context: Record<string, unknown> = {
    err: errorForLog(error),
    request: {
      method: request.method,
      ...(route === undefined ? {} : { route }),
    },
    responseStatus,
  };

  logger.error(context, 'HTTP request failed');
}

export function createErrorMiddleware(logger: Pick<Logger, 'error'> = getLogger()): ErrorRequestHandler {
  return (error: unknown, request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const clientError = toClientError(error);
    logError(logger, error, request, clientError.status);
    response.status(clientError.status).json(clientError.body);
  };
}

export const errorMiddleware: ErrorRequestHandler = (
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void => createErrorMiddleware()(error, request, response, next);
