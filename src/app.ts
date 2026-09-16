import express from 'express';

export function createApp(): express.Application {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}
