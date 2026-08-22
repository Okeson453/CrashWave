/**
 * Cross-Attribute Profile Consistency
 * Real-world hardware profiles as immutable pairs — never randomly mix
 * Mac UA with Nvidia WebGL or Windows font stacks.
 */
export interface HardwareProfile {
  id: string;
  platform: 'windows' | 'macos' | 'linux';
  userAgent: string;
  platformString: string; // navigator.platform
  hardwareConcurrency: number;
  deviceMemory: number;
  screen: { width: number; height: number; colorDepth: number; pixelRatio: number };
  webgl: { vendor: string; renderer: string };
  fonts: string[];
  audioHash: string; // placeholder fingerprint token
  languages: string[];
  timezone: string;
}

export const IMMUTABLE_PROFILES: readonly HardwareProfile[] = [
  {
    id: 'win11-rtx3060-chrome',
    platform: 'windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platformString: 'Win32',
    hardwareConcurrency: 12,
    deviceMemory: 8,
    screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    fonts: ['Arial','Calibri','Cambria','Consolas','Courier New','Georgia','Segoe UI','Tahoma','Times New Roman','Verdana'],
    audioHash: 'win-rtx3060-a1b2',
    languages: ['en-US','en'],
    timezone: 'America/New_York',
  },
  {
    id: 'macos-m2-chrome',
    platform: 'macos',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platformString: 'MacIntel',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screen: { width: 1440, height: 900, colorDepth: 30, pixelRatio: 2 },
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    fonts: ['Helvetica','Helvetica Neue','SF Pro Text','Menlo','Monaco','Geneva','Lucida Grande','Arial'],
    audioHash: 'mac-m2-c3d4',
    languages: ['en-US','en'],
    timezone: 'America/Los_Angeles',
  },
  {
    id: 'win11-intel-uhd-chrome',
    platform: 'windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platformString: 'Win32',
    hardwareConcurrency: 8,
    deviceMemory: 16,
    screen: { width: 2560, height: 1440, colorDepth: 24, pixelRatio: 1 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    fonts: ['Arial','Calibri','Cambria','Consolas','Courier New','Georgia','Segoe UI','Tahoma','Times New Roman','Verdana'],
    audioHash: 'win-uhd-e5f6',
    languages: ['en-GB','en'],
    timezone: 'Europe/London',
  },
] as const;

export function selectHardwareProfile(id?: string): HardwareProfile {
  if (id) {
    const f = IMMUTABLE_PROFILES.find((p) => p.id === id);
    if (f) return f;
  }
  return IMMUTABLE_PROFILES[0]!;
}

/** Validate that a JA4 profile + hardware profile share the same platform family */
export function assertCrossStackConsistency(
  hardware: HardwareProfile,
  ja4Platform: string,
): void {
  if (hardware.platform !== ja4Platform && !(hardware.platform === 'macos' && ja4Platform === 'macos')) {
    // allow exact match
    if (hardware.platform !== ja4Platform) {
      throw new Error(`Hardware profile ${hardware.id} platform=${hardware.platform} inconsistent with JA4 platform=${ja4Platform}`);
    }
  }
}
