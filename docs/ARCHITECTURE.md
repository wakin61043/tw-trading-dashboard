# EquiLens architecture

```
Browser (desktop) ─▶ EquiLens Nexus  (Node, 127.0.0.1:4330) ─▶ data sources (TWSE/TPEx, FinMind, Fugle, Twelve Data, Alpha Vantage)
                         │  .local/ (config, groups, prices, records)          ─▶ AI service (Claude, OpenAI, Gemini, OpenAI-compatible)
Phone (PWA) ─▶ Cloudflare Tunnel ─▶ EquiLens Pocket (127.0.0.1:4340) ─▶ Nexus API (Pocket never touches data files)
```

Nexus is the only process that fetches or writes market data. Pocket is a thin, password-protected proxy with its own
mobile UI and Web Push relay. There is no database and no build step: plain ES modules on Node 22+ and in the browser.

## Nexus (`EquiLens-Nexus/`)

| Module | Role |
|---|---|
| `server.mjs` | HTTP server, API routes, schedulers (intraday monitor, close records, news push, AI report, daily update), market switching |
| `lib/config.mjs` | `.local/config.json`: market, language, enabled data sources and preferences, AI model, up/down colors, and remote access (Pocket connection mode and domains, push contact, desktop Cloudflare Access settings). Legacy installs and `remote.json` are migrated automatically |
| `lib/markets.mjs` | Market profiles: time zone, sessions (with lunch breaks), settle minutes, lot size, tick tables, price limits, symbol format, replay scales. All time / price rules come from here |
| `lib/secrets.mjs` | API keys via Windows DPAPI, macOS Keychain or Secret Service (file fallback); environment variables take priority |
| `lib/i18n.mjs` | Server-side translation with the same dictionaries as the UI; `UserError` marks messages safe to show |
| `lib/providers/` | Data sources and the capability router (see below) |
| `lib/research.mjs` | Per-stock research updates through the router (resumable, keeps old data on empty responses); bulk institutional data for sources that only offer whole-market days |
| `lib/engine.mjs` | Four-factor scoring; factors the current sources can't provide are excluded and weights renormalized |
| `lib/heatmap.mjs` | Sector heatmap from whole-market daily data, live snapshots or local research data |
| `lib/radar.mjs`, `lib/replay.mjs` | Intraday alerts and the per-minute time-machine recorder |
| `lib/pricealerts.mjs` | Custom alerts: user rules per stock (price above/below, % up/down, projected volume ratio), checked on every snapshot or stream row; fires on the false→true crossing, one-time rules disable themselves, repeating rules re-arm with a 5-minute cooldown. Rules in `.local/price-alerts.json`; APIs `GET/POST /api/price-alerts`, `POST /api/price-alerts/delete` |
| `lib/warrants.mjs` | Warrant tracking (Taiwan, call warrants only, pure): FinMind warrant→underlying lookup (`TaiwanStockInfoWithWarrantSummary`, reused codes resolved by listing/last-trading date), TWSE `MI_INDEX` type 0999 and TPEx `tpex_warrant_daily_quts` quote parsing (`callWarrantQuotes` in `providers/twse.mjs`), issuer from the warrant name (the issuer head office's own warrants are excluded), per-branch aggregation by underlying (net amount, share of the underlying's call-warrant turnover, streaks; big-buy and consecutive-buy signals), and the per-stock warrant list. The broker watch queries `/taiwan_stock_warrant_trading_daily_report` once per tracked branch; APIs `GET /api/warrants?id=`, `GET /api/warrants/brokers?wid=&date=`; cache `.local/warrants/` |
| `lib/chipwatch.mjs` | Chip tracking (Taiwan, FinMind Sponsor): broker-branch tracking (one by-branch request per tracked branch after 18:30, `.local/broker-watch/<date>.json`, streaks; alerts for one-day dominance — net buying as a share of the day's volume plus a minimum amount — and multi-day accumulation as a share of total shares in custody) and the big-holder concentration ranking (whole-market shareholding table per week, `.local/holders-all/<date>.json`, 1- and 4-week change). APIs `/api/chipwatch*`, `/api/holders/rank*`; `POST /api/chipwatch/query` runs in the background (202) and the pages poll `GET /api/chipwatch?date=` for progress (`busy`, `query`) |
| `lib/stream.mjs` | Live-stream client (WebSocket): auth, per-channel batched subscriptions, heartbeat check, reconnect with backoff, events flushed in batches; `createStreamPool` spreads symbols over several connections |
| `lib/daytrade.mjs` | Day-trade engine (pure): per-stock state from trades / 1-minute bars / order book (or aggregates), VWAP, 5-minute bar state per watch-list stock, three signals (close above the 20MA = long; close below the 20MA or below the opening low = short), exclusions, backfill, previous-session turnover ranking, after-close review for both sides |
| `lib/daytrade-context.mjs`, `lib/daytrade-history.mjs` | 5-minute helpers (1-minute → 5-minute aggregation, 20MA cross, opening low) and the queue/cache that loads the previous sessions' 5-minute bars (one historical request per stock) |
| `lib/daytrade-market.mjs` | Day-trade market context (pure, record-only): per-index minute series (TAIEX / TPEx) fed from snapshot rows `001`/`101` or Fugle index candles, change, 15-minute change, time-weighted intraday average, breadth; tailwind / neutral / headwind and relative-strength rules; the `market` record stored with each signal and used to group the review |
| `lib/patterns.mjs`, `lib/pattern-service.mjs` | Pattern detection and the whole-market pattern snapshot |
| `lib/grouprank.mjs` | Research-group ranking (turnover-weighted gain) |
| `lib/llm.mjs`, `lib/report.mjs` | AI providers (structured JSON output) and the after-market report |
| `lib/flows.mjs`, `lib/market-card.mjs`, `lib/insight.mjs` | Taiwan-specific modules built on FinMind datasets (institutional/options overview, report card, brokers, shareholding) |
| `lib/briefing.mjs`, `lib/newswatch.mjs` | Today's Brief (news, economic and earnings calendars) and news push (the data source's market news plus, for Taiwan, the cnyes news list via `lib/providers/cnyes.mjs`; the same article on both sources pushes once, a newly added source is recorded silently the first time) |
| `lib/scope.mjs`, `lib/watchgroups.mjs`, `lib/access.mjs` | Research groups, watchlist groups, Cloudflare Access JWT verification |

