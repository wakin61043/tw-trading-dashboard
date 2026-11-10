// 衡析 Pocket — 手機版網頁伺服器。只綁定 127.0.0.1，對外由 Cloudflare Tunnel 轉入；所有資料 API 需登入。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, read } from './lib/storage.mjs';
import * as auth from './lib/auth.mjs';
import * as nexus from './lib/nexus.mjs';
import * as push from './lib/push.mjs';
import { setLanguage, getLanguage } from './public/i18n.js';
import { loadRemote, storeRemote, allowHost, clientIp as ipOf, isHttps as httpsOf } from './lib/remote.mjs';

export const APP_VERSION = '2.0.0';
const PORT = Number(process.env.PORT || 4340);
const COOKIE = 'np_sid';
const config = read('config.json', {});
const extraHosts = [...(config.hosts || []), ...String(process.env.MOBILE_HOSTS || '').split(',')].map(h => h.trim().toLowerCase()).filter(Boolean);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/heatmap.js': ['heatmap.js', 'text/javascript; charset=utf-8'], '/flow-cards.js': ['flow-cards.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/live.js': ['live.js', 'text/javascript; charset=utf-8'], '/chips.js': ['chips.js', 'text/javascript; charset=utf-8'], '/layout.js': ['layout.js', 'text/javascript; charset=utf-8'], '/native.js': ['native.js', 'text/javascript; charset=utf-8'], '/intraday.js': ['intraday.js', 'text/javascript; charset=utf-8'], '/insight-ui.js': ['insight-ui.js', 'text/javascript; charset=utf-8'], '/report-card.js': ['report-card.js', 'text/javascript; charset=utf-8'], '/save-image.js': ['save-image.js', 'text/javascript; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/market.js': ['market.js', 'text/javascript; charset=utf-8'],  '/icon-192.png': ['icon-192.png', 'image/png'], '/badge-96.png': ['badge-96.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['icon-192.png', 'image/png'],
};

// 前端版本號：public 內檔案的修改時間雜湊（改了網頁檔即變更，手機 App 回到前景時會自動重新載入）
let buildCache = { at: 0, id: '' };
export function buildId() {
  if (Date.now() - buildCache.at < 5000) return buildCache.id;
  const dir = path.join(ROOT, 'public'), sig = fs.readdirSync(dir).sort().map(f => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|');
  let h = 0; for (const c of sig) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  buildCache = { at: Date.now(), id: h.toString(36) }; return buildCache.id;
}
// 前端模組的相對 import（靜態與動態）加上 ?v=版本號
export const versionImports = (src, v) => src.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\/[\w-]+\.js)\2/g, `$1$2$3?v=${v}$2`);
// 允許的網域：本機、電腦版「遠端存取」設定的手機版網域、本資料夾 .local/config.json 的 hosts 與環境變數 MOBILE_HOSTS（防 DNS rebinding）
let remote = loadRemote();
export function hostAllowed(host) { return allowHost(host, { port: PORT, extra: extraHosts, remote }); }
const isHttps = req => httpsOf(req, remote?.tunnel);
const clientIp = req => ipOf(req, remote?.tunnel);
function cookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(p => p.trim().split('=')).filter(p => p.length === 2)); }
function send(req, res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'Content-Type': type, 'Cache-Control': type.startsWith('application/json') ? 'no-store' : 'no-cache', ...extra };
  if (buf.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && !type.startsWith('image/png')) { buf = zlib.gzipSync(buf); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers); res.end(req.method === 'HEAD' ? undefined : buf);
}
async function body(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 4096) throw Object.assign(new Error('請求內容過大'), { status: 413 }); } try { return JSON.parse(s || '{}'); } catch { throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); } }
const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d).toISOString().slice(0, 10) === d;
// 股票代號：各市場格式不同（2330、AAPL、BRK.B、7203、005930），詳細格式由 Nexus 依市場檢查
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9.&\-]{0,15}$/.test(id) && !id.includes('..');
const todayTW = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const minusDays = (d, n) => new Date(Date.parse(d) - n * 864e5).toISOString().slice(0, 10);

