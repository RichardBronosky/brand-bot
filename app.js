/* brand-bot conversation tools. Plain browser APIs; no build dependencies. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const config = JSON.parse($('app-config').textContent);
  const backend = config.backend;
  const scope = 'brand-bot:' + (backend ? backend.url : location.origin) + ':';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const originalQR = $('qr-code').innerHTML;
  const panels = ['home', 'professional', 'personal', 'qr', 'owner'];
  const errors = [];
  let auth = read('auth', null), owner = false, connection = null;
  let refreshing = null, flushing = false, creating = false;
  let messagesToken = null, cursor = 0, polling = false;
  const seenMessages = new Set();
  let visitor = read('visitor', null);
  if (!UUID.test(visitor || '')) { visitor = crypto.randomUUID(); write('visitor', visitor); }

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(scope + key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(scope + key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function remove(key) { try { localStorage.removeItem(scope + key); } catch {} }
  function issue(error) {
    errors.push({ at: new Date().toISOString(), message: String(error.message || error).slice(0, 300) });
    if (errors.length > 10) errors.shift();
  }
  window.addEventListener('error', (e) => issue(e.message));
  window.addEventListener('unhandledrejection', (e) => issue(e.reason || 'Unhandled rejection'));
  function status(text) { $('owner-status').textContent = text; }
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    if (parts[0] === 'meet') {
      return { token: UUID.test(parts[1] || '') ? parts[1] : null,
        invalid: !UUID.test(parts[1] || ''), panel: ['professional', 'personal'].includes(parts[2]) ? parts[2] : 'home' };
    }
    return { token: null, invalid: false, panel: panels.includes(parts[0]) ? parts[0] : 'home' };
  }
  function routeHref(panel) {
    const r = route();
    return r.token ? '#/meet/' + r.token + (panel === 'home' ? '' : '/' + panel) : '#/' + (panel === 'home' ? '' : panel);
  }
  function show() {
    const r = route();
    panels.forEach((p) => $('panel-' + p).classList.toggle('is-active', p === r.panel));
    document.body.classList.toggle('owner-view', r.panel === 'owner');
    document.querySelectorAll('.choice').forEach((a, i) => { a.href = routeHref(i === 0 ? 'professional' : 'personal'); });
    $('shared-messages').hidden = !backend || (!r.token && !r.invalid) || r.panel === 'qr' || r.panel === 'owner';
    if (r.invalid) $('shared-status').textContent = 'This invitation link is invalid. You can still use my contact card.';
    $('owner-entry').hidden = !backend || r.panel === 'qr' || r.panel === 'owner';
    $('qr-owner-tools').hidden = !owner;
    $('bug-toggle').hidden = !owner;
    // Keep bug capture in the QR action stack so it cannot cover wallpaper hints.
    if (r.panel === 'qr') document.querySelector('.qr-actions').append($('bug-toggle'));
    else document.body.insertBefore($('bug-toggle'), $('bug-dialog'));
    if (r.token !== messagesToken) {
      messagesToken = r.token; cursor = 0; seenMessages.clear(); $('shared-list').replaceChildren();
      if (r.token) $('shared-status').textContent = 'Checking for shared messages…';
    }
    if (backend && owner && r.panel === 'owner') refreshOwner().catch(ownerError);
  }
  window.addEventListener('hashchange', show);
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { location.hash = routeHref('home'); }));
  const osHint = document.querySelector('[data-os-hint]');
  osHint.textContent = /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Photos → Share → Use as Wallpaper → Set Lock Screen.' :
    /Android/.test(navigator.userAgent) ? 'Photos → ⋮ → Use as → Lock screen.' : 'Then set it as your lock screen wallpaper.';

  async function request(path, body, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const headers = { apikey: backend.publishableKey, 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch(backend.url + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, credentials: 'omit' });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(result?.message || result?.error_description || result?.msg || 'Request failed (' + res.status + ')');
        err.status = res.status; throw err;
      }
      return result;
    } finally { clearTimeout(timeout); }
  }
  async function accessToken() {
    if (!auth) throw new Error('Sign in to your meeting tools.');
    if (auth.expires_at > Date.now() / 1000 + 60) return auth.access_token;
    if (!refreshing) refreshing = request('/auth/v1/token?grant_type=refresh_token', { refresh_token: auth.refresh_token })
      .then(saveAuth).catch((err) => {
        if (err.status === 400 || err.status === 401) { auth = null; owner = false; remove('auth'); updateOwnerUI(); }
        throw err;
      }).finally(() => { refreshing = null; });
    await refreshing;
    return auth.access_token;
  }
  function saveAuth(data) {
    auth = { access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: data.expires_at || Date.now() / 1000 + data.expires_in, user_id: data.user.id };
    write('auth', auth);
  }
  async function rpc(name, body = {}, privateCall = false) {
    return request('/rest/v1/rpc/brand_' + name, body, privateCall ? await accessToken() : null);
  }
  function ownerError(err) {
    issue(err);
    if (err.status === 401 || err.status === 403) {
      owner = false; updateOwnerUI();
      status('Owner access unavailable. Sign in with the account configured for this card.');
    } else status('Could not sync: ' + err.message + '. Your draft notes stay on this device.');
  }
  function updateOwnerUI() {
    $('owner-login').hidden = owner || !backend;
    $('owner-tools').hidden = !owner;
    $('qr-owner-tools').hidden = !owner;
    $('bug-toggle').hidden = !owner;
    if (!owner) { connection = null; $('qr-code').innerHTML = originalQR; $('qr-status').textContent = ''; }
  }

  // Writes persist locally until acknowledged. There is no public read/poll.
  function enqueue(item) {
    const queue = read('outbox', []);
    queue.push(item);
    // Bound local storage; latest interactions are more useful than ancient retries.
    const saved = write('outbox', queue.slice(-500));
    flush().catch(issue);
    return saved;
  }
  function record(kind, details = {}, token = route().token) {
    if (!backend || owner || route().invalid) return;
    enqueue({ name: 'record_event', body: { p_id: crypto.randomUUID(), p_visitor_id: visitor, p_token: token, p_kind: kind, p_details: details } });
  }
  async function flush() {
    if (!backend || flushing || !navigator.onLine) return;
    flushing = true;
    try {
      for (const item of read('outbox', [])) {
        if (item.owner_id && (!owner || item.owner_id !== auth?.user_id)) continue;
        try { await rpc(item.name, item.body, !!item.owner_id); }
        catch (err) {
          if (!err.status || err.status === 429 || err.status >= 500 || item.owner_id) break;
          issue(err); // Invalid visitor event: no permanent retry loop.
        }
        write('outbox', read('outbox', []).filter((x) => x.body.p_id !== item.body.p_id));
      }
    } finally { flushing = false; }
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('link')) record('contact_click', {
      label: a.querySelector('.lbl')?.textContent || '', href: a.getAttribute('href')
    });
    if (a.classList.contains('vcard')) record('vcard_download');
  });

  function timeNode(value) {
    const node = document.createElement('time'); node.dateTime = value;
    node.textContent = new Date(value).toLocaleString(); return node;
  }
  function httpURL(value) {
    if (!value) return null;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  function messageNode(m, guest = false) {
    const li = document.createElement('li'); const p = document.createElement('p');
    p.textContent = m.body; li.append(timeNode(m.created_at), p);
    const url = httpURL(m.url);
    if (url) {
      const a = document.createElement('a'); a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (guest) a.addEventListener('click', () => record('message_click', { message_id: m.id }));
      li.append(a);
    }
    return li;
  }
  async function refreshMessages() {
    const token = route().token;
    if (!token) return;
    const data = await rpc('get_messages', { p_token: token, p_after: cursor });
    if (route().token !== token) return;
    for (const m of data) {
      if (!seenMessages.has(m.id)) {
        $('shared-list').append(messageNode(m, true)); seenMessages.add(m.id);
        record('message_received', { message_id: m.id }, token);
      }
      cursor = Math.max(cursor, Number(m.id));
    }
    $('shared-status').textContent = seenMessages.size ? 'These messages stay available when you reopen this link.' : 'Links shared during our conversation will appear here.';
  }
  function eventNode(e) {
    const li = document.createElement('li');
    const labels = { page_open: 'Page opened', contact_click: 'Tapped ' + (e.details.label || 'contact link'),
      vcard_download: 'Tapped contact download', message_received: 'Message #' + e.details.message_id + ' received by page',
      message_click: 'Tapped link in message #' + e.details.message_id };
    const text = document.createElement('div'); text.textContent = labels[e.kind] || e.kind;
    li.append(timeNode(e.created_at), text); return li;
  }
  function renderEvents(id, data) {
    const ul = $(id); ul.replaceChildren(...data.slice().reverse().map(eventNode));
    if (!data.length) { const li = document.createElement('li'); li.textContent = 'No activity yet.'; ul.append(li); }
  }
  async function refreshOwner() {
    const rows = await rpc('list_connections', {}, true);
    if (!owner) return;
    $('session-list').replaceChildren(...rows.map((c) => {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = (c.label || new Date(c.created_at).toLocaleString()) + ' · ' + c.opens + ' opens';
      button.addEventListener('click', () => selectConnection(c.id).catch(ownerError)); li.append(button); return li;
    }));
    await refreshConnection();
  }
  async function refreshConnection() {
    if (!connection || !owner) return;
    const id = connection.id;
    const data = await rpc('get_connection', { p_id: id }, true);
    if (!owner || connection?.id !== id) return;
    renderEvents('session-events', data.events);
    $('owner-messages').replaceChildren(...data.messages.map((m) => {
      const node = messageNode(m);
      const received = data.events.filter((e) => e.kind === 'message_received' && Number(e.details.message_id) === Number(m.id)).length;
      const p = document.createElement('p'); p.className = 'activity-help'; p.textContent = received ? 'Received by page' : 'Saved · awaiting page receipt';
      node.append(p); return node;
    }));
    const opens = data.events.filter((e) => e.kind === 'page_open').length;
    $('qr-status').textContent = opens ? opens + ' page open' + (opens === 1 ? '' : 's') + ' · open Meeting tools for activity' : 'Conversation QR ready · waiting for a page open';
  }
  function draftKey(id) { return 'draft:' + auth.user_id + ':' + id; }
  function setConnection(c) {
    connection = c;
    const draft = read(draftKey(c.id), null);
    $('session-editor').hidden = false; $('show-session-qr').hidden = false;
    $('session-label').value = draft?.label ?? c.label;
    $('session-notes').value = draft?.notes ?? c.notes;
    $('notes-status').textContent = draft ? 'Unsaved draft on this device' : '';
    $('session-info').textContent = 'Started ' + new Date(c.created_at).toLocaleString() +
      (c.latitude !== null ? ' · ' + c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5) : ' · location not recorded');
    renderQR(c.invite_token);
  }
  async function selectConnection(id) {
    const data = await rpc('get_connection', { p_id: id }, true);
    if (!owner) return;
    setConnection(data.connection); await refreshConnection(); status('Conversation selected.');
  }
  function renderQR(token) {
    const url = location.origin + location.pathname + '#/meet/' + token;
    const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
    const border = 4, size = qr.size + border * 2;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size); svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Scan to open this conversation');
    const bg = document.createElementNS(svg.namespaceURI, 'rect'); bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(svg.namespaceURI, 'path'); let d = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x + border},${y + border}h1v1h-1z`;
    path.setAttribute('d', d); path.setAttribute('fill', '#000'); svg.append(bg, path); $('qr-code').replaceChildren(svg);
    $('qr-status').textContent = 'Conversation QR ready · waiting for a page open';
  }
  async function newConnection() {
    if (creating) return;
    creating = true; $('new-session').disabled = true;
    status('Creating conversation…'); $('qr-status').textContent = 'Creating a new conversation…';
    try {
      const c = await rpc('create_connection', {}, true);
      if (!owner) return;
      setConnection(c); location.hash = '#/qr'; status('Conversation created.');
      // Location is private metadata. A slow/denied fix never delays the QR.
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(async (position) => {
        try {
          await rpc('set_location', { p_id: c.id, p_latitude: position.coords.latitude, p_longitude: position.coords.longitude, p_accuracy: position.coords.accuracy }, true);
          if (connection?.id === c.id) {
            c.latitude = position.coords.latitude; c.longitude = position.coords.longitude;
            $('session-info').textContent = 'Started ' + new Date(c.created_at).toLocaleString() + ' · ' + c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5);
          }
        } catch (err) { issue(err); }
      }, () => {}, { timeout: 8000, maximumAge: 0, enableHighAccuracy: false });
      await refreshOwner();
    } catch (err) {
      ownerError(err);
      $('qr-status').textContent = 'Could not create a new conversation. ' + (connection ? 'Showing the previous conversation QR.' : 'Showing your public card QR.');
    } finally { creating = false; $('new-session').disabled = false; }
  }
  $('new-session').addEventListener('click', () => newConnection());
  $('show-session-qr').addEventListener('click', () => { location.hash = '#/qr'; });
  for (const id of ['session-label', 'session-notes']) $(id).addEventListener('input', () => {
    if (!connection || !auth) return;
    const saved = write(draftKey(connection.id), { label: $('session-label').value, notes: $('session-notes').value });
    $('notes-status').textContent = saved ? 'Unsaved draft on this device' : 'Draft storage unavailable; save before leaving.';
  });
  $('notes-form').addEventListener('submit', async (e) => {
    e.preventDefault(); if (!connection) return;
    const id = connection.id, key = draftKey(id);
    const label = $('session-label').value, notes = $('session-notes').value;
    try {
      await rpc('update_connection', { p_id: id, p_label: label, p_notes: notes }, true);
      const draft = read(key, null);
      if (!draft || (draft.label === label && draft.notes === notes)) remove(key);
      if (connection?.id === id) {
        connection.label = label; connection.notes = notes;
        $('notes-status').textContent = read(key, null) ? 'Newer changes still unsaved' : 'Saved';
      }
      await refreshOwner();
    } catch (err) { ownerError(err); }
  });
  $('message-form').addEventListener('submit', async (e) => {
    e.preventDefault(); if (!connection) return;
    const body = $('message-body').value.trim(), raw = $('message-url').value.trim();
    if (!body || (raw && !httpURL(raw))) { status('Enter a message and an http:// or https:// URL.'); return; }
    const button = e.submitter || e.target.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      await rpc('send_message', { p_id: connection.id, p_body: body, p_url: raw ? httpURL(raw) : null }, true);
      $('message-body').value = ''; $('message-url').value = ''; status('Message saved. Their open page will receive it shortly.');
      await refreshConnection();
    } catch (err) { ownerError(err); } finally { button.disabled = false; }
  });
  $('owner-login').addEventListener('submit', async (e) => {
    e.preventDefault(); const button = e.submitter || e.target.querySelector('button[type="submit"]'); button.disabled = true; status('Signing in…');
    try {
      const form = new FormData(e.target);
      saveAuth(await request('/auth/v1/token?grant_type=password', { email: form.get('email'), password: form.get('password') }));
      $('owner-login').reset(); await rpc('list_connections', {}, true);
      owner = true; updateOwnerUI(); status('Signed in. Start a conversation to show its QR.'); await refreshOwner(); await flush();
    } catch (err) { ownerError(err); } finally { button.disabled = false; }
  });
  $('owner-logout').addEventListener('click', async () => {
    const token = auth?.access_token;
    auth = null; owner = false; remove('auth'); updateOwnerUI();
    $('session-events').replaceChildren(); $('owner-messages').replaceChildren(); $('session-list').replaceChildren();
    $('session-label').value = ''; $('session-notes').value = '';
    $('public-events').replaceChildren(); $('bug-list').replaceChildren(); status('Signed out.');
    if (token) request('/auth/v1/logout?scope=local', {}, token).catch(issue);
  });
  $('public-activity').addEventListener('toggle', async () => {
    if (!$('public-activity').open || !owner) return;
    try { const data = await rpc('get_public_events', {}, true); if (owner) renderEvents('public-events', data.slice().reverse()); }
    catch (err) { ownerError(err); }
  });
  $('bug-history').addEventListener('toggle', async () => {
    if (!$('bug-history').open || !owner) return;
    try {
      const rows = await rpc('list_bugs', {}, true);
      if (owner) $('bug-list').replaceChildren(...rows.map((b) => {
        const li = document.createElement('li'), p = document.createElement('p'); p.textContent = b.description;
        li.append(timeNode(b.created_at), p); return li;
      }));
    } catch (err) { ownerError(err); }
  });
  $('bug-toggle').addEventListener('click', () => { $('bug-status').textContent = ''; $('bug-dialog').showModal(); $('bug-description').focus(); });
  $('bug-cancel').addEventListener('click', () => $('bug-dialog').close());
  $('bug-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const description = $('bug-description').value.trim();
    if (!description || !owner) return;
    const saved = enqueue({ name: 'report_bug', owner_id: auth.user_id, body: {
      p_id: crypto.randomUUID(), p_connection_id: connection?.id || null, p_description: description,
      p_context: { screen: route().panel, captured_at: new Date().toISOString(), version: config.version,
        user_agent: navigator.userAgent.slice(0, 500), online: navigator.onLine, installed, errors: errors.slice() }
    } });
    if (!saved) { $('bug-status').textContent = 'Device storage is unavailable. Keep this report open and try again.'; return; }
    $('bug-description').value = ''; $('bug-dialog').close(); status('Bug report captured; it will sync when connected.');
  });
  async function tick() {
    if (polling || document.hidden || !backend) return;
    polling = true;
    try {
      await flush();
      const r = route();
      if (owner && ['qr', 'owner'].includes(r.panel)) await refreshConnection();
      else if (r.token) await refreshMessages();
    } catch (err) {
      issue(err);
      if (route().token) $('shared-status').textContent = 'Shared messages are unavailable right now. Your contact links still work.';
      else if (owner) status('Updates unavailable right now. Your draft notes stay on this device.');
    } finally { polling = false; }
  }
  async function loop() { await tick(); setTimeout(loop, navigator.onLine ? 3000 : 15000); }
  window.addEventListener('online', () => tick());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  async function start() {
    show(); updateOwnerUI();
    if (backend) {
      if (auth) {
        try { await rpc('list_connections', {}, true); owner = true; updateOwnerUI(); }
        catch (err) { ownerError(err); }
      }
      if (owner) {
        if (installed && route().panel === 'qr') await newConnection();
        else await refreshOwner().catch(ownerError);
      } else {
        record('page_open', { screen: route().panel });
        if (route().panel === 'owner') status('Sign in with the owner account configured for this card.');
      }
      loop();
    } else if (route().panel === 'owner') status('Meeting tools are not configured for this card.');
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(issue);
  }
  start().catch(issue);
})();
