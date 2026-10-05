import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'brand-build-test-'));
mkdirSync(join(root, 'vendor'));
for (const f of ['categories.mjs', 'build.mjs', 'template.html', 'sw.js', 'app.js', 'app.css', 'vendor/qrcodegen.js', 'qr.svg']) copyFileSync(join(source, f), join(root, f));
const base = { name: 'Test Person', domain: 'test.example.org' };
let previousCache = 'brand-bot-v1';
for (const enabled of [false, true, false, true]) {
  execFileSync(process.execPath, [join(root, 'build.mjs')], { env: { ...process.env, BRAND_CONFIG: JSON.stringify({ ...base, vcard: { enabled } }) } });
  const out = join(root, 'dist');
  assert.equal(existsSync(join(out, 'contact.vcf')), enabled);
  assert.equal(readFileSync(join(out, 'index.html'), 'utf8').includes('href="contact.vcf"'), enabled);
  const handlers = {}; let cached, deleted = [], claimed = false, skipped = false;
  vm.runInNewContext(readFileSync(join(out, 'sw.js'), 'utf8'), { URL, self: {
    location: { origin: 'https://test.example.org' }, addEventListener: (type, fn) => handlers[type] = fn,
    skipWaiting: () => skipped = true, clients: { claim: () => claimed = true }
  }, caches: {
    open: async name => { cached = name; return { addAll: async assets => {
      assert.equal(assets.includes('./contact.vcf'), enabled);
      for (const asset of assets) assert.ok(existsSync(join(out, asset === './' ? 'index.html' : asset)), asset);
    } }; }, keys: async () => [previousCache, cached], delete: async key => deleted.push(key)
  } });
  let pending; const event = { waitUntil: p => pending = p };
  handlers.install(event); await pending; handlers.activate(event); await pending;
  assert.ok(skipped && claimed); assert.notEqual(cached, previousCache); assert.deepEqual(deleted, [previousCache]); previousCache = cached;
  let intercepted = false;
  handlers.fetch({ request: { method: 'GET', url: 'https://test.supabase.co/private' }, respondWith: () => intercepted = true });
  assert.equal(intercepted, false, 'API data must not enter offline cache');
  console.log(`PASS vCard ${enabled}: generated files, cache installation, cleanup and API exclusion`);
}
const badKeys = ['sb_secret_should_never_publish', 'not-a-key', 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.sig'];
for (const key of badKeys) {
  assert.throws(() => execFileSync(process.execPath, [join(root, 'build.mjs')], {
    env: { ...process.env, BRAND_CONFIG: JSON.stringify({ ...base, backend: { url: 'https://test.supabase.co', publishableKey: key } }) }, stdio: 'pipe'
  }), 'Secret keys must fail the build');
}
execFileSync(process.execPath, [join(root, 'build.mjs')], { env: { ...process.env, BRAND_CONFIG: JSON.stringify({ ...base, backend: { url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test' } }) } });
assert.ok(readFileSync(join(root, 'dist/index.html'), 'utf8').includes('sb_publishable_test'));
console.log('PASS public key accepted; secret/service-role keys rejected');