// Nexus 的市場、語言與配色（5 分鐘更新一次）：手機版畫面與推播文字依此顯示
let profileCache = { at: 0, data: null }, hostRefreshAt = 0;
async function profile(force = false) {
  if (!force && profileCache.data && Date.now() - profileCache.at < 300000) return profileCache.data;
  try {
    const p = await nexus.profile(); profileCache = { at: Date.now(), data: p };
    if (p.language !== getLanguage()) await setLanguage(p.language, nexus.NEXUS_URL);
    if (p.remote) remote = storeRemote(p.remote);
    // 推播聯絡方式：手機版網址優先，否則用推播聯絡信箱
    if (p.publicUrl) push.setSubject(p.publicUrl); else if (p.remote?.contact) push.setSubject(`mailto:${p.remote.contact}`);
  } catch { }
  return profileCache.data;
}

let flowLatest = null;
async function latestFlows() {
  if (flowLatest && Date.now() - flowLatest.at < 300000) return flowLatest.data;
  let found = null;
  for (let i = 0; i < 14 && !found; i++) { const r = await nexus.flows(minusDays(todayTW(), i)).catch(() => null); if (r?.data) found = r.data; }
  flowLatest = { at: Date.now(), data: found };
  return found;
}

async function summary() {
  const s = await nexus.state();
  const watch = s.watchlist || [];
  const stocks = s.stocks.map(x => nexus.slimStock(x, watch));
  let patternRows = [], patternMeta = null;
  try { const p = await nexus.patterns(); patternRows = nexus.slimPatternRows(p); patternMeta = { asOf: p.asOf, matched: p.matched, count: p.patternCount }; } catch { }
  const flows = await latestFlows().catch(() => null);
  const dataDate = stocks.map(x => x.asOf).filter(Boolean).sort().at(-1) || null;
  return {
    appVersion: APP_VERSION, nexusVersion: s.appVersion, dataDate, cutoff: s.cutoff, tokenConfigured: s.tokenConfigured, dataConfigured: s.dataConfigured ?? s.tokenConfigured, capabilities: s.capabilities || null,
    job: { running: s.job.running, message: s.job.message, done: s.job.done, total: s.job.total, finishedAt: s.job.finishedAt },
    heat: s.heatSummary || null, heatDates: s.heatDates || [], index: s.indexSummary || null,
    watch: stocks.filter(x => x.watch),
    movers: [...stocks].filter(x => x.change != null && x.asOf === dataDate).sort((a, b) => b.change - a.change),
    strong: stocks.filter(x => x.score != null).sort((a, b) => b.score - a.score).slice(0, 8),
    groups: (s.sectors || []).map(nexus.slimGroup).filter(g => g.score != null).sort((a, b) => b.score - a.score).slice(0, 6),
    patterns: patternRows.filter(r => ['量價確認', '突破待次日確認'].includes(r.status)).slice(0, 6), patternMeta,
    flows: nexus.slimFlows(flows),
  };
}

