# Conversation backend

Decision: Supabase Free, PostgreSQL functions and managed Auth/Data API. Keep
GitHub Pages and the current domain. No Cloudflare account, custom Worker,
CAPTCHA, visitor authentication, or separate application server is required.

## Setup

1. Create a free Supabase project. Enable its Data API with `public` exposed.
   Keep the `brand` schema **unexposed**.
2. Run [schema.sql](schema.sql) once in the dashboard SQL editor. It creates
   private tables and narrowly granted public RPC functions.
3. In Authentication → Users, create your owner account with an email and
   password. Use a confirmed account. Disable public user sign-ups; visitors do
   not use Auth. Leave CAPTCHA disabled. Copy the owner's user UUID.
4. Add your owner in the SQL editor (replace the UUID):

   ```sql
   insert into brand.owners(user_id) values ('YOUR-AUTH-USER-UUID');
   ```

   Having an Auth account alone grants no owner access. There is no browser
   endpoint to claim ownership or add owners.
5. Add this optional object to your gitignored `config.json`:

   ```json
   "backend": {
     "url": "https://YOUR-PROJECT.supabase.co",
     "publishableKey": "sb_publishable_YOUR-PUBLIC-KEY"
   }
   ```

   Use the public publishable key (or legacy **anon** key). Never use a secret or
   service-role key. The build rejects those keys. Public keys are deliberately
   included in the site; database grants and function checks enforce access.
6. Run `./brand-bot build` / `./brand-bot serve` to preview. Publishing still uses
   `./brand-bot push-config` followed by the existing deploy workflow on main.
   A feature branch is not automatically deployed.
7. On your phone, open **My meeting tools**, sign in, and install the PWA. On each
   new installed-app launch at `#/qr`, an authenticated owner gets a fresh QR.
   You can also create one manually with **New conversation QR**. Returning to
   the QR during a conversation keeps the current invitation.

The hosted backend is not provisioned by a local build. Existing cards without
`backend` keep working normally. Supabase Free can pause an inactive project;
resume it in the dashboard before relying on it for a meeting. See the current
[free-plan details](https://supabase.com/pricing).

## Data and permissions

- `connections`: database timestamp, random invitation UUID, owner, optional
  phone coordinates/accuracy, label, private notes.
- `events`: random deduplication ID, browser visitor ID, optional connection,
  database receipt timestamp, allowed UI action, bounded JSON details.
- `messages`: persisted text and optional HTTP(S) URL for one conversation.
- `bugs`: private owner reports, connection, screen/app version and recent
  in-memory errors. Captured reports queue on the device if offline.

Tables have RLS enabled and no grants to browser roles. All app access uses SQL
RPC functions with explicit grants and a fixed empty `search_path`. Owner RPCs
check `auth.uid()` against `brand.owners` and scope records to that owner.
Visitor functions intentionally run with definer rights, validate the invitation
and permitted payload, and expose only the operation described below.

| Caller | Writes | Reads |
|---|---|---|
| Public visitor, no invitation | Page open, contact tap, vCard download tap | None |
| Visitor with invitation token | Same events plus message-page receipt/link tap | Shared messages for that token only |
| Configured owner | Connections, location, notes, messages, bug reports | Own conversations/events/bugs and unsolicited UI events |

The random token in `#/meet/TOKEN` is a bearer invitation. It stays valid; people
with a forwarded link can also read the shared messages. It reveals neither
location nor private notes. There is no global visitor-readable conversation
listing. Timestamp/coordinates are separate fields, not secrets embedded in a
URL. No CAPTCHA or quota-based admission controls are introduced. Payload bounds
and types protect data shape; they do not attempt to stop someone spending the
free quota.

Public event writes do not initiate a chat or collect an unsolicited message.
Cold contacts use your existing email/social links. A tap is an intent signal,
not evidence of an email sent, follow completed, or contact saved. Events are
client-reported, so they are not proof of human identity or action. Visitor IDs
are stored on the browser and are not names.

## Delivery and offline behavior

Invited pages and active owner conversations poll every three seconds while
visible. Polling stops while hidden; reopening retrieves saved messages.
“Received by page” means the visitor browser rendered the message, not that the
person read it. Public pages never poll or read database data.

Events and bug reports retry from a bounded device-local outbox (500 entries).
Database IDs make retries idempotent. Queue state and owner sign-in are local to
this device/browser. Bug reports are retried only under the same owner account.
Notes save explicitly; edits stay as local drafts if disconnected. Messages
require a successful online save and are not queued, so sending while offline
shows a failure. A new QR requires a database connection; failures explicitly
identify the previous/public QR being shown. Location permission/availability
never holds up the QR.

The service worker caches only same-origin site assets, never Supabase API/Auth
responses. The QR encoder is bundled locally with its MIT license. New builds
rotate the offline cache, including removal of old contact cards when disabled.
Activity screens show bounded recent history (100 conversations/messages/bugs,
200 events); the underlying records remain in PostgreSQL for later export or
pagination. Current bug capture is text; phone dictation can fill the field.

## Verification

```sh
node tests/build.mjs
node tests/browser.mjs
bash tests/database.sh
# Or, if PostgreSQL is not installed and Nix is available:
nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#postgresql --command bash tests/database.sh
```

The database test starts/stops a temporary Unix-socket-only PostgreSQL instance.
It tests API-role grants, owner isolation, invalid invitations, payload/URL
constraints and deduplication. Browser tests use real Chromium with mock HTTP
responses, decode the rendered QR screenshot, and exercise public writes,
notes/messages, invitation reopening, installed launch, and offline bug retry.
They do not assert that a real Supabase project is configured correctly.

On a configured project, check two separate browsers: sign in only on your
phone, generate an invitation, scan on the second browser, tap a contact link,
share a URL, and reopen the invitation. Check that an uninvited visit only adds
public UI events and that a signed-in non-owner cannot use meeting tools.
