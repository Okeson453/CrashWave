/**
 * Session lifecycle & rotation (R1-D).
 * Cold → Warming → Authenticated → Active → Cooling → Rotating → Quarantined
 */

import { EventEmitter } from 'events';
import { getLogger } from '../observability/logger';
import { ChallengeEvent } from './challenge-detector';

export type SessionLifecycleState =
  | 'Cold'
  | 'Warming'
  | 'Authenticated'
  | 'Active'
  | 'Cooling'
  | 'Rotating'
  | 'Quarantined';

export interface SessionRotatorOptions {
  maxAgeHours: number;
  maxContinuousActiveMinutes: number;
  rotationJitterMinutes: number;
  quarantineOnChallenge: boolean;
  minWarmStandbyProfiles: number;
}

export interface SessionSnapshot {
  state: SessionLifecycleState;
  profileId: string | null;
  sessionStartedAt: string | null;
  activeSince: string | null;
  lastQuarantineReason: string | null;
  ageMs: number;
  continuousActiveMs: number;
}

const DEFAULTS: SessionRotatorOptions = {
  maxAgeHours: 12,
  maxContinuousActiveMinutes: 150,
  rotationJitterMinutes: 25,
  quarantineOnChallenge: true,
  minWarmStandbyProfiles: 1,
};

export class SessionRotator extends EventEmitter {
  private readonly options: SessionRotatorOptions;
  private readonly logger = getLogger();
  private state: SessionLifecycleState = 'Cold';
  private profileId: string | null = null;
  private sessionStartedAt: number | null = null;
  private activeSince: number | null = null;
  private lastQuarantineReason: string | null = null;
  private rotationDeadlineMs: number | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: Partial<SessionRotatorOptions>) {
    super();
    this.options = { ...DEFAULTS, ...options };
  }

  startMonitoring(intervalMs = 30_000): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => this.evaluate(), intervalMs);
    if (typeof this.checkTimer === 'object' && 'unref' in this.checkTimer) {
      (this.checkTimer as NodeJS.Timeout).unref();
    }
  }

  stopMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  getState(): SessionLifecycleState {
    return this.state;
  }

  getSnapshot(): SessionSnapshot {
    const now = Date.now();
    return {
      state: this.state,
      profileId: this.profileId,
      sessionStartedAt: this.sessionStartedAt ? new Date(this.sessionStartedAt).toISOString() : null,
      activeSince: this.activeSince ? new Date(this.activeSince).toISOString() : null,
      lastQuarantineReason: this.lastQuarantineReason,
      ageMs: this.sessionStartedAt ? now - this.sessionStartedAt : 0,
      continuousActiveMs: this.activeSince ? now - this.activeSince : 0,
    };
  }

  /** Whether new live entries are allowed */
  canAcceptEntries(): boolean {
    return this.state === 'Active' || this.state === 'Authenticated';
  }

  transition(to: SessionLifecycleState, reason?: string): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === 'Cold' || to === 'Warming') {
      this.sessionStartedAt = Date.now();
      this.activeSince = null;
      this.scheduleRotationDeadline();
    }
    if (to === 'Active') {
      this.activeSince = Date.now();
    }
    if (to === 'Quarantined') {
      this.lastQuarantineReason = reason ?? 'unspecified';
      this.activeSince = null;
    }
    this.logger.info(
      { component: 'SessionRotator', from, to, reason, profileId: this.profileId },
      `Session lifecycle: ${from} → ${to}`
    );
    this.emit('transition', { from, to, reason, profileId: this.profileId });
  }

  bindProfile(profileId: string): void {
    this.profileId = profileId;
  }

  onChallenge(event: ChallengeEvent): void {
    if (!this.options.quarantineOnChallenge) {
      this.transition('Cooling', `challenge:${event.kind}`);
      return;
    }
    this.transition('Quarantined', `${event.kind}: ${event.detail}`);
    this.emit('quarantine', event);
  }

  softTrigger(reason: string): void {
    if (this.state === 'Active' || this.state === 'Authenticated') {
      this.logger.warn({ component: 'SessionRotator', reason }, 'Soft rotation trigger');
      this.transition('Cooling', reason);
      this.emit('rotation-needed', { reason, profileId: this.profileId });
    }
  }

  private scheduleRotationDeadline(): void {
    const base = this.options.maxAgeHours * 3600_000;
    const jitter = (Math.random() * 2 - 1) * this.options.rotationJitterMinutes * 60_000;
    this.rotationDeadlineMs = Date.now() + base + jitter;
  }

  evaluate(): void {
    if (!this.sessionStartedAt) return;
    const now = Date.now();

    if (this.state === 'Quarantined' || this.state === 'Rotating' || this.state === 'Cold') {
      return;
    }

    if (this.rotationDeadlineMs && now >= this.rotationDeadlineMs) {
      this.transition('Rotating', 'max session age');
      this.emit('rotation-needed', { reason: 'max_age', profileId: this.profileId });
      return;
    }

    if (
      this.activeSince &&
      now - this.activeSince >= this.options.maxContinuousActiveMinutes * 60_000
    ) {
      this.transition('Cooling', 'max continuous active time');
      this.emit('rotation-needed', {
        reason: 'max_continuous_active',
        profileId: this.profileId,
      });
    }
  }

  /** Mark rotation complete with optional new profile */
  completeRotation(newProfileId?: string): void {
    if (newProfileId) this.profileId = newProfileId;
    this.sessionStartedAt = Date.now();
    this.activeSince = null;
    this.lastQuarantineReason = null;
    this.scheduleRotationDeadline();
    this.transition('Warming', 'rotation complete');
  }
}
