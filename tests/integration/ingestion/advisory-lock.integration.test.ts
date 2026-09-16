import { Client } from 'pg';

import {
  EcbIngestionLockService,
  type IngestionLockAcquired,
} from '../../../src/services/ecb/ingestion-lock.service';

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

describeIntegration('ECB advisory-lock session authority', () => {
  const connectionString = process.env.DATABASE_URL as string;
  let owner: IngestionLockAcquired | undefined;
  let competingClient: Client | undefined;

  afterEach(async () => {
    await owner?.lock.release();
    owner = undefined;
    await competingClient?.end().catch(() => undefined);
    competingClient = undefined;
  });

  it('allows one dedicated session to own the lock and reports a competing executor', async () => {
    const first = new EcbIngestionLockService({ connectionString });
    const second = new EcbIngestionLockService({ connectionString });

    const firstResult = await first.acquire();
    expect(firstResult.acquired).toBe(true);
    if (!firstResult.acquired) {
      throw new Error('expected the first client to acquire the advisory lock');
    }
    owner = firstResult;

    const secondResult = await second.acquire();
    expect(secondResult).toEqual({
      acquired: false,
      status: 'ACTIVE_EXECUTOR',
      reason: 'ACTIVE_EXECUTOR',
    });
  });

  it('releases ownership with the session so a later client can acquire it', async () => {
    const first = new EcbIngestionLockService({ connectionString });
    const second = new EcbIngestionLockService({ connectionString });

    const firstResult = await first.acquire();
    expect(firstResult.acquired).toBe(true);
    if (!firstResult.acquired) {
      throw new Error('expected the first client to acquire the advisory lock');
    }
    await firstResult.lock.release();

    const secondResult = await second.acquire();
    expect(secondResult.acquired).toBe(true);
    if (!secondResult.acquired) {
      throw new Error('expected the second client to acquire after release');
    }
    owner = secondResult;
  });

  it('uses a session-level lock rather than an unrelated pooled connection', async () => {
    const first = new EcbIngestionLockService({ connectionString });
    const firstResult = await first.acquire();
    expect(firstResult.acquired).toBe(true);
    if (!firstResult.acquired) {
      throw new Error('expected the first client to acquire the advisory lock');
    }
    owner = firstResult;

    competingClient = new Client({ connectionString });
    await competingClient.connect();
    const lockKey = first.lockKey;
    const result = await competingClient.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [lockKey],
    );
    expect(result.rows[0]?.acquired).toBe(false);
  });
});
