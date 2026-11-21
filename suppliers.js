/* The Pot Drop: how actively each store lists, sells out and restocks. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
// store: the store open in the dialog; pageDay/storeDay: the calendar day picked on each;
// askLoaded: the saved Ask history is on the page; briefsRunning: store ids.
const state = {
  data: null, view: 'stores', store: null, tab: 'timeline', timeline: null, pageDay: null, storeDay: null,
  askLoaded: false, asking: false, briefsRunning: new Set(),
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TIME_ZONE = 'America/Chicago';
const centralTime = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const centralDate = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' });
const clockTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
// YYYY-MM-DD in US Central, the calendar's days.
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format;
const utcDay = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const longDate = (key) => new Date(utcDay(key)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

// Midnight US Central: 06:00 UTC in standard time, 05:00 in daylight time.
function centralMidnight(key) {
  const t = utcDay(key) + 6 * 3600_000;
  return dayKey(t - 3600_000) === key ? t - 3600_000 : t;
}

function relTime(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return fmt.format(Math.round(diff / 1000), 'second');
  if (abs < 3600_000) return fmt.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86400_000) return fmt.format(Math.round(diff / 3600_000), 'hour');
  if (abs < 60 * 86400_000) return fmt.format(Math.round(diff / 86400_000), 'day');
  return fmt.format(Math.round(diff / (30 * 86400_000)), 'month');
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const days = (d) => (d * 24 < 23.5 ? `${Math.max(1, Math.round(d * 24))} h` : `${d.toFixed(d < 10 ? 1 : 0)} d`);
const length = (ms) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : days(ms / 86400_000));
const zero = (n) => (n ? n.toLocaleString() : '<span class="muted">0</span>');

const EVENTS = {
  listed: () => '<span class="tag new">New</span>',
  sold_out: () => '<span class="tag gone">Sold out</span>',
  restocked: () => '<span class="tag sale">Restocked</span>',
  removed: (e) => (e.inStock ? '<span class="tag gone">Vanished in stock</span>' : '<span class="tag">Removed</span>'),
  returned: (e) => `<span class="tag new">Back${e.inStock ? '' : ', sold out'}</span>`,
};
const STATES = { in: 'In stock', out: 'Sold out', gone: 'Off the site' };
const CAL_KINDS = [['listed', 'new'], ['soldOut', 'sold out'], ['restocked', 'restocked'], ['pulled', 'pulled']];

const quiet = (s) => !s.moves;

async function getJson(url) {
  if (STATIC) return staticGet(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/* ---------- published copy ---------- */

// The published copy (src/publish.js) has no server: the stores table and the
// all-stores calendar are pre-built per period and type, and a store's views
// are filtered here from the event log and its timeline file.
const STATIC = document.documentElement.hasAttribute('data-static');
let staticFiles = {};
const staticFile = (name) => (staticFiles[name] ??= fetch(`data/activity/${name}`, { cache: 'no-cache' })
  .then((res) => { if (!res.ok) throw new Error(res.statusText); return res.json(); }));
const typeSlug = (type) => (type ? type.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'all');

// As in src/activity.js: what each event counts as on the calendar.
function calendarKind(e) {
  if (e.kind === 'listed') return 'listed';
  if (e.kind === 'sold_out' || (e.kind === 'removed' && e.inStock)) return 'soldOut';
  if (e.kind === 'restocked' || (e.kind === 'returned' && e.inStock)) return 'restocked';
  return e.kind === 'removed' ? 'pulled' : null;
}

