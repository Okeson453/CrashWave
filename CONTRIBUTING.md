# Contributing Guidelines

## Development Workflow

1. All changes must be made via pull request.
2. CI must pass (lint, type-check, unit tests) before merge.
3. Security-sensitive changes require additional review.
4. All commits should follow conventional commit format.

## Commit Convention

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `security`

Examples:
- `feat(betting): add idempotency key generation`
- `fix(health): correct degraded threshold calculation`
- `security(crypto): rotate encryption key handling`

## Code Standards

- TypeScript strict mode is enforced.
- All public functions must have explicit return types.
- No `any` types without documented justification.
- All errors must use the custom error hierarchy.
- All async operations must handle errors explicitly.
- Secrets must never be logged or committed.
- Tests must cover happy path and error paths.

## Testing

- Unit tests: fast, isolated, no external dependencies.
- Integration tests: require Postgres/Redis test instances.
- Simulation tests: mock game server scenarios.
- E2E tests: full dry-run validation.

## Environment Setup

```bash
npm install
npm run typecheck
npm run test
```

## Before Submitting

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test
```
