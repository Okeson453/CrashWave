/**
 * Trips after N consecutive DOM/navigation failures and invokes onTrip
 * (typically a full browser relaunch). Separate from the financial circuit breaker.
 */
export class DomCircuitBreaker {
  private failures = 0;
  constructor(
    private readonly threshold = 3,
    private readonly onTrip: () => void
  ) {}

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.failures = 0;
      this.onTrip();
    }
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  getFailures(): number {
    return this.failures;
  }
}
