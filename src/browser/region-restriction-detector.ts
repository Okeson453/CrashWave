/**
 * Region restriction detector for BC.Game pages.
 * Distinct from ordinary auth-required — geo-blocks must not be reported as login failures.
 */
import type { Page } from 'playwright';

export type RegionRestrictionKind = 'geo_block' | 'interstitial' | 'unknown';

export interface RegionRestrictionResult {
  restricted: boolean;
  kind?: RegionRestrictionKind;
  detail?: string;
  currentUrl?: string;
  suggestedAction?: string;
}

const BODY_PATTERNS: RegExp[] = [
  /access denied/i,
  /not available/i,
  /restricted/i,
  /unavailable in your region/i,
  /unavailable in your country/i,
  /country not supported/i,
  /service not available/i,
  /blocked from your location/i,
  /vpn detected/i,
  /proxy detected/i,
  /not available in (your|this) (country|region|area)/i,
  /region (is )?restricted/i,
  /geo[- ]?block/i,
  /service is not available in/i,
];

const TITLE_PATTERNS: RegExp[] = [
  /access denied/i,
  /restricted/i,
  /unavailable/i,
  /not available/i,
];

/**
 * Detect BC.Game geo / interstitial restriction from title, body text, and URL.
 * Also applies a form-absent heuristic on login paths (silent interstitials).
 */
export async function detectRegionRestriction(page: Page): Promise<RegionRestrictionResult> {
  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {
    return { restricted: false };
  }

  let title = '';
  try {
    title = await page.title();
  } catch {
    title = '';
  }

  let bodySnippet = '';
  try {
    bodySnippet = await page.locator('body').innerText({ timeout: 4000 }).catch(() => '');
  } catch {
    bodySnippet = '';
  }

  const sample = `${title}\n${bodySnippet}`.slice(0, 8000);

  for (const re of TITLE_PATTERNS) {
    if (re.test(title)) {
      return {
        restricted: true,
        kind: 'geo_block',
        detail: `title_match:${re.source}`,
        currentUrl,
        suggestedAction:
          'Region restriction detected. Use a legitimate network path allowed for BC.Game, or continue dry-run only if public Crash telemetry is reachable.',
      };
    }
  }

  for (const re of BODY_PATTERNS) {
    if (re.test(sample)) {
      return {
        restricted: true,
        kind: 'geo_block',
        detail: `body_match:${re.source}`,
        currentUrl,
        suggestedAction:
          'Region restriction detected from page content. Verify deployment IP/region. Dry-run ACIE can continue without login.',
      };
    }
  }

  if (/geo|region|country|restricted|denied/i.test(currentUrl)) {
    return {
      restricted: true,
      kind: 'unknown',
      detail: 'url_hint',
      currentUrl,
      suggestedAction: 'URL suggests access restriction. Verify network path.',
    };
  }

  try {
    const passCount = await page.locator('input[type="password"]').count().catch(() => 0);
    const emailCount = await page
      .locator('input[type="email"], input[name*="email" i], input[placeholder*="email" i]')
      .count()
      .catch(() => 0);
    const authUi = await page
      .locator('[data-testid="user-menu"], .user-menu, [class*="balance"], [class*="wallet"]')
      .count()
      .catch(() => 0);
    const onLoginPath = /\/login|\/signin|\/sign-in|\/auth/i.test(currentUrl);
    if (onLoginPath && passCount === 0 && emailCount === 0 && authUi === 0) {
      return {
        restricted: true,
        kind: 'interstitial',
        detail: 'login_form_absent_on_login_path',
        currentUrl,
        suggestedAction:
          'Login path loaded without form or account UI — likely region/access interstitial. Verify deployment region/IP.',
      };
    }
  } catch {
    // heuristic is best-effort
  }

  return { restricted: false };
}
