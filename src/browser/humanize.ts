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
  mouseStepsMin: 8,
  mouseStepsMax: 22,
  mouseOvershootPx: 12,
  clickDelayMinMs: 35,
  clickDelayMaxMs: 130,
  typeDelayMinMs: 30,
  typeDelayMaxMs: 95,
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

    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    const box = await locator.boundingBox();
    if (!box) {
      await locator.click({
        delay: rand(this.config.clickDelayMinMs, this.config.clickDelayMaxMs),
      });
      return;
    }

    const target = {
      x: box.x + box.width / 2 + rand(-4, 4),
      y: box.y + box.height / 2 + rand(-3, 3),
    };
    const from = {
      x: target.x + rand(-120, 120),
      y: target.y + rand(-80, 80),
    };

    const steps = rand(this.config.mouseStepsMin, this.config.mouseStepsMax);
    const path = generatePath(from, target, steps, this.config.mouseOvershootPx);

    for (const point of path) {
      await page.mouse.move(point.x, point.y);
      await sleep(rand(4, 14));
    }

    await sleep(rand(25, 70));
    await page.mouse.click(target.x, target.y, {
      delay: rand(this.config.clickDelayMinMs, this.config.clickDelayMaxMs),
    });

    (metricCollector as any).recordHumanizedClick?.();
    logger.debug({ component: 'Humanizer' }, 'Humanized click completed');
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
