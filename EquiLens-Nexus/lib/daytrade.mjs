// 當沖監控引擎（台股）：盤中把富果 WebSocket 的逐筆成交、1 分 K、五檔委買賣（或精簡模式的聚合行情）整理成每檔的即時狀態，
// 只觀察 5 分 K：觀察名單內的股票，5 分 K 收盤突破 20MA 發多方訊號；跌破 20MA、或跌破當日開盤低點發空方訊號。
// 訊號只在 5 分 K 走完時判斷一次；門檻尚未回測，收盤後以分 K 檢討每個訊號扣除成本後的結果。
// 純計算模組：資料取得、觀察名單、排程與推播在 server.mjs；時間一律用毫秒時間戳，交易所當地時間以固定時差換算。
import { tickSize, hhmm, minuteOf, limitPrices } from './markets.mjs';
import { t } from './i18n.mjs';
import { prepareHistory, fiveMinuteBars, maState, openLowState, contextDate, validBar, MA_PERIOD } from './daytrade-context.mjs';
import { createMarketTracker, marketRecord, regimeOf, regimeKey, strengthKey, INDEX_KEYS, MARKET_RULES, REGIMES, STRENGTHS } from './daytrade-market.mjs';

export const DT_VERSION = 3;
export const DT_TYPES = { maUp: 'dt-ma-up', maDown: 'dt-ma-down', openLow: 'dt-open-low' };
export const DT_SIDES = { 'dt-ma-up': 'long', 'dt-ma-down': 'short', 'dt-open-low': 'short' };
export const DT_TITLES = { 'dt-ma-up': '突破 20MA（多方）', 'dt-ma-down': '跌破 20MA（空方）', 'dt-open-low': '跌破開盤低點（空方）' };
// 舊版訊號（紀錄與檢討仍可查看）：v2 多週期確認、v1 當日分 K
const LEGACY_TITLES = { 2: { 'dt-breakout': '多週期爆量突破', 'dt-vwap': '多週期回測轉強', 'dt-bid': '五檔增強確認', 'dt-weak': '多單轉弱警示', 'dt-risk': '跌破參考停損', 'dt-stop': '停止新增部位' },
  1: { 'dt-breakout': '爆量突破', 'dt-vwap': 'VWAP 趨勢延續', 'dt-bid': '買盤持續增強' } };
export const signalTitle = s => DT_TITLES[s.type] || LEGACY_TITLES[s.version || 1]?.[s.type] || LEGACY_TITLES[2][s.type] || s.type;
export const DT_PLANS = ['auto', 'basic', 'developer', 'advanced'];
export const DT_DEFAULTS = Object.freeze({
  version: DT_VERSION, enabled: true, plan: 'auto', top: 30,       // top：觀察名單畫面顯示幾檔（只影響畫面）
  sources: { turnover: true, groups: true, watchlist: false },    // 觀察名單來源：前一日高周轉率、全部研究族群、自選股
  turnoverTop: 50, turnoverMinAmount: 100e6,                      // 高周轉率：前一交易日周轉率前 N 名，且成交金額達下限
  signals: { maUp: true, maDown: true, openLow: true },
  eligibleOnly: true,                                             // 只對可現股當沖的股票發訊號（排除不可當沖、處置；空方另排除暫停先賣後買）
  watchFrom: '09:05', stopNew: '13:25',                           // 訊號時段：第一根 5 分 K 走完起，到收盤集合競價前
  costs: { feeRate: 0.001425, feeDiscount: 1, taxRate: 0.0015, slipTicks: 1 }, // 手續費（買賣各一次）、當沖證交稅、滑價（每邊檔數）
});
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const round = (x, n = 2) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n;