async function staticGet(url) {
  const u = new URL(url, location.href);
  const path = u.pathname.replace(/^.*\/api\/activity/, '');
  const days = Number(u.searchParams.get('days')) || 7;
  const type = u.searchParams.get('type') ?? '';
  const store = u.searchParams.get('store') ?? path.match(/^\/([^/]+)\/(events|timelines)$/)?.[1] ?? '';
  if (path === '') return staticFile(`summary-${days}-${typeSlug(type)}.json`);
  if (path === '/calendar' && !store) return staticFile(`calendar-${days}-${typeSlug(type)}.json`);

  // events.json: { generatedAt, trackedSince: { store: first check }, products: { id: [store, title, url, type] }, events: [[at, kind, inStock, id]] }
  const log = await staticFile('events.json');
  const now = log.generatedAt;
  const from = Math.max(now - days * 86400_000, log.trackedSince[store] ?? 0);
  const events = log.events.map(([at, kind, inStock, id]) => {
    const [storeId, title, href, productType] = log.products[id];
    return { at, kind, inStock, productId: id, storeId, title, url: href, productType };
  }).filter((e) => (!store || e.storeId === store) && (!type || e.productType === type));

  if (path === '/calendar') {
    const counts = {};
    for (const e of events) {
      const kind = e.at >= from && calendarKind(e);
      if (kind) (counts[dayKey(e.at)] ??= { listed: 0, soldOut: 0, restocked: 0, pulled: 0 })[kind]++;
    }
    return { from: dayKey(from), to: dayKey(now), days: counts };
  }
  const day = path.match(/^\/day\/(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (day) return events.filter((e) => dayKey(e.at) === day);
  if (path.endsWith('/events')) return events.filter((e) => e.at >= from).slice(0, 500);

  // Timelines: the file has every product's spans over 90 days; clip them to the period.
  const t = await staticFile(`timelines/${encodeURIComponent(store)}.json`);
  const start = Math.max(from, t.from);
  const changes = {};
  for (const e of events) if (e.at >= start) changes[e.productId] = (changes[e.productId] ?? 0) + 1;
  const rows = t.products
    .filter((p) => (!type || p.productType === type) && (changes[p.id] || u.searchParams.get('all') === '1'))
    .map((p) => ({ ...p, changes: changes[p.id] ?? 0, spans: p.spans.filter(([, end]) => end > start).map(([a, b, s]) => [Math.max(a, start), b, s]) }))
    .filter((p) => p.spans.some((s) => s[2] !== 'gone'));
  return { from: start, to: t.to, total: rows.length, products: rows.slice(0, 400) };
}

const query = () => `days=${$('#days').value}&type=${encodeURIComponent($('#type').value)}`;
const periodText = () => `Last ${state.data.days} days${state.data.type ? ` · ${state.data.type}` : ''}`;

/* ---------- stores table ---------- */

function render() {
  const d = state.data;
  if (!d) return;
  const stores = d.stores;
  const sum = (key) => stores.reduce((n, s) => n + s[key], 0);
  const active = stores.filter((s) => s.newProducts || s.restocked);
  const period = `last ${d.days} days${d.type ? ` · ${d.type}` : ''}`;
  const since = d.trackingSince && d.trackingSince > Date.now() - d.days * 86400_000 ? `tracking since ${centralDate(d.trackingSince)}` : '';

  $('#window-note').textContent = `Listing, selling out and restocking · ${period}`;
  $('#t-active').textContent = `${active.length} / ${stores.length}`;
  $('#t-active-sub').textContent = 'listed or restocked something';
  $('#t-new').textContent = sum('newProducts').toLocaleString();
  $('#t-new-sub').textContent = since || period;
  $('#t-sold').textContent = sum('soldOut').toLocaleString();
  $('#t-sold-sub').textContent = sum('vanished') ? `${sum('vanished').toLocaleString()} vanished while in stock` : period;
  $('#t-restocked').textContent = sum('restocked').toLocaleString();
  $('#t-restocked-sub').textContent = since || period;

  const q = $('#search').value.trim().toLowerCase();
  const desc = (key) => (a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
  const sorters = {
    moves: desc('moves'),
    turnover: desc('turnover'),
    new: desc('newProducts'),
    sold: desc('soldOut'),
    restocked: desc('restocked'),
    shelf: (a, b) => (a.shelfDays ?? Infinity) - (b.shelfDays ?? Infinity),
    inStock: desc('inStock'),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  const rows = stores
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .filter((s) => !$('#quiet').checked || !quiet(s))
    .sort((a, b) => sorters[$('#sort').value](a, b) || b.moves - a.moves || a.name.localeCompare(b.name));

  $('#result-count').textContent = plural(rows.length, 'store');
  $('#empty').hidden = rows.length > 0;
  $('#rows').innerHTML = rows.map((s) => {
    const tracked = s.trackedSince ? `tracked ${relTime(s.trackedSince).replace(/ ago$/, '')}` : 'not checked yet';
    return `<tr data-store="${escapeHtml(s.id)}" class="${quiet(s) ? 'quiet' : ''}">
      <td><span class="p-title">${escapeHtml(s.name)}</span>
        <div class="p-meta"><span>${escapeHtml(s.platform)}</span><span>${escapeHtml(tracked)}</span></div></td>
      <td class="num">${s.inStock.toLocaleString()}<span class="muted"> / ${s.listed.toLocaleString()}</span></td>
      <td class="num">${zero(s.newProducts)}</td>
      <td class="num">${zero(s.soldOut)}${s.vanished ? `<div class="p-meta num-meta"><span>${s.vanished} vanished</span></div>` : ''}</td>
      <td class="num">${zero(s.restocked)}</td>
      <td class="num hide-sm">${zero(s.removed)}${s.removedInStock ? `<div class="p-meta num-meta"><span>${s.removedInStock} in stock</span></div>` : ''}</td>
      <td class="num">${s.shelfDays != null
        ? `${days(s.shelfDays)}<div class="p-meta num-meta"><span>${plural(s.shelfSamples, 'sell-out')}</span></div>`
        : '<span class="muted">–</span>'}</td>
      <td class="num hide-sm">${s.unitsSold != null ? s.unitsSold.toLocaleString() : '<span class="muted" title="This store doesn\'t show stock counts">–</span>'}</td>
      <td class="hide-sm">${s.lastNewAt ? `<span title="${escapeHtml(centralTime(s.lastNewAt))}">${relTime(s.lastNewAt)}</span>` : '<span class="muted">–</span>'}</td>
      <td class="num">${s.turnover != null ? `${Math.round(s.turnover * 100)}%` : '<span class="muted" title="Fewer than 10 products listed">–</span>'}</td>
    </tr>`;
  }).join('');
}

let loads = 0;
async function load() {
  staticFiles = {}; // pick up a newer published copy
  const id = ++loads;
  try {
    const data = await getJson(`/api/activity?${query()}`);
    if (id !== loads) return; // a later filter change is already loading
    state.data = data;
    const type = $('#type').value;
    $('#type').innerHTML = '<option value="">All types</option>'
      + state.data.types.map((t) => `<option ${t === type ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    render();
    if (state.view === 'calendar') await loadPageCalendar();
  } catch (err) {
    $('#window-note').textContent = `Can't reach the server (${err.message})`;
  }
}

function selectTab(buttons, attr, value) {
  for (const b of buttons) {
    b.classList.toggle('active', b.dataset[attr] === value);
    b.setAttribute('aria-selected', String(b.dataset[attr] === value));
  }
}

function setView(view) {
  state.view = view;
  selectTab($$('[data-view]'), 'view', view);
  for (const v of ['stores', 'calendar', 'ask']) {
    document.body.classList.toggle(`view-${v}`, view === v);
    $(`#${v}-view`).hidden = view !== v;
  }
  if (view === 'calendar') loadPageCalendar();
  if (view === 'ask') {
    $('#ask-input').focus();
    loadAskHistory().catch((err) => { $('#ask-count').textContent = `Couldn't load earlier questions (${err.message})`; });
  }
}

/* ---------- assistant ---------- */

// Just enough Markdown for the assistant's answers: headings, bold, italics,
// code, links, lists, tables and paragraphs. Text is escaped first.
function renderMarkdown(md) {
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const lines = String(md).replace(/\r/g, '').split('\n');
  const out = [];
  let paragraph = [];
  const flush = () => { if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,4})\s+(.*)/.exec(line);
    if (heading) { flush(); out.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`); continue; }
    if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line);
      const body = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) body.push(cells(lines[i]));
      i--;
      out.push(`<div class="table-wrap md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>
        <tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const item = /^\s*([-*•]|\d+[.)])\s+(.*)/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = /^\s*([-*•]|\d+[.)])\s+(.*)/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${inline(m[2])}</li>`);
      }
      i--;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return out.join('');
}

// POSTs to an assistant route and reads its NDJSON stream: status notes go to
// onStatus; resolves to the answer.
async function streamAssistant(url, body, onStatus) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (line.status) onStatus(line.status);
      if (line.error) throw new Error(line.error);
      if (line.answer != null) return line.answer;
    }
  }
  throw new Error('The assistant stopped without an answer');
}

const askedTime = (ms) => `<span title="${escapeHtml(centralTime(ms))}">${relTime(ms)}</span>`;

// One question and its answer; a null answer shows the progress line instead.
function addAskEntry(question, askedAt, answer) {
  const entry = document.createElement('div');
  entry.className = 'ask-entry';
  entry.innerHTML = `<div class="ask-q">${escapeHtml(question)}</div>
    <div class="ask-a">${answer == null ? '<p class="muted ask-status">Starting Claude Code…</p>' : `<div class="md">${renderMarkdown(answer)}</div>`}</div>
    <div class="ask-time muted">${askedAt ? askedTime(askedAt) : ''}</div>`;
  $('#ask-log').append(entry);
  return entry;
}

function updateAskCount() {
  const n = $('#ask-log').querySelectorAll('.ask-entry').length;
  $('#ask-count').textContent = n ? plural(n, 'saved question') : '';
  $('#ask-clear').hidden = !n;
}

async function loadAskHistory() {
  if (state.askLoaded) return;
  state.askLoaded = true;
  const history = await getJson('/api/assistant/history');
  $('#ask-log').prepend(...history.map((h) => addAskEntry(h.question, h.askedAt, h.answer)));
  updateAskCount();
  $('#ask-log').lastElementChild?.scrollIntoView({ block: 'end' });
}

async function ask(question) {
  if (!question || state.asking) return;
  state.asking = true;
  $('#ask-send').disabled = true;
  $('#ask-input').value = '';
  const entry = addAskEntry(question, null, null);
  entry.scrollIntoView({ block: 'nearest' });
  const answerEl = entry.querySelector('.ask-a');
  try {
    const answer = await streamAssistant('/api/assistant/ask', { question }, (status) => {
      answerEl.querySelector('.ask-status').textContent = status;
    });
    answerEl.innerHTML = `<div class="md">${renderMarkdown(answer)}</div>`;
    entry.querySelector('.ask-time').innerHTML = askedTime(Date.now());
    updateAskCount();
  } catch (err) {
    // Failed questions aren't saved, so they drop off the next time the page loads.
    answerEl.innerHTML = `<p class="check-error">${escapeHtml(err.message)}</p>`;
  }
  state.asking = false;
  $('#ask-send').disabled = false;
  $('#ask-input').focus();
}

async function clearAskHistory() {
  if (!confirm('Delete every saved question and answer?')) return;
  const res = await fetch('/api/assistant/history', { method: 'DELETE' });
  if (!res.ok) return;
  for (const entry of $$('#ask-log .ask-entry')) if (!entry.querySelector('.ask-status')) entry.remove();
  updateAskCount();
}

function showBrief(brief) {
  const running = state.briefsRunning.has(state.store.id);
  $('#brief-meta').textContent = brief ? `Written ${relTime(brief.generatedAt)} · ${centralTime(brief.generatedAt)}` : 'No brief yet.';
  $('#brief-run').textContent = running ? 'Writing…' : brief ? 'Rewrite brief' : 'Write brief';
  $('#brief-run').disabled = running;
  $('#brief-body').innerHTML = brief ? renderMarkdown(brief.body) : '';
}

async function loadBrief() {
  showBrief(await getJson(`/api/assistant/brief/${encodeURIComponent(state.store.id)}`));
}

async function writeBrief() {
  const id = state.store.id;
  const here = () => state.store?.id === id && $('#store').open;
  state.briefsRunning.add(id);
  $('#brief-run').disabled = true;
  $('#brief-run').textContent = 'Writing…';
  $('#brief-status').hidden = false;
  $('#brief-status').classList.remove('check-error');
  $('#brief-status').textContent = 'Starting Claude Code…';
  try {
    await streamAssistant(`/api/assistant/brief/${encodeURIComponent(id)}`, {}, (status) => {
      if (here()) $('#brief-status').textContent = status;
    });
    state.briefsRunning.delete(id);
    if (here()) {
      $('#brief-status').hidden = true;
      await loadBrief();
    }
  } catch (err) {
    state.briefsRunning.delete(id);
    if (here()) {
      $('#brief-status').classList.add('check-error');
      $('#brief-status').textContent = err.message;
      await loadBrief();
    }
  }
}

/* ---------- calendar ---------- */

// Month grids covering cal.from..cal.to, each day showing its counts; busier
// days are shaded darker.
function renderCalendar(el, cal, selected) {
  const today = dayKey(Date.now());
  const totals = Object.values(cal.days).map((d) => d.listed + d.soldOut + d.restocked + d.pulled);
  const busiest = Math.max(1, ...totals);
  const first = new Date(utcDay(cal.from));
  const months = [];
  for (let m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1); m <= utcDay(cal.to);) {
    const date = new Date(m);
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth();
    const cells = Array.from({ length: date.getUTCDay() }, () => '<span class="cal-pad"></span>');
    for (let d = 1; d <= new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); d++) {
      const key = new Date(Date.UTC(y, mo, d)).toISOString().slice(0, 10);
      const inRange = key >= cal.from && key <= cal.to;
      const counts = cal.days[key];
      const total = counts ? counts.listed + counts.soldOut + counts.restocked + counts.pulled : 0;
      const chips = counts ? CAL_KINDS.filter(([k]) => counts[k])
        .map(([k, label]) => `<span class="cal-n ${k}" title="${counts[k]} ${label}">${counts[k]}</span>`).join('') : '';
      cells.push(`<button type="button" class="cal-day${inRange ? '' : ' off'}${key === today ? ' today' : ''}${key === selected ? ' selected' : ''}"
        data-day="${key}" ${inRange ? '' : 'disabled'} style="--heat:${(total / busiest).toFixed(2)}"
        aria-label="${escapeHtml(`${longDate(key)}: ${total ? plural(total, 'event') : 'nothing'}`)}">
        <span class="cal-date">${d}</span><span class="cal-chips">${chips}</span></button>`);
    }
    months.push(`<div class="cal-month">
      <h3>${date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })}</h3>
      <div class="cal-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => `<span class="cal-wd">${w}</span>`).join('')}${cells.join('')}</div>
    </div>`);
    m = Date.UTC(y, mo + 1, 1);
  }
  el.innerHTML = months.join('');
}

// The events of one calendar day, for one store or (without `store`) all of them.
async function showDay(el, date, store) {
  el.innerHTML = '<p class="muted cal-loading">Loading…</p>';
  const events = await getJson(`/api/activity/day/${date}?${query()}${store ? `&store=${encodeURIComponent(store)}` : ''}`);
  const names = Object.fromEntries(state.data.stores.map((s) => [s.id, s.name]));
  el.innerHTML = `<h3 class="cal-day-title">${escapeHtml(longDate(date))} · ${plural(events.length, 'event')}</h3>
    ${events.length ? `<div class="table-wrap cal-events"><table class="checks">
      <thead><tr><th>Time</th><th>Event</th><th>Product</th>${store ? '' : '<th>Store</th>'}<th class="hide-sm">Type</th></tr></thead>
      <tbody>${events.map((e) => `<tr>
        <td>${clockTime(e.at)}</td>
        <td>${EVENTS[e.kind]?.(e) ?? escapeHtml(e.kind)}</td>
        <td><a class="p-title" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a></td>
        ${store ? '' : `<td>${escapeHtml(names[e.storeId] ?? e.storeId)}</td>`}
        <td class="hide-sm">${escapeHtml(e.productType ?? '')}</td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing happened this day.</p>'}`;
}

async function loadPageCalendar() {
  renderCalendar($('#cal'), await getJson(`/api/activity/calendar?${query()}`), state.pageDay);
}

function pickDay(e, calEl, dayEl, key, store) {
  const btn = e.target.closest('.cal-day');
  if (!btn || btn.disabled) return;
  state[key] = btn.dataset.day;
  for (const b of calEl.querySelectorAll('.cal-day.selected')) b.classList.remove('selected');
  btn.classList.add('selected');
  showDay(dayEl, btn.dataset.day, store);
}

/* ---------- store dialog ---------- */

// Stock spans per product across the period, with a line at each US Central midnight.
function renderTimeline() {
  const t = state.timeline;
  if (!t) return;
  const q = $('#tl-search').value.trim().toLowerCase();
  const rows = t.products.filter((p) => !q || p.title.toLowerCase().includes(q));
  const width = t.to - t.from;
  const pct = (ms) => `${((ms / width) * 100).toFixed(3)}%`;
  const spanDays = width / 86400_000;
  const every = spanDays <= 10 ? 1 : spanDays <= 35 ? 3 : 7;
  const ticks = [];
  for (let i = 1, start = utcDay(dayKey(t.from)); ; i++) {
    const key = new Date(start + i * 86400_000).toISOString().slice(0, 10);
    const at = centralMidnight(key);
    if (at >= t.to) break;
    ticks.push({ at, label: i % every === 0 ? new Date(utcDay(key)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '' });
  }

  $('#tl-count').textContent = `${plural(rows.length, 'product')}${t.total > t.products.length ? ` (the ${t.products.length} most recently changed of ${t.total.toLocaleString()})` : ''}`;
  $('#tl-empty').hidden = rows.length > 0;
  $('#tl').hidden = !rows.length;
  $('#tl').innerHTML = `
    <div class="tl-lines" aria-hidden="true">${ticks.map((k) => `<i style="left:${pct(k.at - t.from)}"></i>`).join('')}</div>
    <div class="tl-row tl-axis" aria-hidden="true"><div class="tl-label"></div><div class="tl-track">
      ${ticks.filter((k) => k.label).map((k) => `<span class="tl-tick" style="left:${pct(k.at - t.from)}">${k.label}</span>`).join('')}
    </div></div>
    ${rows.map((p) => `<div class="tl-row">
      <div class="tl-label">
        <a class="p-title" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</a>
        <div class="p-meta"><span>${escapeHtml(p.productType ?? '')}</span><span>${plural(p.changes, 'change')}</span></div>
      </div>
      <div class="tl-track">${p.spans.map(([a, b, s]) => `<span class="tl-seg seg-${s}" style="left:${pct(a - t.from)};width:${pct(b - a)}"
        title="${escapeHtml(`${STATES[s]}: ${centralTime(a)} → ${b >= t.to - 60_000 ? 'now' : centralTime(b)} (${length(b - a)})`)}"></span>`).join('')}</div>
    </div>`).join('')}`;
}

async function loadTimeline() {
  $('#tl-count').textContent = 'Loading…';
  state.timeline = await getJson(`/api/activity/${encodeURIComponent(state.store.id)}/timelines?${query()}${$('#tl-all').checked ? '&all=1' : ''}`);
  renderTimeline();
}

async function loadStoreCalendar() {
  renderCalendar($('#sd-cal'), await getJson(`/api/activity/calendar?${query()}&store=${encodeURIComponent(state.store.id)}`), state.storeDay);
}

async function loadEvents() {
  const events = await getJson(`/api/activity/${encodeURIComponent(state.store.id)}/events?${query()}`);
  $('#sd-sub').textContent = `${periodText()} · ${plural(events.length, 'event')}${events.length >= 500 ? ' (latest 500)' : ''}`;
  $('#ev-empty').hidden = events.length > 0;
  $('#ev-rows').innerHTML = events.map((e) => `<tr>
    <td><span title="${escapeHtml(centralTime(e.at))}">${relTime(e.at)}</span><div class="p-meta"><span>${escapeHtml(centralTime(e.at))}</span></div></td>
    <td>${EVENTS[e.kind]?.(e) ?? escapeHtml(e.kind)}</td>
    <td><a class="p-title" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a></td>
    <td class="hide-sm">${escapeHtml(e.productType ?? '')}</td>
  </tr>`).join('');
}

const TAB_LOADERS = { timeline: loadTimeline, calendar: loadStoreCalendar, events: loadEvents, brief: loadBrief };

function setTab(tab) {
  state.tab = tab;
  selectTab($$('[data-tab]'), 'tab', tab);
  for (const pane of $$('.sd-pane')) pane.hidden = pane.dataset.pane !== tab;
  TAB_LOADERS[tab]().catch((err) => { $('#sd-sub').textContent = `Couldn't load (${err.message})`; });
}

function openStore(id) {
  const s = state.data.stores.find((x) => x.id === id);
  if (!s) return;
  Object.assign(state, { store: s, timeline: null, storeDay: null });
  $('#sd-title').textContent = s.name;
  $('#sd-sub').textContent = periodText();
  $('#sd-link').href = s.baseUrl;
  $('#tl-search').value = '';
  $('#tl-all').checked = false;
  for (const sel of ['#tl', '#sd-cal', '#sd-cal-day', '#ev-rows', '#brief-body', '#brief-meta']) $(sel).innerHTML = '';
  $('#brief-status').hidden = true;
  $('#store').showModal();
  setTab(state.tab);
}

/* ---------- wiring ---------- */

$('#rows').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-store]');
  if (row) openStore(row.dataset.store);
});
$('#sd-close').addEventListener('click', () => $('#store').close());
for (const b of $$('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
for (const b of $$('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
$('#cal').addEventListener('click', (e) => pickDay(e, $('#cal'), $('#cal-day'), 'pageDay', ''));
$('#sd-cal').addEventListener('click', (e) => pickDay(e, $('#sd-cal'), $('#sd-cal-day'), 'storeDay', state.store.id));
$('#tl-search').addEventListener('input', renderTimeline);
$('#brief-run').addEventListener('click', writeBrief);
$('#ask-clear').addEventListener('click', clearAskHistory);
$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  ask($('#ask-input').value.trim());
});
// Enter asks; Shift+Enter adds a line.
$('#ask-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ask($('#ask-input').value.trim());
  }
});
$('#ask-examples').addEventListener('click', (e) => {
  const example = e.target.closest('button');
  if (example) ask(example.textContent);
});
$('#tl-all').addEventListener('change', loadTimeline);
for (const sel of ['#search', '#sort', '#quiet']) $(sel).addEventListener('input', render);
for (const sel of ['#days', '#type']) {
  $(sel).addEventListener('change', () => {
    state.pageDay = null;
    $('#cal-day').innerHTML = '';
    load();
  });
}
load();
setInterval(load, 60_000);
