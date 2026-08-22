import { createHmac } from 'crypto';
import { PaystackClient } from '../../../src/platform/payments/paystack-client';
import { processPaystackWebhookHttp } from '../../../src/platform/payments/webhook-handler';

describe('webhook security', () => {
  const secret = 'sk_test_webhook_security_key';

  beforeAll(() => {
    process.env.PAYSTACK_SECRET_KEY = secret;
    process.env.NODE_ENV = 'production';
    delete process.env.PAYSTACK_SKIP_SIGNATURE;
  });

  it('rejects missing signature in production', async () => {
    const res = await processPaystackWebhookHttp({
      rawBody: JSON.stringify({ event: 'charge.success', data: {} }),
      signatureHeader: undefined,
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid signature', async () => {
    const res = await processPaystackWebhookHttp({
      rawBody: '{}',
      signatureHeader: 'deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('accepts valid signature structure', () => {
    const client = new PaystackClient(secret);
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'x' } });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(client.verifyWebhookSignature(body, sig)).toBe(true);
  });
});
