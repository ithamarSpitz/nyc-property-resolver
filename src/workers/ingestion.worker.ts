import { getConfig } from '../config';
import { getLogger } from '../logging/logger';

function shutdown(signal: string, keepAlive: NodeJS.Timeout, logger: ReturnType<typeof getLogger>): void {
  logger.info({ signal }, 'Ingestion worker shutting down');
  clearInterval(keepAlive);
  process.exit(0);
}

function main(): void {
  const config = getConfig();
  const logger = getLogger();
  const keepAlive = setInterval(() => {
    // Hold the process open until a shutdown signal is received.
  }, 60_000);

  process.on('SIGTERM', () => shutdown('SIGTERM', keepAlive, logger));
  process.on('SIGINT', () => shutdown('SIGINT', keepAlive, logger));

  logger.info(
    {
      ingestIntervalMs: config.ingestIntervalMs,
      ecbBatchSize: config.ecbBatchSize,
    },
    'Ingestion worker started',
  );
}

main();
