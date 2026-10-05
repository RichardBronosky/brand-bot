# Pre-release security audit — 2026-10-05

Scope: final conversation feature, static GitHub Pages build, service worker,
Supabase SQL schema/migrations, actual hosted grants and anonymous API, owner
Auth flow, local secret handling, and production deployment workflow.

## Result

No unresolved critical or high-severity finding in the reviewed application.
This is a focused source/configuration review and regression audit, not a
claim that every future vulnerability or platform configuration is covered.

## Changes made before release

- Added a restrictive Content Security Policy: scripts/assets come from this
  site; API connections are limited to this site and the configured Supabase
  project. Inline scripts, plugins, base URL injection, and cross-origin form
  submission are blocked. Inline CSS remains allowed for the existing template.
- Fixed token-refresh and owner initialization races so a late response cannot
  restore owner sign-in after logout.
- Replaced automatic message-row JSON conversion with an explicit visitor field
  allowlist: id, timestamp, body, URL, sender. Internal request IDs and future
  private columns stay out of visitor responses.
- Made build, database permission, browser, and rendered QR checks prerequisites
  for Pages deployment. Feature/manual runs outside main cannot deploy Pages.

## Verified protections

Actual hosted database assertions pass: brand schema usage is denied to browser
roles, all private tables have RLS and no browser grants, SQL RPC functions use
an empty search_path, PUBLIC execution is revoked, and anonymous execution is
limited to the four intentional invitation/telemetry functions. Live HTTP probes
reject direct table access, owner operations, and invalid/missing invitation
operations. Local SQL tests verify separate-owner isolation, constraints,
invitation scoping, retry deduplication, atomic from/to location history, and
rejection of forged visitor location-history events.

Browser tests verify safe text rendering for adversarial message HTML, link
protocol handling, injected inline-script blocking by CSP, logout during an
in-flight token refresh, absence of unsolicited visitor reads, persistence,
offline retry, hierarchy navigation, and QR screenshot decoding. API/Auth
responses are excluded from the service-worker cache. Build tests reject secret
and service-role keys. Config files, DB password, connection metadata, and build
output remain gitignored; only the public publishable key enters the app.

The SQL approach follows [Supabase function security guidance](https://supabase.com/docs/guides/database/functions).
Public keys are intentional; grants and Auth enforce access, as described in
[Supabase API key guidance](https://supabase.com/docs/guides/getting-started/api-keys).

## Accepted behavior and limitations

- Invitation UUIDs are bearer credentials and stay valid. Anyone given or
  forwarded a link can read/send that conversation's shared messages and see its
  saved label. Private notes, coordinates, owner records, and bugs remain private.
- Public Auth signup is currently enabled in the hosted project. A new user
  gains no owner access; the private owner allowlist is authoritative. Disabling
  signup in the dashboard remains an optional reduction in unused Auth surface.
- No CAPTCHA or quota admission controls were added, per the owner's decision.
  Someone can consume free quota with permitted writes or invitation polling.
- UI events/visitor IDs/receipt events are client reports, not verified identity
  or proof of a sent email, saved contact, or read message.
- Owner tokens and drafts are stored on the owner's device. CSP and text-only
  rendering reduce XSS exposure; a compromised/unlocked device remains outside
  this application's protection. Supabase/GitHub account security and hosted
  platform internals were not independently penetration-tested.
- The audit does not reconstruct location changes made before audit logging
  was installed and does not constitute a backup/retention guarantee.

Re-run: `node tests/build.mjs`, `node tests/browser.mjs`,
`bash tests/database.sh`, and `node supabase/connect.mjs audit`.
