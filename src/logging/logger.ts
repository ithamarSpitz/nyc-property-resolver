import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const REDACT_PATHS = [
  'databaseUrl',
  'DATABASE_URL',
  'socrataAppToken',
  'SOCRATA_APP_TOKEN',
  '*.databaseUrl',
  '*.DATABASE_URL',
  '*.socrataAppToken',
  '*.SOCRATA_APP_TOKEN',
  '*.password',
  '*.secret',
  '*.token',
  '*.connectionString',
  'req.headers.authorization',
];

export function createLoggerOptions(): LoggerOptions {
  return {
    redact: {
      paths: REDACT_PATHS,
      censor: '[Redacted]',
    },
  };
}

export function createLogger(
  destination?: DestinationStream | NodeJS.WritableStream,
): Logger {
  const options = createLoggerOptions();

  if (destination) {
    return pino(options, destination);
  }

  return pino(options);
}

let cachedLogger: Logger | undefined;

export function getLogger(): Logger {
  if (!cachedLogger) {
    cachedLogger = createLogger();
  }

  return cachedLogger;
}

export function resetLoggerCache(): void {
  cachedLogger = undefined;
}
