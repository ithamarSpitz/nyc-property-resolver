import { createApp } from './app';
import { getConfig } from './config';
import { getLogger } from './logging/logger';

getConfig();
const logger = getLogger();
const app = createApp();

const server = app.listen(() => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  logger.info({ port }, 'API listening');
});
