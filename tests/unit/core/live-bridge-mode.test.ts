/**
 * Mode isolation smoke tests — pure logic without browser.
 */
describe('live-bridge mode isolation (source contract)', () => {
  it('documents that live bridge requires mode live', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../../src/core/live-bridge.ts'),
      'utf8'
    );
    expect(src).toMatch(/mode !== 'live'/);
    expect(src).toMatch(/isRealExecutionAllowed/);
    expect(src).toMatch(/LiveBetExecutor/);
  });

  it('documents dry-run bridge rejects non dry-run modes', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../../src/core/dry-run/dry-run-bridge.ts'),
      'utf8'
    );
    expect(src).toMatch(/mode !== 'dry-run'/);
    expect(src).toMatch(/observe-only/);
  });
});