Front end (`public/`): `app.js` (shell and pages), `setup.js` (setup wizard and system settings), `market.js`
(client-side market clock, colors and units), `i18n.js` (translation), plus page modules. `i18n.js`, `market.js`,
`insight-ui.js`, `report-card.js`, `flow-cards.js`, `save-image.js` and `intraday.js` are shared with Pocket as identical copies;
a test fails if they drift apart.

### Data source router

Every provider module (`lib/providers/*.mjs`) exports an object:

```js
{
  id, name, site, docs,
  markets: ['TW', ...],              // markets it covers
  key: 'required' | 'none', keyEnv,  // key requirement and environment-variable override
  interval,                          // minimum milliseconds between requests
  caps: { daily: 1, snapshot: 'paid', universe: ['US'], institutional: 'bulk', ... },
  snapshotMode: 'market' | 'symbols',// whole-market snapshot or per-symbol quotes
  stream: { url, plans, plan(info, setting), channels: { full, lite }, auth(key), subscribe(symbols, channel), batch, parse(msg, market) }, // optional live stream
  streamBackfill(id, ctx),           // REST catch-up after a reconnect (quote + 1-minute bars)
  async validate(key) { return { plan, tier: 'free' | 'paid' | 'sponsor', ... } },
  daily(id, from, to, ctx), snapshot(ids, ctx), ...   // one function per capability
}
```

Capability values: `1` available, `'paid'` / `'sponsor'` only when the verified tier allows it, an array limits it to
some markets, `'bulk'` (institutional) means research updates use whole-market days. `providers/index.mjs` picks a
provider per capability (preferred source first, then the enabled order), injects the key, interval and market into
`ctx`, and exposes `data.<capability>()` to the rest of the app. `capabilityMap()` tells the UI which features exist.

Capabilities: `universe, calendar, daily, adjusted, dailyAll, snapshot, stream, dayTrade, intraday, news, marketNews,
valuation, revenue, institutional, institutionalAll, brokers, holders, flows, futures, margin`.

