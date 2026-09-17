import express from 'express';
import request from 'supertest';
import { z } from 'zod';

import { loadConfig } from '../../../src/config';
import { AppError } from '../../../src/errors';
import { createErrorMiddleware } from '../../../src/middleware/error.middleware';
import { createHttpSecurityMiddleware } from '../../../src/middleware/security.middleware';
import {
  parseCreatePropertyRequest,
  parsePropertyIdParam,
} from '../../../src/schemas/property-api.schema';

function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DATABASE_URL: 'postgresql://app:secret@localhost:5432/test',
    API_RATE_LIMIT: '100',
    API_BODY_LIMIT: '1kb',
    ...overrides,
  });
}

function createTestApp(
  logger: { error: jest.Mock } = { error: jest.fn() },
  overrides: NodeJS.ProcessEnv = {},
) {
  const app = express();
  app.use(...createHttpSecurityMiddleware(testConfig(overrides)));
  app.post('/echo', (req, res) => res.json(req.body));
  app.get('/zod-error', () => {
    z.object({ id: z.string().uuid('id must be a UUID') }).parse({ id: 'invalid' });
  });
  app.post('/validation/property', (req, res) => {
    res.json(parseCreatePropertyRequest(req.body));
  });
  app.get('/validation/property/:id', (req, res) => {
    res.json(parsePropertyIdParam(req.params));
  });
  app.get('/app-error', () => {
    throw new AppError({
      code: 'PROPERTY_NOT_FOUND',
      message: 'Property not found',
      statusCode: 404,
    });
  });
  app.get('/upstream-client-error', () => {
    throw new AppError({
      code: 'PLUTO_HTTP_ERROR',
      message: 'PLUTO request failed with status 429; token=upstream-secret',
      statusCode: 429,
    });
  });
  app.get('/internal-error', () => {
    throw new AppError({
      code: 'DATABASE_FAILURE',
      message: 'database password=top-secret connection refused',
      statusCode: 500,
      cause: new Error('postgresql://app:cause-secret@localhost/database'),
    });
  });
  app.use(createErrorMiddleware(logger));
  return app;
}

describe('HTTP security and error middleware', () => {
  it('installs standard Helmet security headers', async () => {
    const response = await request(createTestApp()).post('/echo').send({ ok: true });

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('uses the configured body limit and rejects oversized JSON', async () => {
    const response = await request(createTestApp()).post('/echo').send({ value: 'x'.repeat(2_000) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the configured limit',
      },
    });
  });

  it('uses the configured request limit', async () => {
    const app = createTestApp(undefined, { API_RATE_LIMIT: '1' });

    const first = await request(app).post('/echo').send({ ok: true });
    const second = await request(app).post('/echo').send({ ok: true });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.ratelimit).toContain('limit=1');
  });

  it('fails fast when no configured rate limit is supplied', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://localhost/test' });

    expect(() => createHttpSecurityMiddleware(config)).toThrow(
      'API_RATE_LIMIT must be configured before creating HTTP middleware',
    );
  });

  it('maps Zod and operational application errors to stable client responses', async () => {
    const app = createTestApp();

    const validation = await request(app).get('/zod-error');
    const application = await request(app).get('/app-error');

    expect(validation.status).toBe(400);
    expect(validation.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
    });
    expect(application.status).toBe(404);
    expect(application.body).toEqual({
      error: { code: 'CLIENT_ERROR', message: 'The request could not be completed' },
    });
    expect(JSON.stringify(validation.body)).not.toContain('stack');
    expect(JSON.stringify(application.body)).not.toContain('stack');
  });

  it.each([
    ['body', 'Request must include exactly one of address or bbl'],
    ['params', 'Property id must be a valid UUID'],
  ])('preserves wrapped validation errors from the property %s parser', async (source, message) => {
    const app = createTestApp();
    const response = source === 'body'
      ? await request(app).post('/validation/property').send({})
      : await request(app).get('/validation/property/invalid');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message },
    });
    expect(JSON.stringify(response.body)).not.toContain('stack');
    expect(JSON.stringify(response.body)).not.toContain('cause');
  });

  it('does not expose upstream details carried by a 4xx AppError', async () => {
    const response = await request(createTestApp()).get('/upstream-client-error');

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: { code: 'CLIENT_ERROR', message: 'The request could not be completed' },
    });
    expect(JSON.stringify(response.body)).not.toContain('PLUTO_HTTP_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('upstream-secret');
  });

  it('logs detailed internal context while returning a generic response', async () => {
    const logger = { error: jest.fn() };
    const response = await request(createTestApp(logger)).get(
      '/internal-error?token=query-secret',
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('top-secret');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: {
          category: 'application',
          type: 'AppError',
          code: 'DATABASE_FAILURE',
          statusCode: 500,
          isOperational: true,
          hasCause: true,
        },
        request: { method: 'GET', route: '/internal-error' },
        responseStatus: 500,
      }),
      'HTTP request failed',
    );
    const serializedLogCalls = JSON.stringify(logger.error.mock.calls);
    expect(serializedLogCalls).not.toContain('top-secret');
    expect(serializedLogCalls).not.toContain('cause-secret');
    expect(serializedLogCalls).not.toContain('query-secret');
  });
});
