/**
 * HumanInput layer (R1-C) — highest-leverage anti-detection defence.
 * All live placement/cash-out paths must go through this; observation-only can skip.
 */

import { Page, Locator } from 'playwright';
import { getLogger } from '../observability/logger';

export interface HumanInputOptions {
  enabled: boolean;
  minActionDelayMs: number;
  maxActionDelayMs: number;
  mouseBezier: boolean;
  typeInsteadOfFill: boolean;
  requirePrecedingMouseMove: boolean;
  keyDwellMinMs: number;
  keyDwellMaxMs: number;
}

const DEFAULTS: HumanInputOptions = {
  enabled: true,
  minActionDelayMs: 70,
  maxActionDelayMs: 450,
  mouseBezier: true,
  typeInsteadOfFill: true,
  requirePrecedingMouseMove: true,
  keyDwellMinMs: 60,
  keyDwellMaxMs: 220,
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cubic bezier point */
function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export class HumanInput {
  private readonly options: HumanInputOptions;
  private readonly logger = getLogger();
  private lastX = 100;
  private lastY = 100;

  constructor(
    private readonly page: Page,
    options?: Partial<HumanInputOptions>
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  async randomDelay(): Promise<void> {
    if (!this.options.enabled) return;
    await sleep(rand(this.options.minActionDelayMs, this.options.maxActionDelayMs));
  }

  /**
   * Move mouse along a multi-segment bezier path with micro-jitter.
   */
  async moveMouseTo(x: number, y: number, steps = 20): Promise<void> {
    if (!this.options.enabled) {
      await this.page.mouse.move(x, y);
      this.lastX = x;
      this.lastY = y;
      return;
    }

    const startX = this.lastX;
    const startY = this.lastY;
    const cp1x = startX + (x - startX) * rand(0.2, 0.4) + rand(-30, 30);
    const cp1y = startY + (y - startY) * rand(0.1, 0.3) + rand(-20, 20);
    const cp2x = startX + (x - startX) * rand(0.6, 0.8) + rand(-20, 20);
    const cp2y = startY + (y - startY) * rand(0.7, 0.9) + rand(-15, 15);

    const n = this.options.mouseBezier ? Math.max(12, steps) : Math.max(5, Math.floor(steps / 2));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      // ease-in-out acceleration
      const te = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      let mx = bezier(te, startX, cp1x, cp2x, x);
      let my = bezier(te, startY, cp1y, cp2y, y);
      mx += rand(-0.6, 0.6);
      my += rand(-0.6, 0.6);
      await this.page.mouse.move(mx, my);
      await sleep(rand(4, 18));
    }
    this.lastX = x;
    this.lastY = y;
  }

  /**
   * Ensure a non-zero mouse-move stream before a sensitive action.
   */
  async ensurePrecedingMouseMove(): Promise<void> {
    if (!this.options.enabled || !this.options.requirePrecedingMouseMove) return;
    const viewport = this.page.viewportSize() ?? { width: 1366, height: 900 };
    const tx = rand(80, Math.max(120, viewport.width - 80));
    const ty = rand(80, Math.max(120, viewport.height - 80));
    await this.moveMouseTo(tx, ty, 16);
    await this.randomDelay();
  }

  /**
   * Human-like click on a locator (move to box center + delay + click).
   */
  async click(locator: Locator): Promise<void> {
    await this.ensurePrecedingMouseMove();
    const box = await locator.boundingBox();
    if (box) {
      const x = box.x + box.width * rand(0.3, 0.7);
      const y = box.y + box.height * rand(0.3, 0.7);
      await this.moveMouseTo(x, y, 18);
      await sleep(rand(40, 120));
      await this.page.mouse.down();
      await sleep(rand(30, 90));
      await this.page.mouse.up();
    } else {
      await locator.click({ delay: this.options.enabled ? rand(40, 120) : 0 });
    }
    await this.randomDelay();
  }

  /**
   * Type text with variable key dwell; never use fill() when humanize is on.
   */
  async typeText(locator: Locator, text: string): Promise<void> {
    await this.ensurePrecedingMouseMove();
    await locator.click({ clickCount: 3 }).catch(() => locator.click());
    await sleep(rand(50, 150));

    if (!this.options.enabled || !this.options.typeInsteadOfFill) {
      await locator.fill(text);
      return;
    }

    // Clear existing
    await this.page.keyboard.press('Control+A').catch(() => undefined);
    await this.page.keyboard.press('Backspace').catch(() => undefined);
    await sleep(rand(30, 80));

    for (const ch of text) {
      await this.page.keyboard.type(ch, {
        delay: rand(this.options.keyDwellMinMs, this.options.keyDwellMaxMs),
      });
    }
    await this.randomDelay();
  }

  /**
   * Convenience: focus field, clear, type stake amount.
   */
  async typeStake(locator: Locator, amount: number | string): Promise<void> {
    const text = String(amount);
    this.logger.debug({ component: 'HumanInput', chars: text.length }, 'Typing stake');
    await this.typeText(locator, text);
  }
}
