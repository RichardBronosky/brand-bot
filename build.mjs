#!/usr/bin/env node
// Render config -> static HTML.
//
// Config resolution, highest priority first:
//   1. BRAND_CONFIG env var (JSON string)
//   2. ./config.json
//   3. error

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const OUT = join(root, "dist");

const PLACEHOLDERS = ["Your Name", "you.example.com", "you@example.com", "yourhandle"];

const AUTHOR = {
  author: "Bruno Bronosky",
  authorUrl: "https://bruno.bronosky.com/",
  projectName: "brand-bot",
  projectUrl: "https://github.com/RichardBronosky/brand-bot",
};

function die(msg) {
  console.error("\nbuild failed: " + msg + "\n");
  process.exit(1);
}

function loadConfig() {
  const env = process.env.BRAND_CONFIG;
  if (env && env.trim()) {
    try {
      return { config: JSON.parse(env), source: "BRAND_CONFIG env var" };
    } catch (e) {
      die(
        "BRAND_CONFIG is set but is not valid JSON: " + e.message +
        "\n\nIf this is a GitHub Actions run, check the repository variable:" +
        "\n  gh variable set BRAND_CONFIG < config.json"
      );
    }
  }

  const local = join(root, "config.json");
  if (existsSync(local)) {
    try {
      return { config: JSON.parse(readFileSync(local, "utf8")), source: "config.json" };
    } catch (e) {
      die("config.json is not valid JSON: " + e.message);
    }
  }

  die(
    "no configuration found.\n" +
    "\n  Locally:  cp config.example.json config.json   # then edit it" +
    "\n  In CI:    set the BRAND_CONFIG repository variable" +
    "\n            gh variable set BRAND_CONFIG < config.json"
  );
}

