import { NotificationRouter } from '../../../src/notifications/notification-router';
import { EventBus } from '../../../src/core/event-bus/bus';
import { NotificationPayload } from '../../../src/telegram/types';

describe('NotificationRouter', () => {
  it('subscribes and routes HealthDegraded when sendHealthWarnings enabled', async () => {
    const routed: string[] = [];
    const bus = new EventBus();
    const router = new NotificationRouter({
      eventBus: bus,
      critical: {
        dispatch: async (p: NotificationPayload) => {
          routed.push(`critical:${p.title}`);
        },
      } as never,
      health: {
        dispatch: async (p: NotificationPayload) => {
          routed.push(`health:${p.title}`);
        },
      } as never,
      routine: {
        dispatch: async (p: NotificationPayload) => {
          routed.push(`routine:${p.title}`);
        },
      } as never,
      queue: null,
      config: {
        sendRoundStart: false,
        sendRoundResult: true,
        sendHealthWarnings: true,
        verbosity: 'normal',
      },
    });
    router.start();
    await bus.emitTyped(
      'HealthDegraded',
      { component: 'ws', status: 'warning', message: 'disconnected' },
      't1',
      'test'
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(routed.some((r) => r.startsWith('health:'))).toBe(true);
    router.stop();
  });

  it('respects sendRoundStart=false', async () => {
    const routed: string[] = [];
    const bus = new EventBus();
    const router = new NotificationRouter({
      eventBus: bus,
      critical: { dispatch: async () => {} } as never,
      health: { dispatch: async () => {} } as never,
      routine: {
        dispatch: async (p: NotificationPayload) => {
          routed.push(p.title);
        },
      } as never,
      queue: null,
      config: {
        sendRoundStart: false,
        sendRoundResult: true,
        sendHealthWarnings: true,
        verbosity: 'normal',
      },
    });
    router.start();
    await bus.emitTyped(
      'RoundStarted',
      { roundId: 'r1', sessionId: 's1', startedAt: new Date().toISOString() },
      't2',
      'test'
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(routed).toHaveLength(0);
    router.stop();
  });
});
