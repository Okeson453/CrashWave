/**
 * Health-checked circuit for remote browser-worker.
 */

import { BrowserWorkerHttpClient } from './http-client.js';
import { getLogger } from '../../observability/logger.js';
import { browserProcessUp } from '../../observability/metrics/registry.js';

const logger = getLogger();

export class BrowserWorkerHealthCircuit {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly threshold = 3,
    private readonly coolDownMs = 60_000
  ) {}

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  async probe(): Promise<boolean> {
    const client = BrowserWorkerHttpClient.fromEnv();
    if (!client) {
      browserProcessUp.set(0);
      return false;
    }
    try {
      const ok = await client.health();
      if (ok) {
        this.failures = 0;
        this.openUntil = 0;
        browserProcessUp.set(1);
        return true;
      }
      this.failures += 1;
    } catch {
      this.failures += 1;
    }
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.coolDownMs;
      logger.error(
        { component: 'BrowserWorkerHealthCircuit', failures: this.failures },
        'Browser worker circuit OPEN'
      );
    }
    browserProcessUp.set(0);
    return false;
  }
}

export const globalBrowserWorkerHealth = new BrowserWorkerHealthCircuit();
