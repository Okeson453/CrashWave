/**
 * Payment amount validation: underpayment must not activate.
 */

function acceptsPayment(received: number, expected: number): boolean {
  return received >= expected;
}

describe('payment amount validation', () => {
  const expected = 79000;

  it('accepts exact', () => {
    expect(acceptsPayment(79000, expected)).toBe(true);
  });

  it('accepts +1 overpay', () => {
    expect(acceptsPayment(79001, expected)).toBe(true);
  });

  it('rejects 1 under', () => {
    expect(acceptsPayment(78999, expected)).toBe(false);
  });

  it('rejects significant underpay', () => {
    expect(acceptsPayment(1000, expected)).toBe(false);
  });

  it('daily plan exact', () => {
    expect(acceptsPayment(2000, 2000)).toBe(true);
    expect(acceptsPayment(1999, 2000)).toBe(false);
  });
});
