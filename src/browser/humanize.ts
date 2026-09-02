/**
 * Advanced behavioral humanization — minimum-jerk trajectories, overshoot, variable delays.
 */

import { Page, Locator } from 'playwright';
import { BehavioralConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { metricCollector } from '../observability/metrics/collectors';

const logger = getLogger();

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Quadratic bezier path with optional overshoot correction */
function generatePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  overshootPx: number
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const midX = (from.x + to.x) / 2 + rand(-40, 40);
  const midY = (from.y + to.y) / 2 + rand(-30, 30);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * midX + t * t * to.x;
    const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * midY + t * t * to.y;
    points.push({ x, y });
  }

  if (overshootPx > 0) {
    const last = points[points.length - 1];
    points.push({
      x: last.x + rand(-overshootPx, overshootPx),
      y: last.y + rand(-overshootPx, overshootPx),
    });
    points.push({ x: to.x, y: to.y });
  }
  return points;
}

const DEFAULT_BEHAVIORAL: BehavioralConfig = {
  enabled: true,
  minActionDelayMs: 80,
  maxActionDelayMs: 250,
  typingWpmMin: 180,
  typingWpmMax: 320,
  mouseJitterPx: 3,
  scrollProbability: 0.15,
  mouseStepsMin: 8,
  mouseStepsMax: 22,
  mouseOvershootPx: 12,
  clickDelayMinMs: 35,
  clickDelayMaxMs: 130,
  typeDelayMinMs: 30,
  typeDelayMaxMs: 95,
};

/** V1.1 critical-path profile: still humanized, tighter latency (design §1.4 browser 70–200ms) */
const FAST_PATH_BEHAVIORAL: BehavioralConfig = {
  enabled: true,
  minActionDelayMs: 15,
  maxActionDelayMs: 45,
  typingWpmMin: 250,
  typingWpmMax: 400,
  mouseJitterPx: 1,
  scrollProbability: 0.05,
  mouseStepsMin: 3,
  mouseStepsMax: 7,
  mouseOvershootPx: 4,
  clickDelayMinMs: 15,
  clickDelayMaxMs: 45,
  typeDelayMinMs: 15,
  typeDelayMaxMs: 40,
};

import { biomechanicalClick } from './biomechanical-input';

export class Humanizer {
  private readonly config: BehavioralConfig;

  constructor(config?: Partial<BehavioralConfig>) {
    this.config = { ...DEFAULT_BEHAVIORAL, ...config };
  }

  async click(page: Page, selector: string | Locator): Promise<void> {
    const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;

    if (!this.config.enabled) {
      await locator.click();
      return;
    }

    await this.clickInternal(page, locator, this.config, false);
  }

  /**
   * V1.1 fast-path click for time-critical actions (place bet / cash-out).
   * Shorter trajectory and delays while remaining non-instant.
   */
  async clickFast(page: Page, selector: string | Locator): Promise<void> {
    const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
    if (!this.config.enabled) {
      await locator.click();
      return;
    }
    await this.clickInternal(page, locator, FAST_PATH_BEHAVIORAL, true);
  }

  private async clickInternal(
    page: Page,
    locator: Locator,
    cfg: BehavioralConfig,
    fast: boolean
  ): Promise<void> {
    await locator.waitFor({ state: 'visible', timeout: fast ? 4_000 : 10_000 });
    const box = await locator.boundingBox();
    if (!box) {
      await locator.click({
        delay: rand(cfg.clickDelayMinMs, cfg.clickDelayMaxMs),
      });
      return;
    }

    const jitter = fast ? 2 : 4;
    const target = {
      x: box.x + box.width / 2 + rand(-jitter, jitter),
      y: box.y + box.height / 2 + rand(-Math.max(1, jitter - 1), Math.max(1, jitter - 1)),
    };
    const from = {
      x: target.x + rand(fast ? -40 : -120, fast ? 40 : 120),
      y: target.y + rand(fast ? -30 : -80, fast ? 30 : 80),
    };

    const steps = rand(cfg.mouseStepsMin, cfg.mouseStepsMax);
    const path = generatePath(from, target, steps, cfg.mouseOvershootPx);

    for (const point of path) {
      await page.mouse.move(point.x, point.y);
      await sleep(rand(fast ? 2 : 4, fast ? 6 : 14));
    }

    await sleep(rand(fast ? 8 : 25, fast ? 25 : 70));
    await page.mouse.click(target.x, target.y, {
      delay: rand(cfg.clickDelayMinMs, cfg.clickDelayMaxMs),
    });

    (metricCollector as any).recordHumanizedClick?.();
    logger.debug({ component: 'Humanizer', fast }, 'Humanized click completed');
  }

  async type(page: Page, selector: string | Locator, text: string): Promise<void> {
    const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;

    if (!this.config.enabled) {
      await locator.fill(text);
      return;
    }

    await this.click(page, locator);
    await sleep(rand(60, 160));

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await sleep(rand(30, 80));

    for (const char of text) {
      await page.keyboard.type(char, {
        delay: rand(this.config.typeDelayMinMs, this.config.typeDelayMaxMs),
      });
    }
  }
}

/** Convenience wrappers (backward compatible with earlier humanize helpers) */
export async function humanClick(
  page: Page,
  selector: string,
  options?: { delay?: number }
): Promise<void> {
  const h = new Humanizer(
    options?.delay
      ? { clickDelayMinMs: options.delay, clickDelayMaxMs: options.delay + 20 }
      : undefined
  );
  await h.click(page, selector);
}

export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  const h = new Humanizer();
  await h.type(page, selector, text);
}


/** Prefer biomechanical path when stealth upgrade is enabled */
export async function clickWithBiomechanics(page: import('playwright').Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    await page.locator(selector).first().click();
    return;
  }
  await biomechanicalClick(page, box.x + box.width / 2, box.y + box.height / 2);
}
