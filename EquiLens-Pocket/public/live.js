// 衡析 Pocket：盤中分頁（族群／自選即時看板、異動雷達、族群排名、雷達設定）、個股 K 線、熱浪時光機、個股籌碼深度、AI 盤後日報、推播訂閱。
import { esc, fmt, pct, cls, sparkSVG, candleSVG, brokerHTML, holderHTML, warrantHTML, warrantBrokersHTML, alertRow, alertMatch, isMove, ALERT_GROUPS, reportHTML, rotationData, rotationSVG, replayStocks, priceRuleForm, priceRulesHTML, priceRuleBody } from './insight-ui.js';
import { tx } from './i18n.js';
import { intradaySVG, readAt, legendHTML, bookHTML, tapeHTML } from './intraday.js';
import * as MK from './market.js';
import { docked, layout } from './layout.js';
import { APP, APP_PLATFORM, appCall, appInfo, onAppEvent } from './native.js';

let C = null; // { api, toast, draw, S, openSheet, openStock, inScope, aggregate, renderTreemap, heatColor, $, setSel }
const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, savePref = (k, v) => { try { localStorage.setItem(k, v); } catch { } };
const L = { view: 'board', board: null, boardAt: 0, bgroup: pref('pocket.boardGroup', ''), bsort: pref('pocket.boardSort', 'default'), alerts: [], latest: 0, alertDate: '', group: 'all', monitor: null, draft: null, push: { state: 'unknown', count: 0 }, report: null, reportLoaded: false, replay: null, error: '', rules: null };
export const liveState = L;
// 平台：iPhone／iPad（含 iPadOS 桌面版 UA）與是否從主畫面圖示開啟（iOS 只有主畫面 App 能收推播）
export const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushHelp = state => APP ? (state === 'unsupported' ? '這個版本的衡析 App 無法使用推播通知。' : APP_PLATFORM === 'ios' ? '通知權限已關閉，請到 iPhone「設定 → 通知 → 衡析」打開「允許通知」。' : '通知權限已關閉，請到手機「設定 → 應用程式 → 衡析 → 通知」開啟。')
  : state === 'unsupported'
  ? IOS ? STANDALONE ? '這支 iPhone 的系統版本不支援網頁推播，請更新到 iOS 16.4 以上。' : 'iPhone／iPad 要先加入主畫面才能收通知：用 Safari 開啟衡析手機版的網址 →「分享」→「加入主畫面」，再從主畫面的「衡析」圖示開啟，回到這裡按「開啟通知」（需 iOS 16.4 以上）。'
    : '這個瀏覽器不支援推播。請用 Chrome 安裝到主畫面的 App 開啟。'
  : IOS ? '通知權限已關閉，請到 iPhone「設定 → 通知 → 衡析」打開「允許通知」。' : '通知權限被封鎖，請到手機設定 → 應用程式 → Chrome（或此 App）→ 通知 開啟。';
export function initLive(ctx) { C = ctx; }


export function marketOpen() { return MK.isOpen(); }
const elapsed = s => MK.elapsed(s);
const yi = v => v == null ? '—' : fmt(v / 1e8, Math.abs(v) >= 1e10 ? 0 : 1);

/* ---------- data ---------- */
export async function loadBoard() { try { const want = L.bgroup, b = await C.api('api/board' + (want ? '?group=' + encodeURIComponent(want) : '')); if (want === L.bgroup) { L.board = b; L.boardAt = Date.now(); L.error = ''; } } catch (e) { if (!e.silent) L.error = e.message; } }
export async function loadAlerts(reset = false) {
  try {
    const r = await C.api('api/alerts?since=' + (reset ? 0 : L.latest));
    if (reset || r.date !== L.alertDate) { L.alerts = []; L.alertDate = r.date; }
    if (r.alerts.length) L.alerts.push(...r.alerts);
    L.latest = Math.max(L.latest, r.latest || 0);
  } catch (e) { if (!e.silent) L.error = e.message; }
}
// 當沖掃描：Top N、推播與盤前資料狀態、訊號檢討（設定在電腦版）
const DT = { info: null, review: null, at: 0 };
async function loadDaytrade() { try { DT.info = await C.api('api/daytrade'); DT.at = Date.now(); } catch (e) { if (!e.silent) L.error = e.message; } }
async function loadDtReview() { try { DT.review = await C.api('api/daytrade/review'); } catch (e) { if (!e.silent) L.error = e.message; } }
async function loadMonitor() { try { L.monitor = await C.api('api/monitor'); L.draft = structuredClone({ monitor: L.monitor.enabled, radar: L.monitor.radar }); } catch (e) { if (!e.silent) L.error = e.message; } }
export async function loadLiveTab() { await Promise.all([loadBoard(), loadAlerts(!L.alertDate), L.monitor ? null : loadMonitor(), checkPush(), DT.info ? null : loadDaytrade()]); }
setInterval(async () => {
  if (!C || document.hidden) return;
  const S = C.S;
  if (S.tab === 'live' && (marketOpen() || Date.now() - L.boardAt > 60000)) { await Promise.all([loadBoard(), loadAlerts(), L.view === 'daytrade' || Date.now() - DT.at > 300e3 ? loadDaytrade() : null]); if (S.tab === 'live' && !overlay()) redrawLive(); }
  if (S.tab === 'brief' && L.report?.busy) { await loadReport(); if (S.tab === 'brief') C.draw(); }
  if (S.tab === 'live' && marketOpen() && ++streamTick % 3 === 0) await refreshStream(); // 盤中每 30 秒確認即時推播狀態
}, 10000);
// 即時推播（例如富果 WebSocket）運作時，盤中分頁的看板與異動每 3 秒更新
let streamTick = 0;
const streamOn = () => !!L.monitor?.stream?.active;
async function refreshStream() { try { const m = await C.api('api/monitor'); if (L.monitor) { L.monitor.stream = m.stream; L.monitor.error = m.error; } } catch { } }
setInterval(async () => {
  if (!C || document.hidden || C.S.tab !== 'live' || !streamOn() || !marketOpen()) return;
  await Promise.all([L.view === 'daytrade' ? loadDaytrade() : null, loadAlerts()]); // 看板固定用快照，每 10 秒更新
  if (C.S.tab === 'live' && !overlay()) redrawLive();
}, 3000);
const sheetOpen = () => C.$('#sheet')?.classList.contains('open');
const overlay = () => sheetOpen() && !docked(); // 單頁時個股視窗蓋住清單：不重畫清單
const paneVisible = () => sheetOpen() || docked(); // 個股視窗或雙頁的副頁看得到：持續更新走勢
function redrawLive() { // 重繪時保留頁面與族群切換列的捲動位置
  const keep = window.scrollY, chips = C.$('.lv-gchips')?.scrollLeft; C.draw(); window.scrollTo(0, keep);
  const el = C.$('.lv-gchips'); if (el && chips != null) el.scrollLeft = chips;
}

