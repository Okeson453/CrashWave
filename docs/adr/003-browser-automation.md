# ADR 003: Browser Automation

## Status
Accepted

## Context
The system needs to interact with BC.Game's web interface to observe game state and place bets. We needed to choose a browser automation framework.

## Decision
We chose Playwright over Puppeteer and Selenium.

## Alternatives Considered

### Option 1: Puppeteer
- **Pros:** Lightweight, good Chrome DevTools Protocol support, large community
- **Cons:** Chrome-only (though Firefox support exists, it's less mature), less robust auto-waiting
- **Verdict:** Good but Playwright is more robust

### Option 2: Selenium
- **Pros:** Mature, supports many browsers, industry standard
- **Cons:** Slower, more complex setup, less reliable auto-waiting, heavier resource usage
- **Verdict:** Too heavy for our needs

### Option 3: Playwright (Chosen)
- **Pros:** Auto-waiting, cross-browser (Chromium, Firefox, WebKit), reliable, good TypeScript support, built-in tracing
- **Cons:** Larger dependency than Puppeteer, newer (less Stack Overflow content)
- **Verdict:** Best reliability and developer experience

### Option 4: Direct WebSocket/API
- **Pros:** No browser overhead, faster, more reliable
- **Cons:** BC.Game does not expose a public API, reverse engineering is fragile and violates ToS
- **Verdict:** Not feasible

## Consequences

### Positive
- Reliable DOM interaction with auto-waiting
- Built-in screenshot and video recording for debugging
- Tracing for performance analysis
- Headless mode for production
- Profile management for session persistence

### Negative
- Browser overhead (memory ~200-400MB)
- Requires periodic restart to prevent memory leaks
- DOM selectors can break if BC.Game updates their UI
- Network latency adds to observation delay

## Mitigations
- UI change detection with fallback to observe-only
- Browser health monitoring with automatic restart
- Profile encryption for security
- Stale multiplier detection
