const $ = (sel) => document.querySelector(sel);
const MAX_PLOTTED = 8; // one per categorical color slot
const PAGE_SIZE = 100;
const NEW_MS = 48 * 3600_000;

const state = { products: [], status: null, detail: null, chart: null };

const money = (cents) => (cents == null ? '–' : `$${(cents / 100).toFixed(2)}`);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function relTime(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return fmt.format(Math.round(diff / 1000), 'second');
  if (abs < 3600_000) return fmt.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86400_000) return fmt.format(Math.round(diff / 3600_000), 'hour');
  return fmt.format(Math.round(diff / 86400_000), 'day');
}

function deltaHtml(pct) {
  if (Math.abs(pct) < 0.05) return '<span class="delta flat">— no change</span>';
  const cls = pct < 0 ? 'down' : 'up';
  const arrow = pct < 0 ? '▼' : '▲';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

// The published copy (src/publish.js) is static: the same reads come from JSON
// files, and everything that changes something is hidden.
const STATIC = document.documentElement.hasAttribute('data-static');
const STATIC_FILES = { '/api/status': 'data/status.json', '/api/products': 'data/products.json' };

async function api(path, opts) {
  const res = await fetch(STATIC ? STATIC_FILES[path] ?? path : path, STATIC ? { cache: 'no-cache' } : opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

// A product's price history: one file per store in the static copy.
const historyFiles = {};
async function productHistory(product) {
  if (!STATIC) return api(`/api/products/${encodeURIComponent(product.id)}/history`);
  historyFiles[product.storeId] ??= api(`data/history/${encodeURIComponent(product.storeId)}.json`)
    .catch((err) => { delete historyFiles[product.storeId]; throw err; });
  return (await historyFiles[product.storeId])[product.id] ?? { variants: [] };
}

/* ---------- sparkline ---------- */

function sparkline(points, w = 120, h = 32) {
  if (points.length < 2) return '<span class="muted" style="font-size:12px">collecting…</span>';
  const ts = points.map((p) => p[0]);
  const vs = points.map((p) => p[1]);
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  const [lo, hi] = [Math.min(...vs), Math.max(...vs)];
  const x = (t) => 2 + ((t - t0) / (t1 - t0 || 1)) * (w - 4);
  const y = (v) => (hi === lo ? h / 2 : 3 + (1 - (v - lo) / (hi - lo)) * (h - 6));
  // Step path: prices hold until the next check changes them.
  let d = `M${x(ts[0])},${y(vs[0])}`;
  for (let i = 1; i < points.length; i++) d += `H${x(ts[i])}V${y(vs[i])}`;
  const last = points.at(-1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${x(last[0])}" cy="${y(last[1])}" r="2.5" fill="currentColor"/>
  </svg>`;
}

/* ---------- product table ---------- */

// Shopify's CDN resizes on request; other stores already give us a thumbnail.
function thumbUrl(src) {
  if (!src.includes('cdn.shopify.com')) return src;
  const url = new URL(src);
  url.searchParams.set('width', '96');
  return url.href;
}

// "💸 $115.80 w/ first30 (first order)" under a price.
function codePriceHtml(v) {
  const c = v.withCode;
  return `<div class="code-price" title="${c.firstOrder ? 'First-order code' : 'Discount code'}${v.withGeneralCode ? ` · anyone: ${money(v.withGeneralCode.cents)} with ${v.withGeneralCode.code}` : ''}">
    💸 ${money(c.cents)} w/ <strong>${escapeHtml(c.code)}</strong>${c.firstOrder ? ' <span class="first">(first order)</span>' : ''}</div>`;
}

const thumbLetter = (p) => (p.productType ?? p.title).trim()[0]?.toUpperCase() ?? '?';

// Some stores block hotlinked images; swap in a lettered tile instead.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const tile = document.createElement('div');
  tile.className = 'thumb';
  tile.textContent = img.dataset.fallback;
  img.replaceWith(tile);
}, true);

// Size filter buckets per product type, matched on one size field: an option
// fits when that field is in [min, max). Flower and concentrates go by total
// weight, vapes by device size, pre-rolls and edibles by how many come in it.
const SIZES = {
  Flower: { field: 'grams', unit: 'g', buckets: [
    ['1g', 0, 1.5], ['2g', 1.5, 3], ['3.5g · eighth', 3, 5], ['7g · quarter', 5, 10], ['14g · half oz', 10, 21],
    ['28g · ounce', 21, 42], ['2–4 oz · QP', 42, 140], ['½ lb', 140, 300], ['1 lb+', 300, Infinity],
  ] },
  Concentrates: { field: 'grams', unit: 'g', buckets: [
    ['1g', 0, 1.5], ['2g', 1.5, 3], ['3.5–5g', 3, 6], ['7–10g', 6, 12], ['14g', 12, 21], ['28g', 21, 42], ['2 oz+ · bulk', 42, Infinity],
  ] },
  Vapes: { field: 'unitGrams', unit: 'g', buckets: [
    ['0.5g', 0, 0.75], ['1g', 0.75, 1.5], ['2g', 1.5, 2.5], ['3g', 2.5, 3.75], ['4g+', 3.75, Infinity],
  ] },
  'Pre-Rolls': { field: 'count', unit: 'ea', buckets: [
    ['Single', 1, 2], ['2–5 pack', 2, 6], ['6–10 pack', 6, 11], ['11–50', 11, 51], ['51+ · bulk', 51, Infinity],
  ] },
  Edibles: { field: 'count', unit: 'ea', buckets: [
    ['Single', 1, 2], ['2–5 pack', 2, 6], ['6–12', 6, 13], ['13–30', 13, 31], ['31+', 31, Infinity],
  ] },
};
const sizeScheme = (type) => SIZES[type] ?? null;

// $/g for weighed products, $/each for counted ones.
function unitPrice(v, type) {
  const scheme = sizeScheme(type) ?? SIZES.Flower;
  const qty = scheme.unit === 'g' ? v.grams : v.count > 1 ? v.count : null;
  return qty ? { cents: v.priceCents / qty, unit: scheme.unit } : null;
}
const unitPriceText = (v, type) => {
  const u = unitPrice(v, type);
  return u ? `${money(u.cents)}/${u.unit}` : '';
};

// Minimum-potency choices: flower-range percentages unless the type is a concentrate or vape.
const POTENCY_STEPS = { strong: [60, 70, 80, 90], flower: [20, 25, 28, 30, 33] };
const potencySteps = (type) => (type === 'Edibles' || type === 'Other' ? null
  : type === 'Concentrates' || type === 'Vapes' ? POTENCY_STEPS.strong : POTENCY_STEPS.flower);

function fillPotencyOptions() {
  const el = $('#filter-potency');
  const steps = potencySteps($('#filter-type').value);
  el.innerHTML = steps
    ? `<option value="">Any potency</option>${steps.map((s) => `<option value="${s}">${s}%+</option>`).join('')}`
    : '<option value="">Potency: n/a</option>';
  el.disabled = !steps;
}

const POTENCY_SHORT = { THCa: 'THCa', 'Total THC': 'total THC', 'Total cannabinoids': 'total cannabinoids' };
const potencyText = (p) => `${+p.thcaPct.toFixed(2)}% ${POTENCY_SHORT[p.potencyLabel] ?? p.potencyLabel}`;

// Store-listed potency, strain type, grow method and brand (at multi-brand stores).
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ownBrand = (p) => squash(p.brand).includes(squash(p.storeName)) || squash(p.storeName).includes(squash(p.brand));
const brandOf = (p) => (p.brand && state.multiBrand?.has(p.storeId) && !ownBrand(p) ? p.brand : null);

function detailsHtml(p) {
  const brand = brandOf(p);
  return [
    p.thcaPct != null ? `<span class="tag potency" title="Potency the store lists for this product">${escapeHtml(potencyText(p))}</span>` : '',
    p.strainType ? `<span>${escapeHtml(p.strainType)}</span>` : '',
    p.grow ? `<span>${escapeHtml(p.grow)}</span>` : '',
    brand ? `<span title="Brand">${escapeHtml(brand)}</span>` : '',
    p.coaUrl ? '<span title="Has a lab report (COA) link">🧪 Lab report</span>' : '',
  ].join('');
}

// The options a row is priced from: those in the chosen size (in stock when
// available), so "From" and sorting reflect that size rather than the cheapest option.
function productView(p, size, inStockOnly) {
  let opts = p.variants;
  if (size) {
    opts = opts.filter((v) => v[size.field] != null && v[size.field] >= size.min && v[size.field] < size.max);
    if (!opts.length || (inStockOnly && !opts.some((v) => v.available))) return null;
  }
  const inStock = opts.filter((v) => v.available);
  const pool = inStock.length ? inStock : opts;
  const cheapest = pool.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
  return {
    cheapest,
    fromCents: cheapest.priceCents,
    fromWithCodeCents: Math.min(...pool.map((v) => v.withCode?.cents ?? v.priceCents)),
    unitCents: Math.min(...pool.map((v) => unitPrice(v, p.productType)?.cents ?? Infinity)),
    // Price per gram of THCa (or of total THC / cannabinoids, as listed), for weighed products.
    valueCents: p.thcaPct ? Math.min(...pool.map((v) => {
      const u = unitPrice(v, p.productType);
      return u?.unit === 'g' ? u.cents / (p.thcaPct / 100) : Infinity;
    })) : Infinity,
  };
}

// The chosen size bucket, as { field, min, max }, or null for all sizes.
function selectedSize() {
  const scheme = sizeScheme($('#filter-type').value);
  const value = $('#filter-size').value; // '' is "All sizes", not bucket 0
  const bucket = value === '' ? null : scheme?.buckets[Number(value)];
  return bucket ? { field: scheme.field, min: bucket[1], max: bucket[2] } : null;
}

// Sizes depend on the type, so the menu is rebuilt (and reset) when the type changes.
function fillSizeOptions() {
  const el = $('#filter-size');
  const scheme = sizeScheme($('#filter-type').value);
  el.innerHTML = scheme
    ? `<option value="">All sizes</option>${scheme.buckets.map(([label], i) => `<option value="${i}">${escapeHtml(label)}</option>`).join('')}`
    : '<option value="">Size: pick a type</option>';
  el.disabled = !scheme;
}

function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const hidden = state.hiddenStores;
  const type = $('#filter-type').value;
  const size = selectedSize();
  const inStockOnly = $('#filter-instock').checked;
  const sort = $('#sort').value;
  const minPotency = Number($('#filter-potency').value) || 0;
  const strain = $('#filter-strain').value;
  const grow = $('#filter-grow').value;
  const coaOnly = $('#filter-coa').checked;

  const list = state.products.filter((p) => {
    if (hidden.has(p.storeId)) return false;
    if (type && (p.productType ?? 'Other') !== type) return false;
    if (inStockOnly && (!p.inStock || p.delisted)) return false;
    if (minPotency && !(p.thcaPct >= minPotency)) return false;
    // Lower-case choices include the leaning hybrids ("indica" = Indica + Indica-leaning).
    if (strain && (strain === strain.toLowerCase() ? !p.strainType?.toLowerCase().startsWith(strain) : p.strainType !== strain)) return false;
    if (grow && p.grow !== grow) return false;
    if (coaOnly && !p.coaUrl) return false;
    if (q && !p.title.toLowerCase().includes(q) && !p.variants.some((v) => v.title.toLowerCase().includes(q))) return false;
    p.view = productView(p, size, inStockOnly);
    return p.view != null;
  });

  const sorters = {
    drop: (a, b) => a.biggestDropPct - b.biggestDropPct || a.title.localeCompare(b.title),
    'price-asc': (a, b) => a.view.fromCents - b.view.fromCents,
    'code-asc': (a, b) => a.view.fromWithCodeCents - b.view.fromWithCodeCents,
    'unit-asc': (a, b) => a.view.unitCents - b.view.unitCents || a.view.fromCents - b.view.fromCents,
    // Products without a listed potency (or a weight) go last.
    'value-asc': (a, b) => a.view.valueCents - b.view.valueCents || a.view.fromCents - b.view.fromCents,
    'potency-desc': (a, b) => (b.thcaPct ?? -1) - (a.thcaPct ?? -1) || a.view.fromCents - b.view.fromCents,
    'price-desc': (a, b) => b.view.fromCents - a.view.fromCents,
    // Items with no known listing date go last: a newly tracked store's catalog isn't new.
    // Products without a standing drop go last.
    'newest-drop': (a, b) => (b.lastDrop?.at ?? -Infinity) - (a.lastDrop?.at ?? -Infinity) || a.biggestDropPct - b.biggestDropPct,
    newest: (a, b) => (b.addedAt ?? -Infinity) - (a.addedAt ?? -Infinity) || b.firstSeen - a.firstSeen,
    // Unrated products go last.
    'top-rated': (a, b) => ratingScore(b) - ratingScore(a) || (b.reviewCount ?? 0) - (a.reviewCount ?? 0),
    'most-reviewed': (a, b) => (b.reviewCount ?? -1) - (a.reviewCount ?? -1) || (b.rating ?? 0) - (a.rating ?? 0),
    name: (a, b) => a.title.localeCompare(b.title),
  };
  return list.sort(sorters[sort]);
}

// Times are shown in US Central (CST/CDT) no matter where the dashboard is opened.
const TIME_ZONE = 'America/Chicago';
const centralTime = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  ...(new Date(ms).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
});

// A "drop" is always a discount; new products are "listed".
// "▼ Price drop Oct 29, 9:14 AM CDT · 3.5g $40.00 → $30.00 (−25%)"
function droppedHtml(d) {
  const option = d.variant !== 'Default' ? `${d.variant} ` : '';
  return `<span class="delta down" title="Most recent price drop that still holds">▼ Price drop ${centralTime(d.at)}</span><span>${escapeHtml(option)}${money(d.oldCents)} → ${money(d.newCents)} (−${Math.abs(Math.round(d.pct))}%)</span>`;
}

// "Top rated" ranks by the average pulled toward a typical 4.5★ by 10 phantom
// reviews, so a single 5★ review doesn't outrank 4.8★ from 300 people.
const RATING_PRIOR = { rating: 4.5, count: 10 };
const ratingScore = (p) => (p.rating == null || !p.reviewCount ? -Infinity
  : (p.rating * p.reviewCount + RATING_PRIOR.rating * RATING_PRIOR.count) / (p.reviewCount + RATING_PRIOR.count));

// Rounded down, so a 4.95 average reads 4.9 rather than a perfect 5.0.
const stars = (rating) => (Math.floor(rating * 10 + 1e-9) / 10).toFixed(1);

// "★ 4.8 (123)", from the store's own reviews.
function ratingHtml(p) {
  if (p.rating == null || !p.reviewCount) return '';
  return `<span class="rating" title="${p.rating.toFixed(2)} average from ${p.reviewCount.toLocaleString()} review${p.reviewCount === 1 ? '' : 's'} on the store">★ ${stars(p.rating)} (${p.reviewCount.toLocaleString()})</span>`;
}

function addedHtml(p) {
  if (p.addedAt) {
    const source = p.listedAt ? 'When the store listed it' : 'When The Pot Drop first saw it listed';
    return `<span title="${source}">Listed ${centralTime(p.addedAt)}</span>`;
  }
  return `<span title="Already listed when we started tracking this store">Listed before ${centralTime(state.storeStart[p.storeId])}</span>`;
}

function renderProducts({ keepPage = false } = {}) {
  if (!keepPage) state.shown = PAGE_SIZE;
  const all = filtered();
  const rows = all.slice(0, state.shown);
  $('#empty').hidden = all.length > 0;
  const more = $('#show-more');
  more.hidden = all.length <= rows.length;
  more.textContent = `Show more (${(all.length - rows.length).toLocaleString()} left)`;
  $('#result-count').textContent = `${all.length.toLocaleString()} product${all.length === 1 ? '' : 's'}`;
  $('#product-rows').innerHTML = rows.map((p) => {
    const { cheapest } = p.view;
    const lo = Math.min(...p.variants.map((v) => v.lowCents));
    const hi = Math.max(...p.variants.map((v) => v.highCents));
    const tags = [
      p.productType ? `<span class="tag">${escapeHtml(p.productType)}</span>` : '',
      p.watchCents ? `<span class="tag new" title="Alert set">🎯 ${money(p.watchCents)}</span>` : '',
      p.onSale ? '<span class="tag sale">On sale</span>' : '',
      // "New" = listed after we started tracking that store, not just newly tracked.
      Date.now() - p.firstSeen < NEW_MS && p.firstSeen - state.storeStart[p.storeId] > 3600_000 ? '<span class="tag new">New listing</span>' : '',
      p.delisted ? '<span class="tag gone">Delisted</span>' : !p.inStock ? '<span class="tag">Sold out</span>' : '',
    ].join('');
    const listed = addedHtml(p);
    return `<tr data-id="${escapeHtml(p.id)}" class="${p.inStock && !p.delisted ? '' : 'out'}">
      <td>${p.image ? `<img class="thumb" loading="lazy" src="${escapeHtml(thumbUrl(p.image))}" alt="" data-fallback="${escapeHtml(thumbLetter(p))}">` : `<div class="thumb">${escapeHtml(thumbLetter(p))}</div>`}</td>
      <td>
        <div class="p-title">${escapeHtml(p.title)}</div>
        <div class="p-meta"><span>${p.variants.length} option${p.variants.length === 1 ? '' : 's'}</span>${state.status?.stores.length > 1 ? `<span>${escapeHtml(p.storeName)}</span>` : ''}${ratingHtml(p)}${listed}${tags}</div>
        ${detailsHtml(p) ? `<div class="p-meta">${detailsHtml(p)}</div>` : ''}
        ${p.lastDrop ? `<div class="p-meta">${droppedHtml(p.lastDrop)}</div>` : ''}
      </td>
      <td class="num"><span class="price">${money(cheapest.priceCents)}</span>${cheapest.compareAtCents ? `<span class="strike">${money(cheapest.compareAtCents)}</span>` : ''}
        <div class="p-meta" style="justify-content:flex-end"><span>${escapeHtml(cheapest.title)}</span>${unitPrice(cheapest, p.productType) ? `<span>${unitPriceText(cheapest, p.productType)}</span>` : ''}</div>
        ${$('#sort').value === 'value-asc' && Number.isFinite(p.view.valueCents) ? `<div class="p-meta" style="justify-content:flex-end"><span title="Price per gram of THCa at the listed potency">${money(p.view.valueCents)}/g THCa</span></div>` : ''}
        ${cheapest.withCode ? codePriceHtml(cheapest) : ''}</td>
      <td class="num">${deltaHtml(p.biggestDropPct)}</td>
      <td class="num hide-sm">${lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`}</td>
      <td class="hide-sm">${sparkline(p.sparkline)}</td>
    </tr>`;
  }).join('');
}

function renderTiles() {
  const live = state.products.filter((p) => !p.delisted);
  const variants = live.flatMap((p) => p.variants);
  const dropped = variants.filter((v) => v.priceCents < v.firstCents);
  $('#stat-products').textContent = live.length;
  $('#stat-instock').textContent = `${live.filter((p) => p.inStock).length} in stock · ${variants.length} options`;
  $('#stat-dropped').textContent = `${dropped.length}`;
  $('#stat-dropped-sub').textContent = dropped.length
    ? `options · avg ▼ ${(dropped.reduce((s, v) => s + -v.changePct, 0) / dropped.length).toFixed(1)}%`
    : 'options so far';
}

function renderStatus() {
  const s = state.status;
  // A bare "YYYY-MM-DD" means local midnight; full timestamps are used as-is.
  const ban = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s.banDate) ? `${s.banDate}T00:00:00` : s.banDate);
  const days = Math.max(0, Math.ceil((ban - Date.now()) / 86400_000));
  $('#countdown').textContent = `${days} day${days === 1 ? '' : 's'}`;
  $('#ban-date').textContent = ban.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

  const lastOk = Math.max(0, ...s.runs.filter((r) => r.status === 'ok').map((r) => r.started_at));
  const failed = s.runs.filter((r) => r.status === 'error');
  const names = Object.fromEntries(s.stores.map((st) => [st.id, st.name]));
  $('#stat-last').textContent = s.running ? 'Checking all…' : lastOk ? relTime(lastOk) : 'Never';
  // Stores are checked one by one on a rolling queue, so also show the stalest.
  const okRuns = s.runs.filter((r) => r.status === 'ok');
  const oldestOk = okRuns.length === s.stores.length ? Math.min(...okRuns.map((r) => r.started_at)) : 0;
  const next = $('#stat-next');
  next.textContent = [
    s.running ? '' : s.checking?.length ? `Checking ${s.checking.join(', ')}` : s.nextStore ? `Next: ${s.nextStore} ${relTime(s.nextRunAt)}` : '',
    oldestOk && !s.running ? `oldest ${relTime(oldestOk)}` : '',
    failed.length ? `⚠ ${failed.length} store${failed.length === 1 ? '' : 's'} failed` : '',
  ].filter(Boolean).join(' · ');
  next.title = failed.map((r) => `${names[r.store_id]}: ${r.error}`).join('\n');

  const sel = $('#interval');
  const match = [...sel.options].find((o) => Number(o.value) === s.intervalMinutes);
  if (!match) {
    let opt = sel.querySelector('option[data-custom]');
    if (!opt) {
      opt = new Option('', '');
      opt.dataset.custom = '1';
      sel.insertBefore(opt, sel.lastElementChild);
    }
    opt.value = s.intervalMinutes;
    opt.textContent = `${s.intervalMinutes} min`;
  }
  sel.value = String(s.intervalMinutes);
  $('#scrape-now').disabled = s.running;
}

function fillFilterOptions() {
  const keep = (sel, values) => {
    const el = $(sel);
    const current = el.value;
    const first = el.options[0].outerHTML;
    el.innerHTML = first + values.map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join('');
    el.value = current;
  };
  $('#store-picker').hidden = state.status.stores.length < 2;
  renderStorePicker();
  const types = [...new Set(state.products.map((p) => p.productType ?? 'Other'))].sort();
  keep('#filter-type', types.map((t) => [t, t]));
}

async function refresh() {
  const [status, products] = await Promise.all([api('/api/status'), api('/api/products')]);
  state.status = status;
  state.products = products;
  state.loadedAt = Date.now();
  state.storeStart = {};
  for (const p of products) state.storeStart[p.storeId] = Math.min(state.storeStart[p.storeId] ?? Infinity, p.firstSeen);
  // The store's own listing date when it gives one (Shopify); otherwise when we first saw it,
  // unless that was the store's first check, when it could have been listed any time before.
  for (const p of products) p.addedAt = p.listedAt ?? (p.firstSeen - state.storeStart[p.storeId] > 3600_000 ? p.firstSeen : null);
  // Brands only mean something at stores that sell other companies' products.
  // Elsewhere the "brand" is the store's own or legal name, or a supplier field
  // ("Gold Standard Wholesale", "Printify"), so it takes several to count.
  const brandsByStore = {};
  for (const p of products) if (p.brand && !ownBrand(p)) (brandsByStore[p.storeId] ??= new Set()).add(p.brand);
  state.multiBrand = new Set(Object.keys(brandsByStore).filter((id) => brandsByStore[id].size >= 4));
  fillFilterOptions();
  renderStatus();
  renderTiles();
  renderProducts({ keepPage: state.shown != null }); // background refreshes keep "Show more" progress
}

/* ---------- detail dialog ---------- */

const seriesColor = (slot) => cssVar(`--series-${slot + 1}`);

async function openDetail(id) {
  const product = state.products.find((p) => p.id === id);
  const history = await productHistory(product);
  const current = new Set(product.variants.map((v) => v.id));
  const variants = history.variants.filter((v) => current.has(v.id));

  // Color follows the variant: each plotted variant holds its slot until unchecked.
  const slots = new Map();
  const defaults = [...product.variants].sort((a, b) => b.available - a.available).slice(0, MAX_PLOTTED);
  defaults.forEach((v, i) => slots.set(v.id, i));

  state.detail = { product, variants, slots };
  $('#detail-title').textContent = product.title;
  $('#detail-meta').textContent = [
    product.storeName,
    brandOf(product) ? `by ${brandOf(product)}` : '',
    product.thcaPct != null ? potencyText(product) : '',
    product.strainType,
    product.grow,
    product.reviewCount && product.rating != null ? `★ ${stars(product.rating)} from ${product.reviewCount.toLocaleString()} review${product.reviewCount === 1 ? '' : 's'}` : '',
    product.listedAt ? `listed ${centralTime(product.listedAt)}` : '',
    `tracking since ${centralTime(product.firstSeen)}`,
  ].filter(Boolean).join(' · ');
  $('#detail-link').href = product.url;
  $('#detail-coa').hidden = !product.coaUrl;
  if (product.coaUrl) $('#detail-coa').href = product.coaUrl;
  $('#detail-hint').textContent = product.variants.length > MAX_PLOTTED
    ? `Showing ${MAX_PLOTTED} of ${product.variants.length} options — tick boxes below to choose which are plotted.`
    : '';
  renderWatch();
  renderCodes(product);
  renderDetail();
  $('#detail').showModal();
}

const SOURCE_LABEL = { franklist: 'via Franklist', site: 'from the store\'s site', manual: 'added by you', web: 'found online, unverified' };

function renderCodes(product) {
  const codes = state.status.codes?.[product.storeId] ?? [];
  const offers = state.status.offers?.[product.storeId] ?? [];
  const box = $('#detail-codes');
  box.hidden = !codes.length && !offers.length;
  if (box.hidden) return;
  const offerChips = offers.map((o) => `<div class="code-chip offer">
      <strong>✉ Sign-up offer</strong>
      <span class="muted">${escapeHtml(o.description)}</span>
      ${o.sourceUrl ? `<a class="muted" href="${escapeHtml(o.sourceUrl)}" target="_blank" rel="noopener">on the store's site ↗</a>` : ''}
    </div>`).join('');
  box.innerHTML = `<h3>Codes at ${escapeHtml(product.storeName)}</h3>
    <div class="code-list">${offerChips}${codes.map((c) => {
      const value = c.percentOff ? `${c.percentOff}% off` : c.amountOffCents ? `${money(c.amountOffCents)} off` : '';
      const notes = c.notes.length ? c.notes.join(' · ') : 'Anyone, sitewide';
      return `<div class="code-chip">
        <button type="button" data-copy="${escapeHtml(c.code)}" title="Copy code"><strong>${escapeHtml(c.code)}</strong>${value ? ` · ${value}` : ''} ⧉</button>
        <span class="muted">${escapeHtml(notes)}</span>
        <span class="muted">${escapeHtml(SOURCE_LABEL[c.source] ?? c.source)}</span>
      </div>`;
    }).join('')}</div>`;
}

$('#detail-codes').addEventListener('click', async (e) => {
  const code = e.target.closest('[data-copy]')?.dataset.copy;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${code}`);
  } catch {
    toast(code);
  }
});

