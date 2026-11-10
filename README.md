# EquiLens (衡析) · Taiwan stock trading dashboard

**A self-hosted Taiwan stock trading dashboard and research desk (tw-trading-dashboard).** EquiLens runs on your own computer: it ranks the companies you choose to
research, shows where money is flowing, watches the market during the session, recognizes chart patterns and
writes an after-market report with the AI model of your choice. You bring your own data sources and API keys;
nothing is sent to anyone else.

[繁體中文說明](README.zh-TW.md) · [Feature guides (zh-TW)](docs/features/README.md) · [Changelog (zh-TW)](docs/CHANGELOG.zh-TW.md) · [Architecture](docs/ARCHITECTURE.md) · [Day-trade monitoring (zh-TW)](docs/DAYTRADE.zh-TW.md)

> EquiLens is a research tool. Scores rank research, they are not trading signals, price targets or return
> predictions. Nothing here is investment advice.

![Research overview: four-factor scores, 30-day sparklines and group pulse](docs/images/desktop-overview.webp)

<sub>All screenshots use synthetic sample data, not real market data. The interface is shown in Traditional Chinese; English is also available.</sub>

---

## What's inside

| Component | What it is | Default address |
|---|---|---|
| **EquiLens Nexus** (`EquiLens-Nexus/`) | The desktop app and the only data engine: research scores, sector heatmap, intraday radar, pattern scanner, AI report, settings | http://127.0.0.1:4330 |
| **EquiLens Pocket** (`EquiLens-Pocket/`) | Optional mobile web app (PWA) that reads from Nexus, protected by a password, reachable from your phone through a Cloudflare Tunnel; supports push notifications | http://127.0.0.1:4340 |

Both servers bind to `127.0.0.1` only. Your settings, research groups and cached market data live in each
component's `.local/` folder; API keys are encrypted by the operating system (see [Security](#security)).

### Features

- **Research overview** – a four-factor score (technical, institutional flows, topic evidence, industry trend) for every
  stock in *your* research groups, with transparent reasons, missing-data handling and an effective-weight disclosure.
- **Sector heatmap** – turnover-sized, change-colored treemap of the whole market (or of your research groups when the
  data source has no whole-market data), live during the session, with a per-minute **time machine** replay.
