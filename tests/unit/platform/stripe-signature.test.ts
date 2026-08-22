import { createHmac } from 'crypto';
import { verifyStripeSignature } from '../../../src/platform/billing/stripe-webhook';

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test_secret';

  it('accepts valid signature', () => {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000);
    const signed = `${ts}.${body}`;
    const sig = createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
    const header = `t=${ts},v1=${sig}`;
    expect(verifyStripeSignature(body, header, secret)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const body = '{}';
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(body, `t=${ts},v1=deadbeef`, secret)).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyStripeSignature('{}', undefined, secret)).toBe(false);
  });
});
