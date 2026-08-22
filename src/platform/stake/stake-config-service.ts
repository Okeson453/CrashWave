/**
 * StakeConfigurationService — plan stake ranges, upsell fee (1.5x monthly), history.
 */

import { getPool } from '../../persistence/client.js';
import { getLogger } from '../../observability/logger.js';
import { TenantManager } from '../tenant-manager.js';

export interface StakeConfig {
  currentStake: number;
  minStake: number;
  maxStake: number;
  isConfigurable: boolean;
  defaultStake: number;
  increaseFeeRequired: boolean;
  increaseFeeAmount: number;
  increasePaid: boolean;
}

export interface StakeChangeResult {
  success: boolean;
  message: string;
  oldStake?: number;
  newStake?: number;
  feeRequired?: number;
  feePaid?: boolean;
}

export class StakeConfigurationService {
  private readonly logger = getLogger();
  private readonly tenants = new TenantManager();
  private readonly multiplier = parseFloat(
    process.env.STAKE_INCREASE_FEE_MULTIPLIER ?? '1.5'
  );

  calculateIncreaseFee(monthlyFee: number): number {
    return Math.round(monthlyFee * this.multiplier);
  }

  async getStakeConfig(userId: string): Promise<StakeConfig | null> {
    const userResult = await getPool().query(
      `SELECT custom_stake, plan_id, stake_increase_paid, stake_increase_fee
       FROM users WHERE id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) return null;
    const user = userResult.rows[0] as {
      custom_stake: string | number;
      plan_id: string | null;
      stake_increase_paid: boolean;
      stake_increase_fee: string | number;
    };
    if (!user.plan_id) return null;
    const plan = await this.tenants.getPlan(user.plan_id);
    if (!plan) return null;

    const currentStake = parseFloat(String(user.custom_stake ?? plan.fixedStake));
    const increasePaid = Boolean(user.stake_increase_paid);
    return {
      currentStake,
      minStake: plan.minStake,
      maxStake: plan.maxStake,
      isConfigurable: plan.stakeConfigurable,
      defaultStake: plan.fixedStake,
      // Fee required once when configurable and not yet paid (unlock above default)
      increaseFeeRequired: plan.stakeConfigurable && !increasePaid,
      increaseFeeAmount: this.calculateIncreaseFee(plan.priceMonthly),
      increasePaid,
    };
  }

  async setStake(userId: string, newStake: number): Promise<StakeChangeResult> {
    const config = await this.getStakeConfig(userId);
    if (!config) return { success: false, message: 'User or plan not found' };
    if (!config.isConfigurable) {
      return {
        success: false,
        message: 'Your plan does not support stake customization. Upgrade to Pro or Whale.',
      };
    }
    if (newStake < config.minStake) {
      return {
        success: false,
        message: `Minimum stake for your plan is ${config.minStake.toLocaleString()}.`,
      };
    }
    if (newStake > config.maxStake) {
      return {
        success: false,
        message: `Maximum stake for your plan is ${config.maxStake.toLocaleString()}.`,
      };
    }

    const isIncrease = newStake > config.defaultStake;
    if (isIncrease && !config.increasePaid) {
      const fee = this.calculateIncreaseFee(
        (await this.tenants.getUserById(userId).then(async (u) => {
          const p = u?.planId ? await this.tenants.getPlan(u.planId) : null;
          return p?.priceMonthly ?? 0;
        })) ?? 0
      );
      return {
        success: false,
        message: `Increasing stake above ${config.defaultStake.toLocaleString()} requires a one-time fee of ₦${fee.toLocaleString()}. Use /pay_stake_increase to proceed.`,
        feeRequired: fee,
      };
    }

    const oldStake = config.currentStake;
    await getPool().query(
      `UPDATE users SET custom_stake = $1, updated_at = NOW() WHERE id = $2`,
      [newStake, userId]
    );
    await getPool().query(
      `INSERT INTO stake_change_history (user_id, old_stake, new_stake, change_type, fee_paid, changed_by)
       VALUES ($1, $2, $3, $4, $5, 'user')`,
      [
        userId,
        oldStake,
        newStake,
        newStake < oldStake ? 'decrease' : 'increase',
        config.increasePaid ? config.increaseFeeAmount : 0,
      ]
    );
    this.logger.info(
      { component: 'StakeConfig', userId, oldStake, newStake },
      'Stake changed'
    );
    return {
      success: true,
      message: `Stake updated to ₦${newStake.toLocaleString()}. Engine will use this on the next bet.`,
      oldStake,
      newStake,
    };
  }

  async processStakeIncreasePayment(
    userId: string,
    reference: string
  ): Promise<StakeChangeResult> {
    const user = await this.tenants.getUserById(userId);
    if (!user) return { success: false, message: 'User not found' };
    const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
    if (!plan) return { success: false, message: 'Plan not found' };
    const fee = this.calculateIncreaseFee(plan.priceMonthly);

    await getPool().query(
      `UPDATE users SET
         stake_increase_paid = true,
         stake_increase_fee = $1,
         stake_increase_paid_at = NOW(),
         updated_at = NOW()
       WHERE id = $2`,
      [fee, userId]
    );
    await getPool().query(
      `INSERT INTO payment_transactions (user_id, amount, currency, status, paystack_reference, channel)
       VALUES ($1, $2, 'NGN', 'success', $3, 'stake_increase_fee')
       ON CONFLICT (paystack_reference) DO NOTHING`,
      [userId, fee, reference]
    );
    this.logger.info(
      { component: 'StakeConfig', userId, fee, reference },
      'Stake increase fee paid'
    );
    return {
      success: true,
      message: `Stake increase fee of ₦${fee.toLocaleString()} paid. You may set stake up to ₦${plan.maxStake.toLocaleString()}.`,
      feePaid: true,
    };
  }

  async resetStakeToDefault(userId: string): Promise<StakeChangeResult> {
    const config = await this.getStakeConfig(userId);
    if (!config) return { success: false, message: 'User not found' };
    const oldStake = config.currentStake;
    await getPool().query(
      `UPDATE users SET custom_stake = $1, updated_at = NOW() WHERE id = $2`,
      [config.defaultStake, userId]
    );
    await getPool().query(
      `INSERT INTO stake_change_history (user_id, old_stake, new_stake, change_type, changed_by)
       VALUES ($1, $2, $3, 'reset', 'user')`,
      [userId, oldStake, config.defaultStake]
    );
    return {
      success: true,
      message: `Stake reset to default: ₦${config.defaultStake.toLocaleString()}.`,
      oldStake,
      newStake: config.defaultStake,
    };
  }

  async adminSetStake(
    userId: string,
    newStake: number,
    adminId: string
  ): Promise<StakeChangeResult> {
    const config = await this.getStakeConfig(userId);
    if (!config) return { success: false, message: 'User not found' };
    const oldStake = config.currentStake;
    await getPool().query(
      `UPDATE users SET custom_stake = $1, stake_increase_paid = true, updated_at = NOW() WHERE id = $2`,
      [newStake, userId]
    );
    await getPool().query(
      `INSERT INTO stake_change_history (user_id, old_stake, new_stake, change_type, changed_by)
       VALUES ($1, $2, $3, 'increase', $4)`,
      [userId, oldStake, newStake, `admin:${adminId}`]
    );
    return {
      success: true,
      message: `Admin set stake to ${newStake}`,
      oldStake,
      newStake,
    };
  }

  async getStakeHistory(userId: string): Promise<
    Array<{
      oldStake: number;
      newStake: number;
      changeType: string;
      feePaid: number;
      createdAt: Date;
    }>
  > {
    const result = await getPool().query(
      `SELECT old_stake, new_stake, change_type, fee_paid, created_at
       FROM stake_change_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    return result.rows.map((r) => ({
      oldStake: parseFloat(String(r.old_stake)),
      newStake: parseFloat(String(r.new_stake)),
      changeType: String(r.change_type),
      feePaid: parseFloat(String(r.fee_paid ?? 0)),
      createdAt: r.created_at as Date,
    }));
  }

  async listHighStakes(threshold = 10000): Promise<
    Array<{ userId: string; stake: number; telegramId: string }>
  > {
    const result = await getPool().query(
      `SELECT id, custom_stake, telegram_id FROM users
       WHERE custom_stake > $1 ORDER BY custom_stake DESC LIMIT 50`,
      [threshold]
    );
    return result.rows.map((r) => ({
      userId: String(r.id),
      stake: parseFloat(String(r.custom_stake)),
      telegramId: String(r.telegram_id),
    }));
  }
}
