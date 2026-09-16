import Bottleneck from 'bottleneck';
import type { Logger } from 'pino';

import { CONFIG_DEFAULTS } from '../config/defaults';
import type { AppConfig } from '../config/env';
import { AppError } from '../errors';

export const SOCRATA_REQUEST_ERROR_CODES = {
  ABORTED: 'SOCRATA_REQUEST_ABORTED',
  TIMEOUT: 'SOCRATA_REQUEST_TIMEOUT',
} as const;

type SocrataConfigValues = Pick<
  AppConfig,
  'socrataConcurrency' | 'socrataRequestTimeoutMs' | 'socrataMaxRetries'
>;

export type SocrataRequestOperation<T> = (
  signal: AbortSignal,
) => PromiseLike<T> | T;

export type SocrataRetryClassifier = (error: unknown) => boolean;

export type SocrataRequestExecution<T> = {
  /** The value returned by the supplied operation. */
  value: T;
  /** Alias for consumers that call the operation's value a result. */
  result: T;
  /** Number of retry HTTP calls, excluding the first request call. */
  retryCalls: number;
  /** Total operation calls, including the first request call. */
  requestCalls: number;
};

export type SocrataRequestMetrics = {
  requestCalls: number;
  retryCalls: number;
};

export type SocrataRequestExecutorOptions = Partial<SocrataConfigValues> & {
  config?: Partial<SocrataConfigValues> & {
    /** Optional future-compatible pacing value; not part of the current S2-T1 config. */
    socrataPacingMs?: number;
    socrataMinTimeMs?: number;
  };
  /** Direct override for the Bottleneck maxConcurrent setting. */
  concurrency?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  /** Delay between the starts of all requests, passed to Bottleneck as minTime. */
  minTimeMs?: number;
  /** Alias for minTimeMs. */
  pacingMs?: number;
  /** Constant or retry-number-aware delay before a retry is queued. */
  retryDelayMs?: number | ((retryNumber: number, error: unknown) => number);
  /** Alias for retryDelayMs, useful when callers describe this as backoff. */
  backoffMs?: number | ((retryNumber: number, error: unknown) => number);
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  classifyError?: SocrataRetryClassifier;
  logger?: Logger;
};

const RETRYABLE_HTTP_STATUS_CODES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  SOCRATA_REQUEST_ERROR_CODES.TIMEOUT,
]);

function numericProperty(error: object, key: string): number | undefined {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Classifies the transient failures produced by native fetch and Socrata HTTP clients.
 * Callers can replace this with a source-specific classifier when necessary.
 */
function hasRetryableSocrataErrorDetails(
  error: unknown,
  visited: Set<object>,
): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  if (visited.has(error)) {
    return false;
  }
  visited.add(error);

  const candidate = error as Record<string, unknown>;
  if (
    candidate.retryable === true ||
    candidate.isRetryable === true ||
    candidate.transient === true
  ) {
    return true;
  }

  if (candidate.retryable === false || candidate.isRetryable === false) {
    return false;
  }

  const statusCode = numericProperty(error, 'statusCode') ?? numericProperty(error, 'status');
  if (statusCode !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) {
    return true;
  }

  const code = candidate.code;
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  // Native fetch wraps transport failures in TypeError and exposes the
  // actionable network error on `cause`. TypeError alone is not sufficient:
  // it also represents permanent failures such as an invalid request URL.
  return hasRetryableSocrataErrorDetails(candidate.cause, visited);
}

export function isRetryableSocrataError(error: unknown): boolean {
  return hasRetryableSocrataErrorDetails(error, new Set<object>());
}

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value < 1)
  ) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }

  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }

  return value;
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      (error as Error & { code?: unknown }).code === 'ABORT_ERR')
  );
}

function createAbortError(reason: unknown): AppError {
  return new AppError({
    code: SOCRATA_REQUEST_ERROR_CODES.ABORTED,
    message: 'Socrata request was aborted by the caller',
    cause: reason,
  });
}