/* ---------- 盤中分頁 ---------- */
// 即時推播狀態：運作中顯示檔數（超過方案上限時自選優先），未連線顯示原因
function streamPill(st) {
  if (!st?.capable) return '';
  if (st.active) return `<span class="pill" title="${st.total > st.symbols ? `方案上限 ${fmt(st.limit)} 檔，自選優先` : ''}">⚡ 即時推播 ${fmt(st.symbols)} 檔</span>`;
  return st.error ? `<span class="pill warn">即時推播未連線：${esc(st.authFailed ? '金鑰無效或方案不支援（10 分鐘後重試）' : st.error === 'no-heartbeat' ? '連線逾時，重新連線中' : st.error)}</span>` : '<span class="pill">即時推播連線中…</span>';
}
export function livePage() {
  const m = L.monitor, open = marketOpen();
  const status = `<div class="statusline"><span class="pill"><span class="dot ${open && m?.enabled ? 'live' : ''}"></span>${!m ? '讀取中' : !m.enabled ? '監控已關閉' : open ? `監控中 ${esc(L.board?.asOf?.slice(11, 19) || '')}` : '非盤中'}</span>${m?.error ? `<span class="pill warn">${esc(m.error)}</span>` : ''}${open ? streamPill(m?.stream) : ''}<span class="pill">今日異動 ${L.alerts.filter(isMove).length}</span>${m?.news?.enabled ? `<span class="pill">🗞️ 新聞 ${L.alerts.filter(a => a.type === 'news').length}</span>` : ''}</div>`;
  const seg = `<div class="seg" style="margin-bottom:12px">${[['board', '看板'], ...(DT.info?.capable ? [['daytrade', '當沖']] : []), ['radar', '雷達'], ['rules', '提醒'], ['groups', '族群排名'], ['settings', '設定']].map(([v, l]) => `<button class="${L.view === v ? 'on' : ''}" data-lview="${v}">${l}</button>`).join('')}</div>`;
  const err = L.error ? `<div class="notice err">${esc(L.error)}</div>` : '';
  return status + seg + err + (L.view === 'board' ? boardView() : L.view === 'daytrade' ? daytradeView() : L.view === 'radar' ? radarView() : L.view === 'rules' ? rulesView() : L.view === 'groups' ? groupsView() : settingsView());
}
/* ---------- 當沖掃描 ---------- */
const DT_SIG = { 'dt-ma-up': '📈 突破 20MA', 'dt-ma-down': '📉 跌破 20MA', 'dt-open-low': '🔻 跌破開盤低點', 'dt-breakout': '💥 爆量突破', 'dt-vwap': '📈 VWAP 延續', 'dt-bid': '🟢 五檔增強', 'dt-weak': '⚠️ 多單轉弱', 'dt-risk': '🛑 參考停損' };
const DT_SIDE = { long: '多方', short: '空方' };
const DT_FILTERS = { noDayTrade: '不可當沖', disposition: '處置', suspended: '暫停交易' };
const DT_REASONS = { history: '5 分 K 不足 21 根', fiveMinute: '等待第一根 5 分 K', subscription: '超出訂閱範圍', waitingQuote: '等待報價' };
// 大盤環境紀錄（只記錄，不影響訊號與推播）
const DT_REGIME = { tailwind: '順風', neutral: '中性', headwind: '逆風' };
const DT_REGIME_ROW = { tailwind: '大盤順風', neutral: '大盤中性', headwind: '大盤逆風', none: '大盤未記錄' };
const DT_STRENGTH = { strong: '強於大盤', weak: '弱於大盤', none: '強弱未記錄' };
const DT_INDEX = { twse: '加權', tpex: '櫃買' };
function dtMarketLine(mk) {
  if (!mk) return '';
  const one = k => { const x = mk[k]; if (!x) return `${DT_INDEX[k]} 等待指數資料`; return `${DT_INDEX[k]} ${pct(x.chg)}（15 分 ${pct(x.r15)}）${x.stale ? '資料過期' : x.regime ? DT_REGIME[x.regime] : '累積中'}`; };
  return `<small>大盤環境（只記錄）：${one('twse')} · ${one('tpex')}</small>`;
}
const dtRvLine = (label, x) => `<div class="dt-rv"><span>${label}</span><span class="num">${x.n} 則 · 15 分勝率 ${x.win15 ?? '—'}% · 平均 ${x.r15 == null ? '—' : (x.r15 > 0 ? '+' : '') + fmt(x.r15, 2) + '%'}</span></div>`;
function dtMarketReview(mk) {
  if (!mk?.signals) return '';
  const rows = list => list.filter(x => x.n || x.key !== 'none');
  return `<h3>依大盤環境分組</h3>${rows(mk.regimes).map(x => dtRvLine(DT_REGIME_ROW[x.key], x)).join('')}${rows(mk.strength).map(x => dtRvLine(DT_STRENGTH[x.key], x)).join('')}
    <p class="foot">只記錄，不影響訊號。上市股對照加權、上櫃股對照櫃買：順風＝指數在日內均價之上且近 15 分鐘未下跌；逆風＝在均價之下且近 15 分鐘下跌，或近 15 分鐘跌幅達 0.5%。${mk.since ? `從 ${esc(mk.since)} 開始記錄（${mk.recorded}／${mk.signals} 則）。` : '這個版本之後的訊號才會記錄。'}</p>`;
}
function daytradeView() {
  const d = DT.info; if (!d) return '<div class="empty"><span class="spinner"></span> 讀取中…</div>';
  const f = d.feed || {}, p = d.prep, so = d.sources || {}, c = d.counts, st = d.settings || {}, n2 = v => v == null ? '—' : fmt(v, 2);
  const feed = !f.window ? '非盤中 · 平日開盤前 10 分鐘自動連線' : !f.connected ? (f.authFailed ? '金鑰無效或方案不支援（10 分鐘後重試）' : f.error ? `即時推播未連線：${esc(f.error === 'no-heartbeat' ? '連線逾時，重新連線中' : f.error)}` : '即時推播連線中…')
    : `⚡ ${f.mode === 'full' ? '完整模式（逐筆＋分 K＋五檔）' : '精簡模式（聚合行情）'} · 訂閱 ${fmt(f.subscribed)}／${fmt(f.expected)}${f.backfill?.busy ? ` · 補資料中 ${f.backfill.done}／${f.backfill.total}` : ''}`;
  const parts = [st.sources?.turnover ? `高周轉率 ${fmt(so.turnover || 0)}` : '', st.sources?.groups ? `研究族群 ${fmt(so.groups || 0)}` : '', st.sources?.watchlist ? `自選 ${fmt(so.watchlist || 0)}` : ''].filter(Boolean).join('＋');
  const watchLine = `觀察名單 ${fmt(so.total || 0)} 檔（${parts || '沒有選擇來源'}）${c ? ` · 20MA 之上 ${fmt(c.long)}、之下 ${fmt(c.short)}、等待 ${fmt(c.waiting)}` : ''}`;
  const prep = st.sources?.turnover && p && !p.turnover ? '高周轉率名單尚未取得' : p ? `${p.eligible == null ? '可當沖清單未取得' : `可當沖 ${fmt(p.eligible)} 檔`} · 處置 ${p.disposition} · 暫停交易 ${p.suspended}` : '盤前資料於開盤前 30 分鐘取得';
  const head = `<section class="card dt-head"><div>${esc(d.phaseName || '')}${d.phaseName ? ' · ' : ''}${feed}</div><small>${watchLine}</small><small>${prep}</small>${dtMarketLine(d.market)}</section>`;
  if (!d.enabled) return head + '<div class="empty">當沖監控已關閉（可在電腦版「盤中雷達 → 當沖掃描 → 設定」開啟）。</div>';
  const sigs = d.signals || [];
  const sigList = sigs.length ? `<section class="card dt-sigs"><h3>今日訊號 ${fmt(d.signalCount || sigs.length)} 則</h3>${sigs.slice(0, 30).map(s => `<button class="dt-sigrow" data-kbar="${esc(s.id)}"><span class="num">${esc(s.t?.slice(0, 5))}</span><span class="dt-side ${s.side === 'long' ? 'up' : 'down'}">${DT_SIDE[s.side] || ''}</span><b>${esc(s.name)}<small class="num"> ${esc(s.id)}</small></b><span>${DT_SIG[s.type] || esc(s.type)}</span><span class="num">${n2(s.price)}</span></button>`).join('')}</section>`
    : `<div class="empty">${f.window ? '今天還沒有訊號。5 分 K 走完時判斷一次，有訊號會推播到這支手機。' : '盤中才會判斷訊號。'}</div>`;
  const list = (d.top || []).map((x, i) => {
    const v = x.five || {}, wait = [...(x.pending ? ['補資料中'] : []), ...(x.reasons || []).map(k => DT_REASONS[k] || k), ...(x.filters || []).map(k => DT_FILTERS[k] || k)];
    const pos = v.above == null ? '—' : v.above ? '20MA 之上' : v.dist < 0 ? '20MA 之下' : '貼近 20MA';
    return `<button class="dt-card ${cls(x.change)}" data-kbar="${esc(x.id)}"><span class="dt-rank num">${i + 1}</span><span class="dt-main"><b>${esc(x.name)}<small class="num"> ${esc(x.id)}</small></b>
    <small>${wait.length ? esc(wait.join('、')) : pos}${v.dist == null ? '' : `（${pct(v.dist)}）`} · 20MA ${n2(v.ma20)} · 開盤低點 ${n2(v.openLow)}${v.belowOpen ? ' 已跌破' : ''}</small><small class="num">${x.turnover != null ? `周轉 ${fmt(x.turnover, 2)}% · ` : ''}${x.grouped ? '族群' : ''}${x.last ? ` · ${DT_SIG[x.last.type] || ''} ${esc(x.last.t?.slice(0, 5))}` : ''}</small></span>
    <span class="dt-px num"><b class="${cls(x.change)}">${fmt(x.price, 2)}</b><small class="${cls(x.change)}">${pct(x.change)}</small></span></button>`; }).join('');
  const ex = Object.entries(d.excluded || {}).filter(([, v]) => v).map(([k, v]) => `${DT_FILTERS[k] || k} ${v}`);
  const r = DT.review, review = !r ? '<div class="empty"><button class="btn" data-dtreview>載入訊號檢討</button></div>' : !r.signals ? '<p class="foot">尚無訊號紀錄，收盤後會自動檢討當天的訊號。</p>'
    : `<section class="card"><h3>訊號檢討（${r.days} 天、${r.signals} 則）</h3>${r.types.map(t => `<div class="dt-rv"><span>${esc(t.title)} v${t.version || 1}</span><span class="num">${t.n} 則 · 15 分勝率 ${t.win15 ?? '—'}% · 平均 ${t.r15 == null ? '—' : (t.r15 > 0 ? '+' : '') + fmt(t.r15, 2) + '%'}</span></div>`).join('')}<p class="foot">已扣除滑價、手續費與證交稅（來回約 ${fmt(r.cost, 3)}%）</p>${dtMarketReview(r.market)}</section>`;
  return head + sigList + (list ? `<p class="foot">觀察名單${d.listed > (d.top || []).length ? `（顯示 ${(d.top || []).length}／${fmt(d.listed)} 檔，今天有訊號的在前）` : ''}</p><div class="dt-list">${list}</div>` : `<div class="empty">${!f.window ? '盤中才會更新觀察名單。' : '尚無報價，開盤後開始計算。'}</div>`) + (ex.length ? `<p class="foot">不發訊號：${ex.join(' · ')}</p>` : '') + `<p class="foot">只看 5 分 K：收盤突破 20MA 為多方；收盤跌破 20MA、或跌破開盤低點（當日第一根 5 分 K 的最低價）為空方。研究用訊號，不是下單建議。</p>` + review;
}
/* ---------- 即時看板：自選或研究總覽任一族群 ---------- */
const BOARD_SORTS = [['default', '預設'], ['chg', '漲幅'], ['amt', '成交值']];
const chgOf = s => s.quote?.change ?? s.daily?.change;
function sortStocks(list) {
  if (L.bsort === 'chg') return list.slice().sort((a, b) => (chgOf(b) ?? -1e9) - (chgOf(a) ?? -1e9));
  if (L.bsort === 'amt') return list.slice().sort((a, b) => (b.quote?.amount || 0) - (a.quote?.amount || 0));
  return list;
}
function boardView() {
  const b = L.board; if (!b) return '<div class="empty"><span class="spinner"></span> 讀取中…</div>';
  const chips = b.groups ? `<div class="chips lv-gchips"><button class="chip ${b.group === 'watch' ? 'on' : ''}" data-bgroup="watch">☆ 自選<b class="num">${b.watchCount}</b></button>${b.groups.map(g => `<button class="chip ${b.group === g.id ? 'on' : ''}" data-bgroup="${esc(g.id)}">${esc(g.name)}<b class="num ${cls(g.score)}">${g.score == null ? '—' : pct(g.score)}</b></button>`).join('')}</div>` : '';
  const g = b.groups?.find(x => x.id === b.group), up = b.stocks.filter(s => chgOf(s) > 0).length, down = b.stocks.filter(s => chgOf(s) < 0).length;
  const sum = g ? `<span>量能加權 <b class="num ${cls(g.score)}">${pct(g.score)}</b></span><span>漲 <b class="num up">${g.up}</b>／跌 <b class="num down">${g.down}</b></span><span class="num">${yi(g.amount)} 億</span>${g.rank ? `<span>第 <b class="num">${g.rank}</b> 名</span>` : ''}`
    : `<span>自選 ${b.stocks.length} 檔</span><span>漲 <b class="num up">${up}</b>／跌 <b class="num down">${down}</b></span>`;
  const bar = `<div class="lv-gbar"><div class="lv-gsum">${b.loading ? '<span class="spinner"></span>' : sum}</div><div class="seg lv-sort">${BOARD_SORTS.map(([v, l]) => `<button class="${L.bsort === v ? 'on' : ''}" data-bsort="${v}">${l}</button>`).join('')}</div></div>`;
  if (b.loading) return chips + bar + '<div class="empty"><span class="spinner"></span> 讀取中…</div>';
  if (!b.stocks.length) return chips + bar + `<div class="empty">${b.group === 'watch' ? '尚無自選股。在「個股」分頁點選股票後按 ☆ 加入，或在上方切換到任一族群看板。' : '此族群沒有成分股。'}</div>`;
  return chips + bar + `<div class="lv-grid">${sortStocks(b.stocks).map(s => {
    const q = s.quote, chg = chgOf(s), price = q?.close ?? s.daily?.price;
    const ratio = q?.volume && q?.yesterdayVolume && elapsed(q.time) >= 5 ? q.volume / (elapsed(q.time) / MK.sessionLength()) / q.yesterdayVolume : null;
    // 外盤比（即時推播才有）：外盤成交量 ÷（內盤＋外盤），高代表買方積極
    const outer = q?.volumeAtAsk != null && q?.volumeAtBid != null && q.volumeAtAsk + q.volumeAtBid > 0 ? q.volumeAtAsk / (q.volumeAtAsk + q.volumeAtBid) * 100 : null;
    return `<button class="lv-card ${cls(chg)}" data-intra="${s.id}"><div class="lv-top"><b>${esc(s.name)}<small class="num">${s.id}</small></b>${s.score != null ? `<span class="score ${s.score >= 75 ? 'hi' : s.score >= 55 ? 'mid' : ''}">${fmt(s.score)}</span>` : ''}</div>
      <div class="lv-px"><span class="num big ${cls(chg)}">${fmt(price, 2)}</span><span class="chg num ${cls(chg)}">${pct(chg)}</span></div>
      ${sparkSVG(s.spark, s.prev, { xs: s.sparkX })}
      <div class="lv-meta num"><span>${q?.volume ? `${fmt(q.volume)} 張` : q?.time ? `收盤 ${q.time}` : s.daily?.asOf ? `日資料 ${s.daily.asOf.slice(5)}` : '—'}</span><span>${q?.amount ? `${yi(q.amount)} 億` : ''}</span><span class="${ratio >= 2 ? 'up' : ''}">${ratio ? `量比 ${fmt(ratio, 1)}` : ''}</span>${outer != null ? `<span class="${outer >= 60 ? 'up' : outer <= 40 ? 'down' : ''}">外盤 ${fmt(outer, 0)}%</span>` : ''}</div></button>`;
  }).join('')}</div><p class="foot">${b.live ? (b.stream ? '即時推播（每 3 秒更新畫面）' : '盤中每 10 秒更新') : b.date ? `顯示 ${esc(b.date)} 最後狀態` : '開盤後自動顯示即時報價'} · 點卡片看即時走勢（均價線、族群均價線）、五檔與日 K／5 分 K<br>族群旁的數字為量能加權漲幅（與「族群排名」同算法）</p>`;
}
function radarView() {
  const p = L.push, list = L.alerts.filter(a => alertMatch(a, L.group)).slice().reverse();
  const pushCard = `<section class="card lv-push"><div class="card-b"><b>📲 手機通知</b><p>${p.state === 'on' ? `已開啟 · 共 ${p.count} 台裝置` : p.state === 'unsupported' || p.state === 'denied' ? pushHelp(p.state) : '開啟後，盤中異動與 AI 日報會直接推到這支手機。'}</p>
    <div class="upd-row">${p.state === 'on' ? '<button class="btn" data-push="test">發送測試</button><button class="btn" data-push="off">關閉通知</button>' : p.state === 'unsupported' || p.state === 'denied' ? '' : '<button class="btn primary" data-push="on" style="grid-column:1/-1">開啟通知</button>'}</div></div></section>`;
  const chips = `<div class="chips" style="margin-bottom:10px">${ALERT_GROUPS.map(([k, l]) => `<button class="chip ${L.group === k ? 'on' : ''}" data-agroup="${k}">${l} ${L.alerts.filter(a => alertMatch(a, k)).length}</button>`).join('')}</div>`;
  return pushCard + chips + `<section class="card ix-alerts">${list.map(alertRow).join('') || `<div class="empty">${marketOpen() ? '目前沒有符合條件的異動。' : '今日尚無異動紀錄。開盤後雷達會自動掃描。'}</div>`}</section>`;
}
/* ---------- 自訂提醒 ---------- */
async function loadRules() { try { L.rules = await C.api('api/price-alerts'); } catch (e) { if (!e.silent) L.error = e.message; } }
function paintRules() {
  for (const el of document.querySelectorAll('[data-pa-box]')) el.innerHTML = priceRulesHTML(L.rules, { stockId: el.dataset.paBox || null, empty: el.dataset.paBox ? '這檔股票尚未設定提醒' : '尚未設定提醒' });
}
function rulesView() {
  if (!L.rules) { loadRules().then(() => C.S.tab === 'live' && L.view === 'rules' && C.draw()); return '<div class="empty"><span class="spinner"></span> 讀取中…</div>'; }
  const on = L.rules.rules.filter(r => r.active).length;
  return `<section class="card"><div class="card-h"><h2>🔔 自訂提醒<small>啟用 ${on} / ${L.rules.max}</small></h2></div><div class="card-b"><div data-pa-box="">${priceRulesHTML(L.rules, { empty: '尚未設定提醒' })}</div>${priceRuleForm()}</div></section>
  <p class="foot">價格、漲跌幅或預估量達到條件時推播到手機（需在「雷達」開啟通知）。單次提醒觸發後自動停用，可按 ▶ 重新啟用；重複提醒在條件解除後再次成立時提醒。也可以在個股或 K 線頁設定。</p>`;
}
// 個股頁與 K 線頁的提醒區塊
export function rulesCard(stock) {
  if (!L.rules) loadRules().then(paintRules);
  return `<section class="card ix-card"><div class="card-h"><h2>🔔 自訂提醒</h2></div><div class="card-b"><div data-pa-box="${esc(stock.id)}">${L.rules ? priceRulesHTML(L.rules, { stockId: stock.id, empty: '這檔股票尚未設定提醒' }) : '<div class="empty"><span class="spinner"></span></div>'}</div>${priceRuleForm(stock)}</div></section>`;
}
function settingsView() {
  const d = L.draft; if (!d) return '<div class="empty"><span class="spinner"></span> 讀取中…</div>';
  const r = d.radar, sel = (path, opts, unit = '') => `<select class="sel" data-rset="${path}">${opts.map(v => `<option value="${v}" ${String(path.split('.').reduce((o, k) => o[k], r)) === String(v) ? 'selected' : ''}>${v}${unit}</option>`).join('')}</select>`;
  const sw = (path, label, desc, extra = '') => { const on = path === 'monitor' ? d.monitor : path.split('.').reduce((o, k) => o[k], r); return `<div class="lv-rule"><label class="lv-sw"><input type="checkbox" data-rset="${path}" ${on ? 'checked' : ''}><span></span></label><div><b>${label}</b><small>${desc}</small>${extra ? `<div class="lv-opts">${extra}</div>` : ''}</div></div>`; };
  return `<section class="card"><div class="card-b">
    ${sw('monitor', '盤中監控', '平日盤中定時取即時快照（頻率依資料源與方案），驅動即時熱浪、時光機、看板與雷達。')}
    <h3 class="lv-h">監控範圍</h3><div class="seg">${[['watch', '只看自選'], ['research', '自選＋研究名單'], ['all', '全市場']].map(([v, l]) => `<button class="${r.scope === v ? 'on' : ''}" data-rscope="${v}">${l}</button>`).join('')}</div>
    <h3 class="lv-h">提醒條件</h3>
    ${sw('volume.on', '🔥 爆量', '依目前成交量推估全日量，超過昨量倍數時提醒（開盤 15 分鐘後）', `${sel('volume.ratio', [1.5, 2, 3, 5], ' 倍')}${sel('volume.minAmount', [0, 50000000, 100000000, 500000000])}<small>最低成交金額（元）</small>`)}
    ${sw('surge.on', '🚀 急拉／⚡ 急殺', '設定時間內漲（跌）幅達門檻（含）即提醒；以昨收計算，比較現價與這段時間內的最低（最高）價', `${sel('surge.minutes', [1, 3, 5, 10, 15], ' 分鐘')}${sel('surge.pct', [1, 1.5, 2, 3, 5], '%')}`)}
    ${sw('limit.on', '🔺 漲跌停', '觸及、打開與再鎖漲跌停')}
    ${sw('pattern.on', '🎯 型態進場', '型態選股中的股票向上穿越條件進場價（不受監控範圍限制）')}
    ${sw('stop.on', '🛑 跌破防守', '監控範圍內有型態計畫的股票向下跌破結構防守價')}
    <button class="btn primary block" data-rsave style="margin-top:14px">儲存雷達設定</button></div></section>
    <p class="foot">雷達在電腦上的衡析 Nexus 執行；手機關閉時仍會掃描並推播。</p>`;
}
/* ---------- 個股 K 線：日 K／5 分 K（5MA、20MA），盤中每 10 秒更新即時報價與 K 線 ---------- */
const K = { id: null, period: ['day', 'live'].includes(pref('pocket.chartPeriod', '5m')) ? pref('pocket.chartPeriod', '5m') : '5m', data: null, error: '', seq: 0, group: '', sub: pref('pocket.intraView', 'book'), live: null };
const chartShown = id => paneVisible() && !!C.$(`#sheet-body [data-chart="${id}"]`);
async function openChart(id, period = K.period, group = K.group) {
  IX.id = null; if (C.S) C.S.sheetStock = null; // 換成走勢視窗後，背景更新不再把它換回個股診斷
  if (K.id !== id) { K.data = null; K.live = null; K.error = ''; }
  K.group = group || '';
  const shown = chartShown(id) && sheetOpen(); K.id = id; K.period = period; savePref('pocket.chartPeriod', period);
  if (!shown) C.openSheet(L.board?.stocks.find(x => x.id === id)?.name || id, '');
  C.setSel(id);
  paintChart(); await refreshChart();
}
async function refreshChart() {
  const id = K.id, period = K.period, seq = ++K.seq;
  try {
    if (period === 'live') { const d = await C.api(`api/intraday?id=${id}${K.group ? '&group=' + encodeURIComponent(K.group) : ''}`); if (seq !== K.seq) return; K.live = d; K.error = ''; }
    else { const d = await C.api(`api/chart?id=${id}&period=${period}`); if (seq !== K.seq) return; K.data = d; K.error = ''; }
  }
  catch (e) { if (seq !== K.seq || e.silent) return; K.error = e.message; }
  if (chartShown(id)) paintChart();
}
setInterval(() => { if (C && K.id && K.period !== 'live' && marketOpen() && !document.hidden && chartShown(K.id)) refreshChart(); }, 10000);
// 即時走勢每 3 秒更新（盤中、畫面開著時）
setInterval(() => { if (C && K.id && K.period === 'live' && marketOpen() && !document.hidden && chartShown(K.id)) refreshChart(); }, 3000);
function paintChart() {
  if (K.period === 'live') return paintIntraday();
  const id = K.id, d = K.data?.id === id ? K.data : null, s = L.board?.stocks.find(x => x.id === id), body = C.$('#sheet-body');
  const ready = d && d.period === K.period, q = d?.quote ?? s?.quote, dayBar = d?.session || null;
  const price = q?.close ?? dayBar?.[4] ?? d?.daily?.price ?? s?.daily?.price, chg = q?.change ?? d?.daily?.change ?? s?.daily?.change;
  const live = d?.live && marketOpen(), info = [q?.open ?? dayBar?.[1], q?.high ?? dayBar?.[2], q?.low ?? dayBar?.[3]];
  // 依視窗寬度決定圖寬與根數（摺疊螢幕展開時顯示更多 K 棒）
  const { w, h } = chartBox(body, .72, 250, 400);
  const chart = K.error && !ready ? `<div class="notice err">${esc(K.error)}</div>` : ready ? candleSVG(d.bars, { w, h, show: Math.round(w / (d.period === 'day' ? 6 : 5)), period: d.period, key: id + d.period, prev: d.prev, prevs: d.days ? Object.fromEntries(d.days.map(x => [x.date, x.prev])) : null }) : `<div class="empty"><span class="spinner"></span> 讀取${K.period === 'day' ? '日' : ' 5 分'} K…</div>`;
  const caption = !ready ? '' : d.period === 'day' ? `日 K（不還原）${d.today ? ` · 最後一根為 ${md(d.today)} ${live ? '即時' : '當日'}資料` : ''} · 左右滑動或點圖查看各根數值`
    : `${d.notice ? `<span class="amber">⚠ ${esc(d.notice)}</span><br>` : ''}5 分 K · ${d.days.map(x => md(x.date)).join('、')}${d.days.some(x => x.source === 'replay') ? ' · 盤中以每分鐘快照組成，高低點為近似值，收盤後改用資料源的分 K' : ''} · 左右滑動或點圖查看各根數值`;
  C.$('#sheet-title').innerHTML = `${esc(d?.name || s?.name || id)}<small>${id}${d?.sector ? ' · ' + esc(d.sector) : ''}</small>`;
  body.innerHTML = `<div data-chart="${id}"><div class="hero"><div><div class="big num ${cls(chg)}">${fmt(price, 2)}</div><div class="num ${cls(chg)}" style="font-weight:700">${pct(chg)}${q?.changePrice != null ? ` · ${q.changePrice > 0 ? '+' : ''}${fmt(q.changePrice, 2)}` : ''}</div>
    <div class="meta num">開 ${fmt(info[0], 2)} · 高 ${fmt(info[1], 2)} · 低 ${fmt(info[2], 2)}<br><span class="m-sep"> · </span>${q?.volume ? `成交 ${fmt(q.volume)} 張` : dayBar ? `成交 ${fmt(dayBar[5])} 張` : ''}${q?.amount ? ` · ${yi(q.amount)} 億` : ''}${q?.bid ? ` · 委買 ${fmt(q.bid, 2)}／委賣 ${fmt(q.ask, 2)}` : ''}</div></div></div>
    <div class="statusline">${live ? `<span class="pill"><span class="dot live"></span>盤中 · 每 10 秒更新 ${esc(q?.time || '')}</span>` : q?.date ? `<span class="pill">${md(q.date)} ${esc(q.time || '')}</span>` : ''}</div>
    <div class="seg" style="margin-bottom:10px">${PERIODS.map(([v, l]) => `<button class="${K.period === v ? 'on' : ''}" data-cperiod="${v}">${l}</button>`).join('')}</div>
    <section class="card"><div class="card-b">${chart}${caption ? `<p class="ix-foot">${caption}</p>` : ''}</div></section>
    <div class="upd-row">${C.inScope(id) ? `<button class="btn primary" data-stock-detail="${id}">個股診斷</button>` : '<span></span>'}<button class="btn" data-chart-refresh>⟳ 重新整理</button></div>${rulesCard({ id, name: d?.name || s?.name || id, close: price })}</div>`;
}

