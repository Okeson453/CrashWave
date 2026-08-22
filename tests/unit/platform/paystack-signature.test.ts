import { createHmac } from 'crypto';
import { PaystackClient } from '../../../src/platform/payments/paystack-client';

describe('PaystackClient.verifyWebhookSignature', () => {
  const secret = 'sk_test_paystack_secret_key_value';

  it('accepts valid sha512 signature', () => {
    process.env.PAYSTACK_SECRET_KEY = secret;
    const client = new PaystackClient(secret);
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'r1' } });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(client.verifyWebhookSignature(body, sig)).toBe(true);
  });

  it('rejects invalid signature', () => {
    process.env.PAYSTACK_SECRET_KEY = secret;
    const client = new PaystackClient(secret);
    expect(client.verifyWebhookSignature('{}', 'deadbeef')).toBe(false);
  });
});
