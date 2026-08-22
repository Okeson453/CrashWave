/**
 * Paystack API client — customers, dedicated virtual accounts, verify, webhooks.
 */

import { createHmac, timingSafeEqual } from 'crypto';

import { getLogger } from '../../observability/logger.js';

const PAYSTACK_BASE = 'https://api.paystack.co';

export interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface PaystackCustomer {
  id: number;
  customer_code: string;
  email: string;
  first_name?: string;
  last_name?: string;
}

export interface PaystackDVA {
  id: number;
  account_number: string;
  account_name: string;
  bank: { name: string; id: number; slug: string };
  customer?: { id: number; customer_code: string };
}

export interface PaystackTransaction {
  reference: string;
  amount: number;
  status: string;
  paid_at: string | null;
  channel: string;
  currency?: string;
  customer?: { id: number; customer_code: string };
  authorization?: { bank?: string; last4?: string; channel?: string };
  metadata?: Record<string, unknown>;
}

export class PaystackClient {
  private readonly headers: Record<string, string>;
  private readonly logger = getLogger();
  private readonly secretKey: string;

  constructor(secretKey?: string) {
    this.secretKey = secretKey ?? process.env.PAYSTACK_SECRET_KEY ?? '';
    if (!this.secretKey) {
      throw new Error('PAYSTACK_SECRET_KEY is required');
    }
    this.headers = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as PaystackResponse<T>;
    if (!json.status) {
      this.logger.error(
        { component: 'PaystackClient', path, message: json.message },
        'Paystack API error'
      );
      throw new Error(`Paystack ${path}: ${json.message}`);
    }
    return json.data;
  }

  async createCustomer(params: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  }): Promise<PaystackCustomer> {
    return this.request<PaystackCustomer>('POST', '/customer', {
      email: params.email,
      first_name: params.firstName,
      last_name: params.lastName,
      phone: params.phone,
    });
  }

  async createDedicatedVirtualAccount(params: {
    customerCode: string;
    preferredBank?: string;
    firstName: string;
    lastName: string;
    phone: string;
  }): Promise<PaystackDVA> {
    return this.request<PaystackDVA>('POST', '/dedicated_account', {
      customer: params.customerCode,
      preferred_bank: params.preferredBank ?? process.env.PAYSTACK_PREFERRED_BANK ?? 'wema-bank',
      first_name: params.firstName,
      last_name: params.lastName,
      phone: params.phone,
      country: 'NG',
    });
  }

  async fetchDedicatedVirtualAccount(accountId: string): Promise<PaystackDVA> {
    return this.request<PaystackDVA>('GET', `/dedicated_account/${accountId}`);
  }

  async verifyTransaction(reference: string): Promise<PaystackTransaction> {
    return this.request<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  }

  /**
   * Paystack signs webhooks with HMAC-SHA512 of the raw body using the secret key.
   * Header: x-paystack-signature
   */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) {return false;}
    const secret =
      process.env.PAYSTACK_WEBHOOK_SECRET ||
      this.secretKey;
    const hash = createHmac('sha512', secret).update(rawBody).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
    } catch {
      return hash === signature;
    }
  }
}
