// 富果 Fugle 行情 API（台股，需金鑰）：WebSocket 即時推播（逐筆成交、1 分 K、五檔，或聚合行情；盤中雷達與當沖監控）、
// 盤中全市場快照（開發者／進階方案）、分 K（盤中與歷史）、日 K 歷史（含還原）。
// 沒有法人、分點、新聞等籌碼資料，可搭配證交所開放資料或 FinMind。
import { DataError, fetchJSON, limiter, num, addDays, httpError } from './common.mjs';

const BASE = 'https://api.fugle.tw/marketdata/v1.0/stock';
const WS = 'wss://api.fugle.tw/marketdata/v1.0/stock/streaming';
// 方案：WebSocket 訂閱數（1 檔 × 1 個頻道 = 1 個）、同時連線數、盤中 REST 每分鐘次數（官方方案表，2026-10）
export const PLANS = { basic: { limit: 5, connections: 1, perMinute: 60 }, developer: { limit: 300, connections: 2, perMinute: 600 }, advanced: { limit: 2000, connections: 2, perMinute: 2000 } };
export const STREAM_LIMITS = { free: PLANS.basic.limit, paid: PLANS.developer.limit };
// 目前方案：金鑰驗證為免費 → 基本；使用者指定的方案優先；自動時付費方案先當開發者（伺服器會嘗試進階並在訂閱不足時退回）
export function planOf(info, setting = 'auto') {
  if (info?.tier === 'free') return 'basic';
  return PLANS[setting] ? setting : 'developer';
}
const LABEL = 'Fugle 富果';
const queue = limiter(150);
// 歷史 K 線 API 另有每分鐘 60 次上限（盤中 REST 依方案 600／2000 次，見回應標頭 x-ratelimit-limit）：
// 獨立排隊、間隔至少 1.05 秒；遇到 429 依 Retry-After 等待後重試（最多 2 次），不讓盤中補資料的間隔套用到歷史 API
export const HISTORY_INTERVAL = 1050;
const historyQueue = limiter(HISTORY_INTERVAL);
const pause = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }, { once: true }); });
async function get(path, ctx) {
  const history = path.startsWith('/historical/'), q = history ? historyQueue : queue;
  const opts = history ? { ...ctx, interval: Math.max(ctx.interval ?? 0, ctx.historyInterval ?? HISTORY_INTERVAL) } : ctx;
  for (let attempt = 0; ; attempt++) {
    const r = await q(() => fetchJSON(BASE + path, { headers: { 'X-API-KEY': ctx.key }, signal: ctx.signal, label: LABEL }), opts);
    if (r.status === 429 && history && attempt < 2 && !ctx.signal?.aborted) { await pause(Math.min(65, Number(r.headers?.get?.('retry-after')) || 30) * 1000, ctx.signal); continue; }
    if (r.status === 404) return null; // 查詢範圍沒有資料
    if (!r.ok) throw httpError(LABEL, r.status, r.body?.message);
    return r.body;
  }
}
const hmOf = iso => /T(\d{2}:\d{2})/.exec(String(iso))?.[1] || null;

// 盤中快照：上市（TSE）＋上櫃（OTC）普通股。成交量單位自動判斷（張或股），統一成張
export function parseSnapshot(body, lot = 1000) {
  const date = body?.date, out = [];
  const items = (body?.data || []).filter(x => x.closePrice > 0 || x.lastPrice > 0);
  // 成交金額 ÷（量 × 價）≈ 1000 表示量的單位是張；≈ 1 表示是股
  const sample = items.filter(x => x.tradeVolume > 0 && x.tradeValue > 0).slice(0, 50).map(x => x.tradeValue / (x.tradeVolume * (x.closePrice || x.lastPrice)));
  const ratio = sample.length ? sample.sort((a, b) => a - b)[Math.floor(sample.length / 2)] : lot;
  const toLots = ratio > lot / 10 ? 1 : 1 / lot;
  for (const x of items) {
    const close = x.lastPrice || x.closePrice, ts = Number(x.lastUpdated);
    const time = ts ? new Date(ts > 1e14 ? ts / 1000 : ts > 1e11 ? ts : ts * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }) : (body.time || '13:30:00');
    out.push({ stock_id: x.symbol, date: `${date} ${time}`, open: x.openPrice, high: x.highPrice, low: x.lowPrice, close, change_price: x.change, change_rate: x.changePercent, total_volume: (x.tradeVolume ?? 0) * toLots, total_amount: x.tradeValue ?? 0, yesterday_volume: null, buy_price: null, sell_price: null });
  }
  return out;
}

