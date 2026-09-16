import {
  SOCRATA_REQUEST_ERROR_CODES,
  SocrataRequestExecutor,
} from '../../../src/clients/socrata-request-executor';

function transientHttpError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

describe('SocrataRequestExecutor', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('limits concurrent operations', async () => {
    let active = 0;
    let maximumActive = 0;
    const executor = new SocrataRequestExecutor({
      concurrency: 2,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      retryDelayMs: 0,
    });

    const operation = jest.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return 'ok';
    });

    const executions = await Promise.all(
      Array.from({ length: 8 }, () => executor.executeWithAccounting(operation)),
    );

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(executions).toHaveLength(8);
    expect(executions.every((execution) => execution.retryCalls === 0)).toBe(true);
    expect(executor.getMetrics()).toEqual({ requestCalls: 8, retryCalls: 0 });
    expect(operation).toHaveBeenCalledTimes(8);
  });

  it('keeps retry-call accounting separate from one logical batch attempt', async () => {
    const executor = new SocrataRequestExecutor({
      concurrency: 1,
      requestTimeoutMs: 1_000,
      maxRetries: 2,
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    const operation = jest
      .fn<Promise<string>, [AbortSignal]>()
      .mockRejectedValueOnce(transientHttpError(503))
      .mockResolvedValue('ok');
    let logicalBatchAttempts = 0;

    const executeLogicalBatchAttempt = async () => {
      logicalBatchAttempts += 1;
      return executor.executeWithAccounting(operation);
    };

    await expect(executeLogicalBatchAttempt()).resolves.toMatchObject({
      value: 'ok',
      requestCalls: 2,
      retryCalls: 1,
    });
    expect(logicalBatchAttempts).toBe(1);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(executor.getMetrics()).toEqual({ requestCalls: 2, retryCalls: 1 });
  });

  it('stops retrying persistent transient failures at SOCRATA_MAX_RETRIES', async () => {
    const executor = new SocrataRequestExecutor({
      concurrency: 1,
      requestTimeoutMs: 1_000,
      maxRetries: 2,
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    const error = transientHttpError(503);
    const operation = jest.fn(async () => {
      throw error;
    });

    await expect(executor.executeWithAccounting(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(executor.getMetrics()).toEqual({ requestCalls: 3, retryCalls: 2 });
  });

  it('returns non-retryable failures immediately', async () => {
    const executor = new SocrataRequestExecutor({ maxRetries: 5, retryDelayMs: 0 });
    const error = Object.assign(new Error('bad request'), { statusCode: 400 });
    const operation = jest.fn(async () => {
      throw error;
    });

    await expect(executor.execute(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(executor.getMetrics()).toEqual({ requestCalls: 1, retryCalls: 0 });
  });

  it.each([501, 505])(
    'does not retry permanent HTTP %i responses',
    async (statusCode) => {
      const executor = new SocrataRequestExecutor({
        maxRetries: 5,
        retryDelayMs: 0,
      });
      const error = transientHttpError(statusCode);
      const operation = jest.fn(async () => {
        throw error;
      });

      await expect(executor.execute(operation)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(executor.getMetrics()).toEqual({ requestCalls: 1, retryCalls: 0 });
    },
  );

  it('does not retry a permanent TypeError from request construction', async () => {
    const executor = new SocrataRequestExecutor({
      maxRetries: 5,
      retryDelayMs: 0,
    });
    const error = Object.assign(new TypeError('Invalid URL'), {
      code: 'ERR_INVALID_URL',
    });
    const operation = jest.fn(async () => {
      throw error;
    });

    await expect(executor.execute(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(executor.getMetrics()).toEqual({ requestCalls: 1, retryCalls: 0 });
  });

  it('retries a native fetch TypeError with a transient network cause', async () => {
    const executor = new SocrataRequestExecutor({
      maxRetries: 1,
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    });
    const operation = jest
      .fn<Promise<string>, [AbortSignal]>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');

    await expect(executor.executeWithAccounting(operation)).resolves.toMatchObject({
      value: 'ok',
      requestCalls: 2,
      retryCalls: 1,
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('times out an operation that does not settle after its signal is aborted', async () => {
    const executor = new SocrataRequestExecutor({
      requestTimeoutMs: 10,
      maxRetries: 0,
    });
    let markStarted: (() => void) | undefined;
    let observedAbort = false;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const operation = jest.fn(
      (signal: AbortSignal) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
        });
        return new Promise<string>(() => {
          markStarted?.();
        });
      },
    );

    const result = expect(executor.execute(operation)).rejects.toMatchObject({
      code: SOCRATA_REQUEST_ERROR_CODES.TIMEOUT,
    });
    await started;
    await result;
    expect(observedAbort).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(executor.getMetrics()).toEqual({ requestCalls: 1, retryCalls: 0 });
  });

  it('retries executor-generated timeout errors without exceeding the concurrency bound', async () => {
    const executor = new SocrataRequestExecutor({
      concurrency: 1,
      requestTimeoutMs: 10,
      maxRetries: 1,
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    let active = 0;
    let maximumActive = 0;
    const operation = jest.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          signal.addEventListener('abort', () => {
            active -= 1;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    await expect(executor.executeWithAccounting(operation)).rejects.toMatchObject({
      code: SOCRATA_REQUEST_ERROR_CODES.TIMEOUT,
    });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    expect(executor.getMetrics()).toEqual({ requestCalls: 2, retryCalls: 1 });
  });

  it('does not start a retry while a timed-out operation is still running', async () => {
    const controller = new AbortController();
    const executor = new SocrataRequestExecutor({
      concurrency: 1,
      requestTimeoutMs: 10,
      maxRetries: 1,
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    let active = 0;
    let maximumActive = 0;
    const operation = jest.fn(
      () =>
        new Promise<string>(() => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
        }),
    );

    const pending = executor.executeWithAccounting(operation, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The first call ignores its abort signal, so the retry must stay queued
    // behind the limiter slot it still occupies.
    expect(operation).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);

    controller.abort(new Error('lock lost'));
    await expect(pending).rejects.toMatchObject({
      code: SOCRATA_REQUEST_ERROR_CODES.ABORTED,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);
    expect(executor.getMetrics()).toEqual({ requestCalls: 1, retryCalls: 0 });
  });

  it('propagates caller cancellation without waiting for the operation to settle', async () => {
    const controller = new AbortController();
    const executor = new SocrataRequestExecutor({
      requestTimeoutMs: 1_000,
      maxRetries: 3,
      retryDelayMs: 100,
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedAbort = false;
    const operation = jest.fn(
      (signal: AbortSignal) => {
        markStarted?.();
        signal.addEventListener('abort', () => {
          observedAbort = true;
        });
        return new Promise<string>(() => undefined);
      },
    );

    const promise = executor.executeWithAccounting(operation, controller.signal);
    await started;
    controller.abort(new Error('lock lost'));

    await expect(promise).rejects.toMatchObject({
      code: SOCRATA_REQUEST_ERROR_CODES.ABORTED,
    });
    expect(observedAbort).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(executor.getMetrics()).toEqual({ requestCalls: 1, retryCalls: 0 });
  });

  it('does not start queued work after an external abort', async () => {
    const controller = new AbortController();
    let markFirstStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executor = new SocrataRequestExecutor({
      concurrency: 1,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
    });
    let operationCalls = 0;
    const operation = jest.fn(async (signal: AbortSignal) => {
      operationCalls += 1;
      if (operationCalls === 1) {
        markFirstStarted?.();
        await firstRelease;
      }
      if (signal.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return 'ok';
    });

    const first = executor.execute(operation);
    await firstStarted;
    const pending = executor.execute(operation, controller.signal);
    controller.abort(new Error('lock lost'));

    const pendingOutcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still pending'>((resolve) => {
        setImmediate(() => resolve('still pending'));
      }),
    ]);
    releaseFirst?.();

    await expect(first).resolves.toBe('ok');
    expect(pendingOutcome).toMatchObject({
      code: SOCRATA_REQUEST_ERROR_CODES.ABORTED,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(executor.getMetrics()).toEqual({ requestCalls: 1, retryCalls: 0 });
  });
});