function validate(config, source) {
  const missing = [];
  if (!config.name) missing.push("name");
  if (!config.domain) missing.push("domain");
  if (missing.length) die("config (" + source + ") is missing required field(s): " + missing.join(", "));

  const blob = JSON.stringify(config);
  const hits = PLACEHOLDERS.filter((p) => blob.includes(p));
  if (hits.length) {
    die(
      "config (" + source + ") still contains example placeholder(s): " + hits.join(", ") +
      "\n\nEdit your config so it describes you, then build again."
    );
  }
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Blocks javascript: and data: URIs.
function safeHref(href) {
  const v = String(href ?? "").trim();
  if (/^(https?:|mailto:|tel:|sms:)/i.test(v)) return v;
  die("refusing unsafe or unsupported link href: " + JSON.stringify(href) +
      "\nAllowed schemes: https:, http:, mailto:, tel:, sms:");
}

function renderLinks(links = []) {
  return links
    .map(
      (l) => `        <li><a class="link" href="${esc(safeHref(l.href))}">
          <span class="ico" aria-hidden="true">${esc(l.icon || "🔗")}</span>
          <span class="txt"><span class="lbl">${esc(l.label)}</span><span class="sub">${esc(l.sub || "")}</span></span>
        </a></li>`
    )
    .join("\n");
}

const CREDIT_MODES = {
  default:
    `<footer><p class="credit">Built with <a href="${AUTHOR.projectUrl}">${AUTHOR.projectName}</a> ` +
    `by <a href="${AUTHOR.authorUrl}">${AUTHOR.author}</a>.</p></footer>`,

  github:
    `<footer><p class="credit">Built with <a href="${AUTHOR.projectUrl}">${AUTHOR.projectName}</a>.</p></footer>`,

  none: "",
};

function renderCredit(config) {
  const mode = String(config.credit ?? "default").toLowerCase();

  if (!(mode in CREDIT_MODES)) {
    die(
      `unknown credit mode: ${JSON.stringify(config.credit)}\n` +
      `Valid values: ${Object.keys(CREDIT_MODES).map((m) => `"${m}"`).join(", ")}`
    );
  }

  return CREDIT_MODES[mode];
}

function qrSvg(config) {
  const file = join(root, "qr.svg");
  if (!existsSync(file)) {
    die("qr.svg is missing.\n\n  ./brand-bot qr");
  }
  const svg = readFileSync(file, "utf8");
  const start = svg.indexOf("<svg");
  if (start < 0) die("qr.svg does not contain an <svg> element");

  // Keep qrencode's own attributes. Rewriting width/height or
  // preserveAspectRatio puts module edges on fractional pixels and the
  // rendered code stops scanning.
  return svg.slice(start).trim();
}

function icon(config, size) {
  const initials = String(config.name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const r = Math.round(size * 0.22);
  const fs = Math.round(size * 0.42);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="#0b0d10"/>
  <text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#e9eef5"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        font-size="${fs}" font-weight="600">${esc(initials)}</text>
</svg>
`;
}

function manifest(config) {
  return JSON.stringify(
    {
      name: config.name,
      short_name: String(config.name).split(/\s+/)[0],
      description: `${config.name} — how to connect.`,
      start_url: "./#/qr",
      scope: "./",
      display: "standalone",
      orientation: "portrait",
      background_color: "#0b0d10",
      theme_color: "#0b0d10",
      icons: [
        { src: "icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
        { src: "icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" },
        { src: "icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "maskable" },
      ],
      shortcuts: [
        { name: "Show QR", short_name: "QR", url: "./#/qr" },
      ],
    },
    null,
    2
  ) + "\n";
}

function renderVcard(config) {
  if (config.vcard?.enabled === false) return "";
  return `  <a class="vcard" href="contact.vcf" download>${esc(config.vcard?.label || "Save my contact card (.vcf)")}</a>`;
}

// vCard 3.0. Values are escaped per RFC 2426: backslash, comma, semicolon
// and newline are special inside a property value.
const vesc = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");

// Long lines must be folded at 75 octets, continuation lines start with a space.
function vfold(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > 74) {
      out.push(cur);
      cur = " " + ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.join("\r\n");
}

const SOCIAL = [
  [/github\.com/i, "github"],
  [/linkedin\.com/i, "linkedin"],
  [/instagram\.com/i, "instagram"],
  [/t\.me|telegram/i, "telegram"],
  [/wa\.me|whatsapp/i, "whatsapp"],
  [/signal\.me/i, "signal"],
  [/(twitter|x)\.com/i, "twitter"],
  [/mastodon|.*@.*\..*\/@/i, "mastodon"],
  [/bsky\.app/i, "bluesky"],
  [/youtube\.com/i, "youtube"],
];

function buildVcf(config) {
  const parts = String(config.name).trim().split(/\s+/);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const middle = parts.slice(1, -1).join(" ");

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${vesc(last)};${vesc(first)};${vesc(middle)};;`,
    `FN:${vesc(config.name)}`,
  ];

  if (config.vcard?.org) lines.push(`ORG:${vesc(config.vcard.org)}`);
  if (config.vcard?.title) lines.push(`TITLE:${vesc(config.vcard.title)}`);
  if (config.tagline) lines.push(`NOTE:${vesc(config.tagline)}`);

  const email = config.vcard?.email;
  if (email) lines.push(`EMAIL;TYPE=INTERNET,PREF:${vesc(email)}`);

  lines.push(`URL;TYPE=PREF:https://${vesc(config.domain)}/`);

  // Every link from both sides, so a saved contact carries the whole card.
  const seen = new Set([`https://${config.domain}/`]);
  for (const l of [...(config.professional?.links || []), ...(config.personal?.links || [])]) {
    const href = String(l.href || "");
    if (!href || seen.has(href)) continue;
    seen.add(href);

    if (/^mailto:/i.test(href)) {
      const addr = href.replace(/^mailto:/i, "");
      if (addr !== email) lines.push(`EMAIL;TYPE=INTERNET:${vesc(addr)}`);
      continue;
    }
    if (/^tel:/i.test(href)) {
      lines.push(`TEL;TYPE=CELL:${vesc(href.replace(/^tel:/i, ""))}`);
      continue;
    }

    const hit = SOCIAL.find(([re]) => re.test(href));
    if (hit) lines.push(`X-SOCIALPROFILE;TYPE=${hit[1]}:${vesc(href)}`);
    else lines.push(`URL:${vesc(href)}`);
  }

  lines.push("END:VCARD");
  return lines.map(vfold).join("\r\n") + "\r\n";
}

// ---- main ----

const { config, source } = loadConfig();
validate(config, source);

const template = readFileSync(join(root, "template.html"), "utf8");

const pro = config.professional || {};
const per = config.personal || {};

const html = template
  .replaceAll("{{NAME}}", esc(config.name))
  .replaceAll("{{TAGLINE}}", esc(config.tagline || ""))
  .replaceAll("{{DOMAIN}}", esc(config.domain))
  .replaceAll("{{PRO_LABEL}}", esc(pro.label || "Professional"))
  .replaceAll("{{PRO_ICON}}", esc(pro.icon || "💼"))
  .replaceAll("{{PRO_BLURB}}", esc(pro.blurb || ""))
  .replaceAll("{{PRO_LINKS}}", renderLinks(pro.links))
  .replaceAll("{{PER_LABEL}}", esc(per.label || "Personal"))
  .replaceAll("{{PER_ICON}}", esc(per.icon || "🌻"))
  .replaceAll("{{PER_BLURB}}", esc(per.blurb || ""))
  .replaceAll("{{PER_LINKS}}", renderLinks(per.links))
  .replaceAll("{{VCARD}}", renderVcard(config))
  .replaceAll("{{CREDIT}}", renderCredit(config))
  .replaceAll("{{QR_SVG}}", qrSvg(config));

const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) die("template has unreplaced placeholders: " + [...new Set(leftover)].join(", "));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.html"), html);
writeFileSync(join(OUT, "CNAME"), config.domain + "\n");
writeFileSync(join(OUT, "manifest.webmanifest"), manifest(config));
writeFileSync(join(OUT, "icon-192.svg"), icon(config, 192));
writeFileSync(join(OUT, "icon-512.svg"), icon(config, 512));
if (config.vcard?.enabled !== false) writeFileSync(join(OUT, "contact.vcf"), buildVcf(config));
for (const f of ["qr.svg", "sw.js"]) {
  if (existsSync(join(root, f))) copyFileSync(join(root, f), join(OUT, f));
}

console.log(`built dist/ from ${source}`);
console.log(`  name:   ${config.name}`);
console.log(`  domain: ${config.domain}`);
console.log(`  credit: ${config.credit ?? "default"}`);
