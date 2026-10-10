/* SaaS Status — client-side status aggregator.
   Fetches every vendor's official public status feed in the browser,
   normalizes to a common shape, and renders the console.
   One vendor's failure never breaks the rest. */
'use strict';

/* ---------- status vocabulary ---------- */
const S = {
  OK: 'operational',
  DEG: 'degraded',
  PART: 'partial_outage',
  MAJ: 'major_outage',
  MAINT: 'maintenance',
  UNK: 'unknown'
};

const STATUS_LABEL = {
  operational: 'Operational',
  degraded: 'Degraded',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Maintenance',
  unknown: 'Unknown'
};

/* sort rank: problems float to the top */
const RANK = { major_outage: 5, partial_outage: 4, degraded: 3, unknown: 2, maintenance: 1, operational: 0 };

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html || '');
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

function timeAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) { /* future-dated (e.g. scheduled maintenance) */
    const mins = Math.round(-diff / 60000);
    if (mins < 60) return 'in ' + mins + ' min';
    const h = Math.round(mins / 60);
    if (h < 48) return 'in ' + h + ' hr';
    return 'in ' + Math.round(h / 24) + 'd';
  }
  const mins = Math.max(0, Math.round(diff / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.round(mins / 60);
  if (h < 24) return h + ' hr ago';
  return Math.round(h / 24) + 'd ago';
}

/* truncate at a word boundary so descriptions never cut mid-word */
function trunc(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const i = cut.lastIndexOf(' ');
  return (i > n * 0.4 ? cut.slice(0, i) : cut) + '…';
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

function pluralWord(n, one, many) {
  return (n === 1 ? one : many);
}

/* freshness should reflect the newest activity, not a stale feed-level timestamp */
function freshest(r) {
  let best = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
  (r.incidents || []).forEach(i => {
    const t = i.created ? new Date(i.created).getTime() : 0;
    if (!isNaN(t) && t > best) best = t;
  });
  return best ? new Date(best).toISOString() : r.updatedAt;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString();
}

/* ---------- statuspage.io ---------- */
function mapSpComponent(status) {
  switch (status) {
    case 'operational': return S.OK;
    case 'degraded_performance': return S.DEG;
    case 'partial_outage': return S.PART;
    case 'major_outage': return S.MAJ;
    case 'under_maintenance': return S.MAINT;
    default: return S.UNK;
  }
}
function mapSpIndicator(ind) {
  switch (ind) {
    case 'none': return S.OK;
    case 'minor': return S.DEG;
    case 'major': case 'critical': return S.MAJ;
    case 'maintenance': return S.MAINT;
    default: return S.UNK;
  }
}
function parseStatuspage(json, vendor) {
  const page = json.page || {}, st = json.status || {};
  const components = (json.components || [])
    .filter(c => c && c.name && !/^visit\s/i.test(c.name)) /* drop "Visit www.x for more info" placeholders */
    .map(c => ({ name: c.name, status: mapSpComponent(c.status) }));
  const incidents = (json.incidents || []).map(i => {
    const upd = (i.incident_updates || [])[0];
    return {
      title: i.name || 'Incident',
      status: (i.status || 'investigating').toLowerCase().replace(/_/g, ' '),
      impact: i.impact || '',
      url: i.shortlink || vendor.status_page_url,
      created: i.created_at || null,
      body: upd && upd.body ? trunc(stripHtml(upd.body), 600) : ''
    };
  });
  const maint = (json.scheduled_maintenances || []).map(m => ({
    title: m.name || 'Scheduled maintenance',
    status: 'scheduled',
    impact: '',
    url: m.shortlink || vendor.status_page_url,
    created: m.scheduled_for || m.created_at || null,
    body: trunc(stripHtml(m.incident_updates && m.incident_updates[0] && m.incident_updates[0].body || ''), 600)
  }));
  return {
    status: mapSpIndicator(st.indicator),
    summary: st.description || page.name || '',
    components,
    incidents: incidents.concat(maint),
    updatedAt: page.updated_at || null,
    note: ''
  };
}

/* ---------- Slack (custom JSON: active incidents only) ---------- */
function parseSlack(json, vendor) {
  const active = json.active_incidents || [];
  return {
    status: active.length ? S.DEG : S.OK,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components: [],
    incidents: active.map(i => ({
      title: i.title || 'Slack incident',
      status: (i.type || 'investigating').toLowerCase(),
      impact: '',
      url: vendor.status_page_url,
      created: i.date_created || null,
      body: ''
    })),
    updatedAt: json.date_updated || null,
    note: "Slack's public API publishes active incidents only — no per-function breakdown is available."
  };
}

/* ---------- GitLab (status.io) ---------- */
function mapStatusIo(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('operation')) return S.OK;
  if (s.includes('degrad')) return S.DEG;
  if (s.includes('partial')) return S.PART;
  if (s.includes('major')) return S.MAJ;
  if (s.includes('maintenance')) return S.MAINT;
  return S.UNK;
}
function parseGitlab(json) {
  const r = json.result || {};
  const overall = r.status_overall || {};
  const components = [];
  (r.status || []).forEach(svc => {
    components.push({ name: svc.name || 'Service', status: mapStatusIo(svc.status) });
    (svc.containers || []).forEach(c => {
      components.push({ name: (svc.name || '') + ' › ' + (c.name || 'container'), status: mapStatusIo(c.status) });
    });
  });
  const toInc = (list, dflt) => (Array.isArray(list) ? list : []).map(i => ({
    title: i.name || i.title || 'Incident',
    status: (i.status || dflt).toLowerCase(),
    impact: '',
    url: 'https://status.gitlab.com',
    created: i.updated || i.created || null,
    body: trunc(stripHtml(i.message || i.body || ''), 600)
  }));
  return {
    status: mapStatusIo(overall.status),
    summary: overall.status || '',
    components,
    incidents: toInc(r.incidents, 'investigating').concat(toInc(r.maintenance, 'scheduled')),
    updatedAt: overall.updated || null,
    note: ''
  };
}

/* ---------- DocuSign (custom incidents JSON) ---------- */
function mapDsImpact(impact) {
  switch (String(impact || '').toLowerCase()) {
    case 'available': return S.OK;
    case 'performance_degradation': return S.DEG;
    case 'service_disruption': return S.MAJ;
    default: return S.UNK;
  }
}
function parseDocusign(json, vendor) {
  const all = json.incidents || [];
  const active = all.filter(i => !['resolved', 'closed'].includes(String(i.status || '').toLowerCase()));
  const compMap = new Map();
  all.forEach(i => (i.components || []).forEach(c => {
    if (c && c.name && !compMap.has(c.name)) compMap.set(c.name, mapDsImpact(c.status));
  }));
  let status = S.OK;
  active.forEach(i => {
    const s = mapDsImpact(i.impact);
    if (RANK[s] > RANK[status]) status = s;
  });
  return {
    status,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components: [...compMap.entries()].map(([name, st]) => ({ name, status: st })),
    incidents: all.slice(0, 12).map(i => {
      const ev = (i.events || [])[0];
      return {
        title: i.title || 'Incident',
        status: String(i.status || 'investigating').toLowerCase(),
        impact: i.impact || '',
        url: vendor.status_page_url,
        created: i.startedAt || i.createdAt || null,
        body: ev && ev.body ? trunc(stripHtml(ev.body), 600) : ''
      };
    }),
    updatedAt: (all[0] && all[0].updatedAt) || null,
    note: ''
  };
}

/* ---------- Google Workspace (incidents + products) ---------- */
function parseGoogleWorkspace(incJson, prodJson) {
  const now = Date.now();
  const incidents = Array.isArray(incJson) ? incJson : [];
  const products = (prodJson && prodJson.products) || [];
  const active = incidents.filter(i => !i.end || new Date(i.end).getTime() > now);
  const affected = new Set();
  active.forEach(i => (i.affected_products || []).forEach(p => p && p.id && affected.add(p.id)));
  let components, note = '';
  if (products.length) {
    components = products.map(p => ({ name: p.title || p.id, status: affected.has(p.id) ? S.DEG : S.OK }));
  } else {
    /* products.json is not CORS-open in browsers — derive the product list
       from products seen across recent incidents instead of failing outright */
    const seen = new Map();
    incidents.forEach(i => (i.affected_products || []).forEach(p => {
      if (p && p.id && !seen.has(p.id)) seen.set(p.id, p.title || p.id);
    }));
    components = [...seen.entries()].map(([id, name]) => ({ name, status: affected.has(id) ? S.DEG : S.OK }));
    note = 'Full product catalog is not browser-readable — showing products seen in recent incidents.';
  }
  const gwUrl = (u) => !u ? 'https://www.google.com/appsstatus/dashboard/'
    : (String(u).startsWith('http') ? u : 'https://www.google.com/appsstatus/dashboard/' + u);
  return {
    status: active.length ? S.DEG : S.OK,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components,
    incidents: incidents.slice(0, 12).map(i => ({
      title: (i.service_name || 'Google Workspace') + ' — ' + (i.status_impact || i.severity || 'incident'),
      status: (!i.end || new Date(i.end).getTime() > now) ? 'investigating' : 'resolved',
      impact: '',
      url: gwUrl(i.uri),
      created: i.begin || i.created || null,
      body: trunc(stripHtml(i.external_desc || '').replace(/\*\*/g, ''), 600)
    })),
    updatedAt: (incidents[0] && incidents[0].modified) || null,
    note
  };
}

/* ---------- Salesforce (incidents + products APIs) ---------- */
function parseSalesforce(incJson, prodJson) {
  const incidents = Array.isArray(incJson) ? incJson : [];
  const products = Array.isArray(prodJson) ? prodJson.filter(p => p.isActive) : [];
  const active = incidents.filter(i => i.status === 'Active');
  const affected = new Set();
  active.forEach(i => (i.serviceKeys || []).forEach(k => affected.add(String(k).toLowerCase())));
  const activeFirst = active.concat(incidents.filter(i => i.status !== 'Active')).slice(0, 12);
  return {
    status: active.length ? S.DEG : S.OK,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components: products.map(p => ({
      name: p.altDisplayName || p.name || p.key,
      status: affected.has(String(p.key || '').toLowerCase()) ? S.DEG : S.OK
    })),
    incidents: activeFirst.map(i => {
      const tl = (i.timeline || [])[0];
      return {
        title: (i.type || 'Incident') + ' — ' + (i.serviceKeys || []).join(', '),
        status: i.status === 'Active' ? 'investigating' : 'resolved',
        impact: '',
        url: 'https://status.salesforce.com',
        created: i.createdAt || null,
        body: trunc(stripHtml((tl && tl.content) ? tl.content : (i.additionalInformation || '')), 600)
      };
    }),
    updatedAt: (incidents[0] && incidents[0].updatedAt) || null,
    note: ''
  };
}

/* ---------- RSS (AWS; Docker/Intercom via incident.io when reachable) ---------- */
function parseRssItems(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('bad rss');
  return [...doc.querySelectorAll('item')].map(item => {
    const q = (tag) => { const el = item.querySelector(tag); return el ? el.textContent.trim() : ''; };
    return { title: q('title'), link: q('link'), pubDate: q('pubDate'), guid: q('guid'), desc: q('description') };
  });
}
function parseAWS(text) {
  const items = parseRssItems(text);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const alarming = /disruption|degradation|impairment|outage|increased error|elevated/i;
  const recent = items.filter(i => { const t = new Date(i.pubDate).getTime(); return !isNaN(t) && t > dayAgo; });
  const bad = recent.filter(i => alarming.test(i.title));
  return {
    status: bad.length ? S.DEG : S.OK,
    summary: bad.length ? bad.length + ' recent service event(s)' : 'No recent service events',
    components: [],
    incidents: items.slice(0, 12).map(i => ({
      title: stripHtml(i.title),
      status: alarming.test(i.title) ? 'monitoring' : 'resolved',
      impact: '',
      url: 'https://status.aws.amazon.com/',
      created: i.pubDate || null,
      body: trunc(stripHtml(i.desc), 600)
    })),
    updatedAt: (items[0] && items[0].pubDate) || null,
    note: 'AWS publishes public health events only — overall status is inferred from events in the last 24 hours.'
  };
}
function parseIncidentIoRss(text, vendor) {
  const items = parseRssItems(text);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const open = items.filter(i => {
    const t = new Date(i.pubDate).getTime();
    return !isNaN(t) && t > weekAgo && !/complete|resolved/i.test(i.desc.slice(0, 300));
  });
  return {
    status: open.length ? S.DEG : S.OK,
    summary: open.length ? open.length + ' recent update(s)' : 'No recent incidents reported',
    components: [],
    incidents: items.slice(0, 12).map(i => ({
      title: stripHtml(i.title),
      status: /maintenance/i.test(i.title) ? 'scheduled'
        : (/complete|resolved/i.test(i.desc.slice(0, 300)) ? 'resolved' : 'monitoring'),
      impact: '',
      url: i.link || vendor.status_page_url,
      created: i.pubDate || null,
      body: trunc(stripHtml(i.desc), 600)
    })),
    updatedAt: (items[0] && items[0].pubDate) || null,
    note: 'Component-level data is not published by this feed — incident history only.'
  };
}

/* ---------- loaders ---------- */
/* per-vendor timeout so one hung feed can never stall the whole dashboard */
const FETCH_TIMEOUT_MS = 20000;
async function fetchWithTimeout(url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: 'no-store', signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}
async function fetchJson(url) {
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function fetchText(url) {
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

function unknownResult(vendor, note) {
  return {
    status: S.UNK, summary: 'Feed unreachable from the browser', components: [], incidents: [],
    updatedAt: null, note: note || "This vendor's feed can't be loaded cross-origin, or no browser-readable feed exists. Open the official status page for live info.", failed: true
  };
}

/* Vendors whose feeds are verified unreachable from browsers (no CORS / no public API):
   microsoft, zendesk, pagerduty — skip the doomed fetch, go straight to "unknown". */
const SKIP_FETCH = {
  microsoft: 'Microsoft publishes status through its admin portals — no public browser-readable feed exists.',
  zendesk: 'Zendesk’s status API does not allow cross-origin browser requests.',
  pagerduty: 'PagerDuty’s status page exposes no public browser-readable API.'
};

async function loadVendor(v) {
  if (SKIP_FETCH[v.key]) return unknownResult(v, SKIP_FETCH[v.key] + ' Open the official status page for live info.');
  let r;
  try {
    switch (v.key) {
      case 'slack': r = parseSlack(await fetchJson(v.source_url), v); break;
      case 'gitlab': r = parseGitlab(await fetchJson(v.source_url)); break;
      case 'docusign': r = parseDocusign(await fetchJson(v.source_url), v); break;
      case 'google-workspace': {
        const [inc, prod] = await Promise.all([
          fetchJson(v.source_url),
          /* products.json sends no CORS headers — resolve without it rather than failing the vendor */
          fetchJson('https://www.google.com/appsstatus/dashboard/products.json').catch(() => null)
        ]);
        r = parseGoogleWorkspace(inc, prod);
        break;
      }
      case 'salesforce': {
        const [inc, prod] = await Promise.all([
          fetchJson(v.source_url),
          fetchJson('https://api.status.salesforce.com/v1/products')
        ]);
        r = parseSalesforce(inc, prod);
        break;
      }
      case 'aws': r = parseAWS(await fetchText(v.source_url)); break;
      case 'docker':
      case 'intercom': r = parseIncidentIoRss(await fetchText(v.source_url), v); break;
      default: r = parseStatuspage(await fetchJson(v.source_url), v);
    }
  } catch (e) {
    return unknownResult(v);
  }
  r.updatedAt = freshest(r);
  return r;
}

/* ---------- state ---------- */
let VENDORS = [];
let RESULTS = new Map(); /* key -> result */
let lastRefresh = null;
let nextRefreshAt = null;
const REFRESH_MS = 15 * 60 * 1000;
const OPEN = new Set(); /* detail-section ids the user expanded; preserved across re-renders */
let firstPaintDone = false; /* card entrance animation plays only on the very first paint */
/* versioned so vendor-list updates bypass CDN edge caches deterministically */
const VENDORS_URL = 'data/vendors.json?v=20261010b';

/* ---------- rendering ---------- */
function pillClass(s) { return 'pill pill-' + s; }
function dotClass(s) { return 'dot dot-' + s; }
function chipClass(s) {
  const k = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const known = ['investigating', 'identified', 'monitoring', 'degraded', 'resolved', 'completed', 'operational', 'scheduled', 'maintenance'];
  return 'chip chip-' + (known.includes(k) ? k : 'default');
}

function logoHtml(v) {
  if (v.logo) {
    return '<img src="' + esc(v.logo) + '" alt="' + esc(v.name) + ' logo" loading="lazy" onerror="this.parentNode.innerHTML=\'<div class=&quot;logo-fallback&quot;&gt;' + esc(v.name.charAt(0)) + '</div>\'">';
  }
  return '<div class="logo-fallback">' + esc(v.name.charAt(0)) + '</div>';
}

function incidentRow(i) {
  const title = i.url
    ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener">' + esc(i.title) + '</a>'
    : esc(i.title);
  return '<div class="incident-row">' +
    '<div class="incident-top"><span class="incident-title">' + title + '</span>' +
    '<span class="' + chipClass(i.status) + '">' + esc(i.status || 'update') + '</span></div>' +
    '<div class="incident-meta"><span>' + esc(timeAgo(i.created)) + '</span>' +
    (i.created ? '<span class="mono" title="' + esc(fmtTime(i.created)) + '">' + esc(fmtTime(i.created)) + '</span>' : '') + '</div>' +
    (i.body ? '<p class="incident-body">' + esc(i.body) + '</p>' : '') +
    '</div>';
}

function cardHtml(v, r) {
  const bad = r.components.filter(c => c.status !== S.OK && c.status !== S.UNK).length;
  const cardCls = 'card' + (['degraded', 'partial_outage', 'major_outage'].includes(r.status) ? ' card-alert' : '');
  const compList = r.components.length
    ? r.components.map(c =>
        '<div class="comp-row"><span class="' + dotClass(c.status) + '"></span>' +
        '<span class="comp-name">' + esc(c.name) + '</span>' +
        '<span class="comp-status">' + esc(STATUS_LABEL[c.status] || c.status) + '</span></div>').join('')
    : '<div class="coverage-note">No per-function breakdown published by this feed.</div>';
  const incList = r.incidents.length
    ? r.incidents.map(incidentRow).join('')
    : '<div class="coverage-note">No incidents on record.</div>';

  const staleDays = r.updatedAt ? Math.floor((Date.now() - new Date(r.updatedAt).getTime()) / 86400000) : -1;
  const staleNote = (!r.failed && staleDays > 7)
    ? '<div class="coverage-note">This feed last published an update ' + staleDays + 'd ago — data may be stale.</div>'
    : '';

  return '<article class="' + cardCls + '" data-key="' + esc(v.key) + '">' +
    '<div class="card-head">' +
      '<div class="logo-frame">' + logoHtml(v) + '</div>' +
      '<div class="card-title"><h2>' + esc(v.name) + '</h2><div class="card-cat">' + esc(v.category) + '</div></div>' +
      '<span class="' + pillClass(r.status) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' +
    '</div>' +
    '<div class="card-stats"><span><b>' + r.components.length + '</b> ' + esc(pluralWord(r.components.length, 'function', 'functions')) + '</span>' +
      '<span><b>' + r.incidents.length + '</b> ' + esc(pluralWord(r.incidents.length, 'incident', 'incidents')) + '</span>' +
      (bad ? '<span><b>' + bad + '</b> affected</span>' : '') +
      '<span style="margin-left:auto" class="mono" title="' + esc(fmtTime(r.updatedAt)) + '">' + esc(timeAgo(r.updatedAt)) + '</span></div>' +
    (r.note ? '<div class="coverage-note">' + esc(r.note) + '</div>' : '') +
    staleNote +
    '<div class="details">' +
      detailsToggle(v.key, 'comp', 'Functions', r.components.length) +
      '<div class="details-body' + (OPEN.has('comp-' + v.key) ? ' open' : '') + '" id="comp-' + esc(v.key) + '">' + compList + '</div>' +
      detailsToggle(v.key, 'inc', 'Incidents', r.incidents.length) +
      '<div class="details-body' + (OPEN.has('inc-' + v.key) ? ' open' : '') + '" id="inc-' + esc(v.key) + '">' + incList + '</div>' +
    '</div>' +
    '<div class="card-links">' +
      '<a class="link-btn" href="' + esc(v.status_page_url) + '" target="_blank" rel="noopener">Status page ↗</a>' +
      '<a class="link-btn" href="' + esc(v.support_url) + '" target="_blank" rel="noopener">' + esc(v.support_label || 'Support') + ' ↗</a>' +
    '</div>' +
  '</article>';
}

function detailsToggle(key, kind, label, n) {
  const id = kind + '-' + key;
  const open = OPEN.has(id);
  return '<button class="details-toggle" type="button" aria-expanded="' + open + '" data-target="' + esc(id) + '"><span>' +
    esc(label) + ' (' + n + ')</span><span class="chev">▾</span></button>';
}

function skeletonHtml() {
  return '<div class="card skeleton"><div class="card-head"><div class="sk sk-logo"></div>' +
    '<div style="flex:1"><div class="sk sk-line" style="width:60%;margin-bottom:8px"></div><div class="sk sk-line" style="width:35%"></div></div>' +
    '<div class="sk sk-pill"></div></div>' +
    '<div class="sk sk-line" style="width:80%"></div><div class="sk sk-line" style="width:55%"></div></div>';
}

function currentFilter() {
  return {
    q: ($('#search').value || '').trim().toLowerCase(),
    cat: $('#category').value,
    problemsOnly: $('#problems-only').checked
  };
}

function filteredVendors() {
  const f = currentFilter();
  return VENDORS.filter(v => {
    const r = RESULTS.get(v.key);
    if (f.cat && v.category !== f.cat) return false;
    if (f.problemsOnly && r && ![S.DEG, S.PART, S.MAJ, S.UNK].includes(r.status)) return false;
    if (f.q) {
      const hay = (v.name + ' ' + v.category + ' ' +
        (r ? r.components.map(c => c.name).join(' ') : '')).toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const ra = RANK[(RESULTS.get(a.key) || {}).status] || 0;
    const rb = RANK[(RESULTS.get(b.key) || {}).status] || 0;
    return rb - ra || a.name.localeCompare(b.name);
  });
}

function render() {
  const grid = $('#grid');
  const list = filteredVendors();
  $('#result-count').textContent = list.length + ' of ' + VENDORS.length + ' vendors';
  if (!list.length) {
    grid.innerHTML = '<div class="empty-state"><h3>No vendors match</h3><p>Try a different search term or clear the filters.</p></div>';
    return;
  }
  grid.innerHTML = list.map(v => cardHtml(v, RESULTS.get(v.key) || {
    status: S.UNK, summary: '', components: [], incidents: [], updatedAt: null, note: 'Loading…'
  })).join('');
  if (!firstPaintDone) { grid.classList.add('painted'); firstPaintDone = true; }
  grid.querySelectorAll('.details-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = document.getElementById(btn.dataset.target);
      const open = body.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) OPEN.add(btn.dataset.target); else OPEN.delete(btn.dataset.target);
    });
  });
}