// WebSocket aggregates 頻道（每檔的累計行情、五檔、內外盤）→ 衡析快照列。
// 時間戳可能是微秒／毫秒／秒；量可能是張或股（以成交金額 ÷（量 × 價）判斷：≈ 1000 為張、≈ 1 為股）
const ts2time = (ts, tz) => { const n = Number(ts); return n > 0 ? new Date(n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000).toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }) : null; };
export function aggregateRow(d, tz = 'Asia/Taipei', lot = 1000) {
  const close = num(d?.closePrice) ?? num(d?.lastPrice);
  if (!d?.symbol || !d?.date || !(close > 0)) return null;
  const prev = num(d.previousClose) ?? num(d.referencePrice), t = d.total || {};
  const vol = num(t.tradeVolume), val = num(t.tradeValue), k = lot > 1 && vol > 0 && val > 0 && val / (vol * close) < lot / 10 ? 1 / lot : 1;
  const lots = v => v == null ? null : Math.round(v * k * 1000) / 1000;
  return {
    stock_id: String(d.symbol), date: `${d.date} ${ts2time(d.lastUpdated ?? t.time, tz) || '00:00:00'}`,
    open: num(d.openPrice), high: num(d.highPrice), low: num(d.lowPrice), close,
    change_price: num(d.change) ?? (prev > 0 ? Math.round((close - prev) * 1e4) / 1e4 : null), change_rate: num(d.changePercent),
    total_volume: lots(vol) ?? 0, total_amount: val ?? 0, yesterday_volume: null,
    buy_price: num(d.bids?.[0]?.price), sell_price: num(d.asks?.[0]?.price),
    volume_at_bid: lots(num(t.tradeVolumeAtBid)), volume_at_ask: lots(num(t.tradeVolumeAtAsk)), transactions: num(t.transaction),
  };
}

// WebSocket 資料訊息 → 推播事件：逐筆成交、五檔、1 分 K、聚合行情。時間一律換成毫秒；量為張（上市櫃普通股）
const ms = v => { const n = Number(v); return n > 1e14 ? n / 1000 : n > 1e11 ? n : n > 0 ? n * 1000 : 0; };
const levels = a => (Array.isArray(a) ? a : []).map(l => ({ price: num(l?.price), size: num(l?.size) ?? 0 })).filter(l => l.price > 0);
export function streamEvent(msg, market) {
  const d = msg?.data; if (msg?.event !== 'data' || !d?.symbol) return null;
  const id = String(d.symbol);
  switch (msg.channel) {
    case 'trades': return { kind: 'trade', id, time: ms(d.time), price: num(d.price), size: num(d.size) ?? 0, volume: num(d.volume), bid: num(d.bid), ask: num(d.ask), serial: num(d.serial), trial: !!d.isTrial, limitUp: !!d.isLimitUpPrice, halted: !!(d.isLimitUpHalt || d.isLimitDownHalt) };
    case 'books': return { kind: 'book', key: 'b:' + id, id, time: ms(d.time), bids: levels(d.bids), asks: levels(d.asks), trial: !!d.isTrial };
    case 'candles': { const t = Date.parse(d.date); return t > 0 ? { kind: 'candle', key: `c:${id}:${t}`, id, time: t, open: num(d.open), high: num(d.high), low: num(d.low), close: num(d.close), volume: num(d.volume) ?? 0 } : null; }
    case 'aggregates': { const row = aggregateRow(d, market?.tz, market?.lot); return row ? { kind: 'agg', key: 'a:' + id, id, tradeTime: ms(d.closeTime ?? d.lastTrade?.time), time: ms(d.lastUpdated ?? d.total?.time), row, book: { bids: levels(d.bids), asks: levels(d.asks) } } : null; }
    default: return null;
  }
}

