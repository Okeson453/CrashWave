import { CashOutController, createTestMultiplierStream } from '../../../src/betting/cashout';
import { MockBetPlacementAdapter } from '../../../src/betting/executor';

jest.mock('../../../src/observability/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('CashOutController', () => {
  let adapter: MockBetPlacementAdapter;
  let controller: CashOutController;

  beforeEach(() => {
    adapter = new MockBetPlacementAdapter();
    controller = new CashOutController('bet-1', 'round-1', adapter);
  });

  afterEach(() => {
    controller.abort();
  });

  describe('initialization', () => {
    it('initializes with default config', () => {
      const state = controller.getState();
      expect(state.betId).toBe('bet-1');
      expect(state.roundId).toBe('round-1');
      expect(state.triggered).toBe(false);
      expect(state.confirmed).toBe(false);
      expect(state.triggeredAtMultiplier).toBeNull();
      expect(state.confirmedAtMultiplier).toBeNull();
      expect(state.pnl).toBeNull();
      expect(state.error).toBeNull();
    });

    it('accepts custom config overrides', () => {
      const custom = new CashOutController('bet-2', 'round-2', adapter, {
        targetMultiplier: 2.0,
        latencyBufferMs: 100,
        confirmationTimeoutMs: 5000,
        preferNativeAutoCashOut: true,
      });
      expect(custom).toBeDefined();
    });

    it('returns false from isComplete() initially', () => {
      expect(controller.isComplete()).toBe(false);
    });
  });

  describe('configureNativeAutoCashOut', () => {
    it('returns false when preferNativeAutoCashOut is false', async () => {
      const result = await controller.configureNativeAutoCashOut();
      expect(result).toBe(false);
    });

    it('returns false when adapter does not support native auto cash-out', async () => {
      const customController = new CashOutController('bet-1', 'round-1', adapter, {
        preferNativeAutoCashOut: true,
      });
      const result = await customController.configureNativeAutoCashOut();
      expect(result).toBe(false);
    });

    it('returns true when native auto cash-out is configured successfully', async () => {
      const adapterWithNative = new MockBetPlacementAdapter();
      (adapterWithNative as any).setNativeAutoCashOut = jest.fn().mockResolvedValue(true);
      const customController = new CashOutController('bet-1', 'round-1', adapterWithNative, {
        preferNativeAutoCashOut: true,
      });
      const result = await customController.configureNativeAutoCashOut();
      expect(result).toBe(true);
      expect((adapterWithNative as any).setNativeAutoCashOut).toHaveBeenCalledWith(1.30);
    });

    it('returns false and logs warning when native config throws', async () => {
      const adapterWithNative = new MockBetPlacementAdapter();
      (adapterWithNative as any).setNativeAutoCashOut = jest.fn().mockRejectedValue(new Error('UI error'));
      const customController = new CashOutController('bet-1', 'round-1', adapterWithNative, {
        preferNativeAutoCashOut: true,
      });
      const result = await customController.configureNativeAutoCashOut();
      expect(result).toBe(false);
    });
  });

  describe('monitor — successful cash-out', () => {
    it('triggers cash-out when multiplier reaches target and confirms win', async () => {
      const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 10 });
      const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
      stream.start();
      const result = await monitorPromise;
      expect(result.success).toBe(true);
      expect(result.finalState).toBe('CASHED_OUT');
      expect(result.pnl).toBe(210);
      expect(result.cashOutMultiplier).toBe(1.30);
      const state = controller.getState();
      expect(state.triggered).toBe(true);
      expect(state.confirmed).toBe(true);
      expect(state.triggeredAtMultiplier).toBeGreaterThanOrEqual(1.30);
      expect(state.confirmedAtMultiplier).toBe(1.30);
      expect(state.pnl).toBe(210);
      expect(controller.isComplete()).toBe(true);
    });

    it('does not start duplicate monitors on repeated calls', async () => {
      const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 10 });
      const p1 = controller.monitor(stream.onTick, stream.onCrash);
      const p2 = controller.monitor(stream.onTick, stream.onCrash);
      stream.start();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.finalState).toBe('CASHED_OUT');
      expect(r2.finalState).toBe('CASHED_OUT');
    });
  });

  describe('monitor — round crash before target', () => {
    it('resolves as LOST when round crashes below target', async () => {
      const stream = createTestMultiplierStream({ crashPoint: 1.15, tickIntervalMs: 10 });
      const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
      stream.start();
      const result = await monitorPromise;
      expect(result.success).toBe(false);
      expect(result.finalState).toBe('LOST');
      expect(result.pnl).toBeNull();
      expect(result.cashOutMultiplier).toBeNull();
      const state = controller.getState();
      expect(state.triggered).toBe(false);
      expect(state.confirmed).toBe(false);
      // isComplete() only returns true for confirmed or error states;
      // LOST is resolved via promise but does not set those flags
      expect(controller.isComplete()).toBe(false);
    });
  });

  describe('monitor — cash-out failure', () => {
    it('resolves as FAILED when cash-out request is rejected', async () => {
      adapter.setBehavior({ cashOutSuccess: false });
      const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 10 });
      const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
      stream.start();
      const result = await monitorPromise;
      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
      expect(result.error).toBeDefined();
      expect(controller.isComplete()).toBe(true);
    });

    it('resolves as FAILED when cash-out confirmation times out', async () => {
      adapter.setBehavior({ cashOutSuccess: true, confirmDelayMs: 15000 });
      const customController = new CashOutController('bet-1', 'round-1', adapter, {
        confirmationTimeoutMs: 50,
      });
      const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 10 });
      const monitorPromise = customController.monitor(stream.onTick, stream.onCrash);
      stream.start();
      const result = await monitorPromise;
      expect(result.success).toBe(false);
      expect(result.finalState).toBe('FAILED');
      expect(result.error).toContain('timed out');
    });
  });

  describe('monitor — abort behavior', () => {
    it('prevents cash-out trigger when aborted before target', async () => {
      const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 50 });
      controller.monitor(stream.onTick, stream.onCrash);
      stream.start();
      // Abort immediately before target is reached
      controller.abort();
      // Let some ticks pass; abort should prevent trigger
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = controller.getState();
      expect(state.triggered).toBe(false);
      // Clean up by stopping the stream
      stream.stop();
      // The monitor is still running (safety timeout). We don't wait for it.
      expect(controller.isComplete()).toBe(false);
    });
  });

  describe('monitor — crash while cash-out in flight', () => {
    it('lets cash-out promise resolve even if round crashes during request', async () => {
      adapter.setBehavior({ cashOutSuccess: true, confirmDelayMs: 100 });
      const stream = createTestMultiplierStream({ crashPoint: 1.35, tickIntervalMs: 10 });
      const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
      stream.start();
      const result = await monitorPromise;
      expect(result.success).toBe(true);
      expect(result.finalState).toBe('CASHED_OUT');
    });
  });

  describe('createTestMultiplierStream', () => {
    it('simulates a round that reaches target', async () => {
      const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 5 });
      const ticks: number[] = [];
      let crashed = false;
      stream.onTick((m: number) => ticks.push(m));
      stream.onCrash(() => { crashed = true; });
      stream.start();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      stream.stop();
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(1.30);
      expect(crashed).toBe(true);
    }, 5000);

    it('simulates a round that crashes below target', async () => {
      const stream = createTestMultiplierStream({ crashPoint: 1.10, tickIntervalMs: 5 });
      let crashed = false;
      stream.onCrash(() => { crashed = true; });
      stream.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      stream.stop();
      expect(crashed).toBe(true);
    }, 5000);

    it('supports custom start multiplier', async () => {
      const stream = createTestMultiplierStream({
        crashPoint: 2.0,
        tickIntervalMs: 5,
        startMultiplier: 1.25,
      });
      const ticks: number[] = [];
      stream.onTick((m: number) => ticks.push(m));
      stream.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      stream.stop();
      expect(ticks[0]).toBe(1.26);
    }, 5000);

    it('stop() is idempotent', () => {
      const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 5 });
      stream.start();
      stream.stop();
      stream.stop();
      stream.stop();
      expect(true).toBe(true);
    });
  });
});
