import { createApp } from './app';
import { getConfig } from './config';
import { ConfigError } from './errors/config-error';
import { getLogger } from './logging/logger';

const logger = getLogger();

try {
  const config = getConfig();
  const app = createApp();

  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'API listening');
  });
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error({ message: error.message }, 'Invalid application configuration');
  } else {
    logger.error(
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
      'API failed to start',
    );
  }

  process.exitCode = 1;
}
