import { createLogger } from '../../../src/logging/logger';

function captureLogs(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const stream = {
    write(message: string): void {
      lines.push(message);
    },
  };

  return {
    lines,
    logger: createLogger(stream),
  };
}

describe('application logger', () => {
  it('redacts database connection strings from structured logs', () => {
    const { lines, logger } = captureLogs();
    const secretConnectionString = 'postgresql://app:super-secret@db.example:5432/nyc_property_resolver';

    logger.info({ databaseUrl: secretConnectionString }, 'database configured');

    const output = lines.join('');
    expect(output).not.toContain('super-secret');
    expect(output).toContain('[Redacted]');
  });

  it('redacts configured Socrata tokens from structured logs', () => {
    const { lines, logger } = captureLogs();

    logger.info({ socrataAppToken: 'socrata-secret-token' }, 'external client configured');

    const output = lines.join('');
    expect(output).not.toContain('socrata-secret-token');
    expect(output).toContain('[Redacted]');
  });

  it('redacts nested secret fields', () => {
    const { lines, logger } = captureLogs();

    logger.info(
      {
        config: {
          databaseUrl: 'postgresql://app:another-secret@localhost:5432/db',
        },
      },
      'startup configuration loaded',
    );

    const output = lines.join('');
    expect(output).not.toContain('another-secret');
    expect(output).toContain('[Redacted]');
  });
});
