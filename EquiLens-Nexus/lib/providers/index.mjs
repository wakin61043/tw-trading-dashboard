// 資料源路由：每個資料源宣告支援的市場與能力；依使用者設定為每種能力挑一個可用的資料源。
// 挑選順序：指定的偏好 → 啟用清單順序；略過沒有金鑰、不支援目前市場、或方案等級不足的資料源。
import { config, activeMarket } from '../config.mjs';
import { getSecret, secretConfigured } from '../secrets.mjs';
import { read, write } from '../storage.mjs';
import { DataError, weekdays, addDays } from './common.mjs';
import finmind from './finmind.mjs';
import twse from './twse.mjs';
import fugle from './fugle.mjs';
import twelvedata from './twelvedata.mjs';
import alphavantage from './alphavantage.mjs';

export const PROVIDERS = { finmind, twse, fugle, twelvedata, alphavantage };
// 能力名稱（介面顯示用繁中原文，翻譯在 locales）
export const CAPABILITIES = {
  universe: '股票清單', calendar: '交易日曆', daily: '日 K 歷史', adjusted: '還原股價', dailyAll: '全市場單日行情', snapshot: '盤中即時報價', intraday: '分 K',
  news: '個股新聞', marketNews: '全市場新聞', valuation: '本益比／股價淨值比', revenue: '營收', institutional: '法人買賣超', brokers: '券商分點', holders: '股權分散', flows: '法人籌碼總覽', futures: '期貨與選擇權', margin: '融資融券', stream: '盤中即時推播', dayTrade: '當沖資格與參考價',
};

// 方案等級（驗證金鑰時記錄）：.local/provider-info.json { finmind: { tier, plan, checkedAt } }
export const providerInfo = () => read('provider-info.json', {});
export function setProviderInfo(id, info) { const all = providerInfo(); all[id] = { ...info, checkedAt: new Date().toISOString() }; write('provider-info.json', all); }
// 各資料源的請求間隔（FinMind 依設定頁的請求速度）
const intervals = {};
export function setInterval_(id, ms) { intervals[id] = ms; }

export const hasKey = p => p.key === 'none' || secretConfigured(p.id, p.keyEnv);
export function supports(p, cap, market = activeMarket().id) {
  if (!p || !p.markets.includes(market)) return false;
  const c = p.caps[cap]; if (!c) return false;
  if (Array.isArray(c)) return c.includes(market); // 只在部分市場提供
  // 'sponsor'／'paid'：需付費方案；尚未驗證過等級時先當作可用，失敗時再提示
  if (c === 'sponsor' || c === 'paid') { const tier = providerInfo()[p.id]?.tier; return !tier || tier !== 'free'; }
  return true;
}
export function enabledProviders() { return config().providers.enabled.map(id => PROVIDERS[id]).filter(Boolean); }
export function pick(cap) {
  const { prefer } = config().providers, list = enabledProviders();
  const order = prefer[cap] && list.some(p => p.id === prefer[cap]) ? [PROVIDERS[prefer[cap]], ...list] : list;
  return order.find(p => hasKey(p) && supports(p, cap)) || null;
}
export const has = cap => !!pick(cap);
// 每種能力目前由哪個資料源提供（設定頁與前端用來決定顯示哪些功能）
export const capabilityMap = () => Object.fromEntries(Object.keys(CAPABILITIES).map(c => [c, pick(c)?.id || null]));

async function ctxOf(p, opts = {}) {
  const info = providerInfo()[p.id] || {};
  return { ...opts, token: undefined, key: p.key === 'none' ? '' : await getSecret(p.id, p.keyEnv), interval: opts.interval ?? intervals[p.id] ?? p.interval, market: activeMarket(), info, perMinute: info.perMinute };
}
async function call(cap, args, opts) {
  const p = pick(cap);
  if (!p) throw new DataError('目前啟用的資料源不支援「{cap}」，請到「資料與設定 → 資料來源」啟用支援的資料源', { cap: CAPABILITIES[cap] || cap });
  const ctx = await ctxOf(p, opts);
  return p[cap](...args, ctx);
}

export const data = {
  pick, has, source: cap => pick(cap)?.id || null,
  snapshotMode: () => pick('snapshot')?.snapshotMode || null,
  snapshotLimit: () => { const p = pick('snapshot'); return p ? (p.snapshotLimit?.(providerInfo()[p.id]) ?? null) : null; },
  // 即時推播的補資料（REST）：由提供推播的資料源執行
  streamBackfill: async (id, opts) => { const p = pick('stream'); if (!p?.streamBackfill) return null; return p.streamBackfill(id, await ctxOf(p, opts)); },
  streamHistory: async (id, date, opts) => { const p = pick('stream'); if (!p?.streamHistory) throw new DataError('即時資料源不支援歷史分 K'); return p.streamHistory(id, date, await ctxOf(p, opts)); },
  // 當日全部逐筆成交（REST，五檔錄製器收盤後補齊只錄五檔的股票）
  // 個股即時明細與指數（由提供推播的資料源執行，目前為富果）
  streamQuote: async (id, opts) => { const p = pick('stream'); if (!p?.quoteDetail) return null; return p.quoteDetail(id, await ctxOf(p, opts)); },
  indexDetail: async (symbol, opts) => { const p = pick('stream'); if (!p?.indexDetail) return null; return p.indexDetail(symbol, await ctxOf(p, opts)); },
  indexDaily: async (symbol, from, to, opts) => { const p = pick('stream'); if (!p?.indexDaily) return null; return p.indexDaily(symbol, from, to, await ctxOf(p, opts)); },
  streamTrades: async (id, opts) => { const p = pick('stream'); if (!p?.streamTrades) return null; return p.streamTrades(id, await ctxOf(p, opts)); },
  universe: (opts) => call('universe', [], opts),
  // 交易日曆；沒有支援的資料源時以平日代替（假日由「當天沒有行情」判斷）
  calendar: async (from, opts) => has('calendar') ? call('calendar', [from], opts) : weekdays(from || addDays(new Date().toISOString().slice(0, 10), -400), addDays(new Date().toISOString().slice(0, 10), 7)),
  daily: (id, from, to, opts) => call('daily', [id, from, to], opts),
  dailyAll: (date, opts) => call('dailyAll', [date], opts),
  dailyAllAdjusted: (date, opts) => { const p = pick('dailyAll'); return p?.dailyAllAdjusted ? ctxOf(p, opts).then(ctx => p.dailyAllAdjusted(date, ctx)) : call('dailyAll', [date], opts); },
  snapshot: (ids, opts) => call('snapshot', [ids], opts),
  intraday: (id, date, opts) => call('intraday', [id, date], opts),
  dayTrade: (date, opts) => call('dayTrade', [date], opts),
  news: (id, date, opts) => call('news', [id, date], opts),
  marketNews: (date, opts) => call('marketNews', [date], opts),
  valuation: (id, from, to, opts) => call('valuation', [id, from, to], opts),
  revenue: (id, from, to, opts) => call('revenue', [id, from, to], opts),
  institutional: (id, from, to, opts) => call('institutional', [id, from, to], opts),
  institutionalAll: (date, opts) => call('institutionalAll', [date], opts),
  // 台股在地模組（法人籌碼、分點、股權分散、期貨、融資）目前只有 FinMind 提供，直接使用其資料集介面
  finmind: () => hasKey(finmind) && enabledProviders().includes(finmind) && activeMarket().id === 'TW' ? finmind.request : null,
};