- **Intraday radar** – volume spikes, surges and plunges, price-limit touches, pattern entries and stop breaks for your
  watchlist and research groups, plus a live board with daily / 5-minute candles. **Custom alerts** let you set price,
  % change or projected-volume conditions on any stock; they are pushed to your phone when met (one-time or repeating). With a Fugle key the radar runs on a
  WebSocket live stream (watchlist first, up to your plan's limit) instead of periodic snapshots.
- **Day-trade monitoring** (Taiwan, FinMind + Fugle) – 5-minute bars only. The watch list is the previous session's
  highest-turnover stocks across the whole market (top 50 with at least NT$100M traded, by default) plus every stock in
  your research groups. A 5-minute close above the 20MA is a long signal; a close below the 20MA, or below the opening
  low (the low of the day's first 5-minute bar), is a short signal. Each bar is checked once when it ends, and the
  signals of one bar go out as a single phone notification. After the close every signal is reviewed net of costs.
  Alerts only, no orders. See [the rules and limitations](docs/DAYTRADE.zh-TW.md).
  Each signal also records the state of its own index (TAIEX for listed stocks, TPEx for OTC stocks: change, 15-minute
  change, position against the intraday average) and the stock's relative strength; the review groups outcomes by
  tailwind / neutral / headwind. This is recorded only — signals and alerts are unchanged
  ([details, zh-TW](docs/features/daytrade-market.md)).
- **Group ranking** – your research groups ranked by turnover-weighted gain, with daily close records.
- **Pattern scanner** – 10 classic patterns over 90 sessions with conditional entry and stop levels.
- **AI after-market report** – written by Claude, OpenAI, Gemini or any OpenAI-compatible endpoint (including local
  models), with a short note on every watchlist stock and a downloadable 9:16 summary card.
- **Chip tracking** (Taiwan, FinMind Sponsor) – track chosen broker branches (each branch's market-wide trades after the
  close, streaks, push above a threshold) and rank stocks by the weekly change in 1,000-lot holders. **Warrant tracking**
  adds each tracked branch's call-warrant trades grouped by underlying (big-buy and consecutive-buy alerts; the issuer's
  own market making is excluded) and a call-warrant panel in the stock window ([details, zh-TW](docs/features/warrants.md)).
- **Market-specific modules** – for Taiwan with FinMind: broker branches, shareholding distribution, institutional
  and futures/options flows.
- **Interface languages** – Traditional Chinese and English.

### Screenshots

| | |
|---|---|
| **Sector heatmap**<br>![Sector heatmap](docs/images/desktop-heatmap.webp) | **Live board and intraday radar**<br>![Live board and intraday radar](docs/images/desktop-radar.webp) |
| **Intraday chart window**<br>![Intraday chart window](docs/images/desktop-chart.webp) | **Day-trade scanner**<br>![Day-trade scanner](docs/images/desktop-daytrade.webp) |
| **Day-trade review by market regime**<br>![Day-trade review by market regime](docs/images/desktop-daytrade-review.webp) | **Group ranking**<br>![Group ranking](docs/images/desktop-grouprank.webp) |
| **AI after-market report**<br>![AI after-market report](docs/images/desktop-report.webp) | **Broker-branch tracking**<br>![Broker-branch tracking](docs/images/desktop-chips.webp) |
| **Institutional and futures/options flows**<br>![Institutional and futures/options flows](docs/images/desktop-flows.webp) | **Stock diagnosis**<br>![Stock diagnosis](docs/images/desktop-detail.webp) |
| **Pattern scanner**<br>![Pattern scanner](docs/images/desktop-patterns.webp) | **Topic evidence**<br>![Topic evidence](docs/images/desktop-topics.webp) |
| **Call-warrant panel**<br>![Call-warrant panel](docs/images/desktop-warrants.webp) | **Branch call-warrant trades**<br>![Branch call-warrant trades](docs/images/desktop-chips-warrants.webp) |

**Mobile (EquiLens Pocket)**

![Mobile: brief and AI report, live board, day trade, heatmap, stocks, broker branches](docs/images/mobile-overview.webp)

**Foldables and tablets** – the layout follows the screen shape. Regular phones and foldable cover screens keep a single
page. An unfolded foldable (for example iPhone Duo in landscape), a tablet or a phone in landscape splits into two
pages: tab rail and list on the left, the selected stock's chart, order book and trades on the right, and the TAIEX chart
when nothing is selected. Unfolded in portrait or half-folded on a desk, the chart sits on the top page and the list on
the bottom page. Where the browser reports the fold (Viewport Segments API), the split follows the hinge exactly
([details, zh-TW](docs/features/foldable.md)).

![iPhone Duo unfolded: live board on the left, chart and order book on the right](docs/images/foldable-split.webp)

**Store apps (Google Play / App Store)** – native Android and iOS shells (`EquiLens-App/`) that connect to your own
EquiLens Pocket. They add native push notifications delivered through Firebase via a small relay (a Cloudflare Worker
that stores nothing), saving cards to Photos, keep-screen-on, and a demo mode with synthetic sample data that works
without a computer. Build, signing and store-submission steps, store texts, privacy answers and screenshots are in
[EquiLens-App/README.md](EquiLens-App/README.md) (zh-TW); privacy policy: [docs/PRIVACY.md](docs/PRIVACY.md).

## Markets and data sources

One EquiLens instance researches one market at a time. Trading hours (including lunch breaks), time zone, tick
sizes, price limits, up/down colors, volume units and symbol formats all come from the market profile. When you
switch markets, each market's groups, watchlist and records are stored separately and restored when you switch back.

Supported markets: **Taiwan, United States, Japan, Hong Kong, South Korea, United Kingdom, Germany, France, Canada,
Australia, Singapore, India.**

| Data source | Markets | Key | Provides |
|---|---|---|---|
| [TWSE / TPEx open data](https://openapi.twse.com.tw) | TW | none | stock list, trading calendar, daily bars, whole-market daily data, institutional flows (whole market by day), P/E, monthly revenue |
| [FinMind](https://finmindtrade.com) | TW | free / Sponsor | daily and adjusted bars, institutional flows, revenue, P/E, news, shareholding, futures, margin; **Sponsor** adds live snapshots, minute bars, whole-market data, broker branches and the pre-market day-trade list, suspensions and reference prices |
| [Fugle](https://developer.fugle.tw) | TW | free / paid | daily (adjusted) and minute bars; WebSocket live stream for the intraday radar and day-trade monitoring (subscriptions: Basic 5, Developer 300, Advanced 2,000 — full mode uses trades + 1-minute bars + order book, 3 per stock; otherwise aggregates, 1 per stock); paid plans add a whole-market live snapshot |
| [Twelve Data](https://twelvedata.com) | all 12 markets | free / paid | stock list, daily bars, live quotes, minute bars |
| [Alpha Vantage](https://www.alphavantage.co) | US, GB, CA, DE, IN | free / premium | daily bars, quotes, news sentiment, P/E, quarterly revenue |

Enable several sources and EquiLens picks a source per capability (in your order, or as you specify under
*Data & Settings → Data sources → Advanced*). Features a source can't support are hidden or fall back to your
research list's local data — the settings page shows exactly which features are available.

A live-stream source (Fugle) only drives the intraday radar, live board and day-trade monitoring; the heatmap, time machine, research
updates and everything else keep using the snapshot and daily sources. Stocks beyond the stream plan's limit stay on
snapshots, and without a stream key nothing changes.

Free plans have tight quotas. EquiLens rate-limits every source, resumes interrupted updates and never assumes a higher
plan than the one detected when you saved the key.

## Requirements

- **Node.js 22 or newer** – https://nodejs.org
- Windows 10/11, macOS or Linux
- At least one data source that covers your market (TWSE/TPEx open data works for Taiwan without any key)
- Optional: an API key for an AI model; `cloudflared` for phone access

## Quick start

```bash
git clone https://github.com/wakin61043/tw-trading-dashboard.git
cd tw-trading-dashboard/EquiLens-Nexus
npm install --omit=dev
```

Start Nexus:

| Windows | macOS / Linux |
|---|---|
| double-click `EquiLens-Nexus\啟動衡析Nexus.cmd` (or `Start-Nexus.ps1`) | `./start.sh` |
| stop: `Stop-Nexus.ps1` | stop: `./stop.sh` |

Open http://127.0.0.1:4330. The first launch shows a **setup wizard**:

1. Interface language and the market to research
2. Data sources – tick the ones you want and paste their keys (each key is verified before it is saved)
3. AI model – service, key and model (optional; everything else works without it)
4. Research groups – create groups, load sample groups for your market, or import a settings file

Then press **Update** to download history for your research groups. Updates can be stopped and resumed.
Everything can be changed later under **Data & Settings**.

On Windows you can also double-click **安裝衡析.cmd** in the repository root: it checks Node.js, installs packages,
starts Nexus and opens the setup wizard (it also restores a `migration-data` folder exported from another computer).

### Phone access (optional)

```bash
cd EquiLens-Pocket
node scripts/set-password.mjs     # at least 10 characters
./start.sh                        # Windows: 啟動衡析手機版.cmd
```

`start.sh` starts Nexus if needed, starts Pocket and then opens the public address according to the **connection
mode** chosen under *Data & Settings → Remote access*. You decide the domain and the way traffic reaches your computer:

| Connection mode | What happens | You provide |
|---|---|---|
| Automatic (default) | Cloudflare fixed domain when `EquiLens-Pocket/.local/cloudflared.yml` exists, otherwise a temporary URL | – |
| Cloudflare temporary URL | a random `https://….trycloudflare.com` address (changes on restart) | `cloudflared` |
| Cloudflare fixed domain | your domain through a Cloudflare Named Tunnel | a domain on Cloudflare, `cloudflared.yml` |
| Self-managed | EquiLens starts no tunnel; you forward an HTTPS address to `http://127.0.0.1:4340` with ngrok, Tailscale Funnel, Caddy, Nginx… | any domain and HTTPS certificate |
| Off | Pocket only answers on this computer | – |

Enter your domain(s) under *Remote access*: only those hosts are accepted, and the main address is also the contact
for push notifications. See `EquiLens-Pocket/README.md` for step-by-step examples. Add Pocket to your home screen to
receive push notifications (iPhone: iOS 16.4+).

## Configuration

| Where | What |
|---|---|
| *Data & Settings* page | market, language, up/down colors, remote access (connection mode, domains, push contact, desktop remote access), data sources and keys, AI model, research groups, update schedule, score weights, radar and news push |
| `EquiLens-Nexus/.local/` | all Nexus data (`config.json`, groups, watchlist, cached prices, records) – never commit it |
| `EquiLens-Pocket/.local/` | password hash, sessions, push subscriptions, tunnel settings – never commit it |
| Settings file | *Data & Settings → Settings file* exports groups, watchlist and settings **without keys** for another computer |

Environment variables (optional): `PORT`, `EQUITY_DATA_DIR` (Nexus data folder), `MOBILE_DATA_DIR`, `NEXUS_URL`
(Pocket), and key overrides `FINMIND_API_TOKEN`, `FUGLE_API_KEY`, `TWELVEDATA_API_KEY`, `ALPHAVANTAGE_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LLM_API_KEY`.

## Security

- Servers listen on `127.0.0.1` only; write APIs require a CSRF token and same-origin requests.
- API keys are stored with the operating system's protection: **Windows DPAPI**, **macOS Keychain**, or
  **Secret Service** on Linux (a file readable only by you as a fallback). The web pages never read keys back.
- Pocket uses a scrypt password hash, login rate limiting, HttpOnly/SameSite cookies, a strict CSP and a host
  allow-list built from the domains you enter. Client IPs and HTTPS are read only from the headers of the connection
  mode you chose (Cloudflare or your own proxy), so headers from other sources can't bypass the login limits.
- Remote access to the full desktop app requires Cloudflare Access (it can change keys and every setting), and Nexus
  verifies every request's Access JWT itself; configure it under *Data & Settings → Remote access*.
- Your data stays on your computer. The only outbound requests go to the data sources and AI service you configure,
  plus public news and calendar feeds used by *Today's Brief*.

## Development

```bash
cd EquiLens-Nexus && npm test        # library, server and framework tests
cd EquiLens-Pocket && npm test
node EquiLens-Nexus/tools/i18n-keys.mjs --missing en   # interface strings without an English translation
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how markets, data sources, AI providers and languages plug in.

## Disclaimer

Market data belongs to its providers; respect each provider's terms and plan limits. EquiLens is provided as is,
without warranty, and is not investment advice.