function createTimeoutError(timeoutMs: number, cause: unknown): AppError {
  return new AppError({
    code: SOCRATA_REQUEST_ERROR_CODES.TIMEOUT,
    message: `Socrata request timed out after ${timeoutMs}ms`,
    cause,
  });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError(signal.reason));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class SocrataRequestExecutor {
  readonly limiter: Bottleneck;

  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelay: number | ((retryNumber: number, error: unknown) => number);
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly classifyError: SocrataRetryClassifier;
  private readonly logger?: Logger;
  private totalRequestCalls = 0;
  private totalRetryCalls = 0;

  constructor(options: SocrataRequestExecutorOptions = {}) {
    const config = options.config ?? {};
    const concurrency = positiveInteger(
      options.concurrency ?? options.socrataConcurrency ?? config.socrataConcurrency ?? CONFIG_DEFAULTS.SOCRATA_CONCURRENCY,
      'SOCRATA_CONCURRENCY',
    );
    const minTimeMs = nonNegativeFinite(
      options.minTimeMs ??
        options.pacingMs ??
        config.socrataPacingMs ??
        config.socrataMinTimeMs ??
        0,
      'SOCRATA pacing',
    );

    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ??
        options.socrataRequestTimeoutMs ??
        config.socrataRequestTimeoutMs ??
        CONFIG_DEFAULTS.SOCRATA_REQUEST_TIMEOUT_MS,
      'SOCRATA_REQUEST_TIMEOUT_MS',
    );
    this.maxRetries = positiveInteger(
      options.maxRetries ??
        options.socrataMaxRetries ??
        config.socrataMaxRetries ??
        CONFIG_DEFAULTS.SOCRATA_MAX_RETRIES,
      'SOCRATA_MAX_RETRIES',
      true,
    );
    this.retryDelay = options.retryDelayMs ?? options.backoffMs ?? 0;
    if (typeof this.retryDelay === 'number') {
      nonNegativeFinite(this.retryDelay, 'retry delay');
    }
    this.sleep = options.sleep ?? defaultSleep;
    this.classifyError = options.classifyError ?? isRetryableSocrataError;
    this.logger = options.logger;
    this.limiter = new Bottleneck({
      maxConcurrent: concurrency,
      minTime: minTimeMs,
    });
  }

  /** Execute an operation and return only its value. Per-call accounting is available via executeWithAccounting. */
  async execute<T>(
    operation: SocrataRequestOperation<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const execution = await this.executeWithAccounting(operation, signal);
    return execution.value;
  }

  /** Execute an operation and return request/retry counts for this logical caller operation. */
  async executeWithAccounting<T>(
    operation: SocrataRequestOperation<T>,
    signal?: AbortSignal,
  ): Promise<SocrataRequestExecution<T>> {
    let requestCalls = 0;

    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        this.throwIfAborted(signal);

        try {
          const attemptOutcome = this.scheduleAttempt(operation, signal, () => {
            requestCalls += 1;
          });
          const value = await this.waitForScheduledAttempt(attemptOutcome, signal);

          const retryCalls = requestCalls - 1;
          return { value, result: value, requestCalls, retryCalls };
        } catch (error) {
          if (signal?.aborted) {
            throw createAbortError(signal.reason);
          }

          if (attempt >= this.maxRetries || !this.classifyError(error)) {
            throw error;
          }

          const retryNumber = attempt + 1;
          const delayMs =
            typeof this.retryDelay === 'function'
              ? this.retryDelay(retryNumber, error)
              : this.retryDelay;
          nonNegativeFinite(delayMs, 'retry delay');

          this.logger?.debug({ retryNumber, delayMs }, 'retrying Socrata request');
          await this.waitForRetry(delayMs, signal);
        }
      }

      throw new Error('Socrata request retry loop exhausted unexpectedly');
    } finally {
      const retryCalls = Math.max(0, requestCalls - 1);
      this.totalRequestCalls += requestCalls;
      this.totalRetryCalls += retryCalls;
    }
  }

  /** Returns cumulative counts for all operation calls made by this executor. */
  getMetrics(): SocrataRequestMetrics {
    return {
      requestCalls: this.totalRequestCalls,
      retryCalls: this.totalRetryCalls,
    };
  }

  get retryCalls(): number {
    return this.totalRetryCalls;
  }

  async stop(): Promise<void> {
    await this.limiter.stop({ dropWaitingJobs: true });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
  }

  private waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    const retrySignal = signal ?? new AbortController().signal;
    this.throwIfAborted(signal);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        retrySignal.removeEventListener('abort', onAbort);
        reject(createAbortError(retrySignal.reason));
      };
      const complete = () => {
        if (settled) {
          return;
        }
        settled = true;
        retrySignal.removeEventListener('abort', onAbort);
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        retrySignal.removeEventListener('abort', onAbort);
        reject(error);
      };

      retrySignal.addEventListener('abort', onAbort, { once: true });
      try {
        void this.sleep(delayMs, retrySignal).then(complete, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  private waitForScheduledAttempt<T>(
    scheduledAttempt: PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) {
      return Promise.resolve(scheduledAttempt);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(createAbortError(signal.reason));
      };
      const complete = (value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }

      // Keep observing the Bottleneck promise after caller cancellation so a
      // later rejection from the cancelled logical attempt is always handled.
      void Promise.resolve(scheduledAttempt).then(complete, fail);
    });
  }

  private scheduleAttempt<T>(
    operation: SocrataRequestOperation<T>,
    externalSignal: AbortSignal | undefined,
    onRequestStart: () => void,
  ): Promise<T> {
    const outcome = createDeferred<T>();
    const scheduled = this.limiter.schedule(() =>
      this.runAttempt(operation, outcome, externalSignal, onRequestStart),
    );

    // A job rejected or dropped by the limiter itself never reaches runAttempt,
    // so its failure has to settle the outcome here.
    void scheduled.then(undefined, (error: unknown) => {
      outcome.reject(error);
    });

    return outcome.promise;
  }

  /**
   * Runs one request attempt inside a limiter job. Timeout and caller
   * cancellation settle the caller-facing outcome immediately, but the job keeps
   * holding its limiter slot until the supplied operation actually settles, so a
   * cancelled request can never run concurrently with its own retry.
   */
  private async runAttempt<T>(
    operation: SocrataRequestOperation<T>,
    outcome: Deferred<T>,
    externalSignal: AbortSignal | undefined,
    onRequestStart: () => void,
  ): Promise<void> {
    this.throwIfAborted(externalSignal);

    const controller = new AbortController();
    let cancellationError: AppError | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    let detachExternalAbort = () => {};

    const releaseCancellationResources = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      detachExternalAbort();
    };
    const cancel = (error: AppError, reason: unknown) => {
      if (cancellationError) {
        return;
      }

      cancellationError = error;
      releaseCancellationResources();
      controller.abort(reason);
      outcome.reject(error);
    };
    const onExternalAbort = () => {
      cancel(createAbortError(externalSignal?.reason), externalSignal?.reason);
    };

    try {
      if (externalSignal) {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        detachExternalAbort = () => {
          externalSignal.removeEventListener('abort', onExternalAbort);
        };

        if (externalSignal.aborted) {
          onExternalAbort();
          return;
        }
      }

      timeoutId = setTimeout(() => {
        cancel(
          createTimeoutError(this.requestTimeoutMs, undefined),
          undefined,
        );
      }, this.requestTimeoutMs);

      onRequestStart();
      let operationPromise: Promise<T>;
      try {
        operationPromise = Promise.resolve(operation(controller.signal));
      } catch (error) {
        operationPromise = Promise.reject(error);
      }

      try {
        outcome.resolve(await operationPromise);
      } catch (error) {
        if (cancellationError) {
          outcome.reject(cancellationError);
        } else if (isAbortLikeError(error)) {
          outcome.reject(createAbortError(error));
        } else {
          outcome.reject(error);
        }
      }
    } finally {
      releaseCancellationResources();
    }
  }
}