// 舊版（v2 以前）的設定只沿用開關、方案與成本；訊號時段、訊號種類與名單來源改用新版預設
export function normalizeDaytrade(input = {}) {
  const d = DT_DEFAULTS, s = input || {}, c = s.costs || {}, v3 = s.version === DT_VERSION, num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : def; };
  const flags = (def, src) => Object.fromEntries(Object.keys(def).map(k => [k, v3 && typeof src?.[k] === 'boolean' ? src[k] : def[k]]));
  return {
    version: DT_VERSION, enabled: s.enabled !== false, plan: DT_PLANS.includes(s.plan) ? s.plan : d.plan,
    top: Math.round(num(v3 ? s.top : null, 10, 200, d.top)),
    sources: flags(d.sources, s.sources), turnoverTop: Math.round(num(s.turnoverTop, 10, 200, d.turnoverTop)), turnoverMinAmount: num(s.turnoverMinAmount, 0, 1e11, d.turnoverMinAmount),
    signals: flags(d.signals, s.signals), eligibleOnly: s.eligibleOnly !== false,
    watchFrom: v3 && HM.test(s.watchFrom) ? s.watchFrom : d.watchFrom, stopNew: v3 && HM.test(s.stopNew) ? s.stopNew : d.stopNew,
    costs: { feeRate: num(c.feeRate, 0, 0.01, d.costs.feeRate), feeDiscount: num(c.feeDiscount, 0.1, 1, d.costs.feeDiscount), taxRate: num(c.taxRate, 0, 0.01, d.costs.taxRate), slipTicks: Math.round(num(c.slipTicks, 0, 5, d.costs.slipTicks)) },
  };
}
// 一次來回的成本（%）：買賣手續費各一次 × 折扣，加當沖證交稅
export const roundTripCost = costs => (costs.feeRate * costs.feeDiscount * 2 + costs.taxRate) * 100;

// 交易所時區相對 UTC 的毫秒差（台股固定 +8；盤中不會遇到日光節約切換）
export function tzOffset(tz, at = Date.now()) {
  const o = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(at / 1000) * 1000;
}

/* ---------- 觀察名單：前一日高周轉率 ---------- */
// 周轉率＝成交股數 ÷ 股數（集保總股數，約等於發行股數）。只算普通股（4 碼、非 0 開頭，排除 ETF），依周轉率由高到低排序。
// volumes：{ 代號: 成交股數 }；amounts：{ 代號: 成交金額 }；shares：{ 代號: 股數 }；allow：可納入的代號（null＝不限）
export function rankTurnover({ volumes = {}, amounts = {}, shares = {}, allow = null, limit = 500 } = {}) {
  const out = [];
  for (const [id, vol] of Object.entries(volumes)) {
    const sh = shares[id];
    if (!/^[1-9]\d{3}$/.test(id) || !(vol > 0) || !(sh > 0) || (allow && !allow.has(id))) continue;
    out.push({ id, rate: round(vol / sh * 100, 2), amount: amounts[id] ?? null });
  }
  return out.sort((a, b) => b.rate - a.rate || a.id.localeCompare(b.id)).slice(0, limit);
}
// 從排行取觀察名單：成交金額達下限、不在排除名單（不可當沖、處置、暫停交易）的前 N 名
export function selectTurnover(ranked, { top = DT_DEFAULTS.turnoverTop, minAmount = DT_DEFAULTS.turnoverMinAmount, exclude = new Set() } = {}) {
  return (ranked || []).filter(x => !exclude.has(x.id) && !(minAmount > 0 && !(x.amount >= minAmount))).slice(0, top);
}

