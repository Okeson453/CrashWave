/**
 * Cheap network preflight before launching Chromium / attempting BC.Game login.
 */
import { getLogger } from '../observability/logger';

export interface PreflightResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

export async function runNetworkPreflight(
  targetUrl: string,
  _proxyUrl?: string | null
): Promise<PreflightResult> {
  const logger = getLogger();
  const checks: PreflightResult['checks'] = [];

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(targetUrl, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    clearTimeout(t);
    checks.push({ name: 'target-reachable', ok: res.status < 500, detail: `status ${res.status}` });
  } catch (err) {
    checks.push({
      name: 'target-reachable',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // DNS / public egress check (informational if proxy is used; still useful for control-plane diagnostics)
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch('https://ifconfig.me/ip', { signal: controller.signal });
    clearTimeout(t);
    const ip = (await res.text()).trim();
    checks.push({
      name: 'egress-ip',
      ok: res.ok && ip.length > 0,
      detail: ip || `status ${res.status}`,
    });
  } catch (err) {
    checks.push({
      name: 'egress-ip',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // target-reachable is the hard requirement; egress-ip is diagnostic only
  const ok = checks.filter((c) => c.name === 'target-reachable').every((c) => c.ok);
  if (!ok) {
    logger.warn({ component: 'Preflight', checks }, 'Network preflight failed — skipping login attempt');
  }
  return { ok, checks };
}
