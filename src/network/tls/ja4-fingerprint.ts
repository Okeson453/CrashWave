/**
 * TLS / JA4 Stack Mirroring
 * Edge firewalls inspect ClientHello before JS runs.
 * Catalog of immutable JA3/JA4 profiles + consistency guards.
 */
import { z } from 'zod';

export const Ja4ProfileSchema = z.object({
  id: z.string(),
  ja3: z.string().optional(),
  ja4: z.string(),
  cipherSuites: z.array(z.string()),
  extensions: z.array(z.number()),
  supportedGroups: z.array(z.string()),
  signatureAlgorithms: z.array(z.string()),
  alpn: z.array(z.string()).default(['h2', 'http/1.1']),
  http2Settings: z.record(z.string(), z.number()).default({}),
  userAgent: z.string(),
  platform: z.enum(['windows', 'macos', 'linux', 'android', 'ios']),
  browser: z.enum(['chrome', 'firefox', 'safari', 'edge']),
  browserVersion: z.string(),
});
export type Ja4Profile = z.infer<typeof Ja4ProfileSchema>;

export const JA4_PROFILES: readonly Ja4Profile[] = [
  {
    id: 'chrome-126-win11',
    ja4: 't13d1516h2_8daaf6152771_b0da82dd1658',
    cipherSuites: [
      'TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256',
      'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384','TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
      'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256','TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
      'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA','TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
      'TLS_RSA_WITH_AES_128_GCM_SHA256','TLS_RSA_WITH_AES_256_GCM_SHA384',
      'TLS_RSA_WITH_AES_128_CBC_SHA','TLS_RSA_WITH_AES_256_CBC_SHA',
    ],
    extensions: [0,23,65281,10,11,35,16,5,13,18,51,45,43,27,17513,21],
    supportedGroups: ['x25519','secp256r1','secp384r1'],
    signatureAlgorithms: [
      'ecdsa_secp256r1_sha256','rsa_pss_rsae_sha256','rsa_pkcs1_sha256',
      'ecdsa_secp384r1_sha384','rsa_pss_rsae_sha384','rsa_pkcs1_sha384',
      'rsa_pss_rsae_sha512','rsa_pkcs1_sha512',
    ],
    alpn: ['h2','http/1.1'],
    http2Settings: { HEADER_TABLE_SIZE:65536, ENABLE_PUSH:0, INITIAL_WINDOW_SIZE:6291456, MAX_HEADER_LIST_SIZE:262144 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'windows', browser: 'chrome', browserVersion: '126',
  },
  {
    id: 'chrome-126-macos',
    ja4: 't13d1516h2_8daaf6152771_d41ae4817631',
    cipherSuites: [
      'TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256',
      'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384','TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
      'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256','TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
      'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA','TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
      'TLS_RSA_WITH_AES_128_GCM_SHA256','TLS_RSA_WITH_AES_256_GCM_SHA384',
      'TLS_RSA_WITH_AES_128_CBC_SHA','TLS_RSA_WITH_AES_256_CBC_SHA',
    ],
    extensions: [0,23,65281,10,11,35,16,5,13,18,51,45,43,27,17513,21],
    supportedGroups: ['x25519','secp256r1','secp384r1'],
    signatureAlgorithms: [
      'ecdsa_secp256r1_sha256','rsa_pss_rsae_sha256','rsa_pkcs1_sha256',
      'ecdsa_secp384r1_sha384','rsa_pss_rsae_sha384','rsa_pkcs1_sha384',
      'rsa_pss_rsae_sha512','rsa_pkcs1_sha512',
    ],
    alpn: ['h2','http/1.1'],
    http2Settings: { HEADER_TABLE_SIZE:65536, ENABLE_PUSH:0, INITIAL_WINDOW_SIZE:6291456, MAX_HEADER_LIST_SIZE:262144 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'macos', browser: 'chrome', browserVersion: '126',
  },
] as const;

export function selectJa4Profile(id?: string): Ja4Profile {
  if (id) {
    const f = JA4_PROFILES.find((p) => p.id === id);
    if (f) return f;
  }
  return JA4_PROFILES[0]!;
}

export function assertProfileConsistency(ja4: Ja4Profile, userAgent: string): void {
  const family = ja4.browser === 'chrome' ? 'Chrome' : ja4.browser === 'firefox' ? 'Firefox' : 'Safari';
  if (!userAgent.includes(family)) {
    throw new Error(`JA4 profile ${ja4.id} inconsistent with User-Agent`);
  }
}