`stream` (Fugle WebSocket) only drives the intraday radar and live board. During the session `server.mjs` opens it for
the watchlist first, then the research list, up to `stream.limit` for the verified plan, and refreshes the list when it
changes. Stream rows use the live-snapshot format plus `volume_at_bid` / `volume_at_ask`; the radar takes stream rows
for subscribed stocks and snapshot rows for the rest, and quotes use whichever row is newer. The heatmap and time machine
keep using snapshots. The key is sent only in the auth message, never in the URL.

Day-trade monitoring (Taiwan): the watch list is the previous session's highest-turnover stocks (shares traded ÷ TDCC
share count, ranked once before the open from the heatmap record and the latest whole-market shareholding file) plus
every stock in the research groups; both sources, and the personal watchlist, are switches in the settings. Watch-list
stocks are added to the stream. Full mode — trades, 1-minute bars and order book per stock, split over the plan's
connections by sorted symbol — is used when the watchlist and the watch list both fit; otherwise lite mode (aggregates,
one subscription per stock). `auto` plan tries full mode and falls back to lite for the day when the subscriptions come
up short. `lib/daytrade.mjs` turns the events into snapshot rows (so the radar and board keep working) and, three
seconds after each 5-minute bar ends, checks the watch-list stocks once: close above the 20MA (long), close below the
20MA (short), close below the opening low (short). The 20MA runs across sessions, so `lib/daytrade-history.mjs` loads
the previous sessions' 1-minute bars (one Fugle historical request per stock, cached for the day as 5-minute bars).
Pre-market data comes from the `dayTrade` capability (FinMind: day-trade list, suspensions, sell-first bans, reference
prices) and TWSE/TPEx disposition lists. After a reconnect (or a mid-session start) every stock is backfilled through
`streamBackfill` before it can signal again. Signals go to the radar (`dt-ma-up`, `dt-ma-down`, `dt-open-low`) and
push — Pocket sends the signals of one bar as a single notification; after the close they are evaluated against
1-minute bars (long: buy then sell; short: sell then buy back) and stored in `.local/daytrade/<date>.json`.
APIs: `GET /api/daytrade`, `GET /api/daytrade/review`, `POST /api/daytrade/settings`.
Market context (record only): every signal stores a `market` record for its own index — TAIEX for listed stocks, TPEx
for OTC stocks — taken from the snapshot index rows every 10 seconds (no extra requests); when the snapshot has no index
rows for 90 seconds, or a mid-session start misses the open, the server polls Fugle index quote + 1-minute candles at most
once a minute per index. `GET /api/daytrade` returns the current `market` state; `GET /api/daytrade/review` groups long
signals by regime and relative strength. Signals and alerts do not use it.
Details and formulas: [DAYTRADE.zh-TW.md](DAYTRADE.zh-TW.md), [features/daytrade-market.md](features/daytrade-market.md).

All providers return the internal row format (FinMind field names, so scoring and patterns work unchanged):

| Data | Row |
|---|---|
| Daily bar | `{ date, stock_id, open, max, min, close, Trading_Volume (shares), Trading_money, spread }` |
| Live snapshot | `{ stock_id, date 'YYYY-MM-DD HH:MM:SS' (market time), open, high, low, close, change_price, total_volume (display units), total_amount, yesterday_volume, buy_price, sell_price }` |
| Minute bar | `[HH:MM (start), open, high, low, close, volume (display units)]` |
| News | `{ date, stock_id, title, link, source }` |
| Valuation / revenue | `{ date, PER, PBR, dividend_yield }` / `{ date, revenue_year, revenue_month or revenue_quarter, revenue }` |

Errors are `DataError` with `code` `auth`, `quota` or `plan`, which the schedulers use to pause automatic requests.

### Storage

`EquiLens-Nexus/.local/` (or `EQUITY_DATA_DIR`): `config.json`, `settings.json`, `groups.json`, `watchlist.json`,
`universe.json`, `stocks/<symbol>.json`, `heatmap-*.json`, `replay/`, `alerts-*.json`, `reports/`, key files
(`*.dpapi` etc.). When the market is switched, the market-specific files move to `.local/markets/<MARKET>/` and the
target market's files move back.

## Pocket (`EquiLens-Pocket/`)

