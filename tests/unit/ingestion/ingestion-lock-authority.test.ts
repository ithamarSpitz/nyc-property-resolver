import { EventEmitter } from 'node:events';

import {
  EcbIngestionLockService,
  IngestionAuthorityLostError,
  deriveDatasetLockKey,
  type IngestionLockClient,
} from '../../../src/services/ecb/ingestion-lock.service';

class FakeLockClient extends EventEmitter implements IngestionLockClient {
  readonly connect = jest.fn(async () => undefined);
  readonly end = jest.fn(async () => {
    this.emit('end');
    this.endStarted?.();
    await this.endGate;
  });
  readonly queries: Array<{ query: string; values: unknown[] }> = [];
  queryResult = { acquired: true };
  endGate: Promise<void> | undefined;
  endStarted: (() => void) | undefined;

  async query(query: string, values: unknown[] = []): Promise<{ rows: Array<{ acquired: boolean }> }> {
    this.queries.push({ query, values });
    return { rows: [this.queryResult] };
  }
}

describe('ECB ingestion lock authority', () => {
  it('derives a stable, dataset-specific advisory lock key', () => {
    expect(deriveDatasetLockKey()).toBe(deriveDatasetLockKey('DOB_ECB_VIOLATIONS'));
    expect(deriveDatasetLockKey('DOB_ECB_VIOLATIONS')).not.toBe(deriveDatasetLockKey('other-dataset'));
  });

  it('returns an explicit active-executor result without waiting when acquisition fails', async () => {
    const client = new FakeLockClient();
    client.queryResult = { acquired: false };
    const service = new EcbIngestionLockService({
      connectionString: 'postgresql://test',
      clientFactory: () => client,
    });

    await expect(service.acquire()).resolves.toEqual({
      acquired: false,
      status: 'ACTIVE_EXECUTOR',
      reason: 'ACTIVE_EXECUTOR',
    });
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(client.queries[0]?.query).toContain('pg_try_advisory_lock');
  });

  it.each([
    ['error', (client: FakeLockClient) => client.emit('error', new Error('socket reset'))],
    ['end', (client: FakeLockClient) => client.emit('end')],
  ])('revokes authority and aborts exactly once on unexpected client %s', async (_event, loseSession) => {
    const client = new FakeLockClient();
    const service = new EcbIngestionLockService({
      connectionString: 'postgresql://test',
      clientFactory: () => client,
    });
    const result = await service.acquire();

    if (!result.acquired) {
      throw new Error('expected the fake client to acquire the lock');
    }

    let abortCount = 0;
    result.signal.addEventListener('abort', () => abortCount++);
    loseSession(client);
    loseSession(client);

    expect(result.authority.executionAuthorized).toBe(false);
    expect(result.signal.aborted).toBe(true);
    expect(abortCount).toBe(1);
    expect(() => result.authority.assertAuthorized('mark batch complete')).toThrow(IngestionAuthorityLostError);
    expect(() => service.assertAuthorized('publish run')).toThrow(IngestionAuthorityLostError);
  });

  it('does not treat intentional release as authority loss', async () => {
    const client = new FakeLockClient();
    const service = new EcbIngestionLockService({
      connectionString: 'postgresql://test',
      clientFactory: () => client,
    });
    const result = await service.acquire();

    if (!result.acquired) {
      throw new Error('expected the fake client to acquire the lock');
    }

    let abortCount = 0;
    result.signal.addEventListener('abort', () => abortCount++);
    await result.lock.release();
    await result.lock.release();

    expect(abortCount).toBe(0);
    expect(result.signal.aborted).toBe(false);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(client.queries.at(-1)?.query).toContain('pg_advisory_unlock');
  });

  it('waits for an in-flight release before allowing a new acquisition', async () => {
    const client = new FakeLockClient();
    let resolveEnd!: () => void;
    client.endGate = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const endStarted = new Promise<void>((resolve) => {
      client.endStarted = resolve;
    });
    const service = new EcbIngestionLockService({
      connectionString: 'postgresql://test',
      clientFactory: () => client,
    });

    const result = await service.acquire();
    if (!result.acquired) {
      throw new Error('expected the fake client to acquire the lock');
    }

    const firstRelease = service.release();
    await endStarted;
    const secondRelease = service.release();

    await expect(service.acquire()).rejects.toThrow('already acquired');

    let secondReleaseFinished = false;
    void secondRelease.then(() => {
      secondReleaseFinished = true;
    });
    await Promise.resolve();
    expect(secondReleaseFinished).toBe(false);

    resolveEnd();
    await Promise.all([firstRelease, secondRelease]);
    expect(service.checkAuthorized()).toBe(false);
  });
});
