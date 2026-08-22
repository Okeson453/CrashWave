/**
 * Spec-upgrade composition helpers.
 * Call from composition root / live-session-wiring when config.specUpgrade is present.
 */
import { selectJa4Profile, assertProfileConsistency } from '../network/tls/ja4-fingerprint';
import { selectHardwareProfile, assertCrossStackConsistency } from '../browser/profiles/immutable-hardware';
import { NativeSocketWorker } from '../network/tls/native-socket';
import { captureSession, buildNativeHeaders, type HandshakeResult } from '../protocol/session-handshake';
import { PayloadCircuitBreaker, parseWsFrame } from '../protocol/ws-payload-schemas';
import { HashChainVerifier } from '../risk/provably-fair/hash-chain';
import { ClientOrderIdRegistry, ReconciliationService } from '../core/reconciliation-service';
import { InMemoryCapitalGuard, HotWalletSweeper, CapitalWatchdog } from '../capital';
import type { Page, BrowserContext } from 'playwright';
import { getLogger } from '../observability/logger';

const logger = () => getLogger().child({ component: 'SpecUpgradeWiring' });

export interface SpecUpgradeHandles {
  ja4ProfileId: string;
  hardwareProfileId: string;
  socket: NativeSocketWorker | null;
  handshake: HandshakeResult | null;
  circuitBreaker: PayloadCircuitBreaker;
  hashVerifier: HashChainVerifier;
  orderRegistry: ClientOrderIdRegistry;
  reconciliation: ReconciliationService | null;
  capitalGuard: InMemoryCapitalGuard;
  sweeper: HotWalletSweeper | null;
  parseFrame: (raw: string | Buffer) => ReturnType<typeof parseWsFrame>;
}

export async function wireSpecUpgrade(opts: {
  config: any;
  page?: Page;
  context?: BrowserContext;
  orderStatusReader?: (q: { clientOrderId: string }) => Promise<any>;
  withdrawFn?: (amount: number) => Promise<{ ok: boolean; txId?: string }>;
  balanceReader?: () => Promise<number>;
  startingBankroll: number;
  onCircuitTrip?: () => void;
}): Promise<SpecUpgradeHandles> {
  const su = opts.config.specUpgrade ?? {};
  const ja4 = selectJa4Profile(su.ja4?.profileId);
  const hw = selectHardwareProfile(su.stealth?.hardwareProfileId);
  assertProfileConsistency(ja4, ja4.userAgent);
  assertCrossStackConsistency(hw, ja4.platform);

  const circuitBreaker = new PayloadCircuitBreaker(
    su.payloadIngestion?.circuitBreakerThreshold ?? 8,
    () => opts.onCircuitTrip?.(),
  );
  const hashVerifier = new HashChainVerifier(undefined, su.provablyFair?.maxHashFailures ?? 3);
  const orderRegistry = new ClientOrderIdRegistry();

  let handshake: HandshakeResult | null = null;
  let socket: NativeSocketWorker | null = null;

  if (su.stealth?.protocolOffload && opts.page && opts.context) {
    handshake = await captureSession({ page: opts.page, context: opts.context });
    const headers = buildNativeHeaders(handshake, ja4);
    const wsUrl = handshake.wsEndpoint || process.env.CRASH_WS_URL || '';
    if (wsUrl && su.nativeSocket?.enabled !== false) {
      socket = new NativeSocketWorker({
        url: wsUrl,
        headers,
        ja4Profile: ja4,
        noDelay: su.nativeSocket?.noDelay ?? true,
        heartbeatIntervalMs: su.nativeSocket?.heartbeatIntervalMs ?? 15000,
      });
      await socket.start();
      logger().info({ wsUrl }, 'Native socket worker started (protocol offload)');
    }
  }

  const capitalGuard = new InMemoryCapitalGuard({
    maxDrawdownAbs: su.capital?.maxDrawdownAbs ?? 5000,
    maxDrawdownPct: su.capital?.maxDrawdownPct ?? 0.25,
    panicBalanceFloor: su.capital?.panicBalanceFloor ?? 500,
    maxStake: opts.config.betting?.stakePerEntry ?? 700,
    startingBankroll: opts.startingBankroll,
  });

  let sweeper: HotWalletSweeper | null = null;
  if (su.capital?.enabled && opts.withdrawFn) {
    sweeper = new HotWalletSweeper(
      {
        hotBuffer: su.capital.hotBuffer ?? 5000,
        withdrawThreshold: su.capital.withdrawThreshold ?? 8000,
        minWithdrawAmount: su.capital.minWithdrawAmount ?? 1000,
        cooldownMs: su.capital.sweepCooldownMs ?? 300000,
        enabled: true,
      },
      opts.withdrawFn,
    );
  }

  let reconciliation: ReconciliationService | null = null;
  if (opts.orderStatusReader) {
    reconciliation = new ReconciliationService(opts.orderStatusReader, orderRegistry);
  }

  if (su.capital?.watchdogEnabled && opts.balanceReader) {
    const wd = new CapitalWatchdog(
      {
        panicBalanceFloor: su.capital.panicBalanceFloor ?? 500,
        pollIntervalMs: su.capital.watchdogPollIntervalMs ?? 10000,
        targetPid: process.pid,
        enabled: true,
      },
      opts.balanceReader,
    );
    wd.start();
  }

  return {
    ja4ProfileId: ja4.id,
    hardwareProfileId: hw.id,
    socket,
    handshake,
    circuitBreaker,
    hashVerifier,
    orderRegistry,
    reconciliation,
    capitalGuard,
    sweeper,
    parseFrame: (raw) => parseWsFrame(raw, circuitBreaker),
  };
}
