// 衡析 Nexus：當沖掃描面板（盤中雷達頁）— 即時推播狀態、今日當沖訊號、觀察名單（前一日高周轉率＋研究族群）的 5 分 K 與 20MA、收盤後訊號檢討、當沖監控設定。
// 資料：/api/daytrade（每 3 秒）、/api/daytrade/review、/api/daytrade/settings。只有設定了支援即時推播的資料源（例如富果）才顯示。
import { esc, fmt, pct, cls } from './insight-ui.js';
import * as MK from './market.js';

let X = null; // { api, toast, repaint, isLive }
const D = { info: null, review: null, tab: 'scan', draft: null, error: '', at: 0 };
export function initDaytrade(ctx) { X = ctx; }
export const dtCapable = () => !!D.info?.capable;
export async function loadDaytrade() { try { D.info = await X.api('daytrade'); D.at = Date.now(); D.error = ''; if (!D.draft) D.draft = structuredClone(D.info.settings); } catch (e) { D.error = e.message; } }
async function loadReview() { try { D.review = await X.api('daytrade/review'); } catch (e) { D.error = e.message; } }
// 五檔錄製（/api/books）：錄製狀態、換股紀錄、匯出 CSV、設定
const B = { info: null, draft: null, date: '', stocks: null, id: '' };
async function loadBooks() {
  try {
    B.info = await X.api('books'); if (!B.draft) B.draft = structuredClone(B.info.settings);
    const dates = B.info.days.map(x => x.date); if (!dates.includes(B.date)) { B.date = dates[0] || ''; B.stocks = null; }
    if (B.date && !B.stocks) B.stocks = (await X.api('books/stocks?date=' + B.date)).stocks;
  } catch (e) { D.error = e.message; }
}
// 盤中且推播運作時每 3 秒更新；其餘時間 30 秒
setInterval(async () => {
  if (!X || document.hidden || !X.isLive()) return;
  const live = D.info?.feed?.active && MK.isOpen();
  if (!live && Date.now() - D.at < 30e3) return;
  await loadDaytrade(); if (D.tab === 'scan') X.repaint();
  if (D.tab === 'books' && Date.now() - (B.at || 0) > 10e3) { B.at = Date.now(); await loadBooks(); X.repaint(); }
}, 3000);

const PLAN_NAMES = { basic: '基本', developer: '開發者', advanced: '進階' };
const FILTERS = { noDayTrade: '不可當沖', disposition: '處置', suspended: '暫停交易' };
// 訊號名稱（含舊版，供訊號檢討顯示過去的紀錄）
const SIG = { 'dt-ma-up': '📈 突破 20MA', 'dt-ma-down': '📉 跌破 20MA', 'dt-open-low': '🔻 跌破開盤低點', 'dt-breakout': '💥 爆量突破', 'dt-vwap': '📈 VWAP 延續', 'dt-bid': '🟢 五檔增強', 'dt-weak': '⚠️ 多單轉弱', 'dt-risk': '🛑 參考停損' };
const SIDE = { long: '多方', short: '空方' }, sideTag = side => SIDE[side] ? `<span class="dt-side ${side === 'long' ? 'up' : 'down'}">${SIDE[side]}</span>` : '';
const n0 = v => v == null ? '—' : fmt(v, 0), n1 = v => v == null ? '—' : fmt(v, 1), n2 = v => v == null ? '—' : fmt(v, 2);
// 大盤環境紀錄（只記錄，不影響分數、門檻與推播）
const REGIME = { tailwind: '順風', neutral: '中性', headwind: '逆風', none: '未記錄' };
const REGIME_TAG = { tailwind: '大盤順風', neutral: '大盤中性', headwind: '大盤逆風' };
const STRENGTH = { strong: '強於大盤', weak: '弱於大盤', none: '未記錄' };
const INDEX_NAME = { twse: '加權', tpex: '櫃買' };
const MK_REASON = { exchange: '非上市櫃', noIndex: '沒有指數資料', stale: '指數資料過期', warmup: '開盤未滿 15 分鐘' };
function marketLine(mk) {
  if (!mk) return '';
  const one = k => {
    const x = mk[k]; if (!x) return `<span>${INDEX_NAME[k]} <span class="muted">等待指數資料</span></span>`;
    const state = x.stale ? '<b class="warn">資料過期</b>' : x.regime ? `<b>${REGIME[x.regime]}</b>` : '<span class="muted">累積中</span>';
    return `<span title="近 15 分鐘 ${pct(x.r15)} · 日內均價 ${n2(x.avg)}${x.up != null ? ` · 上漲 ${fmt(x.up)}／下跌 ${fmt(x.down)} 家` : ''}">${INDEX_NAME[k]} <b class="mono ${cls(x.chg)}">${pct(x.chg)}</b> · 15 分 <span class="mono ${cls(x.r15)}">${pct(x.r15)}</span>${x.vsAvg == null ? '' : x.vsAvg >= 0 ? ' · 均價之上' : ' · 均價之下'} · ${state}</span>`;
  };
  return `<div class="dt-status"><b>大盤環境（只記錄）</b>${one('twse')}${one('tpex')}</div>`;
}

