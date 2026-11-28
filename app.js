const $ = (sel) => document.querySelector(sel);
const MAX_PLOTTED = 8; // one per categorical color slot
const PAGE_SIZE = 100;
const NEW_MS = 48 * 3600_000;

const state = { products: [], status: null, detail: null, chart: null };

const money = (cents) => (cents == null ? '–'
  : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
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
function thumbUrl(src, width = 96) {
  if (!src.includes('cdn.shopify.com')) return src;
  const url = new URL(src);
  url.searchParams.set('width', String(width));
  return url.href;
}

// "💸 $115.80 w/ first30 (first order)" under a price.
function codePriceHtml(v) {
  const c = v.withCode;
  return `<div class="code-price" title="${c.firstOrder ? 'First-order code' : 'Discount code'}${v.withGeneralCode ? ` · anyone: ${money(v.withGeneralCode.cents)} with ${v.withGeneralCode.code}` : ''}">
    💸 ${money(c.cents)} w/ <strong>${escapeHtml(c.code)}</strong>${c.firstOrder ? ' <span class="first">(first order)</span>' : ''}</div>`;
}

// Generic photos of each product type (Unsplash, free to use), shown with
// "Stock image" over them when a product has no photo of its own or its store
// won't let other sites show it. If the stock photo can't load either, a drawn
// leaf under it shows instead.
const STOCK_PHOTOS = {
  Flower: 'photo-1518465444133-93542d08fdd9',
  'Pre-Rolls': 'photo-1605570382235-7a873a20469e',
  Vapes: 'photo-1599177749654-b8f5fe0b016a',
  Concentrates: 'photo-1598052162874-e41952203254',
  Edibles: 'photo-1629398777962-33db7538a357',
  Other: 'photo-1625249011101-fd3947e09343',
};
const LEAF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21c0-9 6-15 15-16-1 9-7 15-15 16z"/><path d="M5 21 14 12"/></svg>';
function stockImage(type, width = 360) {
  const photo = STOCK_PHOTOS[type] ?? STOCK_PHOTOS.Other;
  return `<div class="stock-img" title="Stock image: there's no photo of this product we can show">${LEAF_ICON}`
    + `<img src="https://images.unsplash.com/${photo}?w=${width}&q=70&auto=format&fit=crop" alt="" loading="lazy" data-stock-photo>`
    + '<span class="stock-label">Stock image</span></div>';
}

// Some stores block hotlinked images: swap in the stock photo of the product's type.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if ('stockPhoto' in img.dataset) img.remove();
  else if (img.dataset.stock != null) img.outerHTML = stockImage(img.dataset.stock);
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

// An option's regular price: the store's "was" price, or the first price we saw if that's higher.
const regularCents = (v) => Math.max(v.compareAtCents ?? 0, v.firstCents ?? 0);
// How far below it the option is now, as a fraction (0 when it isn't).
const offOf = (v) => {
  const regular = regularCents(v);
  return regular > v.priceCents ? 1 - v.priceCents / regular : 0;
};

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
  const deal = pool.reduce((a, b) => (offOf(b) > offOf(a) ? b : a)); // the biggest discount
  return {
    cheapest,
    deal,
    offPct: offOf(deal) * 100,
    hasCode: pool.some((v) => v.withCode),
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

// A size bucket of a type, as { field, min, max }, or null for all sizes.
function sizeBucket(type, value) {
  const scheme = sizeScheme(type);
  const bucket = value === '' || value == null ? null : scheme?.buckets[Number(value)]; // '' is "All sizes", not bucket 0
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

// What the list shows, as plain values: what a shared link or a browser alert saves.
// Keys besides q (the search) and hidden (unticked store ids) are in VIEW_FIELDS.
// A saved view can name its stores as `only` (the ticked ones) instead, so a
// store added later isn't in an "only these stores" view.
function currentView() {
  return {
    q: $('#search').value.trim(),
    ...Object.fromEntries(Object.entries(VIEW_FIELDS).map(([key, sel]) => [key, controlValue(sel)])),
    hidden: [...state.hiddenStores],
  };
}

// A test for whether a view shows a product: its row's prices when it does, else null.
function viewMatcher(view) {
  const q = (view.q ?? '').toLowerCase();
  const hidden = new Set(view.hidden ?? []);
  const only = view.only && new Set(view.only);
  const { type, strain, grow, coa: coaOnly, instock: inStockOnly, code: codeOnly } = view;
  const size = sizeBucket(type, view.size);
  const minPotency = Number(view.potency) || 0;
  const minOff = Number(view.discount) || 0;
  return (p) => {
    if (hidden.has(p.storeId) || (only && !only.has(p.storeId))) return null;
    if (type && (p.productType ?? 'Other') !== type) return null;
    if (inStockOnly && (!p.inStock || p.delisted)) return null;
    if (minPotency && !(p.thcaPct >= minPotency)) return null;
    // Lower-case choices include the leaning hybrids ("indica" = Indica + Indica-leaning).
    if (strain && (strain === strain.toLowerCase() ? !p.strainType?.toLowerCase().startsWith(strain) : p.strainType !== strain)) return null;
    if (grow && p.grow !== grow) return null;
    if (coaOnly && !p.coaUrl) return null;
    if (q && !p.title.toLowerCase().includes(q) && !p.variants.some((v) => v.title.toLowerCase().includes(q))) return null;
    const pv = productView(p, size, inStockOnly);
    // Rounded like the card's badge, so a "−30%" card is in "30%+ off".
    if (!pv || (minOff && Math.round(pv.offPct) < minOff) || (codeOnly && !pv.hasCode)) return null;
    return pv;
  };
}

const SORTERS = {
  // Products without a discount follow, cheapest first.
  discount: (a, b) => b.view.offPct - a.view.offPct || a.view.fromCents - b.view.fromCents,
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

function filtered() {
  const { sort, ...view } = currentView();
  const match = viewMatcher(view);
  const list = state.products.filter((p) => {
    p.view = match(p);
    return p.view != null;
  });
  return list.sort(SORTERS[sort]);
}

// The Saved tab: every saved product whatever the filters, except a typed search.
function savedList() {
  const ids = savedSet();
  const q = $('#search').value.trim().toLowerCase();
  const list = state.products.filter((p) => ids.has(p.id) && (!q || p.title.toLowerCase().includes(q)));
  for (const p of list) p.view = productView(p, null, false);
  return list.sort(SORTERS[$('#sort').value]);
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
  if (p.backAt && p.addedAt === p.backAt) {
    return `<span title="When this option came back into stock in its grab bag">Back ${centralTime(p.backAt)}</span>`;
  }
  if (p.addedAt) {
    const source = p.listedAt ? 'When the store listed it' : 'When The Pot Drop first saw it listed';
    return `<span title="${source}">Listed ${centralTime(p.addedAt)}</span>`;
  }
  return `<span title="Already listed when we started tracking this store">Listed before ${centralTime(state.storeStart[p.storeId])}</span>`;
}

// The list's heading follows the sort.
const SORT_TITLES = {
  discount: 'Biggest discounts', drop: 'Biggest drops since tracking', 'price-asc': 'Lowest prices',
  'code-asc': 'Lowest prices with a code', 'unit-asc': 'Lowest price per gram', 'value-asc': 'Lowest price per gram of THCa',
  'potency-desc': 'Most potent', 'price-desc': 'Highest prices', 'newest-drop': 'Latest price drops',
  newest: 'Newest listings', 'top-rated': 'Top rated', 'most-reviewed': 'Most reviewed', name: 'All products, A to Z',
};
const BOOKMARK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';

// One product as a card: its photo with the discount (or New, Back, Sold out),
// the title, then store, size, potency and strain, then the price. Sorted by
// discount, it's priced from its most discounted option; otherwise its cheapest.
function dealCard(p, sort, saved) {
  const v = sort === 'discount' ? p.view.deal : p.view.cheapest;
  const off = Math.round(offOf(v) * 100);
  const isNew = Date.now() - p.firstSeen < NEW_MS && p.firstSeen - state.storeStart[p.storeId] > 3600_000;
  const isBack = !isNew && p.inStock && Date.now() - (p.backAt ?? 0) < NEW_MS;
  const out = p.delisted ? 'Delisted' : !p.inStock ? 'Sold out' : '';
  const badge = out ? `<span class="deal-badge out">${out}</span>`
    : off >= 1 ? `<span class="deal-badge" title="Below its regular price of ${money(regularCents(v))}">−${off}%</span>`
      : isNew ? '<span class="deal-badge new">New</span>'
        : isBack ? '<span class="deal-badge new" title="Back in stock">Back</span>' : '';
  const type = p.productType ?? 'Other';
  const media = p.image
    ? `<img class="deal-img" loading="lazy" src="${escapeHtml(thumbUrl(p.image, 360))}" alt="" data-stock="${escapeHtml(type)}">`
    : stockImage(type);
  const brand = brandOf(p);
  const meta = [
    state.status?.stores.length > 1 ? escapeHtml(p.storeName) : '',
    brand ? `by ${escapeHtml(brand)}` : '',
    v.title !== 'Default' ? escapeHtml(v.title) : '',
    p.thcaPct != null ? escapeHtml(potencyText(p)) : '',
    p.strainType ? escapeHtml(p.strainType) : '',
    $('#filter-type').value ? '' : escapeHtml(type),
    ratingHtml(p),
  ].filter(Boolean).join(' · ');
  const context = [
    sort === 'newest' ? addedHtml(p) : '',
    (sort === 'newest-drop' || sort === 'drop') && p.lastDrop ? droppedHtml(p.lastDrop) : '',
    p.watchCents ? `<span class="tag new" title="Alert set">🎯 ${money(p.watchCents)}</span>` : '',
  ].join('');
  const unit = sort === 'value-asc' && Number.isFinite(p.view.valueCents)
    ? `<span title="Price per gram of THCa at the listed potency">${money(p.view.valueCents)}/g THCa</span>`
    : unitPriceText(v, p.productType);
  return `<article class="deal${out ? ' out' : ''}" data-id="${escapeHtml(p.id)}">
    <div class="deal-media">${media}${badge}</div>
    <button type="button" class="deal-save" data-save="${escapeHtml(p.id)}" aria-pressed="${saved.has(p.id)}" aria-label="Save ${escapeHtml(p.title)}" title="Save">${BOOKMARK_ICON}</button>
    <div class="deal-body">
      <h3 class="deal-title"><button type="button" class="deal-open">${escapeHtml(p.title)}</button></h3>
      ${meta ? `<div class="deal-meta">${meta}</div>` : ''}
      ${context ? `<div class="deal-context">${context}</div>` : ''}
      <div class="deal-price"><strong>${money(v.priceCents)}</strong>${off >= 1 ? `<s>${money(regularCents(v))}</s>` : ''}${unit ? `<span class="deal-unit">${unit}</span>` : ''}</div>
      ${v.withCode ? codePriceHtml(v) : ''}
    </div>
  </article>`;
}

function renderProducts({ keepPage = false } = {}) {
  if (!keepPage) state.shown = PAGE_SIZE;
  $('#sheet-reset').disabled = !filtersActive();
  syncUrl();
  const sort = $('#sort').value;
  const saved = state.view === 'saved';
  const all = saved ? savedList() : filtered();
  const rows = all.slice(0, state.shown);
  $('#empty').textContent = saved ? 'Nothing saved yet. Tap the bookmark on any product to keep it here.' : 'No products match.';
  $('#empty').hidden = all.length > 0;
  const more = $('#show-more');
  more.hidden = all.length <= rows.length;
  more.textContent = `Show more (${(all.length - rows.length).toLocaleString()} left)`;
  const count = `${all.length.toLocaleString()} product${all.length === 1 ? '' : 's'}`;
  $('#result-count').textContent = count;
  $('#sheet-done').textContent = `Show ${count}`;
  const view = state.view;
  $('#feed-title').textContent = view === 'alerts' ? 'Alerts' : saved ? 'Saved' : SORT_TITLES[sort] ?? 'Products';
  $('#feed-sub').hidden = view !== 'deals';
  $('#view-sub').hidden = view === 'deals';
  $('#view-sub').textContent = view === 'alerts' ? 'Hear about new listings and price drops in what you filter'
    : `${count} · kept in this browser`;
  if (view === 'alerts') renderAlertsView();
  renderFilterChips();
  const savedIds = savedSet();
  $('#product-rows').innerHTML = rows.map((p) => dealCard(p, sort, savedIds)).join('');
}

// The heading's summary and the footer's totals.
function renderTiles() {
  const live = state.products.filter((p) => !p.delisted);
  const variants = live.flatMap((p) => p.variants);
  const dropped = variants.filter((v) => v.priceCents < v.firstCents);
  $('#stat-products').textContent = live.length.toLocaleString();
  $('#stat-instock').textContent = live.filter((p) => p.inStock).length.toLocaleString();
  $('#stat-stores').textContent = state.status.stores.length.toLocaleString();

  // On sale: in-stock options below their regular price (the store's own "was"
  // price, or the first price we saw if that's higher). Most sales were already
  // running when we started tracking a store, so drops since tracking alone
  // undercount them several times over.
  const sale = live.filter((p) => p.inStock).flatMap((p) => p.variants
    .filter((v) => v.available && offOf(v) > 0)
    .map((v) => ({ p, off: offOf(v) })));
  $('#stat-sale').textContent = new Set(sale.map((s) => s.p.id)).size.toLocaleString();
  $('#stat-sale-stores').textContent = new Set(sale.map((s) => s.p.storeId)).size.toLocaleString();
  $('#stat-sale-avg').textContent = sale.length
    ? ` · avg ${Math.round((sale.reduce((sum, s) => sum + s.off, 0) / sale.length) * 100)}% off`
    : '';
  $('#feed-sub').title = 'In-stock products priced below their regular price: the store shows a "was" price, '
    + `or it's cheaper than when we started tracking it. ${dropped.length.toLocaleString()} options have dropped since tracking.`;
}

function renderStatus() {
  const s = state.status;
  // A bare "YYYY-MM-DD" means local midnight; full timestamps are used as-is.
  const ban = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s.banDate) ? `${s.banDate}T00:00:00` : s.banDate);
  const days = Math.max(0, Math.ceil((ban - Date.now()) / 86400_000));
  $('#countdown').textContent = `${days} day${days === 1 ? '' : 's'}`;
  $('#stat-ban').title = `The ban takes effect ${ban.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const lastOk = Math.max(0, ...s.runs.filter((r) => r.status === 'ok').map((r) => r.started_at));
  const failed = s.runs.filter((r) => r.status === 'error');
  const names = Object.fromEntries(s.stores.map((st) => [st.id, st.name]));
  $('#stat-last').textContent = s.running ? 'checking all stores now' : lastOk ? `checked ${relTime(lastOk)}` : 'not checked yet';
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
  $('#store-field').hidden = state.status.stores.length < 2;
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
  // A grab bag strain coming back into stock counts as listed again, so it sorts with new listings.
  for (const p of products) if (p.backAt && p.backAt > (p.addedAt ?? 0)) p.addedAt = p.backAt;
  // Brands only mean something at stores that sell other companies' products.
  // Elsewhere the "brand" is the store's own or legal name, or a supplier field
  // ("Gold Standard Wholesale", "Printify"), so it takes several to count.
  const brandsByStore = {};
  for (const p of products) if (p.brand && !ownBrand(p)) (brandsByStore[p.storeId] ??= new Set()).add(p.brand);
  state.multiBrand = new Set(Object.keys(brandsByStore).filter((id) => brandsByStore[id].size >= 4));
  fillFilterOptions();
  if (!state.filtersRestored) {
    // A shared link's view wins over this browser's saved one. Both need the type options filled above.
    const shared = viewFromQuery(location.search);
    if (shared) applyView(shared);
    else applyFilters(savedFilters());
    state.filtersRestored = true;
  }
  renderStatus();
  renderTiles();
  renderProducts({ keepPage: state.shown != null }); // background refreshes keep "Show more" progress
  checkBrowserAlerts();
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

  state.detail = { product, variants, slots, stock: history.stock };
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
  $('#detail-media').href = product.url;
  $('#detail-media').title = `View on ${product.storeName} ↗`;
  $('#detail-media').setAttribute('aria-label', `View on ${product.storeName}`);
  const type = product.productType ?? 'Other';
  $('#detail-media').innerHTML = product.image
    ? `<img src="${escapeHtml(thumbUrl(product.image, 480))}" alt="" data-stock="${escapeHtml(type)}">`
    : stockImage(type, 480);
  renderDetailSave();
  $('#detail-coa').hidden = !product.coaUrl;
  if (product.coaUrl) $('#detail-coa').href = product.coaUrl;
  $('#detail-hint').textContent = product.variants.length > MAX_PLOTTED
    ? `Showing ${MAX_PLOTTED} of ${product.variants.length} options — tick boxes below to choose which are plotted.`
    : '';
  renderWatch();
  renderCodes(product);
  renderDetail();
  $('#detail').showModal();
  renderStock(); // after opening: the date labels are spaced by the timeline's width
}

const SOURCE_LABEL = { franklist: 'via Franklist', homepage: 'on the store\'s homepage now', banner: 'in a banner image on the store\'s homepage now', site: 'from the store\'s site', manual: 'added by you', web: 'found online, unverified' };
const OFFER_LABEL = { sale: '🏷 Sale on the site', signup: '✉ Sign-up offer' };

// A code's main catch in a word or two, for its button ("1st order", "not on sale").
const SHORT_NOTES = [
  [/^First order/, '1st order'], [/^One-time/, 'one-time'], [/^Not valid on sale/, 'not on sale'],
  [/^Select items/, 'select items'], [/^Min (\S+)/, 'min $1'], [/^Unverified/, 'unverified'],
];
function shortNote(notes) {
  for (const note of notes) {
    const hit = SHORT_NOTES.find(([re]) => re.test(note));
    if (hit) return note.match(hit[0])[0].replace(hit[0], hit[1]);
  }
  return '';
}

// The store's codes as one row of buttons that copy them; Details shows each one's conditions and source.
function renderCodes(product) {
  const codes = state.status.codes?.[product.storeId] ?? [];
  const offers = state.status.offers?.[product.storeId] ?? [];
  const box = $('#detail-codes');
  box.hidden = !codes.length && !offers.length;
  if (box.hidden) return;
  const expanded = !!state.codesExpanded;
  const pills = [
    ...codes.map((c) => {
      const value = c.percentOff ? `${c.percentOff}% off` : c.amountOffCents ? `${money(c.amountOffCents)} off` : '';
      const note = shortNote(c.notes);
      const about = [c.notes.length ? c.notes.join(' · ') : 'Anyone, sitewide', SOURCE_LABEL[c.source] ?? c.source].join(' · ');
      // Always four parts, so a wide screen can line them up in columns (styles.css).
      return `<button type="button" class="code-pill" data-copy="${escapeHtml(c.code)}" title="${escapeHtml(`Copy ${c.code}: ${about}`)}"><strong>${escapeHtml(c.code)}</strong><span>${value}</span><span class="muted">${escapeHtml(note)}</span><span class="copy" aria-hidden="true">⧉</span></button>`;
    }),
    ...offers.map((o) => {
      const pct = o.description.match(/(\d+)\s*%\s*off/i)?.[1];
      const label = o.kind === 'sale' ? '🏷 Site sale' : '✉ Sign-up';
      return `<span class="code-pill offer" title="${escapeHtml(o.description)}"><strong>${label}</strong><span>${pct ? `${pct}% off` : ''}</span><span></span><span></span></span>`;
    }),
  ];
  const offerChips = offers.map((o) => `<div class="code-chip offer">
      <strong>${OFFER_LABEL[o.kind] ?? OFFER_LABEL.signup}</strong>
      <span class="muted">${escapeHtml(o.description)}</span>
      ${o.sourceUrl ? `<a class="muted" href="${escapeHtml(o.sourceUrl)}" target="_blank" rel="noopener">on the store's site ↗</a>` : ''}
    </div>`).join('');
  box.innerHTML = `<div class="codes-head">
      <h3>Codes at ${escapeHtml(product.storeName)}</h3>
      <button type="button" class="link-btn" data-codes-details aria-expanded="${expanded}">${expanded ? 'Less' : 'Details'}</button>
    </div>
    <div class="code-row"${expanded ? ' hidden' : ''}>${pills.join('')}</div>
    <div class="code-list"${expanded ? '' : ' hidden'}>${offerChips}${codes.map((c) => {
      const value = c.percentOff ? `${c.percentOff}% off` : c.amountOffCents ? `${money(c.amountOffCents)} off` : '';
      const notes = c.notes.length ? c.notes.join(' · ') : 'Anyone, sitewide';
      return `<div class="code-chip">
        <button type="button" data-copy="${escapeHtml(c.code)}" title="Copy code"><strong>${escapeHtml(c.code)}</strong>${value ? ` · ${value}` : ''} ⧉</button>
        <span class="muted">${escapeHtml(notes)}</span>
        ${c.source === 'homepage' && c.description ? `<span class="muted banner-quote">“${escapeHtml(c.description)}”</span>` : ''}
        ${c.source === 'banner' && c.description ? `<span class="muted banner-quote">${escapeHtml(c.description)}</span>` : ''}
        <span class="muted">${escapeHtml(SOURCE_LABEL[c.source] ?? c.source)}</span>
      </div>`;
    }).join('')}</div>`;
}

$('#detail-codes').addEventListener('click', async (e) => {
  if (e.target.closest('[data-codes-details]')) {
    state.codesExpanded = !state.codesExpanded; // kept for the next product
    renderCodes(state.detail.product);
    return;
  }
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
    // Cells are named so a phone can lay each option out as a card (styles.css).
    return `<tr>
      <td class="v-plot"><input type="checkbox" data-variant="${escapeHtml(v.id)}" ${slot != null ? 'checked' : ''} ${full ? 'disabled title="Up to 8 at once"' : ''} aria-label="Plot ${escapeHtml(v.title)}"></td>
      <td class="v-name">${slot != null ? `<span class="swatch" style="background:${seriesColor(slot)}"></span>` : '<span class="swatch"></span>'}${escapeHtml(v.title)}</td>
      <td class="num v-price"><strong>${money(v.priceCents)}</strong>${v.compareAtCents ? `<span class="strike">${money(v.compareAtCents)}</span>` : ''}${unitPrice(v, product.productType) ? `<div class="p-meta end">${unitPriceText(v, product.productType)}</div>` : ''}</td>
      <td class="num v-code${v.withCode ? '' : ' none'}">${v.withCode ? codePriceHtml(v) : '<span class="muted">–</span>'}</td>
      <td class="num hide-sm">${money(v.firstCents)}</td>
      <td class="num v-change">${deltaHtml(v.changePct)}</td>
      <td class="num hide-sm">${money(v.lowCents)} / ${money(v.highCents)}</td>
      <td class="v-stock ${v.available ? 'stock-in' : 'stock-out'}">${v.available ? '● In stock' : '○ Sold out'}</td>
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
        legend: { display: false }, // drawn as HTML below the chart (renderLegend)
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: $${ctx.parsed.y.toFixed(2)}` },
        },
      },
    },
  });
  renderLegend(datasets);
}

// The chart's key as HTML under it, so long option names wrap or shorten
// instead of running off a phone's screen and squeezing the plot. Tapping an
// option hides or shows its line, as the chart's own key did.
function renderLegend(datasets) {
  const el = $('#detail-legend');
  el.hidden = datasets.length < 2;
  el.innerHTML = datasets.map((d, i) => `<li><button type="button" class="legend-item" data-series="${i}" aria-pressed="true" title="${escapeHtml(d.label)}">
    <span class="swatch" style="background:${d.borderColor}"></span><span class="legend-name">${escapeHtml(d.label)}</span>
  </button></li>`).join('');
}

$('#detail-legend').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-series]');
  if (!btn || !state.chart) return;
  const i = Number(btn.dataset.series);
  const show = !state.chart.isDatasetVisible(i);
  state.chart.setDatasetVisibility(i, show);
  state.chart.update();
  btn.setAttribute('aria-pressed', String(show));
});

/* ---------- stock timeline (detail dialog) ---------- */

const DAY_MS = 86400_000;
const MAX_STOCK_OPTIONS = 8; // option rows before "Show all" (some grab bags list 90+)
const STOCK_STATES = { in: 'In stock', out: 'Sold out', gone: 'Off the site' };
// YYYY-MM-DD in US Central, and that day's midnight there (06:00 UTC in standard time, 05:00 in daylight time).
const centralDay = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format;
const utcDay = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d); };
function centralMidnight(key) {
  const t = utcDay(key) + 6 * 3600_000;
  return centralDay(t - 3600_000) === key ? t - 3600_000 : t;
}
function spanLength(ms) {
  if (ms < 3600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 23.5 * 3600_000) return `${Math.round(ms / 3600_000)} h`;
  const d = ms / DAY_MS;
  return `${d.toFixed(d < 10 ? 1 : 0)} d`;
}
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
// A share that's neither none nor all never rounds to 0% or 100% ("in stock 0% of the time" while in stock now).
const sharePct = (f) => (f < 0.005 ? 'under 1%' : f > 0.995 ? 'over 99%' : `${Math.round(f * 100)}%`);

// An option's stock from its price history, which has a point at each change.
function optionSpans(points, from, to) {
  const spans = [];
  points.forEach(([t, , , available], i) => {
    const a = Math.max(t, from);
    const b = Math.min(points[i + 1]?.[0] ?? to, to);
    const state = available ? 'in' : 'out';
    const last = spans.at(-1);
    if (last?.[2] === state && last[1] === a) last[1] = b;
    else if (b > a) spans.push([a, b, state]);
  });
  return spans;
}

// While the product was off the site, so were its options.
function markGone(spans, gone) {
  for (const [ga, gb] of gone) {
    spans = spans.flatMap(([a, b, s]) => (b <= ga || a >= gb ? [[a, b, s]] : [
      ...(a < ga ? [[a, ga, s]] : []),
      [Math.max(a, ga), Math.min(b, gb), 'gone'],
      ...(b > gb ? [[gb, b, s]] : []),
    ]));
  }
  return spans;
}

// "Sold out now · in stock 64% of the time since Nov 3 · sold out twice, restocked once"
function stockSummary(spans, from) {
  let inMs = 0;
  let knownMs = 0;
  let soldOut = 0;
  let restocked = 0;
  spans.forEach(([a, b, s], i) => {
    if (s !== 'gone') knownMs += b - a;
    if (s === 'in') inMs += b - a;
    const prev = spans[i - 1]?.[2];
    if (prev === 'in' && s === 'out') soldOut++;
    if (prev === 'out' && s === 'in') restocked++;
  });
  const since = new Date(from).toLocaleDateString('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric' });
  const share = !knownMs ? '' : inMs === knownMs ? `in stock the whole time since ${since}`
    : !inMs ? `sold out the whole time since ${since}`
      : `in stock ${sharePct(inMs / knownMs)} of the time since ${since}`;
  const moves = [soldOut && `sold out ${times(soldOut)}`, restocked && `restocked ${times(restocked)}`].filter(Boolean).join(', ');
  return [`${STOCK_STATES[spans.at(-1)[2]]} now`, share, moves].filter(Boolean).join(' · ');
}

// The product's stock over its whole history, then each option's when it has several.
function renderStock() {
  const { product, variants, stock } = state.detail;
  const box = $('#detail-stock');
  box.hidden = !stock?.spans?.length;
  if (box.hidden) return;
  const { from, to } = stock;
  const width = Math.max(to - from, 1);
  const pct = (ms) => `${((ms / width) * 100).toFixed(3)}%`;
  const titles = Object.fromEntries(product.variants.map((v) => [v.id, v.title]));
  const gone = stock.spans.filter((s) => s[2] === 'gone');
  const options = variants.length > 1 ? variants : [];
  const shown = state.detail.allOptions ? options : options.slice(0, MAX_STOCK_OPTIONS);
  const rows = [{ label: options.length ? 'Overall' : 'This product', spans: stock.spans, overall: true }];
  for (const v of shown) rows.push({ label: titles[v.id] ?? v.title, spans: markGone(optionSpans(v.points, from, to), gone) });
  const more = $('#detail-stock-more');
  more.hidden = options.length <= MAX_STOCK_OPTIONS;
  more.textContent = state.detail.allOptions ? `Show the first ${MAX_STOCK_OPTIONS} options` : `Show all ${options.length} options`;

  // A line at each US Central midnight (only the labelled ones past a month), labels at least ~48px apart.
  const tl = $('#detail-tl');
  const trackPx = Math.max((tl.clientWidth || 600) - (parseFloat(getComputedStyle(tl).getPropertyValue('--tl-label')) || 160) - 36, 100);
  const spanDays = width / DAY_MS;
  const every = [1, 2, 3, 7, 14, 30].find((n) => (n * trackPx) / spanDays >= 48) ?? 30;
  const ticks = [];
  for (let i = 1, start = utcDay(centralDay(from)); ; i++) {
    const key = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const at = centralMidnight(key);
    if (at >= to) break;
    const label = i % every === 0 ? new Date(utcDay(key)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '';
    if (label || spanDays <= 31) ticks.push({ at, label });
  }
  const labelled = ticks.filter((k) => k.label);
  const tip = (label, [a, b, s]) => `${label} · ${STOCK_STATES[s]}: ${centralTime(a)} → ${b >= to - 60_000 ? 'now' : centralTime(b)} (${spanLength(b - a)})`;

  tl.innerHTML = `
    <div class="tl-lines" aria-hidden="true">${ticks.map((k) => `<i style="left:${pct(k.at - from)}"></i>`).join('')}</div>
    ${labelled.length ? `<div class="tl-row tl-axis" aria-hidden="true"><div class="tl-label"></div><div class="tl-track">
      ${labelled.map((k) => `<span class="tl-tick" style="left:${pct(k.at - from)}">${k.label}</span>`).join('')}
    </div></div>` : ''}
    ${rows.map((r) => `<div class="tl-row${r.overall ? ' tl-overall' : ''}">
      <div class="tl-label"><span class="tl-name" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span></div>
      <div class="tl-track">${r.spans.map((span) => `<span class="tl-seg seg-${span[2]}" style="left:${pct(span[0] - from)};width:${pct(span[1] - span[0])}"
        data-tip="${escapeHtml(tip(r.label, span))}"></span>`).join('')}</div>
    </div>`).join('')}`;
  state.detail.stockNote = stockSummary(stock.spans, from);
  $('#detail-stock-note').textContent = state.detail.stockNote;
}

// Pointing at (or tapping) a stretch says when it began and ended; moving the mouse away goes back to the summary.
$('#detail-tl').addEventListener('pointerover', (e) => {
  const tip = e.target.closest('.tl-seg')?.dataset.tip;
  if (tip) $('#detail-stock-note').textContent = tip;
});
$('#detail-tl').addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse') $('#detail-stock-note').textContent = state.detail?.stockNote ?? '';
});
$('#detail-stock-more').addEventListener('click', () => {
  state.detail.allOptions = !state.detail.allOptions;
  renderStock();
});
window.addEventListener('resize', () => { if ($('#detail').open && state.detail) renderStock(); });

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
    <td class="muted" data-label="When">${relTime(d.at)}</td>
    <td class="stack-title"><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${escapeHtml(d.title)}</a>
      <div class="p-meta">${d.variant !== 'Default' ? `<span>${escapeHtml(d.variant)}</span>` : ''}<span>${escapeHtml(stores[d.storeId] ?? d.storeId)}</span>${d.newLow ? '<span class="tag sale">Lowest seen</span>' : ''}${d.available ? '' : '<span class="tag">Sold out</span>'}</div></td>
    <td class="num" data-label="Price"><strong>${money(d.newCents)}</strong><span class="strike">${money(d.oldCents)}</span></td>
    <td class="num" data-label="Drop">${deltaHtml(-d.dropPct)}</td>
    <td class="stack-end">${d.notified ? '<span class="sent" title="Sent to Discord">✓ sent</span>' : ''}</td>
  </tr>`).join('');
}

$('#open-alerts').addEventListener('click', () => openAlerts().catch((err) => toast(err.message)));
$('#alerts-close').addEventListener('click', () => $('#alerts').close());
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
  const save = e.target.closest('[data-save]');
  if (save) return toggleSaved(save.dataset.save);
  const card = e.target.closest('.deal[data-id]');
  if (card) openDetail(card.dataset.id).catch((err) => toast(err.message));
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
$('#detail-save').addEventListener('click', () => toggleSaved(state.detail.product.id));

/* ---------- store picker ---------- */

// Stores are remembered by what's unticked, so stores added later show up by default.
const HIDDEN_STORES_KEY = 'potdrop.hiddenStores';
state.hiddenStores = new Set((() => {
  try { return JSON.parse(localStorage.getItem(HIDDEN_STORES_KEY)) ?? []; } catch { return []; }
})());

function rememberHiddenStores(ids) {
  state.hiddenStores = new Set(ids);
  try { localStorage.setItem(HIDDEN_STORES_KEY, JSON.stringify([...state.hiddenStores])); } catch { /* private mode */ }
}

function setHiddenStores(ids) {
  rememberHiddenStores(ids);
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
  if (e.key !== 'Escape' || !$('#store-picker').open) return;
  e.stopPropagation(); // just the picker, not the filter sheet around it
  $('#store-picker').open = false;
  $('#store-summary').focus();
});

