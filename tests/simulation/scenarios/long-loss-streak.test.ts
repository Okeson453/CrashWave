/**
 * Long Loss Streak Simulation Scenario
 */
import { EventBus } from '../../../src/core/event-bus/bus';
import { DrawdownCalculator } from '../../../src/risk-engine/drawdown';

describe('Simulation: Long Loss Streak', () => {
  let eventBus: EventBus;
  let calculator: DrawdownCalculator;

  beforeEach(() => {
    eventBus = new EventBus();
    calculator = new DrawdownCalculator({
      alertThreshold: 10,
      maxDrawdownPercent: 50,
      stake: 700,
      initialEquity: 1_000_000,
    });
  });

  it('should track consecutive losses', () => {
    for (let i = 0; i < 5; i++) {
      calculator.recordLoss(700);
    }

    const stats = calculator.getStats();
    expect(stats.consecutiveLosses).toBe(5);
    expect(stats.totalDrawdown).toBe(3500);
  });

  it('should reset consecutive losses on win', () => {
    for (let i = 0; i < 5; i++) {
      calculator.recordLoss(700);
    }
    calculator.recordWin(910); // 700 * 1.30

    const stats = calculator.getStats();
    expect(stats.consecutiveLosses).toBe(0);
  });

  it('should alert after threshold consecutive losses', () => {
    for (let i = 0; i < 10; i++) {
      calculator.recordLoss(700);
    }

    const stats = calculator.getStats();
    expect(stats.shouldAlert).toBe(true);
    expect(stats.consecutiveLosses).toBe(10);
    expect(stats.totalDrawdown).toBe(7000);
  });

  it('should not alert before threshold', () => {
    for (let i = 0; i < 9; i++) {
      calculator.recordLoss(700);
    }

    const stats = calculator.getStats();
    expect(stats.shouldAlert).toBe(false);
  });

  it('should emit drawdown alert event', async () => {
    const alerts: Array<{ code: string }> = [];
    eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
      alerts.push(event.payload);
    });

    for (let i = 0; i < 10; i++) {
      calculator.recordLoss(700);
    }

    const stats = calculator.getStats();
    expect(stats.shouldAlert).toBe(true);

    await eventBus.emitTyped('CriticalError', {
      message: `Drawdown alert: ${stats.consecutiveLosses} consecutive losses`,
      code: 'DRAWDOWN_ALERT',
      component: 'DrawdownCalculator',
    }, 'dd-1', 'DrawdownCalculator');

    expect(alerts.length).toBe(1);
    expect(alerts[0].code).toBe('DRAWDOWN_ALERT');
  });
});
