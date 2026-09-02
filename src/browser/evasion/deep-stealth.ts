/**
 * Deep Stealth Orchestrator — single coordinated injection path.
 *
 * Fixes vs earlier draft:
 * - No duplicate script injection (one composite init script)
 * - No history.pushState spam
 * - Network hygiene only on document navigations
 * - CDP does not remap context IDs
 * - Scope injector gets a DOM-free worker preamble + iframe bundle separately
 */

import type { BrowserContext, Page, LaunchOptions, BrowserContextOptions } from 'playwright';
import { getLogger } from '../../observability/logger.js';
import { buildHardenedLaunchArgs, hardenedContextOptions } from './launch-config.js';
import { CDPSanitizer } from './cdp-sanitizer.js';
import { BehavioralPersona, seedFromProfileId } from './behavioral-persona.js';
import {
  applyNetworkNormalization,
  getHTTP2LaunchArgs,
  NetworkFingerprintConfig,
  DEFAULT_NETWORK_CONFIG,
} from './network-fingerprint.js';
import { generateScopeInjectorScript } from './scope-injector.js';
import { generateMemoryForensicsScript, DEFAULT_MEMORY_CONFIG } from './memory-forensics.js';
import { buildDeepFingerprintScript } from './deep-fingerprint.js';
import {
  buildAdvancedStealthInitScript,
  fingerprintToStealth,
  DEFAULT_STEALTH_FINGERPRINT,
  type StealthFingerprint,
} from '../stealth.js';
import type { FingerprintProfile } from '../fingerprint.js';

export interface DeepStealthConfig {
  profileId: string;
  viewport: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  gpuMode?: 'real' | 'software' | 'auto';
  userAgent?: string;
  fingerprint?: FingerprintProfile | StealthFingerprint;
  headless?: boolean;
  /** Enable Playwright route-based header hygiene (default true) */
  networkNormalization?: boolean;
}

export class DeepStealthOrchestrator {
  private readonly logger = getLogger();
  private readonly config: DeepStealthConfig & {
    locale: string;
    timezoneId: string;
    gpuMode: 'real' | 'software' | 'auto';
    networkNormalization: boolean;
  };
  private readonly cdpSanitizer: CDPSanitizer;
  private readonly persona: BehavioralPersona;
  private readonly networkConfig: NetworkFingerprintConfig;
  private readonly stealthFp: StealthFingerprint;
  private appliedPages = new WeakSet<Page>();

  private constructor(
    config: DeepStealthConfig,
    stealthFp: StealthFingerprint,
    persona: BehavioralPersona,
    cdp: CDPSanitizer,
    network: NetworkFingerprintConfig
  ) {
    this.config = {
      locale: 'en-US',
      timezoneId: 'America/New_York',
      gpuMode: 'software',
      networkNormalization: true,
      ...config,
    };
    this.stealthFp = stealthFp;
    this.persona = persona;
    this.cdpSanitizer = cdp;
    this.networkConfig = network;
  }

  static create(config: DeepStealthConfig): DeepStealthOrchestrator {
    const fp: StealthFingerprint = config.fingerprint
      ? 'profileId' in (config.fingerprint as object)
        ? fingerprintToStealth(config.fingerprint as FingerprintProfile)
        : (config.fingerprint as StealthFingerprint)
      : {
          ...DEFAULT_STEALTH_FINGERPRINT,
          userAgent: config.userAgent ?? DEFAULT_STEALTH_FINGERPRINT.userAgent,
        };

    const persona = new BehavioralPersona({
      seed: seedFromProfileId(config.profileId),
      screenWidth: config.viewport.width,
      screenHeight: config.viewport.height,
    });

    const network: NetworkFingerprintConfig = {
      ...DEFAULT_NETWORK_CONFIG,
      userAgent: fp.userAgent,
      platform: fp.secChUaPlatform || '"Windows"',
      secChUa: fp.secChUa,
    };

    const orch = new DeepStealthOrchestrator(config, fp, persona, new CDPSanitizer(), network);
    getLogger().info(
      {
        component: 'DeepStealth',
        profileId: config.profileId,
        archetype: persona.getArchetype(),
      },
      'Deep Stealth Orchestrator initialized'
    );
    return orch;
  }