// Filters and sort are remembered in this browser between visits (typed
// searches aren't). Type comes first: the size and potency menus depend on it.
const FILTERS_KEY = 'potdrop.filters';
const FILTER_DEFAULTS = {
  '#filter-type': '', '#filter-size': '', '#filter-potency': '', '#filter-discount': '', '#filter-strain': '', '#filter-grow': '',
  '#filter-coa': false, '#filter-code': false, '#sort': 'discount', '#filter-instock': true,
};
// Each filter's name in a view and in a shared link (?type=Flower&potency=28).
const VIEW_FIELDS = {
  type: '#filter-type', size: '#filter-size', potency: '#filter-potency', discount: '#filter-discount', strain: '#filter-strain',
  grow: '#filter-grow', coa: '#filter-coa', code: '#filter-code', sort: '#sort', instock: '#filter-instock',
};
const controlValue = (sel) => ($(sel).type === 'checkbox' ? $(sel).checked : $(sel).value);

function setControl(sel, value) {
  const el = $(sel);
  if (el.type === 'checkbox') { el.checked = Boolean(value); return; }
  el.value = value;
  if (el.selectedIndex < 0) el.value = FILTER_DEFAULTS[sel]; // a saved option that no longer exists
}

function applyFilters(values) {
  const valueFor = (sel) => values[sel] ?? FILTER_DEFAULTS[sel];
  setControl('#filter-type', valueFor('#filter-type'));
  fillSizeOptions();
  fillPotencyOptions();
  for (const sel of Object.keys(FILTER_DEFAULTS)) setControl(sel, valueFor(sel));
}

