import express, { type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import type { AppConfig } from '../config';

export type HttpSecurityConfig = Pick<AppConfig, 'apiRateLimit' | 'apiBodyLimit'>;

function configuredRateLimit(value: string | undefined): number {
  if (value === undefined) {
    throw new Error('API_RATE_LIMIT must be configured before creating HTTP middleware');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('API_RATE_LIMIT must be a positive integer');
  }

  return parsed;
}

export function createRateLimitMiddleware(config: Pick<AppConfig, 'apiRateLimit'>): RequestHandler {
  return rateLimit({
    limit: configuredRateLimit(config.apiRateLimit),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
}

export function createHelmetMiddleware(): RequestHandler {
  return helmet();
}

export function createJsonBodyMiddleware(config: Pick<AppConfig, 'apiBodyLimit'>): RequestHandler {
  return express.json({ limit: config.apiBodyLimit });
}

/**
 * Middleware in the architecture-defined order. Application routes are mounted
 * after these handlers; the terminal error middleware is mounted last.
 */
export function createHttpSecurityMiddleware(config: HttpSecurityConfig): RequestHandler[] {
  return [
    createRateLimitMiddleware(config),
    createHelmetMiddleware(),
    createJsonBodyMiddleware(config),
  ];
}

export const createSecurityMiddleware = createHttpSecurityMiddleware;