/* ---------- 盤中引擎 ---------- */
const GRACE = 3000; // 5 分 K 走完後等 3 秒再判斷，讓最後幾筆成交與 1 分 K 先到
// meta：Map(id → { name, groups:[族群 id], exchange:'上市'／'上櫃', turnover:前一日周轉率（%，高周轉率名單才有） })
// prep：{ eligible:Set|null, disposition:Set, suspended:Set, sellFirstOff:Set, ref:Map(id → 參考價) }
// watch：自選（標示用）；scan：觀察名單，只對這些股票判斷與發訊號（未提供時同 watch）
export function createDayTrade({ market: p, date, ids, meta = new Map(), watch = new Set(), scan = null, prep = {}, settings = DT_DEFAULTS, offset = 8 * 3600e3, lang }) {
  const S = new Map(), log = [], lot = p.lot || 1000, T = (msg, params) => t(msg, params, lang);
  let cfg = normalizeDaytrade(settings), info = { eligible: null, disposition: new Set(), suspended: new Set(), sellFirstOff: new Set(), ref: new Map(), ...prep };
  let gaps = new Set(), feedOk = false;
  const history = new Map();
  // 大盤環境（只記錄）：上市對照加權、上櫃對照櫃買；server.mjs 餵入指數資料，訊號紀錄附上當下狀態，不影響訊號
  const market = createMarketTracker({ date, open: p.open, offset });
  const midnight = Date.parse(`${date}T00:00:00Z`) - offset;
  const modOf = ms => Math.floor((ms + offset) / 60000) % 1440;
  const hmsOf = ms => { const s = Math.floor((ms + offset) / 1000) % 86400; return `${hhmm(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`; };
  for (const id of ids) S.set(id, blank(id));
  function blank(id) { return { id, ref: null, last: null, lastAt: 0, quoteAt: 0, open: null, high: null, low: null, cumVol: 0, cumAmt: 0, vNum: 0, vDen: 0, atAsk: 0, atBid: 0, serial: -1, bars: new Map(), book: null, bookAt: 0, five: null, fiveAt: 0, detected: 0, fired: new Map(), limitUp: false, halted: false, tape: [] }; }
  const st = id => { let s = S.get(id); if (!s) S.set(id, s = blank(id)); return s; };
  const refOf = s => s.ref ?? info.ref.get(s.id) ?? null;
  const barOf = (s, m) => { let b = s.bars.get(m); if (!b) s.bars.set(m, b = { m, o: null, h: -Infinity, l: Infinity, c: null, tv: 0, cv: 0, ask: 0, bid: 0, lastAt: 0 }); return b; };
  const vol = b => Math.max(b.tv, b.cv);
  function price(s, b, px, at) { if (b.o == null) b.o = px; b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); if (at >= b.lastAt) { b.c = px; b.lastAt = at; } if (at >= s.lastAt) { s.last = px; s.lastAt = at; } s.open ??= px; s.high = Math.max(s.high ?? px, px); s.low = Math.min(s.low ?? px, px); }

  // 收到一批推播事件；回傳有變動的股票代號
  function ingest(events) {
    const changed = new Set();
    for (const ev of events) {
      if (!ev?.id || !S.has(ev.id) || ev.trial || !Number.isFinite(ev.time) || contextDate(ev.time) !== date) continue;
      const s = st(ev.id);
      if (ev.kind === 'trade') {
        if (ev.serial != null && ev.serial <= s.serial) continue; // 重複（例如斷線補資料後又收到）
        if (ev.serial != null) s.serial = ev.serial;
        const px = ev.price, size = ev.size || 0; if (!(px > 0)) continue;
        const b = barOf(s, modOf(ev.time)); price(s, b, px, ev.time); s.quoteAt = Math.max(s.quoteAt, ev.time); b.tv += size; b.amt = (b.amt || 0) + px * size;
        s.cumVol = ev.volume > 0 ? Math.max(s.cumVol, ev.volume) : s.cumVol + size;
        s.cumAmt += px * size * lot; s.vNum += px * size; s.vDen += size;
        const side = ev.ask > 0 && px >= ev.ask ? 1 : ev.bid > 0 && px <= ev.bid ? -1 : 0;
        if (side > 0) { s.atAsk += size; b.ask += size; } else if (side < 0) { s.atBid += size; b.bid += size; }
        s.tape.push([ev.time, px, size, side]); if (s.tape.length > 80) s.tape.splice(0, s.tape.length - 60); // 最近成交明細（看板個股走勢用）
        s.limitUp = !!ev.limitUp; s.halted = !!ev.halted;
      } else if (ev.kind === 'book') { // 五檔只供看板與個股走勢顯示，不參與訊號
        if (ev.time <= s.bookAt) continue;
        s.book = { bids: ev.bids || [], asks: ev.asks || [] }; s.bookAt = ev.time || s.lastAt;
      } else if (ev.kind === 'candle') {
        const b = barOf(s, modOf(ev.time)); b.cv = Math.max(b.cv, ev.volume || 0);
        if (ev.open > 0 && b.o == null) b.o = ev.open; if (ev.high > 0) b.h = Math.max(b.h, ev.high); if (ev.low > 0) b.l = Math.min(b.l, ev.low);
        // Provider OHLC replaces trade-derived OHLC: candles can fill missing trades.
        if (ev.close > 0) { b.o = ev.open; b.h = ev.high; b.l = ev.low; b.c = ev.close; if (s.last == null) s.last = ev.close; }
      } else if (ev.kind === 'agg') { // 精簡模式：累計量的差額歸到當下這一分鐘
        const r = ev.row; if (!(r?.close > 0)) continue;
        const at = ev.time || s.lastAt, b = barOf(s, modOf(at)), dv = Math.max(0, (r.total_volume || 0) - s.cumVol);
        price(s, b, r.close, at); s.quoteAt = Number.isFinite(ev.tradeTime) ? ev.tradeTime : 0; b.tv += dv;
        if (r.volume_at_ask != null) { b.ask += Math.max(0, r.volume_at_ask - s.atAsk); s.atAsk = r.volume_at_ask; }
        if (r.volume_at_bid != null) { b.bid += Math.max(0, r.volume_at_bid - s.atBid); s.atBid = r.volume_at_bid; }
        s.cumVol = Math.max(s.cumVol, r.total_volume || 0); s.cumAmt = Math.max(s.cumAmt, r.total_amount || 0);
        if (s.cumVol > 0 && s.cumAmt > 0) { s.vNum = s.cumAmt / lot; s.vDen = s.cumVol; } // VWAP＝累計成交金額 ÷ 累計量
        if (r.open > 0) s.open = r.open; if (r.high > 0) s.high = r.high; if (r.low > 0) s.low = r.low;
        if (s.ref == null && r.change_price != null) s.ref = round(r.close - r.change_price, 4);
        if (ev.book) ingest([{ kind: 'book', id: ev.id, time: at, ...ev.book }]);
      } else continue;
      changed.add(ev.id);
    }
    return changed;
  }
  // 斷線重連後以 REST 補資料：quote（累計量、內外盤、均價、五檔、參考價）＋ 1 分 K
  function backfill(id, { quote, candles } = {}) {
    // A failed/empty REST response must not release a pending gap.
    if (!S.has(id) || !quote || !Array.isArray(candles) || !candles.length || quote.isTrial || !Number.isFinite(quote.closePrice) || !(quote.closePrice > 0)) return false;
    // Snapshot updates (including books) must not rejuvenate an old last trade.
    const quoteTime = usTime(quote.closeTime ?? quote.lastTrade?.time);
    const validCandles = candles.filter(c => Number.isFinite(Date.parse(c.date)) && contextDate(Date.parse(c.date)) === date && validBar({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
    if (!Number.isFinite(quoteTime) || !quoteTime || contextDate(quoteTime) !== date || !validCandles.length) return false;
    const s = st(id), q = quote, tot = q.total || {}, at = quoteTime;
    if (q.referencePrice > 0) s.ref = q.referencePrice;
    if (tot.tradeVolume >= s.cumVol) { s.cumVol = tot.tradeVolume; s.cumAmt = tot.tradeValue ?? s.cumAmt; s.atAsk = tot.tradeVolumeAtAsk ?? s.atAsk; s.atBid = tot.tradeVolumeAtBid ?? s.atBid; }
    // 均價一律以報價的全日均價重設：推播的累計量可能比 REST 報價稍新，若沿用上面的條件，VWAP 只會剩下重連後的成交
    if (q.avgPrice > 0 && tot.tradeVolume > 0) { s.vNum = q.avgPrice * tot.tradeVolume; s.vDen = tot.tradeVolume; }
    if (q.openPrice > 0) s.open = q.openPrice; if (q.highPrice > 0) s.high = q.highPrice; if (q.lowPrice > 0) s.low = q.lowPrice;
    if (q.closePrice > 0 && at >= s.lastAt) { s.last = q.closePrice; s.lastAt = at; s.quoteAt = at; }
    if (q.lastTrade?.serial > s.serial) s.serial = q.lastTrade.serial;
    s.halted = !!q.tradingHalt?.isHalted; s.limitUp = !!q.isLimitUpPrice;
    if (q.bids || q.asks) ingest([{ kind: 'book', id, time: usTime(q.lastUpdated ?? tot.time), bids: q.bids, asks: q.asks }]);
    for (const c of validCandles) ingest([{ kind: 'candle', id, time: Date.parse(c.date), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }]);
    gaps.delete(id); dirty(s); return true;
  }

  // 每檔的即時快照列（與資料源快照格式相同，供異動雷達與即時看板使用）
  function row(id) {
    const s = S.get(id); if (!s || !(s.last > 0)) return null;
    const ref = refOf(s), bid = s.book?.bids?.[0]?.price, ask = s.book?.asks?.[0]?.price;
    return { stock_id: id, date: `${date} ${hmsOf(s.lastAt)}`, open: s.open, high: s.high, low: s.low, close: s.last, change_price: ref > 0 ? round(s.last - ref, 4) : null, change_rate: ref > 0 ? round((s.last / ref - 1) * 100) : null,
      total_volume: s.cumVol, total_amount: s.cumAmt, yesterday_volume: null, buy_price: bid ?? null, sell_price: ask ?? null, volume_at_bid: s.atBid, volume_at_ask: s.atAsk };
  }

  /* 5 分 K 狀態 */
  const vwapOf = s => s.vDen > 0 ? s.vNum / s.vDen : s.cumVol > 0 ? s.cumAmt / (s.cumVol * lot) : null;
  const dirty = s => { s.fiveAt = 0; s.detected = 0; }; // 歷史或補資料到了：重新計算，尚未發過的訊號可補發
  // 最近一個已走完的 5 分鐘界線（毫秒）：09:05、09:10 … 13:25、13:30；開盤後未滿 5 分鐘時為 0
  function boundaryOf(now) {
    const m = modOf(now - GRACE), el = Math.min(m, p.close) - p.open; if (el < 5) return 0;
    return midnight + (p.open + Math.floor(el / 5) * 5) * 60000;
  }
  // 今天已完成的 1 分 K（引擎的分 K 以「當日第幾分鐘」為鍵）→ 5 分 K
  const liveMinutes = s => [...s.bars.values()].filter(b => b.c != null && b.o != null).map(b => ({ time: midnight + b.m * 60000, o: b.o, h: b.h, l: b.l, c: b.c, v: vol(b) }));
  // 歷史 5 分 K 換算到今天的價格口徑：今天的參考價與前一日收盤相差超過 1.5 檔（除權息、減資等）時，歷史價格乘上比例
  function historyBars(s, tick) {
    const h = history.get(s.id); if (!h?.five.length) return [];
    const ref = refOf(s), f = ref > 0 && h.rawClose > 0 && tick > 0 && Math.abs(ref - h.rawClose) > tick * 1.5 ? ref / h.rawClose : 1;
    return f === 1 ? h.five : h.five.map(b => ({ ...b, o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f }));
  }
  function refresh(s, boundary) {
    if (s.fiveAt === boundary && s.five) return s.five;
    const tick = s.last > 0 ? tickSize(p, s.last) : null, today = boundary ? fiveMinuteBars(liveMinutes(s), boundary) : [];
    const ma = maState([...historyBars(s, tick), ...today]), ol = openLowState(today), b = today.at(-1);
    s.fiveAt = boundary;
    return s.five = { end: b?.end ?? null, current: !!b && b.end === boundary, close: b?.c ?? null, bars: ma.count, today: today.length,
      ma20: today.length ? round(ma.ma, 4) : null, prevClose: ma.prevClose, prevMa20: round(ma.prevMa, 4), above: today.length ? ma.above : null, below: today.length ? ma.below : null,
      crossUp: !!b && ma.crossUp, crossDown: !!b && ma.crossDown, openLow: ol.low, belowOpen: ol.below, brokeOpen: ol.broke };
  }
  // 排除條件（只在資料取得時生效）：暫停交易；勾選「只對可當沖股票」時另排除不可現股當沖、處置股
  function filters(s) {
    const out = [];
    if (info.suspended.has(s.id) || s.halted) out.push('suspended');
    if (cfg.eligibleOnly && info.eligible && !info.eligible.has(s.id)) out.push('noDayTrade');
    if (cfg.eligibleOnly && info.disposition.has(s.id)) out.push('disposition');
    return out;
  }
  // 交易階段：盤前、開盤觀察、掃描、停止新訊號、收盤集合競價、收盤
  function phase(cur) {
    const w = minuteOf(cfg.watchFrom), stop = minuteOf(cfg.stopNew), auction = p.close - (p.id === 'TW' ? 5 : 0);
    return cur < p.open ? 'pre' : cur < w ? 'opening' : cur < Math.min(stop, auction) ? 'scan' : cur < auction ? 'stop' : cur < p.close + p.settle ? 'auction' : 'closed';
  }
  // 個股近 15 分鐘漲跌（%）：現價對 15 分鐘前最後一根完成 1 分 K 的收盤（大盤環境紀錄用）
  const recentChange = (s, cur) => { const b = [...s.bars.values()].filter(x => x.c != null && x.m <= cur - MARKET_RULES.window).sort((a, b) => a.m - b.m).at(-1); return b?.c > 0 && s.last > 0 ? (s.last / b.c - 1) * 100 : null; };

  let lastEval = { at: 0, list: [], counts: {} };
  // 每秒呼叫：更新觀察名單每檔的 5 分 K 狀態，5 分 K 走完時判斷訊號；回傳新訊號（雷達事件格式）
  function tick(now) {
    if (contextDate(now) !== date) return [];
    const cur = modOf(now), ph = phase(cur), boundary = boundaryOf(now), alerts = [], list = [], counts = { long: 0, short: 0, waiting: 0 }, excluded = {};
    const all = [...S.values()].filter(s => s.last > 0), inScan = scan || watch;
    const chg = all.map(s => { const ref = refOf(s); return ref > 0 ? (s.last / ref - 1) * 100 : null; }).filter(x => x != null), marketChg = chg.length ? chg.reduce((a, b) => a + b, 0) / chg.length : null;
    for (const s of all) {
      const scanned = inScan.has(s.id), mt = meta.get(s.id), ref = refOf(s), change = ref > 0 ? (s.last / ref - 1) * 100 : null, vwap = vwapOf(s);
      const f = scanned ? refresh(s, boundary) : null, why = scanned ? filters(s) : [];
      const reasons = !f ? [] : [...(f.today ? [] : ['fiveMinute']), ...(f.bars < MA_PERIOD + 1 ? ['history'] : [])];
      if (scanned) { for (const k of why) excluded[k] = (excluded[k] || 0) + 1; if (reasons.length || f.above == null) counts.waiting++; else if (f.above) counts.long++; else if (f.below) counts.short++; }
      const item = { id: s.id, name: mt?.name || s.id, watch: watch.has(s.id), scan: scanned, turnover: mt?.turnover ?? null, grouped: !!mt?.groups?.length, price: s.last, change: round(change), vwap: round(vwap, 2),
        five: f && { end: f.end ? hmsOf(f.end).slice(0, 5) : null, close: f.close, ma20: round(f.ma20), dist: f.ma20 > 0 ? round((s.last / f.ma20 - 1) * 100) : null, above: f.above, bars: f.bars, openLow: f.openLow, belowOpen: f.openLow > 0 ? s.last < f.openLow : null },
        filters: why, pending: gaps.has(s.id), reasons, last: s.lastSignal || null, at: hmsOf(s.lastAt) };
      list.push(item);
      // 一根 5 分 K 只判斷一次；連線異常或補資料中先不判斷，恢復後若這根仍是最新一根再補判
      if (!cfg.enabled || !scanned || ph !== 'scan' || !feedOk || gaps.has(s.id) || !f.current || s.detected === f.end) continue;
      s.detected = f.end;
      for (const a of detect(s, f, why)) {
        s.fired.set(a.type, f.end); s.lastSignal = { type: a.type, side: a.side, t: hmsOf(now) };
        alerts.push({ ...a, stockId: s.id, name: item.name, close: s.last, change: item.change, t: hmsOf(now), watch: item.watch, level: 'hi' });
        log.push({ ...a, version: DT_VERSION, id: s.id, name: item.name, at: now, m: cur, t: hmsOf(now), price: s.last, vwap: item.vwap, turnover: item.turnover,
          bar: { end: f.end, close: f.close, ma20: f.ma20, prevClose: f.prevClose, prevMa20: f.prevMa20, openLow: f.openLow },
          market: marketRecord(market, mt?.exchange, { chg: change, r15: recentChange(s, cur) }, now) });
      }
      item.last = s.lastSignal || null;
    }
    // 排序：今天有訊號的在前（最新的最前），其餘依現價與 20MA 的距離由近到遠
    const rank = x => x.last ? 0 : x.five?.dist == null ? 2 : 1;
    list.sort((a, b) => rank(a) - rank(b) || (a.last && b.last ? b.last.t.localeCompare(a.last.t) : 0) || Math.abs(a.five?.dist ?? 0) - Math.abs(b.five?.dist ?? 0) || a.id.localeCompare(b.id));
    lastEval = { at: now, phase: ph, list, counts, excluded, marketChange: round(marketChg) };
    return alerts.map(a => ({ title: T(DT_TITLES[a.type]), ...a }));
  }
  // 突破 20MA（多方）、跌破 20MA（空方）、跌破開盤低點（空方）。同一根 5 分 K 同一種訊號只發一次；
  // 價格收回均線（或開盤低點）之上後再次跌破，才會再發一次。漲停不發多方、跌停不發空方（買不到／賣不到）。
  function detect(s, f, why) {
    if (why.length) return [];
    const out = [], ref = refOf(s), lim = ref > 0 ? limitPrices(p, ref) : null, n = v => round(v, 2);
    const add = (key, detail) => { const type = DT_TYPES[key]; if (cfg.signals[key] && s.fired.get(type) !== f.end) out.push({ type, side: DT_SIDES[type], detail }); };
    const canLong = !(s.limitUp || (lim && s.last >= lim.up)), canShort = !(lim && s.last <= lim.down) && !(cfg.eligibleOnly && info.sellFirstOff.has(s.id));
    if (f.crossUp && canLong) add('maUp', T('5 分 K 收 {close}，站上 20MA {ma}（前一根收 {prev}，在均線 {prevMa} 之下）', { close: n(f.close), ma: n(f.ma20), prev: n(f.prevClose), prevMa: n(f.prevMa20) }));
    if (f.crossDown && canShort) add('maDown', T('5 分 K 收 {close}，跌破 20MA {ma}（前一根收 {prev}，在均線 {prevMa} 之上）', { close: n(f.close), ma: n(f.ma20), prev: n(f.prevClose), prevMa: n(f.prevMa20) }));
    if (f.brokeOpen && canShort) add('openLow', T('5 分 K 收 {close}，跌破開盤低點 {low}', { close: n(f.close), low: n(f.openLow) }));
    return out;
  }

  return {
    ingest, backfill, row, tick, date,
    // 歷史 5 分 K（今天以前）；資料源的 1 分 K 或已整理好的快取都可以
    setHistory(id, data) { history.set(id, prepareHistory(data, date)); const s = S.get(id); if (s) dirty(s); },
    historyReady: id => (history.get(id)?.five.length || 0) >= MA_PERIOD,
    syncIds(ids) { const want = new Set(ids); for (const id of S.keys()) if (!want.has(id)) { S.delete(id); history.delete(id); gaps.delete(id); } for (const id of want) st(id); },
    // 服務重新啟動：還原今天已發出的訊號（供收盤檢討），同一根 5 分 K 不重複發
    restore(signals) { for (const x of signals || []) { log.push(x); const s = st(x.id); if (x.bar?.end) s.fired.set(x.type, x.bar.end); s.lastSignal = { type: x.type, side: x.side, t: x.t }; } },
    ranking: () => lastEval,
    get signals() { return log; },
    bars: id => S.get(id)?.bars || new Map(),
    // 個股即時走勢：參考價、最新價、五檔、最近成交（看板個股走勢；每分鐘量價與均價由 bars 計算）
    quote(id) { const s = S.get(id); if (!s) return null; return { ref: refOf(s), last: s.last, lastAt: s.lastAt, open: s.open, high: s.high, low: s.low, cumVol: s.cumVol, cumAmt: s.cumAmt, vwap: vwapOf(s), atAsk: s.atAsk, atBid: s.atBid, book: s.book, bookAt: s.bookAt, tape: s.tape.slice(-40), limitUp: s.limitUp }; },
    setPrep(next) { info = { ...info, ...next }; for (const s of S.values()) dirty(s); },
    setSettings(next) { cfg = normalizeDaytrade(next); },
    setWatch(next) { watch = next; },
    setScan(next) { scan = next; },
    // 斷線：這些股票在補完資料前不發訊號；feed：連線是否正常
    markGap(list) { for (const id of list) gaps.add(id); },
    setFeed(ok) { feedOk = !!ok; },
    get gaps() { return gaps; },
    get ids() { return [...S.keys()]; },
    modOf, hmsOf, phase: now => phase(modOf(now)),
    // 大盤環境（只記錄）：指數快照、富果指數 1 分 K、漲跌家數；目前狀態（介面顯示用）
    indexSample: (key, x) => market.sample(key, x), indexSeries: (key, x) => market.series(key, x), indexBreadth: (key, x) => market.breadth(key, x),
    indexAge: (key, now) => market.age(key, now), indexHasOpen: key => market.hasOpen(key),
    marketState(now) { return Object.fromEntries(INDEX_KEYS.map(k => { const x = market.state(k, now); return [k, x && { ...x, regime: x.stale ? null : regimeOf(x) }]; })); },
  };
}
const usTime = v => { const n = Number(v); return n > 1e14 ? n / 1000 : n > 1e11 ? n : n > 0 ? n * 1000 : 0; };

/* ---------- 收盤後檢討 ---------- */
// 每個訊號：多方以訊號價加滑價買進、空方以訊號價減滑價賣出（先賣後買），於 5／15／30 分鐘後與收盤時以收盤價反向平倉（同樣計滑價），
// 扣除手續費與證交稅的淨報酬（%）；另記 30 分鐘內最大有利／不利幅度。bars：Map(分鐘 → 分 K)
export function evaluateSignal(sig, bars, p, costs) {
  if (sig.purpose === 'risk') return null; // v2 的風險提醒不是進場訊號
  const short = sig.side === 'short', dir = short ? -1 : 1, slip = x => tickSize(p, x) * costs.slipTicks;
  const list = [...bars.values()].filter(b => b.c != null).sort((a, b) => a.m - b.m), cost = roundTripCost(costs);
  const entry = sig.price + dir * slip(sig.price), after = list.filter(b => b.m > sig.m);
  const exitAt = h => { const b = after.filter(x => x.m <= sig.m + h).at(-1); return b ? b.c : null; };
  const net = x => x == null ? null : round(dir * ((x - dir * slip(x)) / entry - 1) * 100 - cost);
  const w = after.filter(b => b.m <= sig.m + 30), hi = w.length ? Math.max(...w.map(b => b.h)) : null, lo = w.length ? Math.min(...w.map(b => b.l)) : null;
  const move = x => x == null ? null : round(dir * (x / entry - 1) * 100);
  return { r5: net(exitAt(5)), r15: net(exitAt(15)), r30: net(exitAt(30)), rClose: net(list.at(-1)?.c ?? null), mfe: move(short ? lo : hi), mae: move(short ? hi : lo), cost: round(cost, 3) };
}
// 多日訊號紀錄的統計：每種訊號的次數、15 分鐘勝率與平均淨報酬；v2 以後的訊號另依訊號當下的大盤環境分組，
// 大盤環境與相對強弱的合計只算多方訊號（空方在順風時不利，混在一起沒有意義）
const summarize = xs => {
  const avg = k => { const v = xs.map(o => o[k]).filter(n => n != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; }, v15 = xs.filter(o => o.r15 != null);
  return { n: xs.length, win15: v15.length ? round(v15.filter(o => o.r15 > 0).length / v15.length * 100, 0) : null, r5: avg('r5'), r15: avg('r15'), r30: avg('r30'), rClose: avg('rClose'), mfe: avg('mfe'), mae: avg('mae') };
};
const groupBy = (list, keyOf, keys) => keys.map(key => ({ key, ...summarize(list.filter(s => keyOf(s) === key).map(s => s.outcome)) }));
export function reviewStats(days) {
  const by = new Map(), longs = [];
  for (const d of days) for (const s of d.signals || []) {
    if (!s.outcome || s.purpose === 'risk') continue;
    const key = `${s.version || 1}:${s.type}`; let x = by.get(key); if (!x) by.set(key, x = { type: s.type, version: s.version || 1, side: s.side || 'long', list: [] }); x.list.push(s);
    if (s.version >= 2 && s.side !== 'short') longs.push({ ...s, date: d.date });
  }
  const regimeRows = [...REGIMES, 'none'], types = [...by.values()].map(({ type, version, side, list }) => ({ type, version, side, title: signalTitle({ type, version }), ...summarize(list.map(s => s.outcome)),
    ...(version >= 2 ? { regimes: Object.fromEntries(groupBy(list, regimeKey, regimeRows).map(({ key, ...x }) => [key, x])) } : {}) }));
  const recorded = longs.filter(s => s.market), complete = recorded.filter(s => regimeOf(s.market));
  return { days: days.length, signals: types.reduce((a, t) => a + t.n, 0), types: types.sort((a, b) => b.version - a.version || b.n - a.n), byDay: days.map(d => ({ date: d.date, n: (d.signals || []).length })),
    market: { signals: longs.length, recorded: complete.length, since: recorded.map(s => s.date).filter(Boolean).sort()[0] || null, rules: MARKET_RULES,
      regimes: groupBy(longs, regimeKey, regimeRows), strength: groupBy(longs, strengthKey, [...STRENGTHS, 'none']) } };
}
