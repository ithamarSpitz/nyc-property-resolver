import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { IngestionRunStatus, IngestionTriggerType, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

import { runManualIngestion } from '../../../src/cli/ingest-ecb';
import { SocrataRequestExecutor } from '../../../src/clients/socrata-request-executor';
import {
  createProductionIngestionRunner,
  startIngestionWorker,
} from '../../../src/workers/ingestion.worker';
import {
  INGESTION_RUNNER_OUTCOMES,
  type IngestionRunnerResult,
} from '../../../src/services/ecb/ingestion-runner.service';
import type { IngestionExecutor } from '../../../src/workers/scheduler';

const describeGate = process.env.API_OPERATIONS_GATE === '1' ? describe : describe.skip;

async function waitForApiHealth(apiBaseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(`${apiBaseUrl}/health`, { signal: controller.signal });
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') {
          return;
        }
      }
    } catch {
      // Retry until the Compose API is reachable.
    } finally {
      clearTimeout(requestTimeout);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`API health check failed for ${apiBaseUrl}`);
}

function isReadableFile(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function readRequiredComposeFile(): string {
  const encoded = process.env.API_OPERATIONS_GATE_COMPOSE_YAML_B64;
  if (encoded !== undefined && encoded.length > 0) {
    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  const candidates = [
    process.env.API_OPERATIONS_GATE_COMPOSE_PATH,
    path.resolve(__dirname, '../../../docker-compose.yml'),
    path.resolve(process.cwd(), 'docker-compose.yml'),
    '/app/docker-compose.yml',
  ].filter((value): value is string => value !== undefined && value.length > 0);

  for (const composePath of candidates) {
    if (isReadableFile(composePath)) {
      return readFileSync(composePath, 'utf8');
    }
  }

  throw new Error(
    'docker-compose.yml is required to prove postgres → migrate → api/worker startup ordering',
  );
}

describeGate('S4 scheduler and CLI integration gate', () => {
  it(
    'preserves postgres -> migrate -> api/worker Compose startup ordering',
    async () => {
      const compose = readRequiredComposeFile();

      expect(compose).toMatch(
        /migrate:[\s\S]*depends_on:[\s\S]*postgres:[\s\S]*condition:\s*service_healthy/,
      );
      expect(compose).toMatch(
        /api:[\s\S]*depends_on:[\s\S]*migrate:[\s\S]*condition:\s*service_completed_successfully/,
      );
      expect(compose).toMatch(
        /worker:[\s\S]*depends_on:[\s\S]*migrate:[\s\S]*condition:\s*service_completed_successfully/,
      );
      expect(compose).toContain('npx", "prisma", "migrate", "deploy"');
      expect(compose).toContain('npm", "run", "start:api"');
      expect(compose).toContain('npm", "run", "start:worker"');

      const apiBaseUrl = process.env.API_OPERATIONS_GATE_API_URL ?? 'http://api:3000';
      await waitForApiHealth(apiBaseUrl);

      const response = await fetch(`${apiBaseUrl}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    },
    60_000,
  );

  it('exposes the manual ingestion npm script expected by the worker image', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const packageJson = require('../../../package.json') as { scripts: Record<string, string> };

    expect(packageJson.scripts['ingest:ecb']).toBe('node dist/cli/ingest-ecb.js');
    expect(packageJson.scripts['start:worker']).toBe('node dist/workers/ingestion.worker.js');
  });

  it('routes scheduled worker and manual CLI execution through the same injectable ingestion boundary', async () => {
    const execute = jest.fn<
      ReturnType<IngestionExecutor['execute']>,
      Parameters<IngestionExecutor['execute']>
    >();
    const requestExecutor = {
      getMetrics: () => ({ requestCalls: 0, retryCalls: 0 }),
    } as unknown as SocrataRequestExecutor;
    const productionDependencies = {
      prisma: {} as PrismaClient,
      runner: { execute },
      dataRequestExecutor: requestExecutor,
      metadataRequestExecutor: requestExecutor,
      loadCounts: async () => ({ rowsFetched: 4, rowsWritten: 4, failedBatches: 0 }),
    };

    execute
      .mockResolvedValueOnce({
        outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
        run: {
          id: 'scheduled-run',
          status: IngestionRunStatus.COMPLETED,
        },
      } as IngestionRunnerResult)
      .mockResolvedValueOnce({
        outcome: INGESTION_RUNNER_OUTCOMES.COMPLETED,
        run: {
          id: 'manual-run',
          status: IngestionRunStatus.COMPLETED,
        },
      } as IngestionRunnerResult);

    const noopLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    const scheduledService = createProductionIngestionRunner(undefined, productionDependencies);
    const worker = startIngestionWorker({
      ingestionService: scheduledService,
      logger: noopLogger,
      disconnect: jest.fn().mockResolvedValue(undefined),
      registerProcessHandlers: false,
      config: {
        ingestIntervalMs: 60_000,
      } as never,
    });

    await worker.shutdown('TEST');

    const manualExitCode = await runManualIngestion({
      ingestionService: createProductionIngestionRunner(undefined, productionDependencies),
      logger: noopLogger,
    });

    expect(manualExitCode).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, {
      triggerType: IngestionTriggerType.SCHEDULED,
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      triggerType: IngestionTriggerType.MANUAL,
    });
  });
});