function renderWatch() {
  const { product } = state.detail;
  $('#watch-target').value = product.watchCents ? (product.watchCents / 100).toFixed(2) : '';
  $('#watch-target').placeholder = product.fromCents ? (product.fromCents * 0.85 / 100).toFixed(2) : '';
  $('#watch-remove').hidden = !product.watchCents;
  $('#watch-save').textContent = product.watchCents ? 'Update' : 'Set alert';
  $('#watch-status').textContent = product.watchCents
    ? product.fromCents <= product.watchCents ? 'Already at or below; you\'ll be alerted after the next check.' : `Now ${money(product.fromCents)}`
    : '';
}

async function saveWatch(targetCents) {
  const { product } = state.detail;
  const path = `/api/watches/${encodeURIComponent(product.id)}`;
  if (targetCents == null) {
    await api(path, { method: 'DELETE' });
  } else {
    await api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetCents }) });
  }
  product.watchCents = targetCents;
  renderWatch();
  renderProducts({ keepPage: true });
  toast(targetCents == null ? 'Alert removed' : `You'll be alerted at ${money(targetCents)} or less`);
}

function renderDetail() {
  const { product, variants, slots } = state.detail;
  const byId = Object.fromEntries(product.variants.map((v) => [v.id, v]));

  $('#variant-rows').innerHTML = product.variants.map((v) => {
    const slot = slots.get(v.id);
    const full = slots.size >= MAX_PLOTTED && slot == null;
    return `<tr>
      <td><input type="checkbox" data-variant="${escapeHtml(v.id)}" ${slot != null ? 'checked' : ''} ${full ? 'disabled title="Up to 8 at once"' : ''} aria-label="Plot ${escapeHtml(v.title)}"></td>
      <td>${slot != null ? `<span class="swatch" style="background:${seriesColor(slot)}"></span>` : '<span class="swatch"></span>'}${escapeHtml(v.title)}</td>
      <td class="num"><strong>${money(v.priceCents)}</strong>${v.compareAtCents ? `<span class="strike">${money(v.compareAtCents)}</span>` : ''}${unitPrice(v, product.productType) ? `<div class="p-meta" style="justify-content:flex-end">${unitPriceText(v, product.productType)}</div>` : ''}</td>
      <td class="num">${v.withCode ? codePriceHtml(v) : '<span class="muted">–</span>'}</td>
      <td class="num hide-sm">${money(v.firstCents)}</td>
      <td class="num">${deltaHtml(v.changePct)}</td>
      <td class="num hide-sm">${money(v.lowCents)} / ${money(v.highCents)}</td>
      <td class="${v.available ? 'stock-in' : 'stock-out'}">${v.available ? '● In stock' : '○ Sold out'}</td>
    </tr>`;
  }).join('');

  const datasets = variants
    .filter((v) => slots.has(v.id))
    .map((v) => {
      const color = seriesColor(slots.get(v.id));
      return {
        label: byId[v.id]?.title ?? v.title,
        data: v.points.map(([t, p]) => ({ x: t, y: p / 100 })),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        stepped: 'before',
        pointRadius: v.points.length === 1 ? 4 : 0,
        pointHoverRadius: 4,
        pointHoverBorderColor: cssVar('--surface'),
        pointHoverBorderWidth: 2,
      };
    });

  const text2 = cssVar('--text-2');
  const grid = cssVar('--grid');
  if (state.chart) state.chart.destroy();
  state.chart = new Chart($('#detail-chart'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: { type: 'time', grid: { color: grid }, ticks: { color: text2, maxRotation: 0, autoSkipPadding: 24 } },
        y: { grid: { color: grid }, ticks: { color: text2, callback: (v) => `$${v}` }, grace: '10%' },
      },
      plugins: {
        legend: { display: datasets.length > 1, position: 'bottom', labels: { color: text2, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: $${ctx.parsed.y.toFixed(2)}` },
        },
      },
    },
  });
}

/* ---------- alerts dialog ---------- */

const ALL_TYPES = ['Flower', 'Pre-Rolls', 'Vapes', 'Concentrates', 'Edibles', 'Other'];

async function openAlerts() {
  state.alerts = await api('/api/alerts');
  const { settings, discordConfigured, routes } = state.alerts;
  const channels = routes.filter((r) => r.to === 'channel').length;
  $('#alerts-discord').textContent = discordConfigured
    ? `● Discord connected${channels ? ` · ${channels} of ${routes.length} type channels set` : ''}`
    : '○ No Discord webhook set — add discordWebhookUrl or discordWebhooks to config.local.json and restart';
  $('#alerts-discord').className = discordConfigured ? 'stock-in' : 'muted';
  renderRoutes(routes);
  $('#al-enabled').checked = settings.enabled;
  $('#al-pct').value = settings.minDropPct;
  $('#al-dollars').value = settings.minDropCents / 100;
  $('#al-instock').checked = settings.inStockOnly;
  $('#al-new').checked = settings.newItems;
  $('#al-types').innerHTML = ALL_TYPES.map((t) => `<label class="check"><input type="checkbox" value="${t}" ${settings.types.includes(t) ? 'checked' : ''}> ${t}</label>`).join('');
  $('#al-test').disabled = !discordConfigured;
  $('#al-sample').disabled = !discordConfigured;
  renderDrops();
  if (!$('#alerts').open) $('#alerts').showModal();
}

// Where each type's alerts go: its own channel, the default webhook, or nowhere.
function renderRoutes(routes) {
  const el = $('#alerts-routes');
  el.hidden = !routes.some((r) => r.to === 'channel');
  if (el.hidden) return;
  const cell = (r) => ({ channel: '<span class="stock-in">● Own channel</span>', default: '<span class="muted">↪ Default webhook</span>', none: '<span class="muted">○ Not sent</span>' })[r.to];
  const types = [...new Set(routes.map((r) => r.type))];
  el.innerHTML = `<table class="variants"><thead><tr><th>Type</th><th>🆕 New items</th><th>🔥 Sales</th></tr></thead><tbody>${types.map((t) => `<tr><td>${t}</td>${['new', 'sales'].map((k) => `<td>${cell(routes.find((r) => r.type === t && r.kind === k))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderDrops() {
  const stores = Object.fromEntries(state.status.stores.map((s) => [s.id, s.name]));
  const drops = state.alerts.drops.filter((d) => !$('#drops-big').checked || d.big);
  $('#drops-empty').hidden = drops.length > 0;
  $('#drop-rows').innerHTML = drops.map((d) => `<tr>
    <td class="muted">${relTime(d.at)}</td>
    <td><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${escapeHtml(d.title)}</a>
      <div class="p-meta">${d.variant !== 'Default' ? `<span>${escapeHtml(d.variant)}</span>` : ''}<span>${escapeHtml(stores[d.storeId] ?? d.storeId)}</span>${d.newLow ? '<span class="tag sale">Lowest seen</span>' : ''}${d.available ? '' : '<span class="tag">Sold out</span>'}</div></td>
    <td class="num"><strong>${money(d.newCents)}</strong><span class="strike">${money(d.oldCents)}</span></td>
    <td class="num">${deltaHtml(-d.dropPct)}</td>
    <td>${d.notified ? '<span class="sent" title="Sent to Discord">✓ sent</span>' : ''}</td>
  </tr>`).join('');
}

$('#open-alerts').addEventListener('click', () => openAlerts().catch((err) => toast(err.message)));
$('#alerts-close').addEventListener('click', () => $('#alerts').close());
$('#alerts').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#drops-big').addEventListener('change', renderDrops);

$('#alerts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    enabled: $('#al-enabled').checked,
    minDropPct: Number($('#al-pct').value),
    minDropCents: Math.round(Number($('#al-dollars').value) * 100),
    inStockOnly: $('#al-instock').checked,
    newItems: $('#al-new').checked,
    types: [...$('#al-types').querySelectorAll('input:checked')].map((i) => i.value),
  };
  try {
    const { settings } = await api('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    state.alerts.settings = settings;
    await openAlerts();
    toast(settings.enabled ? `Alerting on drops of ${settings.minDropPct}%+` : 'Alerts turned off');
  } catch (err) {
    toast(err.message);
  }
});

for (const [btn, path, done] of [['#al-test', '/api/alerts/test', 'Test alert sent'], ['#al-sample', '/api/alerts/sample', 'Sample drop sent']]) {
  $(btn).addEventListener('click', async () => {
    $(btn).disabled = true;
    try {
      const res = await api(path, { method: 'POST' });
      toast(`${done}${res.channels > 1 ? ` to ${res.channels} channels` : ''} — check Discord`);
    } catch (err) {
      toast(`Failed: ${err.message}`);
    }
    $(btn).disabled = false;
  });
}

$('#watch-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cents = Math.round(Number($('#watch-target').value) * 100);
  if (cents > 0) saveWatch(cents).catch((err) => toast(err.message));
});
$('#watch-remove').addEventListener('click', () => saveWatch(null).catch((err) => toast(err.message)));

/* ---------- wiring ---------- */

$('#product-rows').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) openDetail(row.dataset.id).catch((err) => toast(err.message));
});

$('#variant-rows').addEventListener('change', (e) => {
  const id = e.target.dataset.variant;
  if (!id) return;
  const { slots } = state.detail;
  if (e.target.checked) {
    const used = new Set(slots.values());
    const free = [...Array(MAX_PLOTTED).keys()].find((i) => !used.has(i));
    if (free != null) slots.set(id, free);
  } else {
    slots.delete(id);
  }
  renderDetail();
});

$('#detail-close').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ---------- store picker ---------- */

// Stores are remembered by what's unticked, so stores added later show up by default.
const HIDDEN_STORES_KEY = 'potdrop.hiddenStores';
state.hiddenStores = new Set((() => {
  try { return JSON.parse(localStorage.getItem(HIDDEN_STORES_KEY)) ?? []; } catch { return []; }
})());

function setHiddenStores(ids) {
  state.hiddenStores = new Set(ids);
  try { localStorage.setItem(HIDDEN_STORES_KEY, JSON.stringify([...state.hiddenStores])); } catch { /* private mode */ }
  renderStorePicker();
  renderProducts();
}

function renderStorePicker() {
  const stores = [...state.status.stores].sort((a, b) => a.name.localeCompare(b.name));
  const counts = {};
  for (const p of state.products) counts[p.storeId] = (counts[p.storeId] ?? 0) + 1;
  const shown = stores.filter((s) => !state.hiddenStores.has(s.id));
  $('#store-summary').textContent = shown.length === stores.length ? 'All stores'
    : shown.length === 0 ? 'No stores'
      : shown.length === 1 ? shown[0].name
        : `${shown.length} of ${stores.length} stores`;
  const q = $('#store-search').value.trim().toLowerCase();
  $('#store-list').innerHTML = stores.filter((s) => !q || s.name.toLowerCase().includes(q)).map((s) => `
    <label class="multi-row">
      <input type="checkbox" value="${escapeHtml(s.id)}" ${state.hiddenStores.has(s.id) ? '' : 'checked'}>
      <span class="name">${escapeHtml(s.name)}</span>
      <button type="button" class="only" data-only="${escapeHtml(s.id)}" title="Show only this store">only</button>
      <span class="n">${(counts[s.id] ?? 0).toLocaleString()}</span>
    </label>`).join('') || '<p class="muted hint">No stores match.</p>';
}

const allStoreIds = () => state.status.stores.map((s) => s.id);
$('#store-list').addEventListener('change', (e) => {
  const next = new Set(state.hiddenStores);
  if (e.target.checked) next.delete(e.target.value); else next.add(e.target.value);
  setHiddenStores(next);
});
$('#store-list').addEventListener('click', (e) => {
  const only = e.target.closest('[data-only]')?.dataset.only;
  if (!only) return;
  e.preventDefault(); // don't also toggle the row's checkbox
  setHiddenStores(allStoreIds().filter((id) => id !== only));
});
$('#stores-all').addEventListener('click', () => setHiddenStores([]));
$('#stores-none').addEventListener('click', () => setHiddenStores(allStoreIds()));
$('#stores-invert').addEventListener('click', () => setHiddenStores(allStoreIds().filter((id) => !state.hiddenStores.has(id))));
$('#store-search').addEventListener('input', renderStorePicker);
// Close on an outside click or Escape, like a native dropdown.
document.addEventListener('click', (e) => {
  if ($('#store-picker').open && !$('#store-picker').contains(e.target)) $('#store-picker').open = false;
});
$('#store-picker').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#store-picker').open = false; $('#store-summary').focus(); }
});

fillSizeOptions();
fillPotencyOptions();
// Before the re-render below: sizes and potency steps depend on the type.
$('#filter-type').addEventListener('input', () => { fillSizeOptions(); fillPotencyOptions(); });
for (const sel of ['#search', '#filter-type', '#filter-size', '#filter-potency', '#filter-strain', '#filter-grow', '#filter-coa', '#sort', '#filter-instock']) {
  $(sel).addEventListener('input', () => renderProducts());
}

$('#show-more').addEventListener('click', () => {
  state.shown += PAGE_SIZE;
  renderProducts({ keepPage: true });
});

$('#interval').addEventListener('change', async (e) => {
  let minutes = e.target.value;
  if (minutes === 'custom') {
    minutes = prompt('Check every how many minutes? (minimum 5)', state.status.intervalMinutes);
    if (!minutes) return renderStatus();
  }
  try {
    const res = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalMinutes: Number(minutes) }) });
    Object.assign(state.status, res);
    renderStatus();
    toast(`Checking every ${res.intervalMinutes} minutes`);
  } catch (err) {
    toast(err.message);
    renderStatus();
  }
});

