# ADR 004: Telegram Interface

## Status
Accepted

## Context
The system requires a remote control interface for the operator to monitor status, change modes, and trigger emergency stops. We needed to choose between Telegram, a web dashboard, Slack, and other options.

## Decision
We chose Telegram Bot API as the primary operator interface.

## Alternatives Considered

### Option 1: Web Dashboard
- **Pros:** Rich UI, real-time charts, easy to build with React/Vue
- **Cons:** Requires hosting, authentication complexity, not mobile-friendly for emergency actions, additional attack surface
- **Verdict:** Good for monitoring but poor for emergency control

### Option 2: Slack Bot
- **Pros:** Rich formatting, threads, good for team collaboration
- **Cons:** Requires Slack workspace, rate limits, not as mobile-optimized as Telegram
- **Verdict:** Good alternative but Telegram is simpler

### Option 3: Telegram Bot (Chosen)
- **Pros:** Mobile-first, push notifications, simple API, no hosting needed (Telegram hosts the bot), encrypted messages, widespread use
- **Cons:** Requires internet connection, Telegram API rate limits, dependency on third-party service
- **Verdict:** Best for mobile emergency control and notifications

### Option 4: CLI Only
- **Pros:** No external dependencies, secure, scriptable
- **Cons:** Not accessible remotely, requires SSH access, poor for urgent situations
- **Verdict:** Insufficient for operational needs

## Consequences

### Positive
- Operator can control system from anywhere
- Push notifications for critical alerts
- Simple command interface
- No additional infrastructure to host
- Message history provides audit trail

### Negative
- Dependency on Telegram service availability
- Bot token security risk
- Rate limiting (30 messages/minute)
- Limited message formatting

## Security Measures
- User ID allowlist - only authorized operators can issue commands
- No sensitive data in Telegram messages
- Command logging for audit trail
- Bot token rotated regularly
