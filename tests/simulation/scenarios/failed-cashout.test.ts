import { CashOutController, createTestMultiplierStream } from '../../../src/betting/cashout';
import { MockBetPlacementAdapter } from '../../../src/betting/executor';

describe('Simulation: Failed Cash-Out', () => {
  let adapter: MockBetPlacementAdapter;

  beforeEach(() => {
    adapter = new MockBetPlacementAdapter();
  });

  it('fails when cash-out request is rejected', async () => {
    adapter.setBehavior({ cashOutSuccess: false });
    const controller = new CashOutController('bet-1', 'round-1', adapter, {
      targetMultiplier: 1.30,
      latencyBufferMs: 0,
      confirmationTimeoutMs: 5000,
      preferNativeAutoCashOut: false,
    });

    const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 10 });
    const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
    stream.start();

    const result = await monitorPromise;
    expect(result.success).toBe(false);
    expect(result.finalState).toBe('FAILED');
    expect(result.error).toBeDefined();
  });

  it('fails when cash-out times out', async () => {
    adapter.setBehavior({ cashOutSuccess: true, confirmDelayMs: 10000 });
    const controller = new CashOutController('bet-1', 'round-1', adapter, {
      targetMultiplier: 1.30,
      latencyBufferMs: 0,
      confirmationTimeoutMs: 100,
      preferNativeAutoCashOut: false,
    });

    const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 10 });
    const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
    stream.start();

    const result = await monitorPromise;
    expect(result.success).toBe(false);
    expect(result.finalState).toBe('FAILED');
  });

  it('loses bet when round crashes before cash-out completes', async () => {
    adapter.setBehavior({ cashOutSuccess: true, confirmDelayMs: 500 });
    const controller = new CashOutController('bet-1', 'round-1', adapter, {
      targetMultiplier: 1.30,
      latencyBufferMs: 0,
      confirmationTimeoutMs: 5000,
      preferNativeAutoCashOut: false,
    });

    // Round crashes at 1.15, below target
    const stream = createTestMultiplierStream({ crashPoint: 1.15, tickIntervalMs: 10 });
    const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
    stream.start();

    const result = await monitorPromise;
    expect(result.success).toBe(false);
    expect(result.finalState).toBe('LOST');
  });
});