$('#scrape-now').addEventListener('click', async () => {
  $('#scrape-now').disabled = true;
  $('#stat-last').textContent = 'Checking…';
  try {
    const results = await api('/api/scrape', { method: 'POST' });
    const failed = Object.values(results).filter((r) => !r.ok);
    toast(failed.length ? `Check failed: ${failed[0].error}` : 'Prices updated');
  } catch (err) {
    toast(err.message);
  }
  await refresh();
});

if (STATIC) {
  // There's no Checks page in the published copy.
  const tile = $('.tile-link');
  tile.removeAttribute('href');
  tile.removeAttribute('title');
  tile.querySelector('.tile-label').textContent = 'Last check';
}
refresh().catch((err) => toast(err.message));
// The product list is several MB and stores are checked one by one all the
// time, so poll status and reload products only when a check found changes,
// at most every 5 minutes.
const RELOAD_EVERY_MS = 5 * 60_000;
setInterval(async () => {
  try {
    const status = await api('/api/status');
    if (status.dataVersion !== state.status.dataVersion && Date.now() - (state.loadedAt ?? 0) >= RELOAD_EVERY_MS) {
      return await refresh();
    }
    // Keep the version products were loaded at, so a skipped reload happens on a later poll.
    state.status = { ...status, dataVersion: state.status.dataVersion };
    renderStatus();
  } catch {}
}, 60_000);
