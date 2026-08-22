import {
  buildHardenedLaunchArgs,
  BehavioralEntropyEngine,
  BehavioralPersona,
  seedFromProfileId,
  buildDeepFingerprintScript,
  CDPSanitizer,
  generateMemoryForensicsScript,
  generateScopeInjectorScript,
  DeepStealthOrchestrator,
  getHTTP2LaunchArgs,
} from '../../../../src/browser/evasion';

describe('Sheath Mode evasion suite', () => {
  describe('launch-config', () => {
    it('never includes --enable-automation', () => {
      const args = buildHardenedLaunchArgs({
        extraArgs: ['--enable-automation', '--foo'],
      });
      expect(args.some((a) => a.includes('enable-automation'))).toBe(false);
      expect(args).toContain('--disable-blink-features=AutomationControlled');
    });
  });

  describe('behavioral entropy', () => {
    it('samples positive delays', () => {
      const eng = new BehavioralEntropyEngine({ seed: 'test-seed', missRoundProbability: 1 });
      expect(eng.sampleBetDelayMs()).toBeGreaterThan(0);
      expect(eng.shouldMissRound()).toBe(true);
    });
  });

  describe('behavioral persona', () => {
    it('is seed-stable', () => {
      const seed = seedFromProfileId('profile-abc');
      const a = new BehavioralPersona({ seed, screenWidth: 1366, screenHeight: 900 });
      const b = new BehavioralPersona({ seed, screenWidth: 1366, screenHeight: 900 });
      expect(a.getArchetype()).toBe(b.getArchetype());
      const t1 = a.generateBetTiming(700, 1.3);
      const t2 = b.generateBetTiming(700, 1.3);
      expect(t1.skip).toBe(t2.skip);
      if (!t1.skip) {
        expect(t1.preBetDelayMs).toBe(t2.preBetDelayMs);
      }
    });
  });

  describe('scripts', () => {
    it('deep fingerprint is idempotent and avoids pushState', () => {
      const script = buildDeepFingerprintScript({
        hardwareConcurrency: 8,
        deviceMemory: 8,
        platform: 'Win32',
        seed: 's1',
      });
      expect(script).toContain('__sheathDeepFp');
      expect(script).not.toMatch(/history.pushState/);
      expect(script).toContain('history');
    });

    it('scope injector does not rewrite module workers', () => {
      const s = generateScopeInjectorScript({
        injectWorkers: true,
        injectSharedWorkers: true,
        injectIframes: true,
        iframeBundle: '/* x */',
      });
      expect(s).toContain('isModuleOptions');
      expect(s).toContain('__sheathScopeInstalled');
    });

    it('memory forensics scrubs keywords', () => {
      const s = generateMemoryForensicsScript();
      expect(s).toContain('playwright');
    });
  });

  describe('cdp sanitizer', () => {
    it('blocks debugger domain without remapping context ids', () => {
      const s = new CDPSanitizer();
      expect(() => s.assertAllowed('Debugger.pause')).toThrow(/blocked/i);
      // Runtime.evaluate must pass through unchanged (no fake contextId)
      const out = s.sanitizeOutgoing('Runtime.evaluate', { contextId: 1, expression: '1+1' });
      expect(out.method).toBe('Runtime.evaluate');
      expect(out.params?.contextId).toBe(1);
    });
  });

  describe('deep stealth orchestrator', () => {
    it('builds launch options without automation flag', () => {
      const orch = DeepStealthOrchestrator.create({
        profileId: 'p1',
        viewport: { width: 1366, height: 900 },
      });
      const launch = orch.getLaunchOptions();
      const args = (launch.args as string[]) || [];
      expect(args.some((a) => a.includes('enable-automation'))).toBe(false);
      expect(orch.getPersona().getArchetype()).toBeTruthy();
      expect(getHTTP2LaunchArgs().length).toBeGreaterThan(0);
    });
  });
});