function savedFilters() {
  try { return JSON.parse(localStorage.getItem(FILTERS_KEY)) ?? {}; } catch { return {}; }
}

function saveFilters() {
  const values = Object.fromEntries(Object.keys(FILTER_DEFAULTS).map((sel) => [sel, controlValue(sel)]));
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(values)); } catch { /* private mode */ }
}

const filtersActive = () => $('#search').value !== '' || state.hiddenStores.size > 0
  || Object.entries(FILTER_DEFAULTS).some(([sel, value]) => controlValue(sel) !== value);

/* ---------- filter chips and sheet (phones) ---------- */

// On a phone the filters live in a sheet behind the Filters button. What's on
// shows as chips under the toolbar (tap one to turn it off) and as a count on
// the button. Search and sort stay on the toolbar, so they aren't chips.
function activeFilterChips() {
  const chips = [];
  if (state.hiddenStores.size) chips.push(['stores', $('#store-summary').textContent]);
  for (const sel of ['#filter-type', '#filter-discount', '#filter-size', '#filter-potency', '#filter-strain', '#filter-grow']) {
    const el = $(sel);
    if (el.value === FILTER_DEFAULTS[sel]) continue;
    const text = el.selectedOptions[0]?.textContent ?? el.value;
    chips.push([sel, sel === '#filter-potency' ? `${text} potency` : text]);
  }
  if ($('#filter-code').checked) chips.push(['#filter-code', 'Has a code']);
  if ($('#filter-coa').checked) chips.push(['#filter-coa', 'Lab report']);
  if (!$('#filter-instock').checked) chips.push(['#filter-instock', 'Sold out too']);
  return chips;
}

