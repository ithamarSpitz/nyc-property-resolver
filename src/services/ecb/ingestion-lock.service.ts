import { Client } from 'pg';

export const ECB_DATASET = 'DOB_ECB_VIOLATIONS' as const;

const LOCK_NAMESPACE = 'nyc-property-resolver:ecb-ingestion:';
const ADVISORY_LOCK_QUERY = 'SELECT pg_try_advisory_lock($1::bigint) AS acquired';
const ADVISORY_UNLOCK_QUERY = 'SELECT pg_advisory_unlock($1::bigint) AS released';

type LockQueryRow = {
  acquired?: boolean | string;
  released?: boolean | string;
};

/** The intentionally small surface needed from the dedicated lock session. */
export interface IngestionLockClient {
  connect(): Promise<void>;
  query(query: string, values?: unknown[]): Promise<{ rows: LockQueryRow[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
  removeListener?(event: 'error', listener: (error: Error) => void): this;
  removeListener?(event: 'end', listener: () => void): this;
}

export type IngestionLockClientFactory = (connectionString: string) => IngestionLockClient;

export type IngestionLockServiceOptions = {
  connectionString: string;
  dataset?: string;
  clientFactory?: IngestionLockClientFactory;
};

export class IngestionAuthorityLostError extends Error {
  readonly code = 'INGESTION_AUTHORITY_LOST';

  constructor(operation: string, reason: string) {
    super(`Cannot ${operation}: ECB ingestion execution authority was lost (${reason})`);
    this.name = 'IngestionAuthorityLostError';
  }
}

/**
 * Returns a stable signed int32 key for a dataset. PostgreSQL supports this
 * form of advisory lock key directly and the namespace avoids sharing keys
 * with unrelated application locks.
 */
export function deriveDatasetLockKey(dataset: string = ECB_DATASET): number {
  let hash = 0x811c9dc5;
  for (const character of `${LOCK_NAMESPACE}${dataset}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }

  const key = hash | 0;
  return key === 0 ? 1 : key;
}

export const getDatasetLockKey = deriveDatasetLockKey;

export class IngestionExecutionAuthority {
  private authorized = true;
  private revoked = false;
  private readonly abortController = new AbortController();

  get executionAuthorized(): boolean {
    return this.authorized;
  }

  get isAuthorized(): boolean {
    return this.authorized;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Guard state-changing run, batch, and publication operations. */
  assertAuthorized(operation = 'perform a state-changing ingestion operation'): void {
    if (!this.authorized) {
      throw new IngestionAuthorityLostError(operation, 'lock session ended');
    }
  }

  checkAuthorized(): boolean {
    return this.authorized;
  }

  /** Internal transition used by the lock lease when its client is lost. */
  revoke(reason: string): void {
    if (this.revoked) {
      return;
    }

    this.revoked = true;
    this.authorized = false;
    this.abortController.abort(reason);
  }

  /** Internal transition for intentional release; it must not abort work. */
  deactivate(): void {
    this.authorized = false;
  }
}

export type IngestionLockAcquired = {
  acquired: true;
  status: 'ACQUIRED';
  lock: IngestionLockLease;
  authority: IngestionExecutionAuthority;
  signal: AbortSignal;
};

export type IngestionLockActiveExecutor = {
  acquired: false;
  status: 'ACTIVE_EXECUTOR';
  reason: 'ACTIVE_EXECUTOR';
};

export type IngestionLockAcquisitionResult = IngestionLockAcquired | IngestionLockActiveExecutor;

export class IngestionLockLease {
  private active = true;
  private cleanupStarted = false;
  private cleanupPromise: Promise<void> | undefined;

  constructor(
    private readonly client: IngestionLockClient,
    private readonly lockKey: number,
    readonly authority: IngestionExecutionAuthority,
    private readonly onSessionLoss: (reason: string) => void,
    private readonly errorHandler: (error: Error) => void,
    private readonly endHandler: () => void,
  ) {}

  get signal(): AbortSignal {
    return this.authority.signal;
  }

  get executionAuthorized(): boolean {
    return this.authority.executionAuthorized;
  }

  get isAuthorized(): boolean {
    return this.authority.isAuthorized;
  }

  assertAuthorized(operation?: string): void {
    this.authority.assertAuthorized(operation);
  }

  checkAuthorized(): boolean {
    return this.authority.checkAuthorized();
  }

  /** Release the session lock and close the dedicated connection. */
  release(): Promise<void> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    if (!this.active) {
      return Promise.resolve();
    }

    this.cleanupStarted = true;
    this.authority.deactivate();
    this.cleanupPromise = this.finishRelease();
    return this.cleanupPromise;
  }

  private async finishRelease(): Promise<void> {
    try {
      await this.client.query(ADVISORY_UNLOCK_QUERY, [this.lockKey]);
    } catch {
      // A dead client has already released its session-level lock.
    } finally {
      try {
        await this.client.end();
      } catch {
        // Cleanup is deliberately tolerant of a connection that died first.
      }
      this.removeHandlers();
      this.active = false;
    }
  }

  private removeHandlers(): void {
    this.client.removeListener?.('error', this.errorHandler);
    this.client.removeListener?.('end', this.endHandler);
  }

  /** Internal handler used by the service; retained here for lease ownership. */
  handleUnexpectedSessionLoss(reason: string): void {
    if (!this.active || this.cleanupStarted) {
      return;
    }

    this.onSessionLoss(reason);
  }
}

export class EcbIngestionLockService {
  private readonly connectionString: string;
  private readonly dataset: string;
  private readonly clientFactory: IngestionLockClientFactory;
  private lease: IngestionLockLease | undefined;

  constructor(options: IngestionLockServiceOptions);
  constructor(connectionString: string, options?: Omit<IngestionLockServiceOptions, 'connectionString'>);
  constructor(
    optionsOrConnectionString: IngestionLockServiceOptions | string,
    options: Omit<IngestionLockServiceOptions, 'connectionString'> = {},
  ) {
    if (typeof optionsOrConnectionString === 'string') {
      this.connectionString = optionsOrConnectionString;
      this.dataset = options.dataset ?? ECB_DATASET;
      this.clientFactory = options.clientFactory ?? defaultClientFactory;
    } else {
      this.connectionString = optionsOrConnectionString.connectionString;
      this.dataset = optionsOrConnectionString.dataset ?? ECB_DATASET;
      this.clientFactory = optionsOrConnectionString.clientFactory ?? defaultClientFactory;
    }
  }

  get lockKey(): number {
    return deriveDatasetLockKey(this.dataset);
  }

  get authority(): IngestionExecutionAuthority | undefined {
    return this.lease?.authority;
  }

  get signal(): AbortSignal | undefined {
    return this.lease?.signal;
  }

  get executionAuthorized(): boolean {
    return this.lease?.executionAuthorized ?? false;
  }

  get isAuthorized(): boolean {
    return this.lease?.isAuthorized ?? false;
  }

  assertAuthorized(operation?: string): void {
    if (!this.lease) {
      throw new IngestionAuthorityLostError(operation ?? 'perform a state-changing ingestion operation', 'lock not acquired');
    }
    this.lease.assertAuthorized(operation);
  }

  checkAuthorized(): boolean {
    return this.lease?.checkAuthorized() ?? false;
  }

  async acquire(): Promise<IngestionLockAcquisitionResult> {
    if (this.lease) {
      throw new Error('ECB ingestion lock is already acquired by this service');
    }

    const client = this.clientFactory(this.connectionString);
    let lease: IngestionLockLease | undefined;

    const revoke = (reason: string): void => {
      lease?.authority.revoke(reason);
    };
    const errorHandler = (error: Error): void => {
      if (lease) {
        lease.handleUnexpectedSessionLoss(`client error: ${error.message}`);
      }
    };
    const endHandler = (): void => {
      if (lease) {
        lease.handleUnexpectedSessionLoss('client ended unexpectedly');
      }
    };

    client.on('error', errorHandler);
    client.on('end', endHandler);

    try {
      await client.connect();
      const result = await client.query(ADVISORY_LOCK_QUERY, [this.lockKey]);
      const acquired = parsePostgresBoolean(result.rows[0]?.acquired);

      if (!acquired) {
        try {
          await client.end();
        } catch {
          // There is no owned lock to release; the competing session may have died.
        }
        removeClientHandlers(client, errorHandler, endHandler);
        return { acquired: false, status: 'ACTIVE_EXECUTOR', reason: 'ACTIVE_EXECUTOR' };
      }

      const authority = new IngestionExecutionAuthority();
      lease = new IngestionLockLease(client, this.lockKey, authority, revoke, errorHandler, endHandler);
      this.lease = lease;

      return {
        acquired: true,
        status: 'ACQUIRED',
        lock: lease,
        authority,
        signal: authority.signal,
      };
    } catch (error) {
      try {
        await client.end();
      } catch {
        // Preserve the acquisition error when the connection also failed.
      }
      removeClientHandlers(client, errorHandler, endHandler);
      throw error;
    }
  }

  async release(): Promise<void> {
    const lease = this.lease;
    if (!lease) {
      return;
    }

    await lease.release();
    if (this.lease === lease) {
      this.lease = undefined;
    }
  }
}

function parsePostgresBoolean(value: boolean | string | undefined): boolean {
  return value === true || value === 't' || value === 'true';
}

function removeClientHandlers(
  client: IngestionLockClient,
  errorHandler: (error: Error) => void,
  endHandler: () => void,
): void {
  client.removeListener?.('error', errorHandler);
  client.removeListener?.('end', endHandler);
}

function defaultClientFactory(connectionString: string): IngestionLockClient {
  return new Client({ connectionString }) as unknown as IngestionLockClient;
}

export const IngestionLockService = EcbIngestionLockService;
export const createEcbIngestionLockService = (
  options: IngestionLockServiceOptions,
): EcbIngestionLockService => new EcbIngestionLockService(options);
