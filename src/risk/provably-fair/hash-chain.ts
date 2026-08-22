import { createHash, createHmac } from 'crypto';
import { getLogger } from '../../observability/logger';
const logger = () => getLogger().child({ component: 'HashChainVerifier' });

export interface ChainLink {
  roundId: string; hash: string; seed?: string; crashPoint?: number;
  verified: boolean; expectedHash?: string;
}
export type CrashPointDeriver = (hash: string) => number;

export const defaultBustabitDeriver: CrashPointDeriver = (hash: string): number => {
  const h = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  if (h % 33 === 0) return 1.0;
  return Math.max(1.0, Math.floor((100 * e - h) / (e - h)) / 100);
};

export class HashChainVerifier {
  private chainRoot: string | null = null;
  private links: ChainLink[] = [];
  private consecutiveFailures = 0;
  constructor(private deriver: CrashPointDeriver = defaultBustabitDeriver, private maxFailures = 3) {}

  setChainRoot(root: string): void {
    this.chainRoot = root.toLowerCase().replace(/^0x/, '');
    this.links = []; this.consecutiveFailures = 0;
    logger().info({ root: this.chainRoot.slice(0, 16) + '…' }, 'Chain root registered');
  }

  verifyLink(params: {
    roundId: string; hash: string; nextHash?: string; seed?: string;
    serverSeed?: string; clientSeed?: string; nonce?: number;
  }): ChainLink {
    const hash = params.hash.toLowerCase().replace(/^0x/, '');
    let verified = false; let expectedHash: string | undefined;
    if (params.nextHash) {
      expectedHash = createHash('sha256').update(params.nextHash).digest('hex');
      verified = expectedHash === hash;
    } else if (params.serverSeed && params.clientSeed != null && params.nonce != null) {
      expectedHash = createHmac('sha256', params.serverSeed).update(`${params.clientSeed}:${params.nonce}`).digest('hex');
      verified = expectedHash === hash;
    } else if (params.seed) {
      expectedHash = createHash('sha256').update(params.seed).digest('hex');
      verified = expectedHash === hash;
    }
    const crashPoint = this.deriver(hash);
    const link: ChainLink = { roundId: params.roundId, hash, seed: params.seed, crashPoint, verified, expectedHash };
    this.links.push(link); if (this.links.length > 500) this.links.shift();
    if (!verified && (params.nextHash || params.seed || params.serverSeed)) {
      this.consecutiveFailures++;
      logger().error({ roundId: params.roundId, consecutiveFailures: this.consecutiveFailures }, 'Hash chain verification FAILED');
      if (this.consecutiveFailures >= this.maxFailures) {
        throw new Error(`PROVABLY_FAIR_BREAK: ${this.consecutiveFailures} consecutive failures`);
      }
    } else if (verified) this.consecutiveFailures = 0;
    return link;
  }
  get recentLinks(): readonly ChainLink[] { return this.links; }
  get isHealthy(): boolean { return this.consecutiveFailures < this.maxFailures; }
}