function renderFilterChips() {
  const chips = activeFilterChips();
  // Reset also clears a search and puts the sort back, so it's offered once two things would go.
  const others = ($('#search').value !== '') + ($('#sort').value !== FILTER_DEFAULTS['#sort']);
  $('#filter-badge').hidden = !chips.length;
  $('#filter-badge').textContent = chips.length;
  $('#open-filters').setAttribute('aria-label', chips.length ? `Filters, ${chips.length} on` : 'Filters');
  $('#filter-chips').innerHTML = chips.map(([key, label]) => `
    <button type="button" class="chip" data-clear="${key}" aria-label="Turn off ${escapeHtml(label)}">${escapeHtml(label)} <span aria-hidden="true">✕</span></button>`).join('')
    + (chips.length + others > 1 ? '<button type="button" class="chip clear" data-clear="all">Reset all</button>' : '');
}

$('#filter-chips').addEventListener('click', (e) => {
  const key = e.target.closest('[data-clear]')?.dataset.clear;
  if (!key) return;
  if (key === 'all') resetFilters();
  else if (key === 'stores') setHiddenStores([]);
  else {
    setControl(key, FILTER_DEFAULTS[key]);
    $(key).dispatchEvent(new Event('input')); // the control's own handlers: dependent menus, saving, re-rendering
  }
  ($('#filter-chips .chip') ?? $('#open-filters')).focus(); // the tapped chip is gone
});

