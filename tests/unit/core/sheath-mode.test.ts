/**
 * Sheath Mode state machine unit tests
 */

import { SheathMode } from '../../../src/core/sheath-mode';
import type { SheathTrigger } from '../../../src/core/sheath-mode';

function trigger(
  id: SheathTrigger['id'],
  severity: SheathTrigger['severity']
): SheathTrigger {
  return {
    id,
    severity,
    message: `${id}`,
    detectedAt: new Date().toISOString(),
  };
}

describe('SheathMode', () => {
  it('starts in NORMAL with betting enabled', () => {
    const sm = new SheathMode();
    expect(sm.getState()).toBe('NORMAL');
    expect(sm.isBettingSuspended()).toBe(false);
  });

  it('critical trigger goes straight to SHEATH_ACTIVE', () => {
    const sm = new SheathMode();
    sm.reportTriggers([trigger('execution_problems', 'critical')]);
    expect(sm.getState()).toBe('SHEATH_ACTIVE');
    expect(sm.isBettingSuspended()).toBe(true);
  });

  it('high trigger enters EVALUATING then promotes after rounds', () => {
    const sm = new SheathMode({ evaluateHighRounds: 2 });
    sm.reportTriggers([trigger('model_drift', 'high')]);
    expect(sm.getState()).toBe('SHEATH_EVALUATING');
    sm.onRoundTick();
    expect(sm.getState()).toBe('SHEATH_EVALUATING');
    sm.onRoundTick();
    expect(sm.getState()).toBe('SHEATH_ACTIVE');
  });

  it('operator /sheath is immediate ACTIVE', () => {
    const sm = new SheathMode();
    sm.operatorSheath();
    expect(sm.getState()).toBe('SHEATH_ACTIVE');
  });

  it('operator /unsheath starts recovery, not NORMAL', () => {
    const sm = new SheathMode();
    sm.operatorSheath();
    sm.operatorUnsheath();
    expect(sm.getState()).toBe('SHEATH_RECOVERING');
    expect(sm.isBettingSuspended()).toBe(true);
  });

  it('recovery requires consecutive passing checks', () => {
    const sm = new SheathMode({ recoveryRequiredRounds: 3, maxRecoveryAttempts: 5 });
    sm.operatorSheath();
    sm.operatorUnsheath();

    const pass = [{ name: 'confidence', passed: true }];
    sm.onRoundTick(pass);
    sm.onRoundTick(pass);
    expect(sm.getState()).toBe('SHEATH_RECOVERING');
    sm.onRoundTick(pass);
    expect(sm.getState()).toBe('NORMAL');
    expect(sm.isBettingSuspended()).toBe(false);
  });

  it('failed recovery attempts promote to PERSISTENT', () => {
    const sm = new SheathMode({ recoveryRequiredRounds: 10, maxRecoveryAttempts: 2 });
    sm.operatorSheath();
    sm.operatorUnsheath();

    const fail = [{ name: 'confidence', passed: false }];
    sm.onRoundTick(fail);
    expect(sm.getState()).toBe('SHEATH_RECOVERING');
    sm.onRoundTick(fail);
    expect(sm.getState()).toBe('SHEATH_PERSISTENT');
  });
});
