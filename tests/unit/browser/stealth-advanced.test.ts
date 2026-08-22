import {
  buildAdvancedStealthInitScript,
  DEFAULT_STEALTH_FINGERPRINT,
  fingerprintToStealth,
  STEALTH_BROWSER_ARGS,
} from '../../../src/browser/stealth';
import { createFingerprintProfile } from '../../../src/browser/fingerprint';

describe('Advanced stealth', () => {
  it('builds init script containing core markers', () => {
    const script = buildAdvancedStealthInitScript(DEFAULT_STEALTH_FINGERPRINT);
    expect(script).toContain('webdriver');
    expect(script).toContain('webglVendor');
    expect(script).toContain('toDataURL');
    expect(script).toContain('getChannelData');
    expect(script).toContain('RTCPeerConnection');
    expect(script).toContain('__playwright');
  });

  it('maps FingerprintProfile to StealthFingerprint', () => {
    const fp = createFingerprintProfile('test-id');
    const s = fingerprintToStealth(fp);
    expect(s.userAgent).toBe(fp.userAgent);
    expect(s.canvasNoiseSeed).toBe(fp.canvasNoiseSeed);
    expect(s.secChUa).toBe(fp.secChUa);
  });

  it('includes AutomationControlled disable in args', () => {
    expect(STEALTH_BROWSER_ARGS.some((a) => a.includes('AutomationControlled'))).toBe(true);
  });
});
