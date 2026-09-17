import type { Logger } from 'pino';

import { runManualIngestion, MANUAL_INGESTION_EXIT_CODES } from '../../../src/cli/ingest-ecb';
import { CONFIG_DEFAULTS, loadConfig } from '../../../src/config';

function loggerMock(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
}

describe('manual ingestion publication diagnostics', () => {
  it('retains Prisma error type, code, and complete message without source data', async () => {
    const logger = loggerMock();
    const error = Object.assign(
      new Error('Transaction already closed: timeout was 5000 ms'),
      { name: 'PrismaClientKnownRequestError', code: 'P2028' },
    );
    const sourcePayload = 'source-payload-must-not-be-logged';
    const secret = 'database-secret-must-not-be-logged';
    const ingestionService = {
      execute: jest.fn().mockRejectedValue(error),
      sourcePayload,
      secret,
    };

    await expect(runManualIngestion({ ingestionService, logger })).resolves.toBe(
      MANUAL_INGESTION_EXIT_CODES.FAILURE,
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'PrismaClientKnownRequestError',
        errorCode: 'P2028',
        errorMessage: error.message,
      }),
      'ECB manual ingestion failed',
    );
    const logged = JSON.stringify((logger.error as jest.Mock).mock.calls);
    expect(logged).not.toContain(sourcePayload);
    expect(logged).not.toContain(secret);
  });

  it('loads an independent positive finite accepted-publication timeout', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://example.invalid/db',
      ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS: '45000',
      TERMINAL_PUBLICATION_TRANSACTION_TIMEOUT_MS: '12000',
    });

    expect(config.acceptedPublicationTransactionTimeoutMs).toBe(45_000);
    expect(config.terminalPublicationTransactionTimeoutMs).toBe(12_000);
    expect(CONFIG_DEFAULTS.ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(CONFIG_DEFAULTS.ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS)).toBe(true);

    for (const invalid of ['0', '-1', 'Infinity', '1.5']) {
      expect(() => loadConfig({
        DATABASE_URL: 'postgresql://example.invalid/db',
        ACCEPTED_PUBLICATION_TRANSACTION_TIMEOUT_MS: invalid,
      })).toThrow();
    }
  });
});
