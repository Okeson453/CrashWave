import {
  entitlementsFrom,
  operatorEntitlements,
  mainControlKeyboard,
  operatorControlKeyboard,
  adminControlKeyboard,
  roleControlKeyboard,
  buildBotCommands,
  menuHeaderText,
} from '../../../src/platform/telegram-menu';

const tenant = {
  id: 'abcdefghij',
  telegramId: 1n,
  telegramUsername: null,
  email: null,
  status: 'active' as const,
  planId: 'p1',
  timezone: 'UTC',
  createdAt: new Date(),
};

const plan = {
  id: 'p1',
  name: 'Pro',
  priceMonthly: 10,
  maxDailyEntries: 100,
  fixedStake: 700,
  fixedTarget: 1.3,
  allowedModes: ['observe-only', 'dry-run', 'live'],
  features: { engine: true, analytics: true },
  minStake: 1,
  maxStake: 1000,
  stakeConfigurable: true,
  billingCycle: 'monthly' as const,
};

describe('telegram-menu 3-column grid', () => {
  it('uses at most 3 buttons per row', () => {
    const ent = entitlementsFrom(tenant, plan, null, false);
    for (const r of mainControlKeyboard(ent)) {
      expect(r.length).toBeLessThanOrEqual(3);
    }
    for (const r of operatorControlKeyboard(operatorEntitlements({ engineRunning: true }))) {
      expect(r.length).toBeLessThanOrEqual(3);
    }
    for (const r of adminControlKeyboard(entitlementsFrom(tenant, plan, null, true))) {
      expect(r.length).toBeLessThanOrEqual(3);
    }
  });

  it('cells are emoji + short label', () => {
    const ent = entitlementsFrom(tenant, plan, null, false);
    const flat = mainControlKeyboard(ent).flat();
    for (const b of flat) {
      expect(b.text.length).toBeGreaterThan(1);
      expect(b.callback_data.startsWith('ui:')).toBe(true);
    }
  });

  it('admin grid includes platform tiles', () => {
    const flat = adminControlKeyboard(entitlementsFrom(tenant, plan, null, true))
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toContain('ui:admin_users');
    expect(flat).toContain('ui:admin_pause_all');
  });

  it('roleControlKeyboard routes admin', () => {
    const ent = entitlementsFrom(tenant, plan, null, true);
    expect(ent.role).toBe('admin');
    const flat = roleControlKeyboard(ent).flat().map((b) => b.callback_data);
    expect(flat).toContain('ui:admin_users');
  });

  it('buildBotCommands includes admin_menu for admin', () => {
    const cmds = buildBotCommands(entitlementsFrom(tenant, plan, null, true)).map((c) => c.command);
    expect(cmds).toContain('admin_menu');
  });

  it('menuHeaderText for operator without tenant', () => {
    expect(menuHeaderText(null, operatorEntitlements())).toContain('OPERATOR');
  });
});
