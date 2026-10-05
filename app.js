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
  const originalDomain = document.querySelector('.qr-domain').textContent;
  const categories = new Map([...document.querySelectorAll('[data-category-panel]')].map(p => [p.dataset.categoryPanel, p]));
  const errors = [];
  const locationStates = new Map();
  let auth = read('auth', null), owner = false, connection = null;
  let authEpoch = 0;
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
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const invited = parts[0] === 'meet';
    const path = (invited ? parts.slice(2) : parts).join('/');
    return { token: invited && UUID.test(parts[1] || '') ? parts[1] : null,
      invalid: invited && !UUID.test(parts[1] || ''),
      panel: categories.has(path) ? 'category' : !invited && ['qr', 'owner'].includes(path) ? path : 'home',
      path: categories.has(path) ? path : '' };
  }
  function routeHref(path) {
    const r = route();
    if (path === 'home') path = '';
    return r.token ? '#/meet/' + r.token + (path ? '/' + path : '') : '#/' + path;
  }
  function show() {
    const r = route();
    const active = r.panel === 'category' ? categories.get(r.path) : $('panel-' + r.panel);
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p === active));
    document.body.classList.toggle('owner-view', r.panel === 'owner');
    $('floating-back').hidden = r.panel === 'home';
    $('floating-back').href = routeHref(r.path.split('/').slice(0, -1).join('/'));
    document.querySelectorAll('[data-category-route]').forEach(a => { a.href = routeHref(a.dataset.categoryRoute); });
    $('shared-messages').hidden = !backend || (!r.token && !r.invalid) || r.panel === 'qr' || r.panel === 'owner';
    $('invitee-message-form').hidden = !backend || !r.token;
    $('invitee-message-body').value = r.token ? read('message-draft:' + r.token, '') : '';
    $('shared-status').hidden = !r.invalid;
    if (r.invalid) $('shared-status').textContent = 'This invitation link is invalid. You can still use my contact card.';
    $('qr-owner-tools').hidden = !backend || config.showMeetingTools === false;
    $('bug-toggle').hidden = !owner;
    // Keep bug capture in the QR action stack so it cannot cover wallpaper hints.
    if (r.panel === 'qr') document.querySelector('.qr-actions').append($('bug-toggle'));
    else document.body.insertBefore($('bug-toggle'), $('bug-dialog'));
    if (r.token !== messagesToken) {
      $('shared-heading').textContent = 'Conversation with Bruno';
      messagesToken = r.token; cursor = 0; seenMessages.clear(); $('shared-list').replaceChildren();
      if (!r.invalid) { $('shared-status').hidden = true; $('shared-status').textContent = ''; }
      $('invitee-conversation').open = false;
    }
    if (backend && owner && r.panel === 'owner') refreshOwner().catch(ownerError);
  }
  window.addEventListener('hashchange', show);
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { location.hash = routeHref(route().path.split('/').slice(0, -1).join('/')); }));
  let ownerTaps = [];
  window.addEventListener('hashchange', () => { ownerTaps = []; });
  document.querySelector('.qr-domain').addEventListener('click', () => {
    if (!backend || route().panel !== 'qr') return;
    const now = performance.now();
    ownerTaps = ownerTaps.filter(at => now - at < 3000);
    ownerTaps.push(now);
    if (ownerTaps.length >= 5) { ownerTaps = []; location.hash = '#/owner'; }
  });
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
    if (!refreshing) {
      const session = auth;
      refreshing = request('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
        .then(data => { if (auth !== session) throw new Error('Session changed.'); saveAuth(data); })
        .catch(err => {
          if (auth === session && (err.status === 400 || err.status === 401)) { authEpoch++; auth = null; owner = false; remove('auth'); updateOwnerUI(); }
          throw err;
        }).finally(() => { refreshing = null; });
    }
    await refreshing;
    if (!auth) throw new Error('Sign in to your meeting tools.');
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
    $('qr-nav').href = owner ? '#/owner' : '#/qr';
    $('qr-nav').setAttribute('aria-label', owner ? 'Select a conversation QR in Meeting tools' : 'Show QR code');
    $('owner-login').hidden = owner || !backend;
    $('owner-tools').hidden = !owner;
    $('qr-owner-tools').hidden = !backend || config.showMeetingTools === false;
    $('bug-toggle').hidden = !owner;
    if (!owner) { $('qr-session-meta').hidden = true; connection = null; $('qr-code').innerHTML = originalQR; $('qr-status').textContent = ''; document.querySelector('.qr-domain').textContent = originalDomain; }
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
      label: a.querySelector('.lbl')?.textContent || '', href: a.getAttribute('href'),
      path: JSON.parse(a.dataset.contactPath || '[]'), category_ids: JSON.parse(a.dataset.categoryIds || '[]')
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
    const sender = document.createElement('strong');
    sender.textContent = m.sender === 'invitee' ? (guest ? 'You' : 'Invitee') : (guest ? document.querySelector('header .name').textContent : 'You');
    p.textContent = m.body; li.append(sender, timeNode(m.created_at), p);
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
    const [data, label] = await Promise.all([rpc('get_messages', { p_token: token, p_after: cursor }), rpc('get_conversation_label', { p_token: token })]);
    if (route().token !== token) return;
    $('shared-heading').textContent = 'Conversation with ' + (label?.trim() || 'Bruno');
    for (const m of data) {
      if (!seenMessages.has(m.id)) {
        $('shared-list').append(messageNode(m, true)); seenMessages.add(m.id);
        if (m.sender !== 'invitee') record('message_received', { message_id: m.id }, token);
      }
      cursor = Math.max(cursor, Number(m.id));
    }
    $('shared-status').hidden = true;
    $('shared-status').textContent = '';
  }
  $('invitee-message-body').addEventListener('input', () => {
    if (route().token) write('message-draft:' + route().token, $('invitee-message-body').value);
  });
  let inviteeSending = false;
  $('invitee-message-form').addEventListener('submit', async e => {
    e.preventDefault();
    const token = route().token, body = $('invitee-message-body').value.trim();
    if (!token || !body || inviteeSending) return;
    const key = 'message-pending:' + token;
    let pending = read(key, null);
    if (!pending || pending.body !== body) pending = { body, id: crypto.randomUUID() };
    write(key, pending);
    const button = e.target.querySelector('button'); button.disabled = true; inviteeSending = true;
    $('invitee-message-status').textContent = 'Sending…';
    try {
      await rpc('send_invitee_message', { p_token: token, p_body: body, p_request_id: pending.id });
      remove(key); remove('message-draft:' + token);
      if (route().token === token) {
        if ($('invitee-message-body').value.trim() === body) $('invitee-message-body').value = '';
        else write('message-draft:' + token, $('invitee-message-body').value);
        $('invitee-message-status').textContent = 'Message sent';
        await refreshMessages();
      }
    } catch (error) {
      issue(error);
      if (route().token === token) $('invitee-message-status').textContent = 'Could not confirm sending. Your text is saved; try again. ' + error.message;
    } finally { button.disabled = false; inviteeSending = false; }
  });
  function eventNode(e) {
    const li = document.createElement('li');
    const coordinates = p => p?.latitude != null && p?.longitude != null ? p.latitude + ', ' + p.longitude : 'not recorded';
    const labels = { location_update: 'Location updated · from ' + coordinates(e.details.from) + ' → to ' + coordinates(e.details.to), page_open: 'Page opened', contact_click: 'Tapped ' + (Array.isArray(e.details.path) && e.details.path.length ? e.details.path.join(' > ') : e.details.label || 'contact link'),
      vcard_download: 'Tapped contact download', message_received: 'Message #' + e.details.message_id + ' received by page',
      message_click: 'Tapped link in message #' + e.details.message_id };
    const text = document.createElement('div'); text.textContent = labels[e.kind] || e.kind;
    li.append(timeNode(e.created_at), text); return li;
  }
  function renderEvents(id, data) {
    const ul = $(id); ul.replaceChildren(...data.slice().reverse().map(eventNode));
    if (!data.length) { const li = document.createElement('li'); li.textContent = 'No activity yet.'; ul.append(li); }
  }
  function renderPublicEvents(data) {
    const list = $('public-events');
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(d => d.dataset.visitor));
    const groups = new Map();
    const newest = data.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    for (const event of newest) {
      const id = event.visitor_id || 'unknown';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(event);
    }
    list.replaceChildren(...[...groups].map(([id, events]) => {
      const li = document.createElement('li'), details = document.createElement('details');
      details.dataset.visitor = id; details.open = expanded.has(id);
      const summary = document.createElement('summary');
      summary.textContent = (id === 'unknown' ? 'Unknown visitor' : 'Visitor ' + id.slice(0, 8)) +
        ' · ' + events.length + ' event' + (events.length === 1 ? '' : 's') + ' · latest ';
      summary.append(timeNode(events[0].created_at));
      const actions = document.createElement('ul'); actions.className = 'event-list';
      actions.replaceChildren(...events.map(eventNode));
      details.append(summary, actions); li.append(details); return li;
    }));
    if (!groups.size) { const li = document.createElement('li'); li.textContent = 'No activity yet.'; list.append(li); }
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
    Object.assign(connection, { latitude: data.connection.latitude, longitude: data.connection.longitude, label: data.connection.label });
    renderQRMetadata();
    renderSessionInfo();
    renderEvents('session-events', data.events);
    $('owner-messages').replaceChildren(...data.messages.slice().sort((a, b) => Number(b.id) - Number(a.id)).map((m) => {
      const node = messageNode(m);
      if (m.sender === 'invitee') return node;
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
    $('session-link').value = location.origin + location.pathname + '#/meet/' + c.invite_token;
    $('session-label').value = draft?.label ?? c.label;
    $('session-notes').value = draft?.notes ?? c.notes;
    $('notes-status').textContent = draft ? 'Unsaved draft on this device' : '';
    renderSessionInfo();
    $('session-editor').open = true;
    $('current-conversation-heading').textContent = 'Conversation: ' + (c.label.trim() || 'Unnamed');
    renderQR(c.invite_token);
  }
  async function selectConnection(id) {
    const data = await rpc('get_connection', { p_id: id }, true);
    if (!owner) return;
    setConnection(data.connection); await refreshConnection(); status('Conversation: ' + (connection.label.trim() || 'Unnamed'));
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
    document.querySelector('.qr-domain').textContent = originalDomain;
    renderQRMetadata();
    $('qr-status').textContent = 'Conversation QR ready · waiting for a page open';
  }
  function renderQRMetadata() {
    $('qr-session-meta').hidden = !connection;
    if (!connection) return;
    const label = connection.label.trim();
    $('qr-session-label').hidden = !label;
    $('qr-session-label').textContent = label;
    $('qr-session-created').dateTime = connection.created_at;
    $('qr-session-created').textContent = 'Created ' + new Date(connection.created_at).toLocaleString();
    renderQRAge();
  }
  function renderQRAge() {
    if (!connection) return;
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(connection.created_at).getTime()) / 60000));
    const count = minutes >= 1440 ? Math.floor(minutes / 1440) : minutes >= 60 ? Math.floor(minutes / 60) : minutes;
    const unit = minutes >= 1440 ? 'day' : minutes >= 60 ? 'hour' : 'minute';
    $('qr-session-age').textContent = '(' + count + ' ' + unit + (count === 1 ? '' : 's') + ' ago)';
  }
  setInterval(renderQRAge, 30000);
  function renderSessionInfo() {
    if (!connection) return;
    const c = connection;
    const locating = locationStates.get(c.id);
    const info = $('session-info');
    info.replaceChildren(document.createTextNode('Started ' + new Date(c.created_at).toLocaleString()));
    if (c.latitude != null && c.longitude != null) {
      const coords = c.latitude + ',' + c.longitude;
      const link = document.createElement('a');
      link.href = /Android/i.test(navigator.userAgent) ? 'geo:' + coords + '?q=' + encodeURIComponent(coords) :
        /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ?
        'https://maps.apple.com/?ll=' + coords + '&q=' + encodeURIComponent(coords) :
        'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(coords);
      link.textContent = c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5);
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', 'Open recorded location in maps');
      info.append(' · ', link);
    }
    if (locating) info.append(locating);
    else if (c.latitude == null || c.longitude == null) info.append(' · location not recorded');
    $('retry-location').disabled = locating === ' · Recording location…';
    $('retry-location').textContent = c.latitude != null ? 'Update location' : 'Record location';
  }
  async function captureLocation(c) {
    if (locationStates.get(c.id) === ' · Recording location…') return;
    locationStates.set(c.id, ' · Recording location…');
    if (connection?.id === c.id) renderSessionInfo();
    try {
      if (!navigator.geolocation) throw new Error('Location is unavailable in this browser');
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
        { timeout: 30000, maximumAge: 0, enableHighAccuracy: true }));
      await rpc('set_location', { p_id: c.id, p_latitude: position.coords.latitude, p_longitude: position.coords.longitude, p_accuracy: position.coords.accuracy }, true);
      locationStates.delete(c.id);
      if (connection?.id === c.id) {
        connection.latitude = position.coords.latitude; connection.longitude = position.coords.longitude;
      }
    } catch (err) {
      issue(err);
      const reason = err.code === 1 ? 'permission denied' : err.code === 2 ? 'device could not determine location' : err.code === 3 ? 'location request timed out' : err.message;
      locationStates.set(c.id, ' · Location not recorded: ' + reason + '. Use Record location to retry.');
    }
    if (connection?.id === c.id) renderSessionInfo();
  }
  $('retry-location').addEventListener('click', () => { if (connection && owner) captureLocation(connection); });
  async function newConnection() {
    if (creating) return;
    creating = true; $('new-session').disabled = true;
    status('Creating conversation…'); $('qr-status').textContent = 'Creating a new conversation…';
    try {
      const c = await rpc('create_connection', {}, true);
      if (!owner) return;
      setConnection(c); location.hash = '#/qr'; status('Conversation created.');
      captureLocation(c);
      await refreshOwner();
    } catch (err) {
      ownerError(err);
      $('qr-status').textContent = 'Could not create a new conversation. ' + (connection ? 'Showing the previous conversation QR.' : 'Showing your public card QR.');
    } finally { creating = false; $('new-session').disabled = false; }
  }
  $('new-session').addEventListener('click', () => newConnection());
  $('show-session-qr').addEventListener('click', () => { location.hash = '#/qr'; });
  $('copy-session-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('session-link').value); status('Invitation link copied.'); }
    catch { $('session-link').focus(); $('session-link').select(); status('Select and copy the invitation link.'); }
  });
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
        renderQRMetadata();
        $('current-conversation-heading').textContent = 'Conversation: ' + (label.trim() || 'Unnamed');
        status('Conversation: ' + (label.trim() || 'Unnamed'));
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
      const epoch = ++authEpoch;
      const result = await request('/auth/v1/token?grant_type=password', { email: form.get('email'), password: form.get('password') });
      if (epoch !== authEpoch) return;
      saveAuth(result);
      $('owner-login').reset(); await rpc('list_connections', {}, true);
      if (epoch !== authEpoch || !auth) return;
      owner = true; updateOwnerUI(); status('Signed in. Start a conversation to show its QR.'); await refreshOwner(); await flush();
    } catch (err) { ownerError(err); } finally { button.disabled = false; }
  });
  $('owner-logout').addEventListener('click', async () => {
    const token = auth?.access_token;
    authEpoch++; auth = null; owner = false; remove('auth'); updateOwnerUI();
    $('session-events').replaceChildren(); $('owner-messages').replaceChildren(); $('session-list').replaceChildren();
    $('session-label').value = ''; $('session-notes').value = '';
    $('public-events').replaceChildren(); $('bug-list').replaceChildren(); status('Signed out.');
    if (token) request('/auth/v1/logout?scope=local', {}, token).catch(issue);
  });
  $('public-activity').addEventListener('toggle', async () => {
    if (!$('public-activity').open || !owner) return;
    try { const data = await rpc('get_public_events', {}, true); if (owner) renderPublicEvents(data); }
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
      if (route().token) { $('shared-status').hidden = false; $('shared-status').textContent = 'Shared messages are unavailable right now. Your contact links still work.'; }
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
        try { const epoch = authEpoch; await rpc('list_connections', {}, true); if (epoch === authEpoch && auth) { owner = true; updateOwnerUI(); } }
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
