# ADR 0001 — Production auth is fail-closed (A01/A03)

Status: decided, implemented on `fix/security-auth-admin`

## Decision

Production with `REQUIRE_AUTH=true` and no GitHub OAuth configured answers **503** with an actionable message instead of falling back to an unauthenticated owner. The fallback identity in production is downgraded to `viewer` (read-only); it can never hold `admin.*` or `*.write` permissions.

A narrow **bootstrap window** stays open only while OAuth is unconfigured: `GET /admin/settings` and `PUT /admin/settings/github` are reachable from loopback OR with a one-time setup token printed at boot. The window closes as soon as `getEffectiveOAuthConfig()` becomes truthy.

## Consequences
- Requires operator to configure GitHub login before production can be used — this is intentional (fail-closed).
- Bootstrap token is bounded: loopback-only by default; token header (`X-Codevia-Setup-Token`) for non-loopback operators; never exposed through query params; never grants any route outside settings.
- `DEMO_USER` (shared export) stays unchanged; the read-only identity is produced by `demoFallbackUser()` so no shared mutable object is altered.

## File references
- Design: `src/auth/setup-token.ts` (loopback check, token gen, bootstrap predicate)
- Enforcement: `src/http/auth.ts` (503 body, `demoFallbackUser`)
- Guards: `src/http/routes/admin.ts` (`requireAdminRead` + bootstrap bypass on settings)
