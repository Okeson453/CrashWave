# Multi-tenant phases — implementation status

## Phase 1 — Foundation ✅
- migrations/008_tenancy.sql (plans, users, subs, instances, audit, tenant_id columns)
- TenantManager, TenantSecretVault
- Config tenant env overrides
- Single-tenant engine unchanged without TENANT_ID

## Phase 2 — Control plane ✅
- TenantRouterBot (onboarding, plans, status, mode, creds)
- DockerContainerOrchestrator + Process fallback
- docker/docker-compose.tenant.yml

## Phase 3 — Billing & plans ✅
- SubscriptionService lifecycle
- Stripe webhook HMAC + events
- Quota enforcement in BettingCoordinator

## Phase 4 — Admin & observability ✅
- Control plane admin HTTP API
- Admin Telegram commands
- Global pause/resume, health sweep, audit log
- Next.js admin-dashboard/

## Phase 5 — Hardening ✅
- migrations/009_tenant_rls.sql
- applyTenantDbContext() on engine boot
- Redis keyPrefix from REDIS_KEY_PREFIX
- Credential message auto-delete in Telegram
- Credential purge on destroy/ban
- Network isolation guidance (TENANT_DOCKER_NETWORK / network_mode)
