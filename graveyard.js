/* The Pot Drop: stores that closed or went offline. */

const $ = (sel) => document.querySelector(sel);
const STATIC = document.documentElement.hasAttribute('data-static');

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TIME_ZONE = 'America/Chicago';
const centralTime = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const centralDay = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' });
// "2026-11-10" is a calendar date, so it's read at noon to stay on that day everywhere.
const plainDay = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const host = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
const money = (cents) => (cents == null ? '–' : `$${(cents / 100).toFixed(2)}`);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function span(from, to) {
  const days = Math.round((to - from) / 86400_000);
  return days < 1 ? 'under a day' : plural(days, 'day');
}

const timelineRow = (label, value, note = '') => (value ? `
  <div><dt>${label}</dt><dd>${value}${note ? `<span class="muted"> · ${note}</span>` : ''}</dd></div>` : '');

function stat(value, label) {
  return `<div class="grave-stat"><span class="grave-stat-value">${escapeHtml(value)}</span><span class="grave-stat-label">${label}</span></div>`;
}

function graveHtml(s) {
  const end = s.wentOffline ?? s.lastSeenOnline;
  const years = s.trackedSince && end ? `${centralDay(s.trackedSince)} – ${centralDay(end)}` : '';
  const catalog = s.catalog.length ? `
    <details class="grave-catalog">
      <summary>Last catalog (${plural(s.catalog.length, 'product')}, ${s.inStockAtEnd} in stock)</summary>
      <table>
        <tbody>${s.catalog.map((p) => `
          <tr class="${p.inStock ? '' : 'sold-out'}">
            <td>${escapeHtml(p.title)}</td>
            <td class="muted hide-sm">${escapeHtml(p.type ?? '')}</td>
            <td class="num">${money(p.cents)}</td>
            <td class="muted">${p.inStock ? 'in stock' : 'sold out'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </details>` : '';
  return `
    <article class="grave">
      <div class="grave-head">
        <span class="grave-stone" aria-hidden="true">🪦</span>
        <div>
          <h2>${escapeHtml(s.name)}</h2>
          <span class="muted">${escapeHtml(host(s.baseUrl))}${years ? ` · ${years}` : ''}</span>
        </div>
      </div>
      ${s.reason ? `<p class="grave-reason">${escapeHtml(s.reason)}${s.successor
        ? ` Now: <a href="${escapeHtml(s.successor)}" target="_blank" rel="noopener">${escapeHtml(host(s.successor))}</a>.` : ''}</p>` : ''}
      <dl class="grave-timeline">
        ${timelineRow('Tracked since', s.trackedSince && centralTime(s.trackedSince))}
        ${timelineRow('Last seen online', s.lastSeenOnline && centralTime(s.lastSeenOnline),
          s.productsAtEnd != null ? plural(s.productsAtEnd, 'product') : '')}
        ${timelineRow('Went offline', s.wentOffline && centralTime(s.wentOffline),
          s.firstError ? escapeHtml(s.firstError) : '')}
        ${timelineRow('Removed from checks', s.removed && plainDay(s.removed),
          s.failedChecks ? `after ${plural(s.failedChecks, 'failed check')}` : '')}
      </dl>
      <div class="grave-stats">
        ${stat(s.trackedSince && end ? span(s.trackedSince, end) : '–', 'tracked')}
        ${stat(s.checks.toLocaleString(), 'checks')}
        ${stat(s.newListings, 'new listings')}
        ${stat(s.soldOut, 'sell-outs')}
        ${stat(s.restocked, 'restocks')}
        ${stat(s.priceDrops, 'price drops')}
      </div>
      ${catalog}
    </article>`;
}

async function load() {
  try {
    const res = await fetch(STATIC ? 'data/graveyard.json' : '/api/graveyard', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { stores } = await res.json();
    $('#graves').innerHTML = stores.map(graveHtml).join('');
    $('#empty').hidden = stores.length > 0;
  } catch (err) {
    $('#graves').innerHTML = `<p class="empty">Couldn't load the graveyard (${escapeHtml(err.message)}).</p>`;
  }
}

load();