`server.mjs` serves the PWA and proxies `/m/api/*` to Nexus after password login (`lib/auth.mjs`). It relays new radar,
news and report events as Web Push notifications (`lib/push.mjs`, RFC 8291/8292 with Node's crypto). The interface
language, market profile, colors and remote-access settings come from Nexus `/api/profile`; translations are served from
Nexus `/locales/`.

Store apps (`EquiLens-App/`): native shells — Android (Kotlin, `WebView`) and iOS (Swift, `WKWebView`, project generated by
XcodeGen) — load the user's own Pocket URL, or built-in pages: a connect screen and a demo mode that replays recorded API
responses from `web/demo/demo-api.json` (served by `WebViewAssetLoader` / a `WKURLSchemeHandler`; lookup keys follow
`tools/demo-keys.mjs`). Pages call native features through `window.EquiLensAndroid.postMessage` /
`window.webkit.messageHandlers.equilens` (`public/native.js`): push token, save image, keep awake, theme, switch server.
WebView does not support Web Push, so the app registers its FCM token with `POST /m/api/push/app-subscribe` together with the
relay URL built into the app; `lib/push.mjs` sends those devices' notifications to the relay (`EquiLens-App/relay/`, a
Cloudflare Worker holding the publisher's Firebase service account), which calls FCM HTTP v1. Relay 404/410 removes the device.

Layout (`public/layout.js`): Pocket picks one of three layouts from the viewport size, the fold reported by the Viewport
Segments API (when available) and the user's preference, and marks it on `<html data-layout="phone|split|stack"
data-pane="on|off">` with CSS variables for the page sizes. `phone` is the single page with a bottom tab bar. `split`
puts a tab rail and the list on the left and docks the stock sheet as a pane on the right. `stack` docks the pane on top
and keeps the list and tab bar below. The pane is the same element as the phone's bottom sheet. Docked, it does not
cover the list, so list views keep refreshing, and it shows the index chart when idle. Layout changes (fold, unfold,
rotate) re-dock or un-dock the open sheet and repaint its chart at the new width. Shared views use container queries,
so they adapt to the width of the page they are in rather than the viewport. The decision function `decideLayout` is
pure and tested in `tests/layout.test.mjs`.

Remote access (`lib/remote.mjs`): Pocket binds to `127.0.0.1`, so every external request arrives through a local tunnel or
reverse proxy. The connection mode chosen in Nexus (`auto`, `cloudflare-quick`, `cloudflare-named`, `custom`, `off`) decides
which hosts are allowed (the domains entered in Nexus, plus `*.trycloudflare.com` only for quick tunnels) and which headers
are trusted for the client IP and HTTPS (`CF-Connecting-IP` / `CF-Visitor` for Cloudflare, `X-Real-IP` or the last
`X-Forwarded-For` entry / `X-Forwarded-Proto` for a self-managed proxy). The latest settings are cached in
`.local/remote-cache.json`; an unknown host triggers at most one settings refresh every 15 seconds. The start scripts read
the same mode to decide whether to run `cloudflared`.

## Extending

**Add a data source** – create `lib/providers/<id>.mjs` following the shape above, register it in `PROVIDERS` in
`lib/providers/index.mjs`, add a description in `public/setup.js` (`PROVIDER_NOTES`), add tests with mocked responses,
and translate any new strings.

**Add a market** – add an entry to `MARKETS` in `lib/markets.mjs` (time zone, sessions, lot, ticks, limits, symbol
regex, replay scales, liquidity threshold), map it in the providers that cover it (e.g. Twelve Data `VENUE`), and
optionally add `data/templates/<MARKET>.json` sample groups.

**Add an AI service** – add it to `LLM_INFO`, `generateJSON` and `listModels` in `lib/llm.mjs`, and to
`LLM_PROVIDERS` in `lib/config.mjs`.

**Add a language** – add `public/locales/<lang>.json` (keys are the Traditional Chinese source strings, `{name}` /
`{0}` placeholders must match), add the code to `LANGUAGES` in `lib/config.mjs` and the language pickers in
`public/setup.js`, then run `node tools/i18n-keys.mjs --missing <lang>` until it reports 0. The UI translates text
nodes and `placeholder` / `title` / `aria-label` automatically; mark user data with `translate="no"`.

README screenshots live in `docs/images/` and are regenerated with `EquiLens-Nexus/tools/screenshots/` (synthetic sample data, a fixed clock and no outbound requests; see its README).

## Tests

`npm test` in each component. Nexus tests cover scoring, patterns, heatmap, radar, replay, providers' row handling,
market rules, the setup and market-switch APIs (on a temporary data folder and port), secrets and translations.
