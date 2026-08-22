/**
 * Bind full protocol-offload path: browser handshake → native socket.
 * Call from SessionSupervisor after page is authenticated and challenges clear.
 */
import type { Page, BrowserContext } from 'playwright';
import type { AppConfig } from '../config/schema';
import { wireSpecUpgrade, type SpecUpgradeHandles } from '../app/spec-upgrade-wiring';
import { getLogger } from '../observability/logger';

const logger = () => getLogger().child({ component: 'ProtocolOffloadBind' });

export async function bindProtocolOffload(opts: {
  page: Page;
  context: BrowserContext;
  config: AppConfig;
  startingBankroll: number;
  orderStatusReader?: (q: { clientOrderId: string }) => Promise<any>;
  withdrawFn?: (amount: number) => Promise<{ ok: boolean; txId?: string }>;
  balanceReader?: () => Promise<number>;
  onCircuitTrip?: () => void;
}): Promise<SpecUpgradeHandles | null> {
  const su = (opts.config as any).specUpgrade;
  if (!su?.stealth?.protocolOffload) {
    logger().info('protocolOffload disabled — skipping native socket bind');
    return null;
  }

  const handles = await wireSpecUpgrade({
    config: opts.config,
    page: opts.page,
    context: opts.context,
    orderStatusReader: opts.orderStatusReader,
    withdrawFn: opts.withdrawFn,
    balanceReader: opts.balanceReader,
    startingBankroll: opts.startingBankroll,
    onCircuitTrip: opts.onCircuitTrip,
  });

  logger().info(
    {
      ja4: handles.ja4ProfileId,
      hardware: handles.hardwareProfileId,
      socket: !!handles.socket,
    },
    'Protocol offload bound'
  );
  return handles;
}
