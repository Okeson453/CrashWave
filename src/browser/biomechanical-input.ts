/**
 * Biomechanical Input Emulation
 * Bezier trajectories + Poisson-distributed timing.
 * Replaces instant coordinate jumps and static random delays.
 */
import type { Page } from 'playwright';

export interface Point { x: number; y: number; }

/** Cubic Bezier interpolation */
function bezier(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const u = 1 - t;
  const tt = t * t, uu = u * u;
  const uuu = uu * u, ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/** Generate control points with slight overshoot + micro-jitter */
function generateControls(from: Point, to: Point): [Point, Point] {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const mid1 = {
    x: from.x + dx * 0.25 + (Math.random() - 0.5) * dist * 0.15,
    y: from.y + dy * 0.25 + (Math.random() - 0.5) * dist * 0.15,
  };
  const mid2 = {
    x: from.x + dx * 0.75 + (Math.random() - 0.5) * dist * 0.1,
    y: from.y + dy * 0.75 + (Math.random() - 0.5) * dist * 0.1,
  };
  // Overshoot past target then settle
  mid2.x += dx * 0.05; mid2.y += dy * 0.05;
  return [mid1, mid2];
}

/** Poisson-process inter-arrival (exponential) delay in ms */
export function poissonDelay(meanMs: number): number {
  const u = Math.max(1e-9, Math.random());
  return Math.max(1, -Math.log(u) * meanMs);
}

export interface MoveOptions {
  steps?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
}

/**
 * Move mouse along a realistic Bezier path with acceleration profile.
 */
export async function biomechanicalMove(page: Page, to: Point, opts: MoveOptions = {}): Promise<void> {
  const steps = opts.steps ?? Math.max(12, Math.floor(20 + Math.random() * 25));
  const duration = (opts.minDurationMs ?? 180) + Math.random() * ((opts.maxDurationMs ?? 520) - (opts.minDurationMs ?? 180));
  const stepDelay = duration / steps;

  // Playwright doesn't expose current mouse pos reliably; assume last known or start from offset
  const from: Point = { x: to.x - 80 - Math.random() * 120, y: to.y - 40 - Math.random() * 80 };
  const [c1, c2] = generateControls(from, to);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out velocity curve
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const pt = bezier(eased, from, c1, c2, to);
    // Micro-jitter
    pt.x += (Math.random() - 0.5) * 1.2;
    pt.y += (Math.random() - 0.5) * 1.2;
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(stepDelay * (0.7 + Math.random() * 0.6));
  }
}

export async function biomechanicalClick(page: Page, x: number, y: number): Promise<void> {
  await biomechanicalMove(page, { x, y });
  // Pre-click dwell (human hesitation)
  await page.waitForTimeout(poissonDelay(45));
  await page.mouse.down();
  // Click duration — Poisson around ~60-90ms
  await page.waitForTimeout(poissonDelay(70));
  await page.mouse.up();
  // Post-click micro-delay
  await page.waitForTimeout(poissonDelay(30));
}

export async function biomechanicalType(page: Page, selector: string, text: string): Promise<void> {
  await page.focus(selector);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: poissonDelay(55) });
  }
}
