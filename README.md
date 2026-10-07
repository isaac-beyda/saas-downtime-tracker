# SaaS Status — Live Operations Console

A portfolio-quality static dashboard tracking the live status of **50 SaaS vendors**,
function by function, from each provider's **official** public status feed. No backend,
no build step, no tracking — everything runs in the visitor's browser.

![static site](https://img.shields.io/badge/site-static-blue) ![no build](https://img.shields.io/badge/build-none-green)

## How it works

- On page load, `app.js` fetches `data/vendors.json` (the single source of truth for the
  vendor list), then fetches every vendor's `source_url` **client-side** with `fetch()`.
- Each feed is normalized by a small per-vendor parser into a common shape:
  `operational | degraded | partial_outage | major_outage | maintenance | unknown`,
  plus per-function components and an incident list.
- One vendor's failure never breaks the rest — a failed feed degrades to an
  "Unknown" card with a link to the vendor's official status page.
- Auto-refreshes every **15 minutes**, plus a manual Refresh button. A countdown
  shows the next refresh.

## Feed parsers (`app.js`)

| Vendor(s) | Feed shape | Notes |
|---|---|---|
| ~40 vendors | statuspage.io `/api/v2/summary.json` | statuspage.io sends `Access-Control-Allow-Origin: *`, so these work from any browser. "Visit www…" placeholder components are filtered out. |
| Slack | `slack-status.com/api/v2.0.0/current` | CORS-open. Publishes **active incidents only** — no per-function breakdown exists in the public API. |
| GitLab | `api.status.io` JSON | CORS-open. Flattens services + containers; maps `incidents`/`maintenance` arrays. |
| DocuSign | `health.docusign.com …/incidents.json` | CORS-open. Components aggregated from incident payloads; status from `impact` (`available` / `performance_degradation` / `service_disruption`). |
| Google Workspace | `appsstatus` `incidents.json` + `products.json` | Both CORS-open. Products become components; a product is marked degraded when named in an active incident's `affected_products`. |
| Salesforce | `api.status.salesforce.com` incidents + products | Both CORS-open. Products become components; serviceKeys of `Active` incidents mark products degraded. |
| AWS | `status.aws.amazon.com/rss/all.rss` | CORS-open RSS. Overall status is a **heuristic**: degraded if a disruption/degradation/outage event was published in the last 24 h (documented on the card). |
| Docker, Intercom | incident.io `feed.rss` via `DOMParser` | Parser implemented, but these feeds currently send **no CORS headers**, so browsers block the fetch → cards show "Unknown" with a status-page link until the vendor enables CORS. |
| Microsoft, Zendesk, PagerDuty | — | No browser-readable public feed (Microsoft: admin-portal only; Zendesk SSP API blocks cross-origin; PagerDuty's page has no public API). Cards show "Unknown" with a working link to the official status page instead of failing. |

## Run locally

Any static file server works:

```bash
cd saas-status-dashboard
python3 -m http.server 8080
# open http://localhost:8080
```

> `file://` will not work — `fetch()` requires HTTP(S).

## Deploy to GitHub Pages

1. Push this folder as a repository (or into `docs/` of an existing one).
2. GitHub → **Settings → Pages** → Deploy from branch → select branch + folder (`/` or `/docs`).
3. That's it — no build command. The site works from any path since all asset
   references are relative.

## Logos

All logos in `assets/logos/` were downloaded from each company's **official**
website / press / brand page — never hotlinked, never third-party logo sites.
Transparent backgrounds throughout (official SVG preferred; PNG only with a
verified alpha channel). Filenames match `vendors.json` keys and are referenced
via the `logo` field.

## Project structure

```
index.html          markup + filter toolbar + KPI strip
styles.css          warm operations-console theme (responsive, dark)
app.js              fetching, per-vendor parsers, rendering, refresh cycle
data/vendors.json   vendor list: key, name, category, source_url, status_page_url,
                    support_url, support_label, logo
assets/logos/       50 official transparent logos (<key>.svg / <key>.png)
```

## Limitations (honest edition)

- Data is only as fresh as the visitor's browser — there is no server-side
  history or background refresh when the page is closed.
- A few vendors (Microsoft, Zendesk, PagerDuty, Docker, Intercom) can't be read
  cross-origin, so their cards link out instead of showing live data.
- AWS overall status is inferred from its public RSS (see parser table).
