import { createApp } from './app';
import { getConfig } from './config';
import { getLogger } from './logging/logger';

const config = getConfig();
const logger = getLogger();
const app = createApp();

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'API listening');
});
