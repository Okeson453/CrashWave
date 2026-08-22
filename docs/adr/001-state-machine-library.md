# ADR 001: State Machine Library

## Status
Accepted

## Context
The betting system requires robust state management for bets transitioning through multiple states (RESERVED, REQUESTED, PENDING, ACTIVE, CASHED_OUT, LOST, FAILED, UNKNOWN). We needed to decide whether to use an existing state machine library or implement a custom solution.

## Decision
We implemented a custom lightweight state machine (`src/core/state-machine/`) rather than adopting a third-party library like XState or Robot.

## Alternatives Considered

### Option 1: XState
- **Pros:** Mature, well-documented, visualizer, actor model
- **Cons:** Heavy dependency (~100KB), complex API for our simple needs, additional learning curve
- **Verdict:** Overkill for our use case

### Option 2: Robot
- **Pros:** Lightweight, functional, good TypeScript support
- **Cons:** Smaller community, less documentation, still an external dependency
- **Verdict:** Good but unnecessary

### Option 3: Custom Implementation (Chosen)
- **Pros:** Zero dependencies, exactly matches our domain, full control over behavior, easy to extend
- **Cons:** Must maintain ourselves, no visualizer
- **Verdict:** Best fit for our requirements

## Consequences

### Positive
- No external dependency for core betting logic
- State transitions are explicit and auditable
- Easy to add new states (e.g., RECONCILED for recovery)
- Direct integration with EventBus for event emission

### Negative
- Team must understand the state machine implementation
- No built-in visualization tools
- Must implement guards and side effects manually

## Implementation
The state machine consists of:
- `BetState` enum defining all possible states
- `StateMachine` class managing transitions
- `StateTransition` type defining valid transitions
- Guards preventing invalid transitions
- EventBus integration for state change notifications
