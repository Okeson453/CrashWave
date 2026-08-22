export type TenantStatus = 'onboarding' | 'active' | 'suspended' | 'cancelled' | 'banned';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';
export type InstanceStatus =
  | 'provisioning'
  | 'running'
  | 'paused'
  | 'error'
  | 'stopped'
  | 'destroyed';

export interface Tenant {
  id: string;
  telegramId: bigint;
  telegramUsername: string | null;
  email: string | null;
  status: TenantStatus;
  planId: string | null;
  timezone: string;
  createdAt: Date;
}

export interface TenantInstance {
  id: string;
  userId: string;
  containerId: string | null;
  containerHost: string | null;
  status: InstanceStatus;
  mode: string;
  dailyEntriesUsed: number;
  dailyResetAt: Date | null;
  pnlToday: number;
  pnlTotal: number;
  lastHeartbeat: Date | null;
}

export interface Plan {
  id: string;
  name: string;
  priceMonthly: number;
  maxDailyEntries: number;
  fixedStake: number;
  fixedTarget: number;
  allowedModes: string[];
  features: Record<string, boolean>;
  minStake: number;
  maxStake: number;
  stakeConfigurable: boolean;
  billingCycle: 'daily' | 'monthly' | 'yearly';
}

export interface QuotaResult {
  allowed: boolean;
  reason?: string;
}