const filterSheet = $('#filter-panel');
const sheetOpen = () => filterSheet.classList.contains('open');

function openFilterSheet() {
  filterSheet.classList.add('open');
  filterSheet.setAttribute('role', 'dialog');
  filterSheet.setAttribute('aria-modal', 'true');
  $('#filter-backdrop').hidden = false;
  $('#open-filters').setAttribute('aria-expanded', 'true');
  document.body.classList.add('sheet-open');
  $('#close-filters').focus();
}

function closeFilterSheet({ restoreFocus = true } = {}) {
  if (!sheetOpen()) return;
  filterSheet.classList.remove('open');
  filterSheet.removeAttribute('role');
  filterSheet.removeAttribute('aria-modal');
  $('#filter-backdrop').hidden = true;
  $('#open-filters').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sheet-open');
  $('#store-picker').open = false;
  if (restoreFocus) $('#open-filters').focus();
}

$('#open-filters').addEventListener('click', openFilterSheet);
for (const sel of ['#close-filters', '#sheet-done', '#filter-backdrop']) $(sel).addEventListener('click', () => closeFilterSheet());
filterSheet.addEventListener('keydown', (e) => {
  if (!sheetOpen()) return;
  if (e.key === 'Escape') { e.preventDefault(); closeFilterSheet(); return; }
  // Tab stays inside the sheet while it covers the page: Close is first, Show is last.
  if (e.key !== 'Tab') return;
  const [first, last] = [$('#close-filters'), $('#sheet-done')];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
// Turning a phone sideways (or widening a window) puts the filters back in the bar.
matchMedia('(max-width: 760px)').addEventListener('change', () => closeFilterSheet({ restoreFocus: false }));

/* ---------- shareable views ---------- */

// The address bar always holds the current view, defaults left out, so it can
// be copied and shared: ?q=grab+bag&type=Flower&potency=28&stores=wnc-cbd.
// Stores go as the ticked ones (stores=) or the unticked ones (hide=), whichever
// is shorter. Opening such a link shows that view, and it's remembered like any
// filter change.
function viewQuery(view) {
  const params = new URLSearchParams();
  if (view.q) params.set('q', view.q);
  for (const [key, sel] of Object.entries(VIEW_FIELDS)) {
    const value = view[key];
    if (value === FILTER_DEFAULTS[sel]) continue;
    params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : value);
  }
  const { only, hidden } = storesOf(view);
  if (only) params.set('stores', only.join(','));
  else if (hidden.length) params.set('hide', hidden.join(','));
  return params.toString().replace(/%2C/g, ',');
}

// A view's stores the short way: the ticked ones when there are fewer of them
// (meaning only those), else the unticked ones.
function storesOf(view) {
  const ids = allStoreIds();
  if (view.only) return { only: view.only, hidden: [] };
  const shown = ids.filter((id) => !view.hidden.includes(id));
  return view.hidden.length && shown.length <= view.hidden.length ? { only: shown, hidden: [] } : { only: null, hidden: view.hidden };
}

// The view a link asks for, or null when it doesn't name one.
function viewFromQuery(search) {
  const params = new URLSearchParams(search);
  if (!['q', 'stores', 'hide', ...Object.keys(VIEW_FIELDS)].some((key) => params.has(key))) return null;
  const view = { q: params.get('q') ?? '', hidden: [] };
  for (const [key, sel] of Object.entries(VIEW_FIELDS)) {
    const value = params.get(key);
    view[key] = value == null ? FILTER_DEFAULTS[sel] : typeof FILTER_DEFAULTS[sel] === 'boolean' ? value === '1' : value;
  }
  const ids = allStoreIds();
  const list = (key) => new Set(params.get(key).split(','));
  if (params.has('stores')) view.hidden = ids.filter((id) => !list('stores').has(id));
  else if (params.has('hide')) view.hidden = ids.filter((id) => list('hide').has(id));
  return view;
}

// Shows a view (from a link or a browser alert) and remembers it.
function applyView(view) {
  $('#search').value = view.q ?? '';
  applyFilters(Object.fromEntries(Object.entries(VIEW_FIELDS).map(([key, sel]) => [sel, view[key]])));
  saveFilters();
  rememberHiddenStores(view.only ? allStoreIds().filter((id) => !view.only.includes(id)) : view.hidden ?? []);
  renderStorePicker();
}

function syncUrl() {
  if (!state.filtersRestored) return; // don't wipe a shared link before it's applied
  const query = viewQuery(currentView());
  const url = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  if (url === `${location.pathname}${location.search}${location.hash}`) return;
  try { history.replaceState(history.state, '', url); } catch { /* too many updates in a row (Safari) */ } // keeps an open dialog's entry (dialogs.js)
}

$('#share-view').addEventListener('click', async () => {
  syncUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link to this view copied');
  } catch {
    toast(location.href);
  }
});

