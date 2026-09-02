/**
 * Idle Behavior Loop — realistic activity between crash rounds.
 * Hover, micro-moves, optional scroll — never touches bet placement.
 */

import { Page } from 'playwright';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

export interface IdleBehaviorConfig {
  enabled: boolean;
  /** Max actions per idle window */
  maxActions: number;
  /** Probability of scrolling history/chat */
  scrollProbability: number;
  /** Rest near edges occasionally */
  edgeRestProbability: number;
}

const DEFAULT_IDLE: IdleBehaviorConfig = {
  enabled: true,
  maxActions: 3,
  scrollProbability: 0.35,
  edgeRestProbability: 0.25,
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class IdleBehaviorEngine {
  private readonly cfg: IdleBehaviorConfig;

  constructor(cfg: Partial<IdleBehaviorConfig> = {}) {
    this.cfg = { ...DEFAULT_IDLE, ...cfg };
  }

  /**
   * Run a short idle routine. Safe to call between rounds.
   * Never clicks bet/cashout selectors.
   */
  async runBetweenRounds(page: Page): Promise<void> {
    if (!this.cfg.enabled) return;
    try {
      const viewport = page.viewportSize() ?? { width: 1366, height: 900 };
      const actions = 1 + Math.floor(Math.random() * this.cfg.maxActions);

      for (let i = 0; i < actions; i++) {
        const roll = Math.random();
        if (roll < this.cfg.scrollProbability) {
          await this.softScroll(page);
        } else if (roll < this.cfg.scrollProbability + this.cfg.edgeRestProbability) {
          await this.moveToRest(page, viewport, true);
        } else {
          await this.moveToRest(page, viewport, false);
        }
        await sleep(rand(120, 600));
      }
    } catch (err) {
      logger.debug(
        { component: 'IdleBehavior', error: String(err) },
        'Idle behavior skipped (non-fatal)'
      );
    }
  }

  private async moveToRest(
    page: Page,
    viewport: { width: number; height: number },
    edge: boolean
  ): Promise<void> {
    let x: number;
    let y: number;
    if (edge) {
      const side = Math.floor(Math.random() * 4);
      if (side === 0) {
        x = rand(5, 40);
        y = rand(80, viewport.height - 80);
      } else if (side === 1) {
        x = rand(viewport.width - 40, viewport.width - 5);
        y = rand(80, viewport.height - 80);
      } else if (side === 2) {
        x = rand(40, viewport.width - 40);
        y = rand(5, 50);
      } else {
        x = rand(40, viewport.width - 40);
        y = rand(viewport.height - 60, viewport.height - 10);
      }
    } else {
      x = rand(viewport.width * 0.2, viewport.width * 0.8);
      y = rand(viewport.height * 0.2, viewport.height * 0.7);
    }
    await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 12) });
  }

  private async softScroll(page: Page): Promise<void> {
    const deltaY = rand(-180, 220);
    await page.mouse.wheel(0, deltaY);
    await sleep(rand(80, 250));
    // small corrective scroll (humans overshoot)
    if (Math.random() < 0.4) {
      await page.mouse.wheel(0, -deltaY * rand(0.15, 0.35));
    }
  }
}