export default {
  id: 'fugle', name: 'Fugle 富果行情', site: 'https://developer.fugle.tw', docs: 'https://developer.fugle.tw/docs/data/intro', markets: ['TW'],
  key: 'required', keyEnv: 'FUGLE_API_KEY', interval: 150,
  caps: { snapshot: 'paid', intraday: 1, daily: 1, adjusted: 1, stream: 1 },
  snapshotMode: 'market',
  // 盤中即時推播（WebSocket）：完整模式訂閱逐筆成交＋1 分 K＋五檔（每檔 3 個訂閱），精簡模式只訂閱聚合行情（每檔 1 個）
  stream: {
    url: WS, plans: PLANS, plan: planOf,
    // book：五檔錄製器加錄的股票只訂閱五檔（每檔 1 個訂閱）
    channels: { full: ['trades', 'candles', 'books'], lite: ['aggregates'], book: ['books'] },
    auth: key => ({ event: 'auth', data: { apikey: key } }),
    subscribe: (symbols, channel = 'aggregates') => ({ event: 'subscribe', data: { channel, symbols } }),
    unsubscribe: ids => ({ event: 'unsubscribe', data: { ids } }),
    batch: 50,
    parse: streamEvent,
  },
  // 當沖監控的歷史資料：今天以前最近幾個交易日的 1 分 K（由引擎彙整成 5 分 K，計算跨日的 20MA）。
  // 每檔 1 次歷史請求（歷史 API 每分鐘 60 次）；查 14 個日曆日以涵蓋連假，只保留最後 3 個交易日。價格為原始成交價，
  // 除權息日由引擎以今天的參考價換算。
  async streamHistory(id, date, ctx) {
    const body = await get(`/historical/candles/${id}?timeframe=1&from=${addDays(date, -14)}&to=${addDays(date, -1)}&sort=asc&fields=open,high,low,close,volume`, ctx);
    const dayOf = time => new Date(time + 8 * 3600e3).toISOString().slice(0, 10);
    const rows = (body?.data || []).map(c => ({ time: Date.parse(c.date), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })).filter(b => Number.isFinite(b.time) && dayOf(b.time) < date);
    const keep = new Set([...new Set(rows.map(b => dayOf(b.time)))].sort().slice(-3));
    return { minutes: rows.filter(b => keep.has(dayOf(b.time))), source: 'fugle' };
  },
  // 個股即時明細（沒有即時推播訂閱的股票，例如 ETF、研究名單以外）：報價（五檔、累計量、均價）、最近 40 筆成交、當日 1 分 K（3 次盤中 REST）
  async quoteDetail(id, ctx) {
    const quote = await get(`/intraday/quote/${id}`, ctx), trades = await get(`/intraday/trades/${id}?limit=40`, ctx), candles = await get(`/intraday/candles/${id}?timeframe=1`, ctx);
    return { quote, trades: trades?.data || [], candles: candles?.data || [] };
  },
  // 指數（加權 IX0001、櫃買 IX0043）：報價與當日 1 分 K（量為成交金額）；日 K 走歷史 API（每分鐘 60 次，呼叫端快取）
  async indexDetail(symbol, ctx) {
    const quote = await get(`/intraday/quote/${symbol}`, ctx), candles = await get(`/intraday/candles/${symbol}?timeframe=1`, ctx);
    return { quote, candles: candles?.data || [] };
  },
  async indexDaily(symbol, from, to, ctx) {
    const body = await get(`/historical/candles/${symbol}?timeframe=D&from=${from}&to=${to}&sort=asc&fields=open,high,low,close,volume,turnover`, ctx);
    return (body?.data || []).filter(c => c.close > 0).map(c => [c.date, c.open, c.high, c.low, c.close, c.turnover ?? c.volume ?? 0]);
  },
  // 斷線重連後補資料：最新報價與當日 1 分 K。
  async streamBackfill(id, ctx) {
    const quote = await get(`/intraday/quote/${id}`, ctx), candles = await get(`/intraday/candles/${id}?timeframe=1`, ctx);
    return { quote, candles: candles?.data || [] };
  },
  // 當日全部逐筆成交（每頁最多 500 筆，依時間由舊到新）→ 與推播相同格式的成交事件
  async streamTrades(id, ctx) {
    const out = [];
    for (let offset = 0; offset < 200000; offset += 500) {
      const body = await get(`/intraday/trades/${id}?limit=500&offset=${offset}&sort=asc`, ctx), rows = body?.data || [];
      for (const d of rows) out.push(streamEvent({ event: 'data', channel: 'trades', data: { ...d, symbol: id } }));
      if (rows.length < 500) break;
    }
    return out.filter(Boolean);
  },
  async validate(key) {
    const r = await fetchJSON(`${BASE}/intraday/quote/2330`, { headers: { 'X-API-KEY': key }, label: LABEL });
    if (!r.ok) throw new DataError('Fugle 未接受此金鑰');
    // 快照需開發者以上方案；試一次就知道
    const s = await fetchJSON(`${BASE}/snapshot/quotes/TSE?type=COMMONSTOCK`, { headers: { 'X-API-KEY': key }, label: LABEL });
    return { plan: s.ok ? 'developer+' : 'basic', tier: s.ok ? 'paid' : 'free', streamLimit: s.ok ? PLANS.developer.limit : PLANS.basic.limit };
  },
  snapshot: async (ids, ctx) => {
    const [a, b] = [await get('/snapshot/quotes/TSE?type=COMMONSTOCK', ctx), await get('/snapshot/quotes/OTC?type=COMMONSTOCK', ctx)];
    return [...parseSnapshot(a), ...parseSnapshot(b)];
  },
  // 分 K：今天用盤中 API，過去日期用歷史 API（2023-05-23 以後）；成交量單位為張
  intraday: async (id, date, ctx) => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const body = date === today ? await get(`/intraday/candles/${id}?timeframe=1`, ctx) : await get(`/historical/candles/${id}?timeframe=1&from=${date}&to=${date}&sort=asc`, ctx);
    return (body?.data || []).filter(c => String(c.date).startsWith(date) && c.close > 0).map(c => [hmOf(c.date), c.open, c.high, c.low, c.close, c.volume]).filter(r => r[0]);
  },
  // 日 K：每次查詢需少於一年，分段取得；成交量單位為股
  daily: async (id, from, to, ctx) => {
    const fetchRange = async adjusted => {
      const rows = [];
      for (let a = from; a <= to; a = addDays(a, 360)) {
        const b = addDays(a, 359) < to ? addDays(a, 359) : to;
        const body = await get(`/historical/candles/${id}?timeframe=D&from=${a}&to=${b}&sort=asc&fields=open,high,low,close,volume,turnover,change${adjusted ? '&adjusted=true' : ''}`, ctx);
        for (const c of body?.data || []) if (c.close > 0) rows.push({ date: c.date, stock_id: id, open: c.open, max: c.high, min: c.low, close: c.close, Trading_Volume: c.volume, Trading_money: c.turnover ?? null, spread: num(c.change) });
      }
      return rows;
    };
    return { price: await fetchRange(false), adjusted: await fetchRange(true) };
  },
};
