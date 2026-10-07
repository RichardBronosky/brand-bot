# brand-bot

A QR code you show someone you just met. They scan it, land on a page with your
name on it, and pick how they know you — professional or personal. Each side
shows only the links that belong there.

Live example: **[bruno.bronosky.com](https://bruno.bronosky.com/)**

You can have the same thing, on your own domain, for free. It needs a domain you
already own and a free GitHub account. No server, no hosting bill, no framework.

---

## How it works

| File | What it is |
|---|---|
| `template.html` | The page. Hash routes (`#/professional`, `#/personal`, `#/qr`). |
| `config.json` | Your name and links. Not in this repo — see below. |
| `build.mjs` | Renders template + config into `dist/`. No dependencies. |
| `brand-bot` | CLI: build, preview, publish your config. |
| `.github/workflows/deploy.yml` | Renders and deploys to GitHub Pages. |
| `sw.js` | Service-worker template, rendered with the assets this build produces. |
| `app.js`, `app.css` | Card navigation and optional private meeting tools. |
| `supabase/schema.sql` | Optional conversation database and SQL authorization. |

The published page is static HTML. Contact links are rendered at build time, not
fetched by the browser.

### Your config is not in the repo

`config.json` is gitignored. It lives in a **GitHub Actions repository
variable** named `BRAND_CONFIG`, attached to your repo's settings rather than its
git history.

Repository variables are not copied on fork, so a fork starts with no config and
the build stops with instructions instead of publishing a card with someone
else's name on it.

`qr.svg` is generated, not committed, for the same reason.

---

## Make it yours

Needs: a domain, a GitHub account, `gh`, and Node 18+.

```sh
gh repo fork RichardBronosky/brand-bot --clone
cd brand-bot

cp config.example.json config.json
$EDITOR config.json            # name, domain, links

./brand-bot qr                 # generate qr.svg for your domain
./brand-bot serve              # preview at http://127.0.0.1:8765
./brand-bot push-config        # upload config to the repo variable
```

Then, once:

**1. DNS.** For a subdomain (`cards.example.com`), one record:

```
CNAME   cards   yourhandle.github.io.
```

For an apex (`example.com`), four A records instead — apex domains cannot
use CNAME:

```
A   @   185.199.108.153
A   @   185.199.109.153
A   @   185.199.110.153
A   @   185.199.111.153
```

**2. Pages.** Settings → Pages → Source: **GitHub Actions**.

**3. Deploy.** Actions → *Build and deploy card* → Run workflow.

**4. Custom domain.** Settings → Pages → Custom domain → your domain → Save.
Wait for the certificate, then tick **Enforce HTTPS**. (`build.mjs` writes the
`CNAME` file into `dist/` from your config's `domain`, so this usually
populates itself.)

### The CLI

```
./brand-bot build          render config.json -> dist/
./brand-bot serve [port]   build, then serve dist/ locally
./brand-bot qr             regenerate qr.svg from your config's domain
./brand-bot push-config    upload config.json to the repo variable
./brand-bot pull-config    download the repo variable into config.json
./brand-bot show-config    print the config stored on GitHub
./brand-bot status         repo, config, variable and Pages state
```

`push-config` builds before it uploads, so a config that cannot render never
reaches the repo.

---

## Config

See [`config.example.json`](config.example.json).

```json
{
  "name": "Your Name",
  "tagline": "Nice to meet you.",
  "domain": "cards.example.com",

  "professional": {
    "label": "Professional",
    "icon": "💼",
    "blurb": "Work, code, hiring, speaking",
    "links": [
      { "icon": "🐙", "label": "GitHub", "sub": "@you", "href": "https://github.com/you" }
    ]
  },

  "personal": { "...": "same shape" },

  "vcard":  { "enabled": true, "email": "you@example.com" },
  "credit": "default"
}
```

`domain` becomes the `CNAME` file, the canonical URL, and what the QR encodes.

A link `href` must be `https:`, `http:`, `mailto:`, `tel:` or `sms:`. All values
are HTML-escaped on render.

`vcard.email` is the preferred address in the downloaded `.vcf`. Every link from
both sides is carried into it, deduplicated.

### Attribution

`credit` controls one line at the bottom of the card:

| Value | Shows |
|---|---|
| `"default"` | Built with **brand-bot** by **Bruno Bronosky**. |
| `"github"` | Built with **brand-bot**. |
| `"none"` | Nothing visible; an HTML comment remains in the source. |

---

## The QR screen

`#/qr` fills the screen with the code, positioned clear of where a phone's lock
screen puts its clock and shortcuts, so a screenshot works as wallpaper. The
page suggests the steps for the viewer's OS.

Installed as a PWA, the home screen icon opens straight to this screen — if you
are tapping it, you are standing in front of someone. The card is one tap back.

---

## Optional conversation tools

Keep the static card as-is, or connect a free Supabase project to add private
meeting tools. See [setup and architecture](supabase/README.md).

On your authenticated phone, the installed app opens a fresh conversation QR.
Timestamp and optional phone location stay private in the database. Visitors see
the usual card and any messages or project links you share. The same invitation
works tomorrow. Your tools show page opens, contact-link taps, and message-page
receipts, and let you save private notes or capture a bug without interrupting
the conversation.

Public visits submit UI events only; they never read database records or create
conversations. There is no CAPTCHA, visitor sign-up, or custom backend server.
Supabase supplies the hosted API and owner authentication; SQL functions enforce
permissions. Without backend configuration the card retains its static behavior.

## Development

```sh
nix develop
```

| Command | Does |
|---|---|
| `serve [port]` | Serve `dist/`. `BIND=<ip> serve` to expose on an interface. |
| `qr [url]` | Regenerate `qr.svg` (defaults to your config's domain). |
| `qr-check` | Assert your local `qr.svg` matches `config.json`. |

Without Nix: Node 18+ runs `build.mjs`; `qrencode` and `zbar` are only needed to
regenerate the QR. CI installs them itself.

---

## For an agent working in a clone of this repo

Read this before changing anything.

Checks for the optional feature (require a generated local `qr.svg`):

```sh
node tests/build.mjs                 # Node 18+
node tests/browser.mjs               # Node 22+, Chromium, zbarimg
bash tests/database.sh              # PostgreSQL binaries in PATH
```

Try the meeting tools without a Supabase project with `node demo.mjs`. Open
`http://127.0.0.1:8766/#/owner` and sign in as `demo@example.org` / `demo`.
Use a separate browser or private window to open the conversation invitation.
The clearly labeled demo uses an in-memory mock database; restarting it discards
its data. It binds to this computer's loopback interface and is not deployed.

For phone testing, proxy the running demo through Tailscale Serve:

```sh
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:8766
```

Use a free HTTPS port if another Serve route already occupies 443. Follow the
CLI's account setup link if HTTPS/Serve is not enabled yet. Open the displayed
`https://…ts.net/#/owner` address on both devices, with Tailscale connected to the
same tailnet. Generate the QR from that address so it contains the reachable
hostname. The demo uses same-origin API requests behind the HTTPS proxy.

The browser checks use mocked Supabase HTTP responses and a real browser. The
SQL checks use a disposable real PostgreSQL database with test Auth roles. A live
Supabase project is still needed to check its hosted API and Auth configuration.

**The build must stay dependency-free.** `build.mjs` uses only Node builtins.
Do not add a `package.json`, a bundler, or a templating library. CI runs
`node build.mjs` with no install step.

**Never commit `config.json`, `qr.svg` or `dist/`.** They are gitignored on
purpose (see *Your config is not in the repo*). If a task seems to require
committing one, that is a sign the task is wrong.

**Do not rewrite the QR SVG's attributes.** `qrSvg()` in `build.mjs` inlines
qrencode's output verbatim. Changing its `width`, `height` or
`preserveAspectRatio` puts module edges on fractional pixels and the rendered
code stops scanning — while still *looking* like a QR code. If you touch
anything near the QR, verify by decoding a screenshot of the rendered page,
not the source file:

```sh
./brand-bot serve &
chromium --headless --screenshot=/tmp/qr.png --window-size=390,844 \
  'http://127.0.0.1:8765/#/qr'
zbarimg --quiet --raw /tmp/qr.png    # must print your URL
```

**Config crosses a trust boundary.** It arrives from a repository variable and
is interpolated into HTML. `esc()` and `safeHref()` exist for that reason; keep
them on every value that reaches the page.

**Attribution is not configurable** beyond the three `credit` modes. The author
strings live in `AUTHOR` in `build.mjs` and the wording is fixed, so that
someone unfamiliar with this kind of tooling cannot half-edit it into a broken
or misleading claim. Do not turn it back into a config file.

**The placeholder check is a safety feature.** `validate()` refuses to build a
config still containing example values, so an unedited fork cannot publish a
half-configured card. Do not relax it.

**Verify rendering by looking.** This project has had bugs that only a rendered
screenshot revealed: a corrupt QR, a footer overlapping a button, content
clipped off-screen. A 200 response is not evidence the page is correct.

---

## Related sites on bronosky.com

brand-bot is served from its own subdomain (`bruno.bronosky.com`) and does not
touch anything under `bronosky.com/`. In particular, the resume at
<https://bronosky.com/resume/> is a separate project, deployed from
[RichardBronosky/resume](https://github.com/RichardBronosky/resume#publishing-bronoskycomresume)
by its own Pages workflow (it no longer uses a `gh-pages` branch).

## Questions, or want help setting one up?

Bruno Bronosky — [bruno.bronosky.com](https://bruno.bronosky.com/).
Available for consulting, personal or professional.

Issues and pull requests welcome on
[this repo](https://github.com/RichardBronosky/brand-bot).