// 圖表尺寸：寬度依視窗；上下雙頁時不超過上頁可用高度，半摺立在桌上時不必捲動就看得到整張走勢
function chartBox(body, ratio, min, max) {
  const w = Math.round(Math.max(300, Math.min(900, (body?.clientWidth || 360) - 30)));
  let h = Math.min(max, Math.max(min, w * ratio));
  if (docked() && layout().mode === 'stack') h = Math.min(h, Math.max(150, (body?.clientHeight || 400) - 200));
  return { w, h: Math.round(h) };
}
/* ---------- 任何介面點個股：開啟走勢＋K 線＋五檔／明細（同一個視窗） ---------- */
export function openQuote(id, group = '') { return openChart(id, 'live', group || (L.board?.stocks.some(x => x.id === id) && L.board.group !== 'watch' ? L.board.group : '')); }
/* ---------- 指數詳細資訊（加權指數、櫃買指數）：走勢、日 K、成交金額、委買賣、漲跌家數 ---------- */
const IX = { id: null, period: 'live', data: null, error: '', seq: 0, at: 0 };
const indexShown = () => paneVisible() && !!C.$('#sheet-body [data-index-view]');
export async function openIndex(id, period = IX.period) {
  if (IX.id !== id) { IX.data = null; IX.error = ''; }
  IX.id = id; IX.period = period; K.id = null;
  if (!indexShown()) C.openSheet(id === 'TPEX' ? '櫃買指數' : '加權指數', '');
  C.setSel(''); paintIndex(); await refreshIndex();
}
// 雙頁沒有開啟個股時，副頁顯示大盤指數走勢（台股）；點清單中的股票就換成該股
export function idlePane() {
  if (!C || !docked() || sheetOpen()) return;
  K.id = null; if (C.S) C.S.sheetStock = null;
  if (MK.market().id !== 'TW') { C.$('#sheet-title').textContent = '詳細資料'; C.$('#sheet-body').innerHTML = `<p class="pane-hint">${paneHint()}</p>`; return; }
  const had = indexShown() && IX.data?.id === IX.id; if (!IX.id) IX.id = 'TAIEX';
  paintIndex(); if (!had) refreshIndex();
}
const paneHint = () => layout().mode === 'stack' ? '點下方清單中的任何股票，這裡會換成它的走勢、五檔與成交明細；按 ✕ 回到大盤。' : '點左頁清單中的任何股票，這裡會換成它的走勢、五檔與成交明細；按 ✕ 回到大盤。';
// 版面改變後依新的寬度重畫副頁的圖表
export function repaintPane() { if (!C) return; if (K.id && chartShown(K.id)) paintChart(); else if (IX.id && indexShown()) paintIndex(); }
async function refreshIndex() {
  const id = IX.id, seq = ++IX.seq; IX.at = Date.now();
  try { const d = await C.api(`api/index?id=${id}`); if (seq !== IX.seq) return; IX.data = d; IX.error = ''; } catch (e) { if (seq !== IX.seq || e.silent) return; IX.error = e.message; }
  if (indexShown()) paintIndex();
}
// 盤中更新：開啟指數視窗時每 10 秒；雙頁副頁閒置顯示大盤時每 30 秒（每次向富果 2 個請求，常駐時放慢）
setInterval(() => { if (C && IX.id && marketOpen() && !document.hidden && indexShown() && (sheetOpen() || Date.now() - IX.at >= 29e3)) refreshIndex(); }, 10000);
function paintIndex() {
  const d = IX.data?.id === IX.id ? IX.data : null, body = C.$('#sheet-body'); if (!body) return;
  const q = d?.quote || {}, chg = q.change, b = d?.breadth, { w, h } = chartBox(body, .8, 260, 420);
  const chart = IX.error && !d ? `<div class="notice err">${esc(IX.error)}</div>` : !d ? '<div class="empty"><span class="spinner"></span> 讀取中…</div>'
    : IX.period === 'day' ? (d.daily?.length ? candleSVG(d.daily.map(r => [r[0], r[1], r[2], r[3], r[4], Math.round(r[5] / 1e8)]), { w, h, show: Math.round(w / 6), period: 'day', key: d.id + 'day' }) : '<div class="empty">尚無日 K 資料（需要富果金鑰）。</div>')
    : d.minutes?.m?.length ? intradaySVG(d, { w, h }) : `<div class="empty">${d.source === 'fugle' ? '開盤後才有當日走勢。' : '目前只有指數快照，沒有分時走勢（需要富果金鑰）。'}</div>`;
  const kv = (k, v) => `<div class="kpi"><span>${k}</span><b class="num">${v}</b></div>`;
  C.$('#sheet-title').innerHTML = `${esc(d?.name || (IX.id === 'TPEX' ? '櫃買指數' : '加權指數'))}<small>${esc(d?.symbol || '')}</small>`;
  body.innerHTML = `<div data-index-view="${IX.id}"><div class="hero"><div><div class="big num ${cls(chg)}">${fmt(q.last, 2)}</div><div class="num ${cls(chg)}" style="font-weight:700">${pct(chg)}${q.changePrice != null ? ` · ${q.changePrice > 0 ? '+' : ''}${fmt(q.changePrice, 2)}` : ''}</div>
    <div class="meta num">開 ${fmt(q.open, 2)} · 高 ${fmt(q.high, 2)} · 低 ${fmt(q.low, 2)} · 昨收 ${fmt(d?.ref, 2)}</div></div></div>
    <div class="statusline">${d?.live && marketOpen() ? `<span class="pill"><span class="dot live"></span>${sheetOpen() ? `盤中 · 每 10 秒更新 ${esc(q.time || '')}` : `盤中 · 每 30 秒更新 ${esc(q.time || '')}`}</span>` : d?.date ? `<span class="pill">${md(d.date)} ${esc(q.time || '')}</span>` : ''}</div>
    <div class="ix-switch"><div class="seg">${[['TAIEX', '加權'], ['TPEX', '櫃買']].map(([v, l]) => `<button class="${IX.id === v ? 'on' : ''}" data-ixid="${v}">${l}</button>`).join('')}</div><div class="seg">${[['live', '走勢'], ['day', '日K']].map(([v, l]) => `<button class="${IX.period === v ? 'on' : ''}" data-ixperiod="${v}">${l}</button>`).join('')}</div></div>
    <section class="card"><div class="card-b">${chart}${IX.period === 'live' ? '<p class="ix-foot" id="ia-read">按住或拖曳圖表查看每分鐘指數與成交金額</p>' : ''}<p class="ix-foot">${IX.period === 'day' ? '日 K（量為成交金額，億元）' : '走勢下方為每分鐘成交金額（億元）'}</p></div></section>
    <section class="card"><div class="card-b"><div class="kpis">${kv('成交金額', q.amount ? `${yi(q.amount)}<small>億</small>` : '—')}${kv('成交筆數', q.transactions ? fmt(q.transactions) : '—')}${kv('委買張數', q.bidVolume ? fmt(q.bidVolume) : '—')}${kv('委賣張數', q.askVolume ? fmt(q.askVolume) : '—')}</div>
      ${b ? `<div class="kpis" style="margin-top:8px">${kv('上漲／下跌', `<span class="up">${fmt(b.up)}</span> <small>/</small> <span class="down">${fmt(b.down)}</span>`)}${kv('平盤', fmt(b.flat))}${kv('漲停／跌停', `<span class="up">${fmt(b.limitUp)}</span> <small>/</small> <span class="down">${fmt(b.limitDown)}</span>`)}${kv('普通股家數', fmt(b.count))}</div>
      <div class="breadth" style="margin-top:8px"><i class="u" style="width:${b.up / ((b.up + b.down) || 1) * 100}%"></i><i class="d" style="flex:1"></i></div>` : ''}
      <p class="ix-foot">${IX.id === 'TPEX' ? '上櫃' : '上市'}普通股漲跌家數來自資金熱浪（${esc(b?.date || '—')}）；指數與成交資料來自富果。</p></div></section>
    <div class="upd-row"><span></span><button class="btn" data-ixrefresh>⟳ 重新整理</button></div>${docked() && !sheetOpen() ? `<p class="pane-hint">${paneHint()}</p>` : ''}</div>`;
}
const PERIODS = [['live', '走勢'], ['5m', '5分K'], ['day', '日K']];
// 即時走勢：全日走勢圖（價格、當日均價線、族群均價線、每分鐘量）＋五檔／成交明細
function paintIntraday() {
  const id = K.id, d = K.live?.id === id ? K.live : null, s = L.board?.stocks.find(x => x.id === id), body = C.$('#sheet-body'); if (!body) return;
  const q = d?.quote || {}, price = q.last ?? s?.quote?.close, chg = q.change ?? s?.quote?.change;
  const { w, h } = chartBox(body, .8, 260, 420);
  const chart = K.error && !d ? `<div class="notice err">${esc(K.error)}</div>` : d ? intradaySVG(d, { w, h }) : '<div class="empty"><span class="spinner"></span> 讀取走勢…</div>';
  const live = d?.live && marketOpen(), g = d?.group;
  C.$('#sheet-title').innerHTML = `${esc(d?.name || s?.name || id)}<small>${id}${g ? ' · ' + esc(g.name) : ''}</small>`;
  body.innerHTML = `<div data-chart="${id}"><div class="hero"><div><div class="big num ${cls(chg)}">${fmt(price, 2)}</div><div class="num ${cls(chg)}" style="font-weight:700">${pct(chg)}${q.changePrice != null ? ` · ${q.changePrice > 0 ? '+' : ''}${fmt(q.changePrice, 2)}` : ''}</div>
    <div class="meta num">開 ${fmt(q.open, 2)} · 高 ${fmt(q.high, 2)} · 低 ${fmt(q.low, 2)}<br><span class="m-sep"> · </span>總量 ${fmt(q.volume)} 張${q.lastSize != null ? ` · 單量 ${fmt(q.lastSize)}` : ''} · 均價 <span class="amber">${fmt(q.vwap, 2)}</span></div></div></div>
    <div class="statusline">${live ? `<span class="pill"><span class="dot live"></span>即時推播 · 每 3 秒更新 ${esc(q.time || '')}</span>` : d?.source === 'replay' ? `<span class="pill">每分鐘快照 ${esc(q.time || '')}</span>` : d?.date ? `<span class="pill">${md(d.date)} ${esc(q.time || '')}</span>` : ''}</div>
    <div class="seg" style="margin-bottom:10px">${PERIODS.map(([v, l]) => `<button class="${K.period === v ? 'on' : ''}" data-cperiod="${v}">${l}</button>`).join('')}</div>
    <section class="card"><div class="card-b">${d ? legendHTML(d) : ''}${chart}<p class="ix-foot" id="ia-read">${d?.minutes?.m?.length ? '按住或拖曳圖表查看每分鐘價格、均價與族群均價' : ''}</p>
      ${g?.choices?.length > 1 ? `<div class="seg ia-groups">${g.choices.map(x => `<button class="${x.id === g.id ? 'on' : ''}" data-igroup="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>` : ''}
      <p class="ix-foot">均價＝當日累計成交金額 ÷ 累計成交量；族群均價＝所屬族群各股均價相對參考價的漲跌幅，以成交金額加權後換算到本股價位，股價在其上代表強於族群平均持有成本。</p></div></section>
    <div class="seg" style="margin:10px 0">${[['book', '五檔'], ['tape', '成交明細']].map(([v, l]) => `<button class="${K.sub === v ? 'on' : ''}" data-iview="${v}">${l}</button>`).join('')}</div>
    <section class="card"><div class="card-b">${!d ? '' : K.sub === 'tape' ? tapeHTML(d) : bookHTML(d)}</div></section>
    <div class="upd-row">${C.inScope(id) ? `<button class="btn primary" data-stock-detail="${id}">個股診斷</button>` : '<span></span>'}<button class="btn" data-chart-refresh>⟳ 重新整理</button></div></div>`;
}
// 走勢圖十字線：按住或拖曳時顯示該分鐘數值
function intraPointer(e) {
  const hit = e.target.closest?.('[data-intra-hit]'), data = C?.$('#sheet-body [data-index-view]') ? IX.data : K.live; if (!hit || !data) return;
  const svg = hit.ownerSVGElement, [x0, x1] = hit.dataset.intraHit.split(',').map(Number), box = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
  const x = (e.clientX - box.left) / box.width * vb.width, frac = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
  const cross = svg.querySelector('.ia-cross'); if (cross) { cross.setAttribute('x1', x0 + frac * (x1 - x0)); cross.setAttribute('x2', x0 + frac * (x1 - x0)); cross.setAttribute('visibility', 'visible'); }
  const out = C.$('#ia-read'); if (out) out.innerHTML = readAt(data, frac);
}
document.addEventListener('pointerdown', intraPointer); document.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'mouse') intraPointer(e); });

/* ---------- 設定（☰）：新聞推播 ---------- */
const hhmmss = ms => MK.parts(ms).hm;
export function newsSettingsCard() {
  if (!L.monitor) { loadMonitor().then(() => { const el = C.$('#news-set'); if (el) el.outerHTML = newsSettingsCard(); }); return '<section class="card" id="news-set"><div class="card-b"><span class="spinner"></span> 讀取新聞推播設定…</div></section>'; }
  const n = L.monitor.news || { enabled: false, scope: 'all', quiet: false }, s = n.status || {};
  const status = !n.enabled ? '目前關閉' : s.error ? `⚠ ${esc(s.error)}` : s.at ? `上次掃描 ${hhmmss(s.at)} · 今日新聞 ${s.today || 0} 則` : '即將開始第一次掃描';
  return `<section class="card" id="news-set"><div class="card-h"><h2>🗞️ 新聞推播</h2></div><div class="card-b">
    <div class="lv-rule"><label class="lv-sw"><input type="checkbox" data-npush="enabled" ${n.enabled ? 'checked' : ''}><span></span></label><div><b>新聞推播</b><small>每分鐘掃描一次研究族群成分股的個股新聞（FinMind＋台股的鉅亨網），有新新聞立即推播（點通知直接開原文）。論壇貼文與重複轉載會自動略過；剛開啟時，已有的新聞只記錄不推播。</small></div></div>
    <div class="lv-rule"><div style="flex:1"><b>推播範圍</b><div class="seg" style="margin-top:8px">${[['all', '全部研究族群'], ['watch', '只推自選股']].map(([v, l]) => `<button class="${n.scope === v ? 'on' : ''}" data-npush-scope="${v}">${l}</button>`).join('')}</div></div></div>
    <div class="lv-rule"><label class="lv-sw"><input type="checkbox" data-npush="quiet" ${n.quiet ? 'checked' : ''}><span></span></label><div><b>夜間勿擾</b><small>23:00–07:00 只記錄到雷達、不推播</small></div></div>
    <p class="set-p muted">狀態：${status}${L.push.state !== 'on' ? `<br>${['unsupported', 'denied'].includes(L.push.state) ? pushHelp(L.push.state) : '這支手機的通知尚未開啟：請到「盤中 → 雷達」按「開啟通知」'}` : ''}</p></div></section>`;
}
async function saveNews(patch) {
  const cur = L.monitor?.news || { enabled: false, scope: 'all', quiet: false };
  const r = await C.api('api/news/settings', { enabled: cur.enabled, scope: cur.scope, quiet: cur.quiet, ...patch });
  L.monitor = { ...L.monitor, news: r.news }; const el = C.$('#news-set'); if (el) el.outerHTML = newsSettingsCard();
  C.toast(r.news.enabled ? (patch.enabled ? '新聞推播已開啟，每分鐘掃描一次' : '新聞推播設定已儲存') : '新聞推播已關閉');
}

/* ---------- 推播 ---------- */
const b64ToU8 = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
// 商店版 App：推播 token 由 App 取得（FCM），登記到電腦上的衡析，通知經 App 內建的推播中繼送達
async function checkAppPush() {
  try {
    const i = await appInfo(); if (!i?.pushAvailable) { L.push = { state: 'unsupported', count: 0 }; return; }
    const r = await appCall('pushToken', { prompt: false });
    const k = await C.api('api/push/key' + (r?.token ? '?token=' + encodeURIComponent(r.token) : ''));
    L.push = { state: r?.token && k.subscribed ? 'on' : r?.permission === 'denied' ? 'denied' : 'off', count: k.count };
  } catch { L.push = { state: 'off', count: 0 }; }
}
async function enableAppPush() {
  const i = await appInfo(), r = await appCall('pushToken', { prompt: true });
  if (!r?.token) { await checkAppPush(); throw new Error(r?.permission === 'denied' ? '沒有取得通知權限' : '無法取得推播代碼，請稍後再試'); }
  await C.api('api/push/app-subscribe', { token: r.token, platform: APP_PLATFORM, relay: i.relay });
  await checkAppPush();
}
// 推播 token 更換時（FCM 偶爾會更新）：已開啟通知就改登記新的 token
if (APP) onAppEvent('pushToken', async d => {
  if (L.push.state !== 'on' || !d?.token || !C) return;
  try { const i = await appInfo(); if (d.old) await C.api('api/push/app-unsubscribe', { token: d.old }); await C.api('api/push/app-subscribe', { token: d.token, platform: APP_PLATFORM, relay: i.relay }); } catch { }
});
async function checkPush() {
  if (APP) return checkAppPush();
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { L.push = { state: 'unsupported', count: 0 }; return; }
  if (Notification.permission === 'denied') { L.push = { state: 'denied', count: 0 }; return; }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/'), sub = await reg?.pushManager.getSubscription();
    const k = await C.api('api/push/key' + (sub ? '?endpoint=' + encodeURIComponent(sub.endpoint) : ''));
    L.push = { state: sub && k.subscribed ? 'on' : 'off', count: k.count };
  } catch { L.push = { state: 'off', count: 0 }; }
}
async function enablePush() {
  if (APP) return enableAppPush();
  // iPhone Safari 規定通知權限必須在點擊當下直接請求，前面不能先 await 其他動作，否則不會跳出詢問
  const perm = await Notification.requestPermission(); if (perm !== 'granted') { await checkPush(); throw new Error('沒有取得通知權限'); }
  const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  const { publicKey } = await C.api('api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
  await C.api('api/push/subscribe', { subscription: sub.toJSON() });
  await checkPush();
}
async function disablePush() {
  if (APP) { const r = await appCall('pushToken', { prompt: false }).catch(() => null); if (r?.token) await C.api('api/push/app-unsubscribe', { token: r.token }); return checkAppPush(); }
  const reg = await navigator.serviceWorker.getRegistration('/'), sub = await reg?.pushManager.getSubscription(); if (sub) { await C.api('api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); } await checkPush(); }
if ('serviceWorker' in navigator && !APP) {
  navigator.serviceWorker.register('/sw.js').catch(() => { });
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'open') { const h = new URL(e.data.url).hash; if (h && h !== location.hash) location.hash = h; } });
}

/* ---------- AI 盤後日報（今日焦點分頁頂端） ---------- */
export async function loadReport(date) { try { L.report = await C.api('api/report' + (date ? '?date=' + date : '')); } catch (e) { if (!e.silent) L.report = { error: e.message }; } L.reportLoaded = true; }
export function reportCard() {
  const r = L.report; if (!L.reportLoaded) { loadReport().then(() => { if (C.S.tab === 'brief') C.draw(); }); return ''; }
  if (!r) return '';
  const head = `<div class="card-h"><h2>🤖 AI 盤後日報</h2>${r.dates?.length > 1 ? `<select class="sel lv-rsel" data-rdate>${r.dates.slice().reverse().map(d => `<option ${d === r.report?.date ? 'selected' : ''}>${d}</option>`).join('')}</select>` : ''}</div>`;
  const body = r.busy ? '<div class="empty"><span class="spinner"></span> AI 正在撰寫今日日報…</div>'
    : r.report ? reportHTML(r.report, { compact: true })
      : !r.configured ? '<div class="empty">尚未設定推理模型。請在電腦版「資料與設定」設定後，平日會自動產生。</div>'
        : `<div class="empty">尚無日報。平日 ${esc(r.settings?.time || '16:30')} 後自動產生。</div>`;
  return `<section class="card lv-report">${head}${r.error && !r.busy ? `<div class="notice warn" style="margin:0 14px 10px">${esc(r.error)}</div>` : ''}${body}${r.report && !r.busy ? '<div class="card-b" style="padding-bottom:8px"><button class="btn block primary" data-rcard>📊 下載 9:16 圖卡</button></div>' : ''}${r.configured && !r.busy ? `<div class="card-b"><button class="btn block" data-rgen>${r.report?.date === C.twToday() ? '⟳ 重新產生今日日報' : '✨ 立即產生今日日報'}</button></div>` : ''}</section>`;
}

/* ---------- 熱浪時光機 ---------- */
export const replayActive = () => !!L.replay;
async function openReplay(date) {
  const days = (await C.api('api/replay/days')).days; if (!days.length) throw new Error('還沒有時光機紀錄。盤中監控開啟後，每分鐘會自動錄製一個畫格。');
  const d = date || days.at(-1), sum = await C.api('api/replay?date=' + d);
  L.replay = { days, date: d, sum, rot: rotationData(sum), i: sum.times.length - 1, playing: false, speed: 1, frames: new Map(), agg: null };
  C.S.heat.live = false;
  await showFrame(L.replay.i, true);
}
async function frame(i) { const R = L.replay; if (!R.frames.has(i)) R.frames.set(i, C.api(`api/replay/frame?date=${R.date}&i=${i}`)); return R.frames.get(i); }
async function showFrame(i, full = false) {
  const R = L.replay; if (!R) return; R.i = Math.max(0, Math.min(R.sum.times.length - 1, i));
  const f = await frame(R.i); if (!L.replay || L.replay !== R) return;
  R.agg = C.aggregate({ sectors: [{ stocks: replayStocks(R.sum, f) }] }, C.S.heat.market);
  for (let k = 1; k <= 3; k++) if (R.i + k < R.sum.times.length) frame(R.i + k);
  if (full || !C.$('#rp-time')) { C.draw(); return; }
  paintReplay();
}
function paintReplay() {
  const R = L.replay, t = R.agg.total;
  C.$('#rp-time').textContent = R.sum.times[R.i]; C.$('#rp-slider').value = R.i;
  C.$('#rp-kpi').innerHTML = kpiHTML(t);
  C.$('#rp-rot').innerHTML = rotationSVG(R.rot, { w: 360, h: 150, cursor: R.i });
  const el = C.$('#hm'); if (el) C.renderTreemap(el, R.agg, { focus: C.S.heat.focus, selected: null });
}
const kpiHTML = t => `<div class="kpi"><span>累計成交</span><b class="num">${yi(t.money)}<small>億</small></b></div><div class="kpi"><span>成交加權漲跌 · 漲停 ${t.limitUp}</span><b class="num ${cls(t.change)}">${pct(t.change)}</b></div>`;
let playTimer = null;
function setPlaying(on) {
  const R = L.replay; if (!R) return; R.playing = on; clearInterval(playTimer);
  if (on) { if (R.i >= R.sum.times.length - 1) R.i = 0; playTimer = setInterval(async () => { if (!L.replay) return clearInterval(playTimer); if (R.i >= R.sum.times.length - 1) { setPlaying(false); return; } await showFrame(R.i + R.speed); }, 450); }
  const b = C.$('#rp-play'); if (b) b.textContent = on ? '⏸' : '▶';
}
export function replayPage() {
  const R = L.replay, n = R.sum.times.length;
  return `<div class="toolbar"><div class="field"><select class="sel" data-rpday style="flex:1">${R.days.slice().reverse().map(d => `<option ${d === R.date ? 'selected' : ''}>${d}</option>`).join('')}</select><button class="btn" data-rpclose>結束時光機</button></div>
    <div class="seg">${['全部', '上市', '上櫃'].map(m => `<button class="${C.S.heat.market === m ? 'on' : ''}" data-rpmarket="${m}">${m}</button>`).join('')}</div></div>
    <div class="rp-bar"><button class="btn primary" id="rp-play" data-rpplay>${R.playing ? '⏸' : '▶'}</button><b class="num" id="rp-time">${R.sum.times[R.i]}</b><input type="range" id="rp-slider" min="0" max="${n - 1}" value="${R.i}" aria-label="時間"><div class="seg rp-speed">${[[1, '1×'], [3, '3×'], [10, '10×']].map(([v, l]) => `<button class="${R.speed === v ? 'on' : ''}" data-rpspeed="${v}">${l}</button>`).join('')}</div></div>
    <div class="kpis" id="rp-kpi" style="padding:0;margin-bottom:10px">${R.agg ? kpiHTML(R.agg.total) : ''}</div>
    <div class="hm-wrap"><div id="hm" role="img" aria-label="時光機熱浪圖"></div></div>
    <div class="hm-legend">${[-7, -5, -3, -1, 0, 1, 3, 5, 7].map(v => `<span style="background:${C.heatColor(v)}">${v > 0 ? '+' : ''}${v}</span>`).join('')}</div>
    <section class="card" style="margin-top:10px"><div class="card-h"><h2>板塊輪動<small>每 5 分鐘新增成交的板塊占比</small></h2></div><div class="card-b" id="rp-rot">${rotationSVG(R.rot, { w: 360, h: 150, cursor: R.i })}</div></section>
    <div class="foot">${esc(R.date)} · ${n} 個畫格（每分鐘一格）· 累計成交金額與漲跌幅</div>`;
}
export function mountReplay() { const el = C.$('#hm'); if (el && L.replay?.agg) C.renderTreemap(el, L.replay.agg, { focus: C.S.heat.focus, selected: null }); }

/* ---------- 個股詳情：分點、大戶 ---------- */
export function stockExtrasShell(id) {
  return `<section class="card ix-card"><div class="card-h"><h2>🏦 主力分點<small>近 5 日</small></h2></div><div class="card-b" id="ix-brokers"><div class="empty"><span class="spinner"></span> 讀取券商分點…</div></div></section>
  <section class="card ix-card"><div class="card-h"><h2>🐋 大戶持股<small>每週股權分散</small></h2></div><div class="card-b" id="ix-holders"><div class="empty"><span class="spinner"></span> 讀取股權分散表…</div></div></section>
  <section class="card ix-card"><div class="card-h"><h2>🎫 認購權證<small>權證條件與追蹤分點</small></h2></div><div class="card-b" id="ix-warrants"><div class="empty"><span class="spinner"></span> 讀取權證資料…</div></div></section>`;
}
export async function fillStockExtras(id) {
  const fill = async (sel, path, render) => { try { const d = await C.api(path); const el = C.$(sel); if (el && C.S.sheetStock?.id === id) el.innerHTML = render(d); } catch (e) { const el = C.$(sel); if (el && !e.silent) el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; } };
  await Promise.all([fill('#ix-brokers', 'api/brokers?id=' + id, brokerHTML), fill('#ix-holders', 'api/holders?id=' + id, holderHTML), fill('#ix-warrants', 'api/warrants?id=' + id, warrantHTML)]);
}

/* ---------- 事件 ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !C) return; const ds = b.dataset;
  try {
    if (ds.wbr) { // 個股權證：展開／收合單一權證的分點進出（第一次展開時查詢）
      const row = document.querySelector(`[data-wbr-row="${ds.wbr}"]`); if (!row) return;
      if (!row.hidden) { row.hidden = true; return; }
      row.hidden = false; const cell = row.firstElementChild;
      if (!cell.dataset.loaded) { cell.innerHTML = '<i class="spinner"></i>'; try { cell.innerHTML = warrantBrokersHTML(await C.api(`api/warrants/brokers?wid=${encodeURIComponent(ds.wbr)}&date=${encodeURIComponent(ds.date)}`)); cell.dataset.loaded = '1'; } catch (err) { cell.innerHTML = `<p class="muted">${esc(err.message)}</p>`; } }
      return;
    }
    if (ds.lview) { L.view = ds.lview; if (ds.lview === 'radar') checkPush().then(() => C.S.tab === 'live' && C.draw()); if (ds.lview === 'groups') loadGroupRank(); if (ds.lview === 'daytrade') loadDaytrade().then(() => C.S.tab === 'live' && L.view === 'daytrade' && C.draw()); return C.draw(); }
    if ('dtreview' in ds) { await loadDtReview(); return C.draw(); }
    if ('grQuery' in ds) { GR.view = 'live'; return queryGroupRank(); }
    if (ds.grGroup) { GR.open.has(ds.grGroup) ? GR.open.delete(ds.grGroup) : GR.open.add(ds.grGroup); return C.draw(); }
    if (ds.grStock) return openQuote(ds.grStock, ds.grGroupId || '');
    if (ds.intra) return openChart(ds.intra, 'live', L.board?.group && L.board.group !== 'watch' ? L.board.group : '');
    if (ds.kbar) return openQuote(ds.kbar);
    if (ds.ixperiod) { IX.period = ds.ixperiod; return paintIndex(); }
    if (ds.ixid) return openIndex(ds.ixid);
    if ('ixrefresh' in ds) { b.disabled = true; try { await refreshIndex(); } finally { b.disabled = false; } return; }
    if (ds.iview) { K.sub = ds.iview; savePref('pocket.intraView', ds.iview); return paintIntraday(); }
    if (ds.igroup) { K.group = ds.igroup; return refreshChart(); }
    if (ds.cperiod) return openChart(K.id, ds.cperiod);
    if ('chartRefresh' in ds) { b.disabled = true; try { await refreshChart(); } finally { b.disabled = false; } return; }
    if (ds.bgroup) {
      L.bgroup = ds.bgroup; savePref('pocket.boardGroup', ds.bgroup); if (L.board) L.board = { ...L.board, group: ds.bgroup, stocks: [], loading: true };
      redrawLive(); await loadBoard(); if (C.S.tab !== 'live' || overlay()) return;
      redrawLive(); C.$('.lv-gchips .chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }); return;
    }
    if (ds.bsort) { L.bsort = ds.bsort; savePref('pocket.boardSort', ds.bsort); return redrawLive(); }
    if (ds.npushScope) { if (ds.npushScope !== L.monitor?.news?.scope) await saveNews({ scope: ds.npushScope }); return; }
    if (ds.agroup) { L.group = ds.agroup; return C.draw(); }
    if (ds.alertStock) return openQuote(ds.alertStock);
    if ('openReport' in ds) { C.setTab('brief'); return; }
    if (ds.openChips) { C.openChips(ds.openChips === 'holders' ? 'holders' : 'brokers'); return; }
    if (ds.paDel) { if (!confirm(tx('刪除這則提醒？'))) return; L.rules = await C.api('api/price-alerts/delete', { id: ds.paDel }); paintRules(); return C.toast('已刪除提醒'); }
    if (ds.paToggle) { L.rules = await C.api('api/price-alerts', { id: ds.paToggle, active: ds.on === '1' }); paintRules(); return C.toast(ds.on === '1' ? '提醒已重新啟用' : '提醒已停用'); }
    if (ds.push === 'on') { b.disabled = true; await enablePush(); C.toast('通知已開啟'); return C.draw(); }
    if (ds.push === 'off') { await disablePush(); C.toast('已關閉這台裝置的通知'); return C.draw(); }
    if (ds.push === 'test') { const r = await C.api('api/push/test', {}); C.toast(r.sent ? '測試通知已送出' : '沒有可送達的裝置'); return; }
    if (ds.rscope && L.draft) { L.draft.radar.scope = ds.rscope; return C.draw(); }
    if ('rsave' in ds && L.draft) { await C.api('api/monitor/settings', L.draft); await loadMonitor(); C.toast('雷達設定已儲存'); return C.draw(); }
    if ('rcard' in ds && L.report?.report) { b.disabled = true; const old = b.textContent; b.textContent = '繪製中…'; try { const [{ downloadReportCard }, data] = await Promise.all([import('./report-card.js'), C.api('api/report/card?date=' + L.report.report.date)]); const how = await downloadReportCard(data); if (how === 'download') C.toast('已下載圖卡，可在相簿的「Download／下載」找到'); else if (how === 'saved') C.toast('圖卡已存到相簿'); } finally { b.disabled = false; b.textContent = old; } return; }
    if ('rgen' in ds) { if (!confirm(tx('使用推理模型產生今日盤後日報？可能產生少量 API 費用。'))) return; await C.api('api/report/generate', {}); await loadReport(); C.toast('AI 開始撰寫日報，完成後會推播通知'); return C.draw(); }
    if ('replayOpen' in ds) { b.disabled = true; try { await openReplay(); } finally { b.disabled = false; } return; }
    if ('rpclose' in ds) { setPlaying(false); L.replay = null; return C.draw(); }
    if ('rpplay' in ds) return setPlaying(!L.replay.playing);
    if (ds.rpspeed) { L.replay.speed = Number(ds.rpspeed); C.$$('[data-rpspeed]').forEach(x => x.classList.toggle('on', x === b)); return; }
    if (ds.rpmarket) { C.S.heat.market = ds.rpmarket; return showFrame(L.replay.i, true); }
  } catch (err) { if (!err.silent) C.toast(err.message); }
});
document.addEventListener('submit', async e => {
  const f = e.target; if (!C || !('paForm' in f.dataset)) return; e.preventDefault();
  const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
  try { L.rules = await C.api('api/price-alerts', priceRuleBody(f)); f.elements.value.value = ''; f.elements.note.value = ''; if (f.elements.stockId.type !== 'hidden') f.elements.stockId.value = ''; paintRules(); C.toast('已新增提醒，條件成立時推播'); }
  catch (err) { if (!err.silent) C.toast(err.message); } finally { btn.disabled = false; }
});
document.addEventListener('change', async e => {
  const t = e.target; if (!C) return;
  if (t.dataset.npush) { t.disabled = true; try { await saveNews({ [t.dataset.npush]: t.checked }); } catch (err) { if (!err.silent) C.toast(err.message); t.checked = !t.checked; } finally { t.disabled = false; } return; }
  if (t.dataset.rset && L.draft) { const path = t.dataset.rset, v = t.type === 'checkbox' ? t.checked : Number(t.value); if (path === 'monitor') L.draft.monitor = v; else { const ks = path.split('.'); ks.slice(0, -1).reduce((o, k) => o[k], L.draft.radar)[ks.at(-1)] = v; } return; }
  if ('rdate' in t.dataset) { await loadReport(t.value); return C.draw(); }
  if ('rpday' in t.dataset) { setPlaying(false); try { await openReplay(t.value); } catch (err) { C.toast(err.message); } }
});
let slideTimer;
document.addEventListener('input', e => { if (e.target.id === 'rp-slider' && L.replay) { setPlaying(false); const i = Number(e.target.value); C.$('#rp-time').textContent = L.replay.sum.times[i]; clearTimeout(slideTimer); slideTimer = setTimeout(() => showFrame(i), 60); } });

/* ---------- 族群排名（低量排除＋√成交金額加權） ---------- */
const GR = { live: null, record: null, dates: [], view: 'live', loading: false, error: '', open: new Set(), loaded: false };
async function loadGroupRank() {
  if (!GR.loaded) { GR.loaded = true; try { const r = await C.api('api/grouprank'); GR.record = r.record; GR.dates = r.dates; if (r.live) GR.live = r.live; } catch (e) { if (!e.silent) GR.error = e.message; } }
  if (!GR.live || marketOpen()) await queryGroupRank(true); else if (C.S.tab === 'live') C.draw();
}
async function queryGroupRank(quiet = false) {
  if (GR.loading) return; GR.loading = true; GR.error = ''; if (!quiet && C.S.tab === 'live') C.draw();
  try { GR.live = await C.api('api/grouprank/query', {}); } catch (e) { if (!e.silent) GR.error = e.message; }
  GR.loading = false; if (C.S.tab === 'live' && L.view === 'groups' && !overlay()) C.draw();
}
setInterval(() => { if (C && C.S.tab === 'live' && L.view === 'groups' && GR.view === 'live' && marketOpen() && !document.hidden) queryGroupRank(true); }, 30000);
const md = d => d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '';
function grMove(g) {
  if (g.move == null) return g.prevRank == null ? '<span class="fr-mv new">—</span>' : '';
  if (g.move === 0) return '<span class="fr-mv flat">－0</span>';
  return g.move > 0 ? `<span class="fr-mv up">▲+${g.move}</span>` : `<span class="fr-mv down">▼${g.move}</span>`;
}
function groupsView() {
  const d = GR.view === 'live' ? GR.live : GR.record, max = Math.max(0.5, ...(d?.groups || []).filter(g => g.score != null).map(g => Math.abs(g.score)));
  const ctl = `<div class="toolbar"><div class="field"><button class="btn primary" data-gr-query ${GR.loading ? 'disabled' : ''} style="flex:1">${GR.loading ? '<span class="spinner"></span> 更新中…' : '⟳ 更新排名'}</button><select class="sel" data-gr-date style="flex:1"><option value="live" ${GR.view === 'live' ? 'selected' : ''}>即時排名</option>${GR.dates.slice().reverse().map(x => `<option value="${x}" ${GR.view === x ? 'selected' : ''}>${md(x)} 收盤</option>`).join('')}</select></div></div>`;
  if (!d) return ctl + (GR.error ? `<div class="notice err">${esc(GR.error)}</div>` : '') + `<div class="empty">${GR.loading ? '<span class="spinner"></span> 計算族群排名…' : '按「更新排名」取得各族群目前的漲幅排名。'}</div>`;
  const meta = `<div class="statusline"><span class="pill">${d.source === 'live' ? '盤中' : md(d.date) + ' 收盤'} · ${esc(String(d.asOf || '—').slice(11, 16))}</span><span class="pill">${d.quoted}/${d.stocks} 檔</span>${d.compare ? `<span class="pill">對照 ${md(d.compare.date)} 收盤</span>` : ''}</div>`;
  const list = d.groups.map(g => { const open = GR.open.has(g.id);
    return `<button class="fr-card ${g.score == null ? 'none' : ''}" data-gr-group="${esc(g.id)}"><span class="fr-rk num">${g.rank ?? '—'}</span><span class="fr-nm"><b>${esc(g.name)}</b><small><span class="up">${g.up}</span>/<span class="down">${g.down}</span> · 成交 ${fmt((g.amount || 0) / 1e8, 1)} 億${g.excluded ? ` · ${g.excluded} 檔低量` : ''}</small></span>${grMove(g)}<span class="fr-av num ${cls(g.score)}">${pct(g.score)}</span>
      ${g.score != null ? `<span class="fr-bar"><i class="${g.score >= 0 ? 'pos' : 'neg'}" style="width:${Math.abs(g.score) / max * 50}%;${g.score >= 0 ? 'left:50%' : 'right:50%'}"></i></span>` : ''}</button>
      ${open ? `<div class="fr-items"><p class="gr-ref">成交加權 <b class="${cls(g.wavg)}">${pct(g.wavg)}</b> · 簡單平均 <b class="${cls(g.avg)}">${pct(g.avg)}</b> · 上漲比 ${fmt(g.breadth, 0)}%</p>${g.items.map(x => `<button class="fr-item ${x.excluded ? 'ex' : ''}" data-gr-stock="${esc(x.id)}"><span>${esc(x.name)} <small class="num">${esc(x.id)}</small>${x.excluded ? ' <em class="ix-badge warn">低量</em>' : ''}</span><span class="num">${fmt(x.amount / 1e8, 1)}億</span><span class="num ${cls(x.rate)}">${pct(x.rate)}</span></button>`).join('')}</div>` : ''}`; }).join('');
  return ctl + (GR.error ? `<div class="notice err">${esc(GR.error)}</div>` : '') + meta + `<section class="card fr-list">${list}</section><p class="foot">排名依「量能加權漲幅」：排除低量個股（成交低於族群 0.5% 或 1,000 萬），以 √成交金額加權，避免冷門股或單一權值股失真<br>▲ 名次上升　▼ 名次下降（對照前一交易日收盤）· 盤中每 30 秒自動更新</p>`;
}
document.addEventListener('change', async e => { if (!C || !e.target.matches?.('[data-gr-date]')) return; GR.view = e.target.value; if (GR.view !== 'live') { try { const r = await C.api('api/grouprank?date=' + GR.view); GR.record = r.record; } catch (err) { if (!err.silent) GR.error = err.message; } } C.draw(); });