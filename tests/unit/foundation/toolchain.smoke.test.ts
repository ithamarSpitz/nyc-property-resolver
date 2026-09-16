import request from 'supertest';

import { createApp } from '../../../src/app';

describe('toolchain smoke', () => {
  it('executes TypeScript tests through Jest', () => {
    expect(true).toBe(true);
  });

  it('exposes a health endpoint for foundation verification', async () => {
    const app = createApp();
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