/* ---------- browser alerts ---------- */

// Saved views this browser is told about: new listings (and grab bag strains
// back in stock) and price drops among what a view shows. There's no server to
// push them (the published copy is static files), so they're checked whenever
// the product list loads: on opening the page, and every few minutes while it's
// open. Each match is announced once, as a notification when allowed and a
// message on the page either way.
const BROWSER_ALERTS_KEY = 'potdrop.browserAlerts';
const ALERT_LOOKBACK_MS = 3 * 86400_000; // older matches aren't announced on coming back
const NOTIFY_EACH_UP_TO = 3; // more matches at once get one summary notification

// Read fresh each time: another tab may have announced (and recorded) matches since.
function browserAlerts() {
  try { return JSON.parse(localStorage.getItem(BROWSER_ALERTS_KEY)) ?? []; } catch { return []; }
}
function saveBrowserAlerts(alerts) {
  try { localStorage.setItem(BROWSER_ALERTS_KEY, JSON.stringify(alerts)); } catch { /* private mode */ }
}

// What happened to a product that an alert announces, each with a key so it's announced once.
function alertEvents(p, alert) {
  const events = [];
  // "New" skips a store's first check, like the New listing tag.
  if (alert.newItems && p.firstSeen - (state.storeStart[p.storeId] ?? 0) > 3600_000) {
    events.push({ key: `new:${p.id}:${p.firstSeen}`, at: p.firstSeen, text: 'New listing' });
  }
  if (alert.newItems && p.backAt) events.push({ key: `back:${p.id}:${p.backAt}`, at: p.backAt, text: 'Back in stock' });
  const drop = p.lastDrop;
  if (alert.dropPct && drop && -drop.pct >= alert.dropPct) {
    events.push({ key: `drop:${p.id}:${drop.at}`, at: drop.at, text: `Price drop ${Math.round(-drop.pct)}%, ${money(drop.oldCents)} → ${money(drop.newCents)}` });
  }
  return events;
}