function renderKpis() {
  let ok = 0, issues = 0, incidents = 0, maint = 0, unknown = 0;
  RESULTS.forEach(r => {
    if (r.status === S.OK) ok++;
    else if ([S.DEG, S.PART, S.MAJ].includes(r.status)) issues++;
    else if (r.status === S.MAINT) maint++;
    else unknown++;
    incidents += (r.incidents || []).filter(i => !['resolved', 'completed'].includes(String(i.status).toLowerCase())).length;
  });
  $('#kpi-operational').textContent = ok;
  $('#kpi-issues').textContent = issues;
  $('#kpi-incidents').textContent = incidents;
  $('#kpi-maintenance').textContent = maint;
  const ku = $('#kpi-unknown');
  if (ku) ku.textContent = unknown;
  const total = RESULTS.size;
  if (total) {
    const pct = Math.round(ok / total * 100);
    document.title = pct + '% operational — SaaS Status';
  }
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- refresh cycle ---------- */
/* Cards render progressively as each vendor's feed resolves — a slow or hung
   feed (each has a 20s timeout) can never stall the whole dashboard. */
async function refreshAll(manual) {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  let pending = VENDORS.length;
  const oneDone = () => {
    renderKpis();
    render();
    if (--pending) return;
    lastRefresh = new Date();
    nextRefreshAt = new Date(Date.now() + REFRESH_MS);
    $('#last-updated').textContent = lastRefresh.toLocaleTimeString();
    btn.disabled = false;
    btn.classList.remove('spinning');
    const issues = [...RESULTS.values()].filter(r => [S.DEG, S.PART, S.MAJ].includes(r.status)).length;
    if (manual) toast('Updated ' + RESULTS.size + ' vendors · ' + issues + ' with issues');
  };
  VENDORS.forEach(v => {
    loadVendor(v).then(
      r => RESULTS.set(v.key, r),
      e => RESULTS.set(v.key, unknownResult(v, 'Request failed: ' + (e && e.message)))
    ).then(oneDone);
  });
}

function tickCountdown() {
  if (!nextRefreshAt) return;
  const ms = nextRefreshAt - Date.now();
  if (ms <= 0) return;
  const m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000);
  $('#next-refresh').textContent = 'in ' + m + 'm ' + String(s).padStart(2, '0') + 's';
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const r = await fetch(VENDORS_URL, { cache: 'no-store' });
    VENDORS = await r.json();
  } catch (e) {
    $('#grid').innerHTML = '<div class="empty-state"><h3>Could not load vendor list</h3><p>data/vendors.json failed to load. Serve this folder over HTTP and retry.</p></div>';
    return;
  }
  $('#vendor-count').textContent = VENDORS.length;
  const cats = [...new Set(VENDORS.map(v => v.category))].sort();
  const sel = $('#category');
  cats.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
  let deb;
  $('#search').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(render, 160); });
  sel.addEventListener('change', render);
  $('#problems-only').addEventListener('change', render);
  $('#refresh-btn').addEventListener('click', () => refreshAll(true));
  await refreshAll(false);
  setInterval(() => refreshAll(false), REFRESH_MS);
  setInterval(tickCountdown, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && nextRefreshAt && Date.now() > nextRefreshAt) refreshAll(false);
  });
}

document.addEventListener('DOMContentLoaded', boot);