  getLaunchOptions(): LaunchOptions {
    const useRealGpu =
      this.config.gpuMode === 'real' ||
      (this.config.gpuMode === 'auto' && process.env.STEALTH_REAL_GPU === '1');
    const args = [
      ...buildHardenedLaunchArgs({
        headless: this.config.headless,
        windowWidth: this.config.viewport.width,
        windowHeight: this.config.viewport.height,
        useRealGpu,
        lang: this.config.locale,
      }),
      ...getHTTP2LaunchArgs(),
    ];
    return {
      headless: this.config.headless ?? false,
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    } as LaunchOptions;
  }

  getContextOptions(): BrowserContextOptions {
    return {
      ...hardenedContextOptions({
        userAgent: this.stealthFp.userAgent,
        locale: this.config.locale,
        timezoneId: this.config.timezoneId,
        viewport: this.config.viewport,
      }),
      userAgent: this.stealthFp.userAgent,
      bypassCSP: false,
      acceptDownloads: true,
    } as BrowserContextOptions;
  }

  /** Build one composite main-world script (idempotent pieces inside). */
  private buildMainWorldBundle(): string {
    return [
      buildAdvancedStealthInitScript(this.stealthFp),
      buildDeepFingerprintScript({
        hardwareConcurrency: this.stealthFp.hardwareConcurrency,
        deviceMemory: this.stealthFp.deviceMemory,
        platform: this.stealthFp.platform,
        seed: this.stealthFp.canvasNoiseSeed ?? this.config.profileId,
        patchWorkers: false,
      }),
      CDPSanitizer.buildDetectionPatchScript(),
      generateMemoryForensicsScript(DEFAULT_MEMORY_CONFIG),
    ].join('\n;\n');
  }

  async injectIntoContext(context: BrowserContext): Promise<void> {
    const mainBundle = this.buildMainWorldBundle();
    // Main world once
    await context.addInitScript(mainBundle);
    // Scope injector separately: worker preamble is DOM-free; iframe gets main bundle
    await context.addInitScript(
      generateScopeInjectorScript({
        injectWorkers: true,
        injectSharedWorkers: true,
        injectIframes: true,
        iframeBundle: mainBundle,
      })
    );

    try {
      await context.setExtraHTTPHeaders({
        'Accept-Language': this.stealthFp.languages.join(',') + ';q=0.9',
        'sec-ch-ua': this.stealthFp.secChUa,
        'sec-ch-ua-mobile': this.stealthFp.secChUaMobile,
        'sec-ch-ua-platform': this.stealthFp.secChUaPlatform,
      });
    } catch {
      /* closed */
    }

    this.logger.info({ component: 'DeepStealth' }, 'Evasion layers injected into context');
  }

  async applyToPage(page: Page): Promise<void> {
    if (this.appliedPages.has(page)) return;
    this.appliedPages.add(page);

    if (this.config.networkNormalization) {
      await applyNetworkNormalization(page, this.networkConfig);
    }

    this.logger.info({ component: 'DeepStealth' }, 'Page-level network hygiene applied');
  }

  getPersona(): BehavioralPersona {
    return this.persona;
  }

  getCDPSanitizer(): CDPSanitizer {
    return this.cdpSanitizer;
  }

  getFingerprint(): StealthFingerprint {
    return this.stealthFp;
  }

  getMetrics(): Record<string, unknown> {
    return {
      persona: {
        archetype: this.persona.getArchetype(),
        state: this.persona.getState(),
      },
      profileId: this.config.profileId,
      cdpCommands: this.cdpSanitizer.getCommandCount(),
      userAgent: this.stealthFp.userAgent.slice(0, 64),
    };
  }
}