// Products the alert's view shows now with something not yet announced.
function unannounced(alert) {
  const match = viewMatcher(alert.view);
  const cutoff = Date.now() - ALERT_LOOKBACK_MS;
  const hits = [];
  for (const p of state.products) {
    const events = alertEvents(p, alert).filter((e) => e.at > cutoff && !(e.key in alert.seen));
    if (!events.length) continue;
    const view = match(p);
    if (view) hits.push({ p, view, event: events.sort((a, b) => b.at - a.at)[0], events });
  }
  return hits.sort((a, b) => b.event.at - a.event.at);
}

function notify(title, body, tag, onClick) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); onClick(); n.close(); };
  } catch { /* phones only notify through a service worker; the page message still shows */ }
}

function announce(alert, hits) {
  const line = ({ p, view, event }) => `${event.text} · ${money(view.fromCents)} · ${p.storeName}`;
  toast(hits.length === 1 ? `🔔 ${alert.name}: ${hits[0].p.title}` : `🔔 ${alert.name}: ${hits.length} new matches`);
  if (hits.length <= NOTIFY_EACH_UP_TO) {
    for (const hit of hits) notify(hit.p.title, `${line(hit)}\n${alert.name}`, hit.event.key, () => openDetail(hit.p.id));
  } else {
    const body = hits.slice(0, 4).map((h) => `${h.p.title}: ${h.event.text}`).join('\n');
    notify(`${hits.length} new matches: ${alert.name}`, body, `alert:${alert.id}`, () => {
      applyView(alert.view);
      renderProducts();
    });
  }
}

function checkBrowserAlerts() {
  const alerts = browserAlerts();
  if (!alerts.length) return;
  const cutoff = Date.now() - ALERT_LOOKBACK_MS;
  for (const alert of alerts) {
    const hits = unannounced(alert);
    for (const { events } of hits) for (const e of events) alert.seen[e.key] = e.at;
    for (const [key, at] of Object.entries(alert.seen)) if (at <= cutoff) delete alert.seen[key];
    if (hits.length) {
      alert.lastMatchAt = Date.now();
      announce(alert, hits);
    }
  }
  saveBrowserAlerts(alerts);
  renderNotifyList();
}

// "Flower · 3.5g · 28%+ THCa · WNC CBD", from the menus' own labels.
function viewSummary(view) {
  const parts = view.q ? [`“${view.q}”`] : [];
  for (const [key, sel] of Object.entries(VIEW_FIELDS)) {
    if (['coa', 'code', 'sort', 'instock'].includes(key) || view[key] === FILTER_DEFAULTS[sel]) continue;
    parts.push($(sel).selectedOptions[0]?.text ?? view[key]);
  }
  if (view.code) parts.push('with a code');
  if (view.coa) parts.push('with lab report');
  if (!view.instock) parts.push('sold out too');
  const shown = state.status.stores.filter((s) => !view.hidden.includes(s.id));
  if (view.hidden.length) parts.push(shown.length <= 3 ? shown.map((s) => s.name).join(', ') || 'no stores' : `${shown.length} stores`);
  return parts.join(' · ') || 'Everything';
}

