/**
 * Browser Worker entry — PLATFORM_MODE=browser-worker
 *
 * Deploy this process only in a region where BC.Game officially permits access.
 * Control plane (Telegram, billing, Redis/Postgres) stays on Railway or elsewhere.
 */

import { BrowserWorkerServer } from './server';
import type { AppConfig } from '../../config/schema';
import { getLogger } from '../../observability/logger';

export { BrowserWorkerServer } from './server';
export { BrowserWorkerClient, createBrowserWorkerClientFromEnv, isRemoteBrowserWorkerConfigured } from './client';
export type {
  BrowserWorkerCommand,
  BrowserWorkerRequest,
  BrowserWorkerResponse,
  BrowserWorkerAccessCode,
} from './types';

export async function startBrowserWorker(config: AppConfig): Promise<{ stop: () => Promise<void> }> {
  const logger = getLogger();
  const server = new BrowserWorkerServer({
    config,
    port: parseInt(process.env.BROWSER_WORKER_PORT ?? '8090', 10),
    authToken: process.env.BROWSER_WORKER_TOKEN,
    workerId: process.env.BROWSER_WORKER_ID,
    regionHint: process.env.BROWSER_WORKER_REGION,
  });
  await server.start();
  logger.info(
    {
      component: 'BrowserWorker',
      region: process.env.BROWSER_WORKER_REGION ?? 'unknown',
    },
    'Browser worker mode active — Playwright owned by this process only'
  );
  return {
    stop: () => server.stop(),
  };
}