function feedLine(d) {
  const f = d.feed, plan = PLAN_NAMES[d.plan] || d.plan || '—', lim = d.plans?.[d.plan]?.limit;
  if (!f.window) return '<span>非盤中 · 平日開盤前 10 分鐘自動連線並確認訂閱</span>';
  if (!f.connected) return `<span class="warn">${f.authFailed ? '金鑰無效或方案不支援（10 分鐘後重試）' : f.error ? `即時推播未連線：${esc(f.error === 'no-heartbeat' ? '連線逾時，重新連線中' : f.error)}` : '即時推播連線中…'}</span>`;
  const mode = f.mode === 'full' ? '完整模式：逐筆成交＋1 分 K＋五檔' : '精簡模式：聚合行情';
  // 連線（或斷線重連）後 30 秒內仍在逐批訂閱，顯示「重新訂閱中」；超過 30 秒還不足才是真的訂閱不足
  const short = f.subscribed < f.expected ? (f.since && Date.now() - f.since < 30e3 ? ' <b>重新訂閱中…</b>' : ' <b class="warn">訂閱不足</b>') : '';
  const hm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour12: false }).slice(0, 5), lastDrop = f.drops?.at(-1);
  const drops = f.dropCount ? `<span class="${f.dropCount >= 5 ? 'warn' : ''}" title="${esc((f.drops || []).map(x => `${hm(x.at)} 連線 ${x.conns.join('、') || '—'}：${x.reason === 'no-heartbeat' ? '超過 75 秒沒有訊息' : x.reason === 'close' ? '伺服器關閉連線' : x.reason}`).join(' · '))}">今日斷線重連 ${f.dropCount} 次（最近 ${hm(lastDrop.at)}）</span>` : '';
  return `<span>⚡ ${mode}</span><span>富果${plan}方案${lim ? `（上限 ${fmt(lim)}）` : ''}</span><span>訂閱 <b class="mono">${fmt(f.subscribed)}／${fmt(f.expected)}</b>${f.connections?.length > 1 ? `（${f.connections.length} 條連線）` : ''}${short}</span>${drops}${f.backfill?.busy ? `<span class="warn">斷線補資料中 ${f.backfill.done}／${f.backfill.total}</span>` : ''}${d.fallback ? '<span class="warn">訂閱數不足，今天改用精簡模式</span>' : ''}`;
}
function prepLine(d) {
  const p = d.prep, base = '';
  if (!p) return `<span>盤前資料（可當沖標的、處置股、參考價）於開盤前 30 分鐘取得</span>${base}`;
  return `<span>${p.eligible == null ? '<b class="warn">可當沖清單未取得</b>' : `可當沖 <b class="mono">${fmt(p.eligible)}</b> 檔`}</span><span>處置 <b class="mono">${p.disposition}</b></span><span>暫停交易 <b class="mono">${p.suspended}</b></span><span>暫停先賣後買 <b class="mono">${p.sellFirstOff}</b></span><span>參考價 <b class="mono">${fmt(p.ref)}</b> 檔</span>${p.errors?.length ? `<span class="warn" title="${esc(p.errors.join('\n'))}">部分盤前資料取得失敗</span>` : ''}${base}`;
}
const REASONS = { history: '5 分 K 不足 21 根', fiveMinute: '等待第一根 5 分 K', subscription: '超出訂閱範圍', waitingQuote: '等待報價' };
const md = d => d ? esc(String(d).slice(5).replace('-', '/')) : '—';
function row(x) {
  const f = x.five || {}, waiting = [...(x.pending ? ['補資料中'] : []), ...(x.reasons || []).map(k => REASONS[k] || k), ...(x.filters || []).map(k => FILTERS[k] || k)];
  const pos = f.above == null ? '<span class="muted">—</span>' : f.above ? '<span class="up">20MA 之上</span>' : f.dist < 0 ? '<span class="down">20MA 之下</span>' : '<span class="muted">貼近 20MA</span>';
  const src = `${x.turnover != null ? `<span class="dt-tag" title="前一交易日周轉率">周轉 ${n2(x.turnover)}%</span>` : ''}${x.grouped ? '<span class="dt-tag">族群</span>' : ''}${x.watch ? '<span class="dt-tag">自選</span>' : ''}`;
  return `<tr data-kbar-row="${esc(x.id)}" class="${x.filters?.length ? 'dim' : ''}"><td><b>${esc(x.name)}</b><small class="mono"> ${esc(x.id)}</small><small>${src}</small></td>
    <td class="mono ${cls(x.change)}">${n2(x.price)}<small> ${pct(x.change)}</small></td>
    <td class="mono">${n2(f.close)}<small>${f.end ? `${esc(f.end)} 收` : '—'}</small></td>
    <td class="mono">${n2(f.ma20)}<small class="${cls(f.dist)}">${f.dist == null ? '—' : pct(f.dist)}</small></td>
    <td>${pos}${waiting.length ? `<small class="warn">${esc(waiting.join('、'))}</small>` : ''}</td>
    <td class="mono">${n2(f.openLow)}${f.belowOpen ? '<small class="down">已跌破</small>' : ''}</td>
    <td>${x.last ? `${SIG[x.last.type] || esc(x.last.type)}<small>${esc(x.last.t)}</small>` : '—'}</td></tr>`;
}
function scanView(d) {
  const h = d.history || {}, so = d.sources || {}, c = d.counts, tv = d.prep?.turnover, st = d.settings || {};
  const parts = [st.sources?.turnover ? `高周轉率 ${fmt(so.turnover || 0)}` : '', st.sources?.groups ? `研究族群 ${fmt(so.groups || 0)}` : '', st.sources?.watchlist ? `自選 ${fmt(so.watchlist || 0)}` : ''].filter(Boolean).join('＋');
  const tvLine = !st.sources?.turnover ? '' : tv ? `<span>高周轉率：${md(tv.date)} 周轉率前 ${fmt(tv.picked)} 名${st.turnoverMinAmount ? `（成交金額 ≥ ${fmt(st.turnoverMinAmount / 1e8, 1)} 億）` : ''}${tv.minRate != null ? `，最低 ${n2(tv.minRate)}%` : ''}${tv.sharesDate ? ` · 股數取 ${md(tv.sharesDate)} 集保資料` : ''}</span>` : '<span class="warn">高周轉率名單尚未取得（開盤前 30 分鐘起取得前一交易日的全市場行情）</span>';
  const sigs = d.signals || [], more = (d.signalCount || 0) - sigs.length;
  const sigList = sigs.length ? `<h4 class="dt-sub">今日訊號 ${fmt(d.signalCount || sigs.length)} 則</h4><div class="dt-signals">${sigs.map(s => `<div class="dt-sig" data-kbar-row="${esc(s.id)}"><span class="mono">${esc(s.t?.slice(0, 5))}</span>${sideTag(s.side)}<b>${esc(s.name)}</b> <small class="mono">${esc(s.id)}</small><span>${SIG[s.type] || esc(s.type)}</span><span class="mono">${n2(s.price)}</span><span class="muted">${esc(s.detail || '')}</span></div>`).join('')}</div>${more > 0 ? `<p class="dt-foot">只列出最近 ${sigs.length} 則，完整紀錄見「訊號檢討」。</p>` : ''}`
    : `<div class="empty"><p>${d.feed?.window ? '今天還沒有訊號。5 分 K 走完時判斷一次，有訊號會立即出現並推播到手機。' : '盤中才會判斷訊號。'}</p></div>`;
  const list = d.top || [], ex = Object.entries(d.excluded || {}).filter(([, v]) => v).map(([k, v]) => `${FILTERS[k] || k} ${v}`);
  return `${marketLine(d.market)}<div class="dt-status"><b>觀察名單 ${fmt(so.total || 0)} 檔</b><span>${parts || '沒有選擇來源'}（同一檔可重複）</span>${d.feed?.connected && so.subscribed < so.total ? `<span class="warn">已訂閱 ${fmt(so.subscribed)} 檔，其餘超出方案訂閱數</span>` : ''}<span>歷史 5 分 K 就緒 ${fmt(h.ready || 0)}／${fmt(h.total || 0)}${h.short ? `（不足 ${fmt(h.short)}）` : ''}</span>${c ? `<span>5 分 K 在 20MA 之上 <b class="mono up">${fmt(c.long)}</b>、之下 <b class="mono down">${fmt(c.short)}</b>、等待 <b class="mono">${fmt(c.waiting)}</b></span>` : ''}</div>
    <div class="dt-status">${tvLine}${ex.length ? `<span>不發訊號：${ex.join(' · ')}</span>` : ''}</div>
    ${(h.errors || []).map(x => `<p class="notice warn">${esc(x.id)} · ${esc(x.error)}</p>`).join('')}
    ${sigList}
    <h4 class="dt-sub">觀察名單${d.listed > list.length ? `（顯示 ${list.length}／${fmt(d.listed)} 檔：今天有訊號的在前，其餘依現價與 20MA 的距離由近到遠）` : ''}</h4>
    ${list.length ? `<div class="dt-table"><table><tr><th>股票</th><th>現價</th><th>5 分 K 收盤</th><th>20MA／現價距離</th><th>位置</th><th>開盤低點</th><th>最近訊號</th></tr>${list.map(row).join('')}</table></div>` : `<div class="empty">${so.total ? '尚無報價，開盤後開始計算。' : '觀察名單是空的：請建立研究族群，或在「設定」選擇名單來源。'}</div>`}
    <p class="dt-foot">只看 5 分 K：收盤突破 20MA 為多方訊號；收盤跌破 20MA、或跌破開盤低點（當日第一根 5 分 K 的最低價）為空方訊號。每根 5 分 K 走完後判斷一次，同一根不重複發。</p>
    <p class="dt-foot">20MA 以連續的 5 分 K 計算（接續前一交易日），與一般看盤軟體相同。訊號是研究用的價格事件，不是下單建議，也不代表可以成交。</p>`;
}
const rv = x => x == null ? '—' : `<span class="${cls(x)}">${x > 0 ? '+' : ''}${fmt(x, 2)}%</span>`;
const statCells = x => `<td class="mono">${x.n}</td><td class="mono">${x.win15 == null ? '—' : x.win15 + '%'}</td><td class="mono">${rv(x.r15)}</td><td class="mono">${rv(x.r30)}</td><td class="mono">${rv(x.rClose)}</td><td class="mono">${rv(x.mfe)}／${rv(x.mae)}</td>`;
// 依訊號當下的大盤環境、相對強弱分組（多方訊號）
function marketReview(r) {
  const mk = r.market; if (!mk?.signals) return '';
  const head = (label) => `<tr><th>${label}</th><th>次數</th><th>15 分鐘勝率</th><th>15 分鐘</th><th>30 分鐘</th><th>持有到收盤</th><th>最大有利／不利</th></tr>`;
  const regimes = `<div class="dt-table"><table>${head('大盤環境')}${mk.regimes.filter(x => x.n || x.key !== 'none').map(x => `<tr><td>${REGIME[x.key]}</td>${statCells(x)}</tr>`).join('')}</table></div>`;
  const strength = `<div class="dt-table"><table>${head('相對強弱')}${mk.strength.filter(x => x.n || x.key !== 'none').map(x => `<tr><td>${STRENGTH[x.key]}</td>${statCells(x)}</tr>`).join('')}</table></div>`;
  const v2 = r.types.filter(x => x.regimes), cell = x => x?.n ? `${x.n} 則 · ${x.win15 == null ? '—' : x.win15 + '%'} · ${rv(x.r15)}` : '—';
  const byType = v2.length ? `<div class="dt-table"><table><tr><th>訊號（次數 · 15 分鐘勝率 · 15 分鐘）</th><th>順風</th><th>中性</th><th>逆風</th></tr>${v2.map(x => `<tr><td>${esc(x.title)}</td><td class="mono">${cell(x.regimes.tailwind)}</td><td class="mono">${cell(x.regimes.neutral)}</td><td class="mono">${cell(x.regimes.headwind)}</td></tr>`).join('')}</table></div>` : '';
  return `<h4 class="dt-sub">依大盤環境分組（只記錄，不影響訊號；前兩張表只算多方訊號）</h4>${regimes}${strength}${byType}
    <p class="dt-foot">上市股對照加權指數、上櫃股對照櫃買指數，以訊號當下判斷。順風＝指數在日內均價之上且近 15 分鐘未下跌；逆風＝在均價之下且近 15 分鐘下跌，或近 15 分鐘跌幅達 0.5%；其餘為中性。相對強弱＝個股近 15 分鐘漲跌減指數近 15 分鐘漲跌。</p>
    <p class="dt-foot">${mk.since ? `從 ${esc(mk.since)} 開始記錄，多方訊號 ${mk.signals} 則中有 ${mk.recorded} 則有完整大盤資料` : '尚無大盤紀錄（這個版本之後的訊號才會記錄）'}。各組累積到數十則以上再比較；組間差異不明顯時，不需要加入大盤條件。</p>`;
}
function reviewView() {
  const r = D.review; if (!r) return '<div class="empty"><span class="spinner"></span></div>';
  if (!r.signals) return `<div class="empty"><p>尚無訊號紀錄。每個交易日收盤後，系統會以分 K 檢討當天的當沖訊號。</p></div>`;
  const table = `<div class="dt-table"><table><tr><th>訊號</th><th>次數</th><th>15 分鐘勝率</th><th>5 分鐘</th><th>15 分鐘</th><th>30 分鐘</th><th>持有到收盤</th><th title="30 分鐘內最大有利／不利幅度（未扣成本）">最大有利／不利</th></tr>
    ${r.types.map(x => `<tr><td>${esc(x.title)} <small>v${x.version || 1}</small></td><td class="mono">${x.n}</td><td class="mono">${x.win15 == null ? '—' : x.win15 + '%'}</td><td class="mono">${rv(x.r5)}</td><td class="mono">${rv(x.r15)}</td><td class="mono">${rv(x.r30)}</td><td class="mono">${rv(x.rClose)}</td><td class="mono">${rv(x.mfe)}／${rv(x.mae)}</td></tr>`).join('')}</table></div>`;
  const mkTag = s => !(s.version >= 2) ? '' : s.regime ? `<span>${REGIME_TAG[s.regime]}</span>${s.market?.rs15 != null ? `<span class="mono">相對大盤 ${pct(s.market.rs15)}</span>` : ''}` : `<span class="muted">${MK_REASON[s.market?.reason] || '大盤未記錄'}</span>`;
  const recent = r.recent.map(d => `<details class="dt-day"><summary>${esc(d.date)} · ${d.signals.length} 則${d.mode === 'lite' ? ' · 精簡模式' : ''}</summary>${d.signals.map(s => `<div class="dt-sig"><span class="mono">${esc(s.t?.slice(0, 5))}</span>${sideTag(s.side)}<b>${esc(s.name)}</b> <small class="mono">${esc(s.id)}</small><span>${SIG[s.type] || esc(s.title)}</span><span class="mono">${n2(s.price)}</span><span class="mono">15 分 ${rv(s.purpose === 'risk' ? null : s.outcome?.r15)}</span><span class="mono">收盤 ${rv(s.outcome?.rClose)}</span>${mkTag(s)}</div>`).join('')}</details>`).join('');
  return `${table}<p class="dt-foot">共 ${r.days} 個交易日、${r.signals} 則訊號。多方以訊號價加滑價買進、空方以訊號價減滑價賣出（先賣後買），到時以收盤價反向平倉，已扣除手續費與證交稅（來回約 ${fmt(r.cost, 3)}%）；樣本少時僅供參考。</p>${marketReview(r)}${recent}`;
}
function settingsView(d) {
  const s = D.draft || d.settings, need = d.need || {}, so = d.sources || {};
  const sel = (key, opts, fmtv = v => v) => `<select data-dtset="${key}">${opts.map(v => `<option value="${v}" ${String(key.split('.').reduce((o, k) => o?.[k], s)) === String(v) ? 'selected' : ''}>${fmtv(v)}</option>`).join('')}</select>`;
  const chk = (key, label) => `<label class="lv-rule"><input type="checkbox" data-dtset="${key}" ${key.split('.').reduce((o, k) => o?.[k], s) ? 'checked' : ''}><span>${label}</span></label>`;
  return `<div class="lv-settings">
    ${chk('enabled', '啟用當沖監控（盤中判斷 5 分 K 訊號、推播、收盤檢討）')}
    <label class="dt-field"><span>富果方案</span>${sel('plan', ['auto', 'advanced', 'developer', 'basic'], v => ({ auto: '自動判斷', advanced: '進階（2,000 訂閱）', developer: '開發者（300 訂閱）', basic: '基本（5 訂閱）' })[v])}</label>
    <p class="dt-foot">目前觀察名單 ${fmt(need.scanned || 0)} 檔、即時推播共 ${fmt(need.symbols || 0)} 檔。完整模式每檔 3 個訂閱（逐筆、1 分 K、五檔），放不下時改用精簡模式（每檔 1 個）；訊號只需要成交價，兩種模式都能判斷。</p>
    <h4 class="dt-sub">觀察名單</h4>
    ${chk('sources.turnover', '前一日全市場高周轉率個股')}
    <label class="dt-field sub"><span>周轉率前</span>${sel('turnoverTop', [30, 50, 80, 100, 150, 200], v => `${v} 名`)}<span>成交金額至少</span>${sel('turnoverMinAmount', [0, 50e6, 100e6, 300e6, 500e6, 1000e6], v => v ? `${fmt(v / 1e8, 1)} 億` : '不限')}</label>
    ${chk('sources.groups', `全部研究族群的個股${so.groups ? `（目前 ${fmt(so.groups)} 檔）` : ''}`)}
    ${chk('sources.watchlist', '自選股')}
    <p class="dt-foot">周轉率＝前一交易日成交股數 ÷ 集保總股數，只算上市櫃普通股（不含 ETF）。名單在每天開盤前 30 分鐘取得一次；歷史 5 分 K 每檔 1 次請求（富果歷史 API 每分鐘 60 次），300 檔約 5 分鐘。</p>
    <h4 class="dt-sub">訊號（只看 5 分 K）</h4>
    ${chk('signals.maUp', '📈 多方：5 分 K 收盤突破 20MA')}
    ${chk('signals.maDown', '📉 空方：5 分 K 收盤跌破 20MA')}
    ${chk('signals.openLow', '🔻 空方：5 分 K 收盤跌破開盤低點（當日第一根 5 分 K 的最低價）')}
    ${chk('eligibleOnly', '只對可現股當沖的股票發訊號（排除不可當沖、處置股；空方另排除暫停先賣後買）')}
    <label class="dt-field"><span>訊號時段</span>${sel('watchFrom', ['09:05', '09:10', '09:15', '09:30'])}<span>到</span>${sel('stopNew', ['12:00', '13:00', '13:10', '13:20', '13:25'])}</label>
    <p class="dt-foot">每根 5 分 K 走完後判斷一次（例如 09:10 判斷 09:05–09:10 這一根）；同一批訊號合成一則手機推播，分多方與空方列出。13:25 起是收盤集合競價，不發訊號。</p>
    <label class="dt-field"><span>觀察名單顯示</span>${sel('top', [20, 30, 50, 100, 200], v => `${v} 檔`)}</label>
    <label class="dt-field"><span>手續費折扣</span>${sel('costs.feeDiscount', [1, 0.6, 0.5, 0.38, 0.28, 0.2], v => v === 1 ? '無折扣' : `${+(v * 10).toFixed(1)} 折`)}<span>證交稅</span>${sel('costs.taxRate', [0.0015, 0.003], v => `${fmt(v * 100, 2)}%`)}<span>滑價</span>${sel('costs.slipTicks', [0, 1, 2], v => `${v} 檔價位`)}</label>
    <p class="dt-foot">現股當沖證交稅目前減半為 0.15%（至 2027 年底）；滑價與成本只用於訊號檢討的淨報酬計算。</p>
    <div class="form-actions"><button class="primary" data-dtsave>儲存當沖監控設定</button></div></div>`;
}
function booksView() {
  const b = B.info; if (!b) return '<div class="empty"><span class="spinner"></span></div>';
  const s = B.draft || b.settings, td = b.today, st = b.stats, mb = v => fmt(v / 1048576, 1) + ' MB';
  const status = !s.enabled ? '<span>五檔錄製已關閉</span>' : b.recording && td
    ? `<span>⏺ 錄製中</span><span>推播清單 <b class="mono">${fmt(td.main)}</b> 檔（五檔＋逐筆）</span><span>加錄 <b class="mono">${fmt(td.extras)}</b> 檔（只錄五檔，訂閱 ${fmt(td.subscribed)}／${fmt(td.extras)}）</span>${st ? `<span>五檔變動 <b class="mono">${fmt(st.books)}</b> · 成交 <b class="mono">${fmt(st.trades)}</b> · 原始 ${mb(st.bytes)}</span>` : ''}${td.liquidityDays ? '' : '<span class="warn">時光機沒有紀錄，開盤前無法挑選加錄股票（盤中換股仍會加錄）</span>'}${td.gap ? '<span class="warn">推播曾中斷，收盤後以 REST 補齊逐筆成交</span>' : ''}`
    : `<span>非盤中 · 平日開盤前 10 分鐘隨即時推播開始錄製</span>${b.busy ? `<span class="warn">收盤整理中${td?.fill ? `：補逐筆成交 ${td.fill.done}／${td.fill.total}` : ''}</span>` : ''}`;
  const swaps = td?.swaps?.length ? `<details class="dt-day"><summary>今日換股 ${td.swaps.length} 次（累計錄過 ${fmt(td.ever)} 檔加錄股票）</summary>${td.swaps.map(w => `<div class="dt-sig"><span class="mono">${esc(w.at.slice(0, 5))}</span><span>加錄 <b class="mono">${w.added.length}</b></span><span>移除 <b class="mono">${w.dropped.length}</b></span>${w.sectors.length ? `<span>族群轉強：${w.sectors.map(esc).join('、')}</span>` : ''}<small class="mono">${w.added.slice(0, 12).map(esc).join(' ')}${w.added.length > 12 ? ' …' : ''}</small></div>`).join('')}</details>` : '';
  const opts = (B.stocks || []).map(x => `<option value="${esc(x.id)}">${esc(x.name)}${x.main ? '' : '（加錄）'}${x.books != null ? ` · 五檔 ${x.books} · 成交 ${x.trades}` : ''}</option>`).join('');
  const exp = b.days.length ? `<div class="dt-field"><span>匯出日期</span><select data-bkdate>${b.days.map(x => `<option value="${x.date}" ${x.date === B.date ? 'selected' : ''}>${x.date}${x.compacted ? '' : '（整理前）'}</option>`).join('')}</select>
      <span>股票代號</span><input data-bkid list="bk-stocks" value="${esc(B.id)}" placeholder="例如 3406" size="10" autocomplete="off"><datalist id="bk-stocks">${opts}</datalist><button class="primary" data-bkexport>下載 CSV</button></div>
    <p class="dt-foot">每次五檔變動與每筆成交各一列，成交列附上當下的五檔（委買／委賣各 5 檔價格與張數）。整理前（盤中）匯出需逐檔篩選，可能要等數十秒。</p>` : '<div class="empty"><p>尚無錄製紀錄。</p></div>';
  const days = b.days.length ? `<div class="dt-table"><table><tr><th>日期</th><th>狀態</th><th>股票數</th><th>推播清單</th><th>加錄</th><th>換股</th><th>匯出</th></tr>${b.days.map(x => `<tr><td class="mono">${x.date}</td><td>${x.compacted ? '已整理' : '<span class="warn">待整理</span>'}${x.gap ? ' · 曾中斷' : ''}</td><td class="mono">${x.stocks ?? '—'}</td><td class="mono">${fmt(x.main)}</td><td class="mono">${fmt(x.extra)}</td><td class="mono">${x.swaps}</td><td>${x.exported ? `<span title="${esc(x.exported.file)}">✓ ${fmt(x.exported.bytes / 1048576, 0)} MB</span>` : b.exporting === x.date ? '<span class="warn">匯出中…</span>' : x.exportError ? `<span class="warn" title="${esc(x.exportError)}">失敗</span>` : '—'}</td></tr>`).join('')}</table></div>` : '';
  const sel = (key, list, f = v => v) => `<select data-bkset="${key}">${list.map(v => `<option value="${v}" ${s[key] === v ? 'selected' : ''}>${f(v)}</option>`).join('')}</select>`;
  const set = `<details class="dt-day"><summary>錄製設定</summary><div class="lv-settings">
    <label class="lv-rule"><input type="checkbox" data-bkset="enabled" ${s.enabled ? 'checked' : ''}><span>啟用五檔錄製（隨即時推播盤中錄製，收盤後整理）</span></label>
    <label class="dt-field"><span>加錄股票上限</span>${sel('extra', [0, 300, 500, 800, 1000, 1100], v => v ? `${fmt(v)} 檔` : '不加錄')}<span>保留</span>${sel('keepDays', [5, 10, 20, 40, 60], v => `${v} 個交易日`)}</label>
    <label class="lv-rule"><input type="checkbox" data-bkset="swap" ${s.swap ? 'checked' : ''}><span>盤中換股：開盤後 5 分鐘（第一根 5 分 K）起每 30 分鐘，把冷清的加錄股換成爆量、大漲跌或族群轉強的股票</span></label>
    <p class="dt-foot">加錄只用推播剩下的訂閱數（保留 50 個餘裕），每檔只訂閱五檔 1 個；富果進階方案（2,000 訂閱）扣掉推播清單後約可加錄 1,000 檔。加錄股票的逐筆成交於收盤後以 REST 補齊。</p>
    <label class="dt-field"><span>每日匯出資料夾</span><input data-bkdir value="${esc(s.exportDir || '')}" placeholder="例如 C:\\Users\\你的名字\\Dropbox\\TW_trade" style="flex:1;min-width:260px" spellcheck="false"></label>
    <p class="dt-foot">收盤整理完成後，把當天全部錄製股票匯出成「日期_五檔成交.zip」（每檔一個 CSV，格式同上方下載）。放在 Dropbox 等同步資料夾內即可自動上傳；留空＝不匯出。全部錄製約 1,300 檔時每天約 250–300 MB。</p>
    <div class="form-actions"><button class="primary" data-bksave>儲存錄製設定</button></div></div></details>`;
  return `<div class="dt-status">${status}</div>${swaps}${exp}${days}${set}`;
}
export function daytradePanel() {
  const d = D.info; if (!d?.capable) return '';
  const tabs = [['scan', '觀察名單'], ['review', '訊號檢討'], ['books', '五檔錄製'], ['settings', '設定']];
  const body = !d.enabled && D.tab === 'scan' ? '<div class="empty"><p>當沖監控已關閉，可在「設定」開啟。</p></div>' : D.tab === 'scan' ? scanView(d) : D.tab === 'review' ? reviewView() : D.tab === 'books' ? booksView() : settingsView(d);
  return `<section class="panel dt-panel"><div class="panelhead"><div><h2><span class="idx">DT</span>當沖掃描</h2><p>${d.phaseName ? `${esc(d.phaseName)} · ` : ''}5 分 K 突破／跌破 20MA、跌破開盤低點${d.marketChange != null ? ` · 即時推播股票平均 ${pct(d.marketChange)}` : ''}</p></div><div class="segmented">${tabs.map(([k, l]) => `<button class="${D.tab === k ? 'selected' : ''}" data-dttab="${k}">${l}</button>`).join('')}</div></div>
    <div class="contentpad"><div class="dt-status">${feedLine(d)}</div><div class="dt-status">${prepLine(d)}</div>${D.error ? `<div class="notice err"><span>${esc(D.error)}</span></div>` : ''}${body}</div></section>`;
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button,[data-kbar-row]'); if (!b || !X) return; const ds = b.dataset;
  try {
    if (ds.dttab) { D.tab = ds.dttab; if (D.tab === 'review') { X.repaint(); await loadReview(); } if (D.tab === 'books') { X.repaint(); B.at = Date.now(); await loadBooks(); } return X.repaint(); }
    if (ds.kbarRow) return X.openChart(ds.kbarRow);
    if ('dtsave' in ds && D.draft) { const r = await X.api('daytrade/settings', D.draft); D.draft = structuredClone(r.settings); await loadDaytrade(); X.toast('當沖監控設定已儲存'); return X.repaint(); }
    if ('bksave' in ds && B.draft) { const r = await X.api('books/settings', B.draft); B.info = r.books; B.draft = structuredClone(r.books.settings); X.toast('五檔錄製設定已儲存'); return X.repaint(); }
    if ('bkexport' in ds) {
      const id = (document.querySelector('[data-bkid]')?.value || '').trim().toUpperCase(); B.id = id;
      if (!/^[0-9A-Z]{1,12}$/.test(id) || !B.date) return X.toast('請輸入股票代號');
      // 先確認有資料（沒有時顯示原因），再以連結下載
      b.disabled = true; X.toast('匯出中…');
      try {
        const url = `/api/books/export?date=${B.date}&id=${encodeURIComponent(id)}`, r = await fetch(url);
        if (!r.ok) { const j = await r.json().catch(() => ({})); return X.toast(j.error || `HTTP ${r.status}`); }
        const blob = await r.blob(), a = document.createElement('a'), name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') || '')?.[1] || `${id}-${B.date}.csv`);
        a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
      } finally { b.disabled = false; }
    }
  } catch (err) { X.toast(err.message); }
});
document.addEventListener('change', async e => {
  const t = e.target; if (!X) return;
  if (t.dataset?.bkdate) { B.date = t.value; B.stocks = null; await loadBooks(); return X.repaint(); }
  if ('bkdir' in (t.dataset || {}) && B.draft) { B.draft.exportDir = t.value.trim(); return; }
  if (t.dataset?.bkset && B.draft) { B.draft[t.dataset.bkset] = t.type === 'checkbox' ? t.checked : Number(t.value); return; }
  if (!t.dataset?.dtset || !D.draft) return;
  const keys = t.dataset.dtset.split('.'), v = t.type === 'checkbox' ? t.checked : /^(auto|advanced|developer|basic|all|watchlist|\d{2}:\d{2})$/.test(t.value) ? t.value : Number(t.value);
  keys.slice(0, -1).reduce((o, k) => o[k], D.draft)[keys.at(-1)] = v;
});