function renderNotifyStatus() {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const [title, text] = {
    granted: ['Notifications are on', 'This browser shows a notification when an alert matches.'],
    denied: ['Notifications are blocked', "Allow them for this site in your browser's settings. Matches still show as a message on this page."],
    default: ['Notifications are off', 'Turn them on to hear about matches while this tab is in the background. Matches show on this page either way.'],
    unsupported: ["This browser can't notify", 'Matches show as a message on this page instead.'],
  }[permission];
  $('#notify-perm-title').textContent = title;
  $('#notify-status').textContent = text;
  $('#notify-perm').dataset.state = permission;
  $('#notify-allow').hidden = permission !== 'default';
  const n = browserAlerts().length;
  $('#alerts-count').hidden = !n;
  $('#alerts-count').textContent = n;
}

function renderNotifyList() {
  const alerts = browserAlerts();
  $('#notify-empty').hidden = alerts.length > 0;
  $('#notify-list').innerHTML = alerts.map((a) => {
    const what = [a.newItems && 'new and back in stock', a.dropPct && `drops of ${a.dropPct}%+`].filter(Boolean).join(', ');
    const last = a.lastMatchAt ? ` · last match ${relTime(a.lastMatchAt)}` : '';
    return `<li>
      <div><strong>${escapeHtml(a.name)}</strong><div class="muted">${escapeHtml(a.summary)} · ${escapeHtml(what)}${last}</div></div>
      <div class="detail-actions">
        <button type="button" class="btn ghost" data-show="${escapeHtml(a.id)}">Show</button>
        <button type="button" class="btn ghost" data-remove="${escapeHtml(a.id)}">Remove</button>
      </div>
    </li>`;
  }).join('');
  renderNotifyStatus();
}

// The Alerts tab offers an alert for what the Deals list shows (its filters stay as they were).
function renderAlertsView() {
  if (!state.status) return; // filled in once the data loads
  const summary = viewSummary(currentView());
  $('#notify-view').textContent = summary;
  if (!$('#notify-form').contains(document.activeElement)) $('#notify-name').value = summary.slice(0, 60);
  renderNotifyList();
}

$('#notify-allow').addEventListener('click', async () => {
  await Notification.requestPermission();
  renderNotifyStatus();
});
$('#notify-drops').addEventListener('change', (e) => { $('#notify-pct').disabled = !e.target.checked; });

$('#notify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newItems = $('#notify-new').checked;
  const dropPct = $('#notify-drops').checked ? Number($('#notify-pct').value) : null;
  if (!newItems && !dropPct) return toast('Pick new listings, price drops or both');
  const { sort, hidden, ...rest } = currentView(); // the order doesn't change what matches
  const view = { ...rest, ...storesOf({ hidden }) };
  const alert = {
    id: Date.now().toString(36), name: $('#notify-name').value.trim(), summary: viewSummary(currentView()),
    view, newItems, dropPct, createdAt: Date.now(), seen: {},
  };
  // What the view already shows isn't news.
  for (const { events } of unannounced(alert)) for (const ev of events) alert.seen[ev.key] = ev.at;
  saveBrowserAlerts([...browserAlerts(), alert]);
  renderNotifyList();
  toast(`Alert added: ${alert.name}`);
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
    renderNotifyStatus();
  }
});

$('#notify-list').addEventListener('click', (e) => {
  const show = e.target.closest('[data-show]')?.dataset.show;
  const remove = e.target.closest('[data-remove]')?.dataset.remove;
  if (show) {
    const alert = browserAlerts().find((a) => a.id === show);
    if (!alert) return;
    applyView({ ...alert.view, sort: 'newest' });
    goToDeals();
  } else if (remove) {
    saveBrowserAlerts(browserAlerts().filter((a) => a.id !== remove));
    renderNotifyList();
  }
});

fillSizeOptions();
fillPotencyOptions();
// Before the re-render below: sizes and potency steps depend on the type.
$('#filter-type').addEventListener('input', () => { fillSizeOptions(); fillPotencyOptions(); });
$('#search').addEventListener('input', () => renderProducts());
for (const sel of Object.keys(FILTER_DEFAULTS)) {
  $(sel).addEventListener('input', () => {
    saveFilters();
    renderProducts();
  });
}
function resetFilters() {
  $('#search').value = '';
  $('#store-search').value = '';
  applyFilters({});
  saveFilters();
  setHiddenStores([]); // also re-renders the list
}
$('#sheet-reset').addEventListener('click', resetFilters);

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

/* ---------- saved products and the tabs ---------- */

// Bookmarked products, kept in this browser. The Saved tab lists them whatever the filters.
const SAVED_KEY = 'potdrop.saved';
function savedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY)) ?? []); } catch { return new Set(); }
}

function renderSavedCount() {
  const n = savedSet().size;
  $('#saved-count').hidden = !n;
  $('#saved-count').textContent = n;
}

function renderDetailSave() {
  const on = savedSet().has(state.detail?.product.id);
  $('#detail-save').setAttribute('aria-pressed', String(on));
  $('#detail-save').innerHTML = `${BOOKMARK_ICON}${on ? 'Saved' : 'Save'}`;
}

function toggleSaved(id) {
  const ids = savedSet();
  const on = !ids.has(id);
  if (on) ids.add(id); else ids.delete(id);
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...ids]));
  } catch {
    return toast("This browser isn't keeping saved products (private browsing?)");
  }
  for (const btn of document.querySelectorAll(`[data-save="${CSS.escape(id)}"]`)) btn.setAttribute('aria-pressed', String(on));
  if (state.detail?.product.id === id) renderDetailSave();
  renderSavedCount();
  if (state.view === 'saved') renderProducts({ keepPage: true });
  toast(on ? 'Saved' : 'Removed from Saved');
}

// Deals and Saved are two views of this page; Saved is #saved in the address,
// so Back goes from one to the other like switching tabs in an app.
function route() {
  state.view = location.hash === '#saved' ? 'saved' : location.hash === '#alerts' ? 'alerts' : 'deals';
  document.body.classList.toggle('view-saved', state.view === 'saved');
  document.body.classList.toggle('view-alerts', state.view === 'alerts');
  $('#alerts-view').hidden = state.view !== 'alerts';
  // Until the data loads, at least the heading is right.
  if (state.view === 'alerts') $('#feed-title').textContent = 'Alerts';
  else if (state.view === 'saved') $('#feed-title').textContent = 'Saved';
  $('#feed-sub').hidden = state.view !== 'deals';
  for (const tab of document.querySelectorAll('.app-nav [data-nav]')) {
    if (tab.dataset.nav === state.view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (state.products.length) renderProducts();
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
window.addEventListener('popstate', route);
function goToDeals() {
  if (state.view === 'deals') return window.scrollTo({ top: 0, behavior: 'smooth' });
  history.pushState(history.state, '', `${location.pathname}${location.search}`);
  route();
  window.scrollTo(0, 0);
}
for (const link of document.querySelectorAll('[data-nav="deals"], [data-go-deals]')) {
  link.addEventListener('click', (e) => { e.preventDefault(); goToDeals(); });
}

route();
renderSavedCount();
renderNotifyStatus();
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