async function api(req, res, url) {
  const route = url.pathname.slice('/m/api/'.length), q = url.searchParams;
  if (req.method === 'GET') {
    if (route === 'summary') return send(req, res, 200, await summary());
    if (route === 'stocks') { const s = await nexus.state(); return send(req, res, 200, { dataDate: s.stocks.map(x => x.asOf).filter(Boolean).sort().at(-1) || null, stocks: s.stocks.map(x => nexus.slimStock(x, s.watchlist || [])), groups: (s.sectors || []).map(nexus.slimGroup), weights: s.weights, watchlist: s.watchlist || [], watchGroups: s.watchGroups || { groups: [], assign: {} }, watchExtra: (s.watchExtra || []).map(nexus.slimWatchExtra) }); }
    if (route === 'stock') { if (!validId(q.get('id'))) throw Object.assign(new Error('股票代碼格式錯誤'), { status: 400 }); const [d, s] = await Promise.all([nexus.detail(q.get('id')), nexus.state()]); return send(req, res, 200, { ...nexus.slimDetail(d), watch: (s.watchlist || []).includes(d.id), weights: s.weights }); }
    if (route === 'heatmap') { const date = q.get('date') || 'latest'; if (date !== 'latest' && !validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.heatmap(date)); }
    if (route === 'heatmap/live') return send(req, res, 200, await nexus.heatmapLive());
    if (route === 'monitor') return send(req, res, 200, { ...(await nexus.monitor()), pushCount: push.subscriptionCount() });
    if (route === 'daytrade') return send(req, res, 200, await nexus.daytrade());
    if (route === 'daytrade/review') return send(req, res, 200, await nexus.daytradeReview());
    if (route === 'alerts') { const date = q.get('date'); if (date && !validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.alerts(Number(q.get('since') || 0), date)); }
    if (route === 'board') { const ids = q.get('ids') ? q.get('ids').split(',') : null, group = q.get('group') || null; if ((ids && (ids.length > 60 || !ids.every(validId))) || (group && !/^[\w-]{1,40}$/.test(group))) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.board(ids, group)); }
    if (route === 'replay/days') return send(req, res, 200, await nexus.replayDays());
    if (route === 'replay') { const date = q.get('date'); if (date && !validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.replay(date)); }
    if (route === 'replay/frame') { const date = q.get('date'), i = Number(q.get('i')); if (!validDate(date || '') || !Number.isInteger(i) || i < 0) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.replayFrame(date, i)); }
    if (route === 'index') { if (!['TAIEX', 'TPEX'].includes(q.get('id'))) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.index(q.get('id'))); }
    if (route === 'intraday') { const group = q.get('group') || ''; if (!validId(q.get('id')) || (group && !/^[A-Za-z0-9_-]{1,40}$/.test(group))) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.intraday(q.get('id'), group)); }
    if (route === 'chart') { const period = q.get('period') || '5m'; if (!validId(q.get('id')) || !['day', '5m'].includes(period)) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.chart(q.get('id'), period)); }
    if (route === 'brokers') { if (!validId(q.get('id'))) throw Object.assign(new Error('股票代碼格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.brokers(q.get('id'), Number(q.get('days') || 5))); }
    if (route === 'warrants') { if (!validId(q.get('id'))) throw Object.assign(new Error('股票代碼格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.warrants(q.get('id'))); }
    if (route === 'warrants/brokers') { const wid = String(q.get('wid') || '').toUpperCase(), date = q.get('date'); if (!/^[0-9][0-9A-Z]{5}$/.test(wid) || !validDate(date)) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.warrantBrokers(wid, date)); }
    if (route === 'holders') { if (!validId(q.get('id'))) throw Object.assign(new Error('股票代碼格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.holders(q.get('id'))); }
    if (route === 'grouprank') { const date = q.get('date'); if (date && date !== 'latest' && !validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.grouprank(date)); }
    if (route === 'report/card') { const date = q.get('date'); if (date && !validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.reportCard(date)); }
    if (route === 'report') { const date = q.get('date'); if (date && date !== 'latest' && !validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.report(date)); }
    if (route === 'price-alerts') return send(req, res, 200, await nexus.priceAlerts());
    if (route === 'chipwatch') { const date = q.get('date'); if (date && date !== 'latest' && !validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.chipwatch(date)); }
    if (route === 'chipwatch/branches') { const k = String(q.get('q') || '').trim(); if (k.length > 30) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.brokerSearch(k)); }
    if (route === 'holders/rank') { const scope = q.get('scope') || 'mine', date = q.get('date'); if (!['mine', 'market'].includes(scope) || (date && date !== 'latest' && !validDate(date))) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.holderRank(scope, date)); }
    if (route === 'push/key') return send(req, res, 200, { publicKey: push.publicKey(), count: push.subscriptionCount(), subscribed: q.get('endpoint') ? push.hasSubscription(q.get('endpoint')) : q.get('token') ? push.hasApp(q.get('token')) : null });
    if (route === 'job') { const { job: j = {}, busy } = await nexus.job(); return send(req, res, 200, { running: !!j.running, busy: !!busy, done: j.done || 0, total: j.total || 0, current: j.current || null, message: j.message || '', errors: (j.errors || []).length, finishedAt: j.finishedAt || null }); }
    if (route === 'patterns') { const p = await nexus.patterns(); return send(req, res, 200, { asOf: p.asOf, from: p.from, matched: p.matched, count: p.patternCount, eligible: p.eligible, rows: nexus.slimPatternRows(p) }); }
    if (route === 'pattern') {
      if (!validId(q.get('id'))) throw Object.assign(new Error('股票代碼格式錯誤'), { status: 400 });
      const s = await nexus.patternDetail(q.get('id')), m = s.matches.find(x => x.id === q.get('pid')) || s.matches[0];
      return send(req, res, 200, { id: s.id, name: s.name, sector: s.sector, market: s.market, asOf: s.asOf, price: s.price, avg5: s.avg5, bars: s.bars.map(b => [b.date, b.open, b.max, b.min, b.close, b.volume]), match: m });
    }
    if (route === 'briefing/news') { const offset = Number(q.get('offset') || 0); if (![0, 1].includes(offset)) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.briefingNews(offset, q.get('refresh') === '1')); }
    if (route === 'briefing/week') return send(req, res, 200, await nexus.briefingWeek(q.get('refresh') === '1'));
    if (route === 'flows') { const date = q.get('date'); if (date === 'latest' || !date) return send(req, res, 200, { data: await latestFlows() }); if (!validDate(date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.flows(date)); }
  }
  if (req.method === 'POST') {
    const b = await body(req);
    if (route === 'heatmap/query') { if (!validDate(b.date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.heatmapQuery(b.date)); }
    if (route === 'update') {
      if (!['watchlist', 'all', 'selected'].includes(b.scope)) throw Object.assign(new Error('更新範圍無效'), { status: 400 });
      const ids = b.scope === 'selected' ? b.ids : [];
      if (b.scope === 'selected' && (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every(validId))) throw Object.assign(new Error('股票代碼格式錯誤'), { status: 400 });
      return send(req, res, 202, await nexus.update(b.scope, ids));
    }
    if (route === 'pattern-update') return send(req, res, 202, await nexus.patternUpdate());
    if (route === 'news') { if (!validId(b.id)) throw Object.assign(new Error('股票代碼格式錯誤'), { status: 400 }); return send(req, res, 202, await nexus.stockNews(b.id)); }
    if (route === 'cancel') return send(req, res, 200, await nexus.cancel());
    if (route === 'grouprank/query') return send(req, res, 200, await nexus.grouprankQuery());
    if (route === 'monitor/settings') return send(req, res, 200, await nexus.monitorSettings({ monitor: b.monitor, radar: b.radar }));
    if (route === 'news/settings') {
      if (typeof b.enabled !== 'boolean' || !['all', 'watch'].includes(b.scope) || typeof b.quiet !== 'boolean') throw Object.assign(new Error('資料格式錯誤'), { status: 400 });
      return send(req, res, 200, await nexus.newsSettings({ enabled: b.enabled, scope: b.scope, quiet: b.quiet }));
    }
    if (route === 'price-alerts') {
      // 新增（stockId）或修改（id）自訂提醒；條件與數值由 Nexus 檢查
      const ok = (b.id === undefined || (typeof b.id === 'string' && /^[\w-]{1,40}$/.test(b.id))) && (b.stockId === undefined || validId(b.stockId)) && (b.id !== undefined || b.stockId !== undefined)
        && (b.kind === undefined || typeof b.kind === 'string') && (b.value === undefined || Number.isFinite(Number(b.value))) && (b.repeat === undefined || typeof b.repeat === 'boolean') && (b.active === undefined || typeof b.active === 'boolean') && (b.note === undefined || (typeof b.note === 'string' && b.note.length <= 60));
      if (!ok) throw Object.assign(new Error('資料格式錯誤'), { status: 400 });
      return send(req, res, 200, await nexus.priceAlertSave({ id: b.id, stockId: b.stockId, kind: b.kind, value: b.value, repeat: b.repeat, active: b.active, note: b.note }));
    }
    if (route === 'price-alerts/delete') { if (typeof b.id !== 'string' || !/^[\w-]{1,40}$/.test(b.id)) throw Object.assign(new Error('資料格式錯誤'), { status: 400 }); return send(req, res, 200, await nexus.priceAlertDelete(b.id)); }
    if (route === 'chipwatch/query') { if (b.date && !validDate(b.date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 202, await nexus.chipwatchQuery(b.date ? { date: b.date } : {})); }
    if (route === 'holders/rank/query') return send(req, res, 200, await nexus.holderRankQuery());
    if (route === 'chipwatch/settings') {
      const br = b.branches; if (br !== undefined && (!Array.isArray(br) || br.length > 20 || !br.every(x => x && typeof x.id === 'string' && /^[\w]{1,10}$/.test(x.id) && typeof x.name === 'string' && x.name.length <= 40))) throw Object.assign(new Error('資料格式錯誤'), { status: 400 });
      const nums = ['dayPct', 'minAmount', 'accumPct', 'accumDays', 'warrantAmount', 'warrantPct', 'warrantDays'];
      if ((b.auto !== undefined && typeof b.auto !== 'boolean') || nums.some(k => b[k] !== undefined && !Number.isFinite(Number(b[k]))) || (b.holdersPush !== undefined && typeof b.holdersPush !== 'boolean') || (b.warrants !== undefined && typeof b.warrants !== 'boolean')) throw Object.assign(new Error('資料格式錯誤'), { status: 400 });
      return send(req, res, 200, await nexus.chipwatchSettings({ branches: br, auto: b.auto, holdersPush: b.holdersPush, warrants: b.warrants, ...Object.fromEntries(nums.filter(k => b[k] !== undefined).map(k => [k, Number(b[k])])) }));
    }
    if (route === 'report/generate') { if (b.date && !validDate(b.date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); return send(req, res, 202, await nexus.reportGenerate(b.date)); }
    // 推播聯絡網址：手機開啟通知時所用的 https 網址（Nexus 設定了對外網址時以該網址為準）
    if (route === 'push/subscribe') return send(req, res, 200, { ok: true, count: push.subscribe(b.subscription, req.headers['user-agent'], isHttps(req) ? `https://${req.headers.host}` : '') });
    if (route === 'push/unsubscribe') { push.unsubscribe(String(b.endpoint || '')); return send(req, res, 200, { ok: true }); }
    // 商店版 App：登記 FCM token 與 App 內建的推播中繼網址
    if (route === 'push/app-subscribe') return send(req, res, 200, { ok: true, count: push.subscribeApp({ token: b.token, platform: b.platform, relay: b.relay }, req.headers['user-agent']) });
    if (route === 'push/app-unsubscribe') { push.unsubscribeApp(String(b.token || '')); return send(req, res, 200, { ok: true }); }
    if (route === 'push/test') { const n = await push.sendToAll(push.localize({ title: '📡 衡析推播測試', body: '這台裝置已能收到盤中雷達與 AI 日報通知。', tag: 'test', url: '/#live' })); return send(req, res, 200, { ok: true, sent: n }); }
    if (route === 'flows/query') { if (!validDate(b.date)) throw Object.assign(new Error('日期格式錯誤'), { status: 400 }); const r = await nexus.flowsQuery(b.date); flowLatest = null; return send(req, res, 200, r); }
    if (route === 'watch') {
      // 自選可加入研究名單以外的股票（例如型態選股），並指定自訂分組（group：分組代號，'' 為未分組，省略則不改）
      if (!validId(b.id) || typeof b.on !== 'boolean' || (b.group !== undefined && (typeof b.group !== 'string' || !/^(w\d{1,4})?$/.test(b.group)))) throw Object.assign(new Error('資料格式錯誤'), { status: 400 });
      const r = await nexus.watchSet({ id: b.id, on: b.on, ...(b.group !== undefined ? { group: b.group } : {}) });
      return send(req, res, 200, { ok: true, watch: b.on, watchlist: r.watchlist, watchGroups: r.watchGroups });
    }
    if (route === 'group-stock') { // 把股票加入既有的研究族群（族群的新增、改名、刪除仍在電腦版）
      if (typeof b.groupId !== 'string' || !/^[\w-]{1,64}$/.test(b.groupId) || !validId(b.stockId)) throw Object.assign(new Error('資料格式錯誤'), { status: 400 });
      const r = await nexus.groupStockAdd(b.groupId, b.stockId); return send(req, res, 200, { ok: true, added: !!r.added, needsUpdate: !!r.needsUpdate });
    }
    if (route === 'watch/groups') {
      const list = b.groups; if (!Array.isArray(list) || list.length > 30 || !list.every(g => g && typeof g.name === 'string' && g.name.length <= 40 && (g.id === undefined || /^w\d{1,4}$/.test(g.id)))) throw Object.assign(new Error('資料格式錯誤'), { status: 400 });
      return send(req, res, 200, await nexus.watchGroups(list.map(g => ({ id: g.id, name: g.name }))));
    }
  }
  return send(req, res, 404, { error: '不存在的操作' });
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (!hostAllowed(req.headers.host)) {
    // 剛在電腦版新增的網域：最多每 15 秒向 Nexus 重新讀取一次設定後再判斷
    if (Date.now() - hostRefreshAt > 15000) { hostRefreshAt = Date.now(); await profile(true); }
    if (!hostAllowed(req.headers.host)) return send(req, res, 403, { error: '不允許的主機名稱' });
  }
  try {
    const url = new URL(req.url, 'http://localhost'), route = url.pathname;
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (req.headers['x-requested-with'] !== 'nexus-pocket' || (origin && ![`https://${req.headers.host}`, `http://${req.headers.host}`].includes(origin))) return send(req, res, 403, { error: '請重新整理頁面後再試' });
    }
    if (route.startsWith('/m/')) {
      if (!auth.passwordConfigured()) return send(req, res, 503, { error: '尚未設定手機版密碼，請在電腦上執行「設定手機密碼.cmd」', setup: true });
      const sid = cookies(req)[COOKIE];
      if (route === '/m/auth/login' && req.method === 'POST') {
        const ip = clientIp(req), blocked = auth.loginBlocked(ip);
        if (blocked) return send(req, res, 429, { error: blocked });
        const b = await body(req);
        if (!auth.checkPassword(b.password)) { auth.recordFail(ip); await new Promise(r => setTimeout(r, 400)); return send(req, res, 401, { error: '密碼錯誤' }); }
        auth.clearFails(ip);
        const s = auth.createSession(String(req.headers['user-agent'] || '').slice(0, 120));
        return send(req, res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=${s.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${s.maxAge}${isHttps(req) ? '; Secure' : ''}` });
      }
      if (route === '/m/auth/logout' && req.method === 'POST') { auth.destroySession(sid); return send(req, res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }); }
      if (!auth.validSession(sid)) return send(req, res, 401, { error: '請先登入', login: true });
      if (route === '/m/auth/me') return send(req, res, 200, { ok: true, appVersion: APP_VERSION, profile: await profile() });
      if (route.startsWith('/m/api/')) return await api(req, res, url);
      return send(req, res, 404, { error: '不存在的操作' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return send(req, res, 405, { error: '不支援的請求' });
    if (route === '/health') return send(req, res, 200, { ok: true, app: 'equilens-pocket', version: APP_VERSION, build: buildId(), lang: (await profile())?.language || getLanguage() }); // 登入前也要知道介面語言
    // 介面翻譯字典由 Nexus 提供（電腦版與手機版共用同一份）
    const loc = /^\/locales\/([a-z]{2}(?:-[A-Z]{2})?)\.json$/.exec(route);
    if (loc) { const d = await nexus.locale(loc[1]).catch(() => null); return d ? send(req, res, 200, d, 'application/json; charset=utf-8') : send(req, res, 404, { error: '頁面不存在' }); }
    const file = STATIC[route]; if (!file) return send(req, res, 404, { error: '頁面不存在' });
    if (route === '/') return send(req, res, 200, fs.readFileSync(path.join(ROOT, 'public', file[0]), 'utf8').replace(/(\/app\.(?:js|css))"/g, `$1?v=${buildId()}"`), file[1]);
    // Cloudflare 會把 js／css 的瀏覽器快取改成 4 小時：模組互相 import 時一律加上版本號，改版後手機才會取到新檔
    if (file[0].endsWith('.js') && file[0] !== 'sw.js') return send(req, res, 200, versionImports(fs.readFileSync(path.join(ROOT, 'public', file[0]), 'utf8'), buildId()), file[1]);
    return send(req, res, 200, fs.readFileSync(path.join(ROOT, 'public', file[0])), file[1]);
  } catch (e) {
    const status = e.status || 500;
    send(req, res, status, { error: status === 500 ? '操作失敗，請稍後再試' : e.message, nexusDown: status === 503 });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server.mjs')) {
  server.listen(PORT, '127.0.0.1', () => console.log(`EquiLens Pocket ready: http://127.0.0.1:${PORT}`));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `連接埠 ${PORT} 已使用` : '手機版服務啟動失敗'); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
  // 推播轉送：每 2 秒向 Nexus（本機）取新的雷達／日報事件，推到已開啟通知的手機；只推 10 分鐘內的事件，避免重啟後補發舊訊息。
  // 當沖訊號在每根 5 分 K 走完時一起產生：同一批合成一則推播（分多方、空方列出）；其他事件各自推播。
  let relayBusy = false;
  setInterval(async () => {
    if (relayBusy) return; relayBusy = true;
    try {
      const r = await nexus.alerts(push.lastSeq());
      if (r.latest > push.lastSeq()) {
        const fresh = r.alerts.filter(a => Date.now() - Date.parse(a.at) < 10 * 60e3);
        await profile();
        const { signals, rest } = push.splitDayTrade(fresh), dayTrade = push.dayTradeNotification(signals);
        if (push.subscriptionCount()) for (const n of [...push.notificationsFor(rest), ...(dayTrade ? [dayTrade] : [])]) await push.sendToAll(n);
        push.setLastSeq(r.latest);
      }
    } catch { } finally { relayBusy = false; }
  }, 2000).unref();
}
