// 當沖監控：引擎（分 K、VWAP、內外盤、5 分 K 與 20MA、開盤低點、訊號、排除條件、斷線補資料）、觀察名單（周轉率）、收盤檢討、富果事件解析、多連線訂閱、盤前資料
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDayTrade, normalizeDaytrade, roundTripCost, tzOffset, evaluateSignal, reviewStats, rankTurnover, selectTurnover, signalTitle, DT_DEFAULTS, DT_TYPES } from '../lib/daytrade.mjs';
import { createStreamPool, splitSymbols } from '../lib/stream.mjs';
import fugle, { streamEvent, planOf } from '../lib/providers/fugle.mjs';
import { parseDayTradePrep } from '../lib/providers/finmind.mjs';
import { marketProfile } from '../lib/markets.mjs';
import { regimeOf } from '../lib/daytrade-market.mjs';

const tw = marketProfile('TW'), date = '2026-10-07', prev = '2026-10-06', at = hms => Date.parse(`${date}T${hms}+08:00`);
const book = (id, time, bid, ask, bidSize = 100, askSize = 50) => ({ kind: 'book', id, time, bids: [{ price: bid, size: bidSize }], asks: [{ price: ask, size: askSize }] });
let serial = 0;
const trade = (id, hms, price, size, { bid = price - 0.1, ask = price } = {}) => ({ kind: 'trade', id, time: typeof hms === 'number' ? hms : at(hms), price, size, bid, ask, serial: ++serial });
// 前一交易日的 5 分 K（09:00–13:30 共 54 根，價格固定）：20MA 從這裡接續到今天
const histFive = (px, day = prev) => ({ source: 'fixture', five: Array.from({ length: 54 }, (_, i) => { const time = Date.parse(`${day}T09:00:00+08:00`) + i * 300e3; return { time, end: time + 300e3, o: px, h: px, l: px, c: px, v: 10 }; }) });
const META = new Map([['2330', { name: '台積電', groups: ['semi'], exchange: '上市', turnover: 3.2 }]]);
function engine({ history = histFive(50), settings = {}, prep = {}, ...opts } = {}) {
  const e = createDayTrade({ market: tw, date, ids: ['2330'], meta: META, watch: new Set(), scan: new Set(['2330']), prep: { ref: new Map([['2330', 50]]), ...prep }, settings: { ...DT_DEFAULTS, ...settings }, offset: 8 * 3600e3, ...opts });
  if (history) e.setHistory('2330', history);
  e.setFeed(true); return e;
}
// 一根 5 分 K 的成交：開、低、高、收各一筆，分布在這 5 分鐘內
function bar(e, hm, close, { open = close, low = Math.min(open, close), high = Math.max(open, close) } = {}) {
  const t0 = at(`${hm}:00`);
  e.ingest([trade('2330', t0 + 5e3, open, 5), trade('2330', t0 + 65e3, low, 5), trade('2330', t0 + 125e3, high, 5), trade('2330', t0 + 290e3, close, 5)]);
}
const types = alerts => alerts.map(a => a.type);

test('settings: v3 defaults, bounds, and older settings keep only the switch, plan and costs', () => {
  const old = normalizeDaytrade({ enabled: false, plan: 'advanced', top: 20, scope: 'watchlist', watchFrom: '09:15', stopNew: '13:10', signals: { breakout: false }, costs: { feeDiscount: 0.28, slipTicks: 9 } });
  assert.deepEqual([old.version, old.enabled, old.plan, old.top, old.watchFrom, old.stopNew, old.costs.feeDiscount, old.costs.slipTicks], [3, false, 'advanced', 30, '09:05', '13:25', 0.28, 1]);
  assert.deepEqual([old.sources, old.signals], [{ turnover: true, groups: true, watchlist: false }, { maUp: true, maDown: true, openLow: true }]);
  const s = normalizeDaytrade({ version: 3, top: 999, plan: 'x', sources: { turnover: false, watchlist: true }, signals: { openLow: false }, turnoverTop: 5, turnoverMinAmount: 3e8, eligibleOnly: false, watchFrom: '09:30', stopNew: '25:00' });
  assert.deepEqual([s.top, s.plan, s.sources, s.signals, s.turnoverTop, s.turnoverMinAmount, s.eligibleOnly, s.watchFrom, s.stopNew],
    [30, 'auto', { turnover: false, groups: true, watchlist: true }, { maUp: true, maDown: true, openLow: false }, 50, 3e8, false, '09:30', '13:25']);
  assert.equal(Math.round(roundTripCost(DT_DEFAULTS.costs) * 1000) / 1000, 0.435);
  assert.equal(tzOffset('Asia/Taipei'), 8 * 3600e3);
  assert.deepEqual([signalTitle({ type: 'dt-ma-up', version: 3 }), signalTitle({ type: 'dt-breakout', version: 2 }), signalTitle({ type: 'dt-breakout' })], ['突破 20MA（多方）', '多週期爆量突破', '爆量突破']);
});

test('turnover: volume ÷ shares, common stocks only; selection applies the amount floor, exclusions and top N', () => {
  const ranked = rankTurnover({ volumes: { 2330: 30e6, 3017: 20e6, 6669: 5e6, '0050': 90e6, '00878': 90e6, 9999: 1e6, 1101: 0 }, amounts: { 2330: 4e10, 3017: 2e10, 6669: 5e7, 9999: 1e9 },
    shares: { 2330: 1e9, 3017: 1e8, 6669: 1e7, '0050': 1e8, '00878': 1e8, 1101: 1e9 }, allow: new Set(['2330', '3017', '6669', '0050', '9999']) });
  assert.deepEqual(ranked, [{ id: '6669', rate: 50, amount: 5e7 }, { id: '3017', rate: 20, amount: 2e10 }, { id: '2330', rate: 3, amount: 4e10 }], 'ETFs, stocks without a share count and stocks without volume are skipped');
  assert.deepEqual(selectTurnover(ranked, { top: 5, minAmount: 1e8 }).map(x => x.id), ['3017', '2330'], 'below the amount floor');
  assert.deepEqual(selectTurnover(ranked, { top: 1, minAmount: 0, exclude: new Set(['6669']) }).map(x => x.id), ['3017']);
  assert.deepEqual(selectTurnover(null), []);
});

test('trades build VWAP, bid/ask volume and minute bars; duplicates and trial matches ignored', () => {
  const e = engine({ history: null });
  const t1 = trade('2330', '09:00:05', 50, 10, { bid: 49.9, ask: 50 }), t2 = trade('2330', '09:00:30', 49.9, 30, { bid: 49.9, ask: 50 });
  e.ingest([t1, t2, { ...t1 }, { ...trade('2330', '09:00:40', 60, 999), trial: true }, trade('2330', '09:01:02', 50.2, 10, { bid: 50.1, ask: 50.2 })]);
  const r = e.row('2330');
  assert.deepEqual([r.close, r.total_volume, r.volume_at_ask, r.volume_at_bid, r.change_price, r.open, r.high, r.low], [50.2, 50, 20, 30, 0.2, 50, 50.2, 49.9]);
  assert.equal(r.total_amount, (50 * 10 + 49.9 * 30 + 50.2 * 10) * 1000);
  assert.match(r.date, /^2026-10-07 09:01:02$/);
  const bars = [...e.bars('2330').values()].sort((a, b) => a.m - b.m);
  assert.deepEqual(bars.map(b => [b.m, b.o, b.h, b.l, b.c, b.tv]), [[540, 50, 50, 49.9, 49.9, 40], [541, 50.2, 50.2, 50.2, 50.2, 10]]);
  e.tick(at('09:02:00'));
  const item = e.ranking().list[0];
  assert.equal(item.vwap, Math.round((50 * 10 + 49.9 * 30 + 50.2 * 10) / 50 * 100) / 100);
});

test('candles fill bars missed by trades without double counting', () => {
  const e = engine();
  e.ingest([trade('2330', '09:00:05', 50, 10)]);
  e.ingest([{ kind: 'candle', id: '2330', time: at('09:00:00'), open: 50, high: 50.3, low: 49.8, close: 50.1, volume: 25 }]);
  const b = e.bars('2330').get(540);
  assert.deepEqual([b.h, b.l, b.c, Math.max(b.tv, b.cv)], [50.3, 49.8, 50.1, 25]);
});

test('5-minute close crossing the 20MA: long on the way up, short on the way down, once per bar, again after a re-cross', () => {
  const e = engine();
  bar(e, '09:00', 50, { low: 49.9 });
  assert.deepEqual(e.tick(at('09:05:01')), [], 'waits 3 seconds after the bar ends');
  assert.deepEqual(e.tick(at('09:05:03')), [], 'close equals the average: no cross');
  bar(e, '09:05', 50.5);
  assert.deepEqual(e.tick(at('09:09:59')), [], 'the bar is still forming');
  const up = e.tick(at('09:10:03'));
  assert.deepEqual(types(up), ['dt-ma-up']);
  assert.deepEqual([up[0].side, up[0].title, up[0].stockId, up[0].close, up[0].change, up[0].level], ['long', '突破 20MA（多方）', '2330', 50.5, 1, 'hi']);
  assert.match(up[0].detail, /5 分 K 收 50\.5，站上 20MA 50\.03（前一根收 50，在均線 50 之下）/);
  assert.deepEqual(e.tick(at('09:10:04')), [], 'one evaluation per bar');
  const s = e.signals[0];
  assert.deepEqual([s.version, s.type, s.side, s.price, s.m, s.turnover, s.bar.end, s.bar.close, s.bar.ma20, s.bar.openLow], [3, 'dt-ma-up', 'long', 50.5, 550, 3.2, at('09:10:00'), 50.5, 50.025, 49.9]);
  bar(e, '09:10', 50.4); assert.deepEqual(e.tick(at('09:15:03')), [], 'still above: no new signal');
  bar(e, '09:15', 49.95);
  assert.deepEqual(types(e.tick(at('09:20:03'))), ['dt-ma-down'], 'closes below the average but not below the opening low (49.9)');
  bar(e, '09:20', 49.9); assert.deepEqual(e.tick(at('09:25:03')), [], 'equal to the opening low is not a break');
  bar(e, '09:25', 50.6); assert.deepEqual(types(e.tick(at('09:30:03'))), ['dt-ma-up'], 'crosses up again');
  assert.deepEqual(e.signals.map(x => x.type), ['dt-ma-up', 'dt-ma-down', 'dt-ma-up']);
  const item = e.ranking().list[0];
  assert.deepEqual([item.scan, item.turnover, item.grouped, item.five.end, item.five.above, item.five.openLow, item.five.belowOpen, item.last.type, item.reasons], [true, 3.2, true, '09:30', true, 49.9, false, 'dt-ma-up', []]);
  assert.deepEqual(e.ranking().counts, { long: 1, short: 0, waiting: 0 });
});

test('closing below the opening low is a short signal of its own; both short signals can fire on the same bar', () => {
  const e = engine();
  bar(e, '09:00', 50.2, { low: 50 }); e.tick(at('09:05:03'));
  bar(e, '09:05', 50.3); e.tick(at('09:10:03'));
  bar(e, '09:10', 49.8);
  const a = e.tick(at('09:15:03'));
  assert.deepEqual(types(a).sort(), ['dt-ma-down', 'dt-open-low']);
  assert.ok(a.every(x => x.side === 'short')); assert.match(a.find(x => x.type === 'dt-open-low').detail, /跌破開盤低點 50/);
  bar(e, '09:15', 49.7); assert.deepEqual(e.tick(at('09:20:03')), [], 'stays below: no repeat');
  bar(e, '09:20', 50.05); e.tick(at('09:25:03')); // 收回開盤低點之上（仍在均線附近）
  bar(e, '09:25', 49.6);
  assert.ok(types(e.tick(at('09:30:03'))).includes('dt-open-low'), 'breaks again after recovering');
  // 只有一根 K 棒時不判斷開盤低點；單獨關閉某一種訊號
  const off = engine({ settings: { signals: { maUp: true, maDown: false, openLow: true } } });
  bar(off, '09:00', 50.2, { low: 50 }); off.tick(at('09:05:03')); bar(off, '09:05', 50.3); off.tick(at('09:10:03')); bar(off, '09:10', 49.8);
  assert.deepEqual(types(off.tick(at('09:15:03'))), ['dt-open-low']);
});

test('no signals outside the signal window, when not on the watch list, disabled, or while the feed is down', () => {
  const late = engine({ settings: { watchFrom: '09:30' } });
  bar(late, '09:00', 50); bar(late, '09:05', 50.5);
  assert.deepEqual(late.tick(at('09:10:03')), []); assert.equal(late.phase(at('09:10:03')), 'opening');
  assert.deepEqual(late.tick(at('09:30:03')), [], 'an old bar is never replayed');
  const closing = engine({ settings: { stopNew: '13:00' } });
  bar(closing, '12:50', 50); closing.tick(at('12:55:03')); bar(closing, '12:55', 50.5);
  assert.deepEqual(closing.tick(at('13:00:03')), []); assert.equal(closing.phase(at('13:00:03')), 'stop');
  const auction = engine(); bar(auction, '13:15', 50); auction.tick(at('13:20:03')); bar(auction, '13:20', 50.5);
  assert.deepEqual(auction.tick(at('13:25:03')), [], 'closing auction'); assert.equal(auction.phase(at('13:25:03')), 'auction');
  for (const [name, opts] of [['not scanned', { scan: new Set() }], ['disabled', { settings: { enabled: false } }]]) {
    const e = engine(opts); bar(e, '09:00', 50); e.tick(at('09:05:03')); bar(e, '09:05', 50.5);
    assert.deepEqual(e.tick(at('09:10:03')), [], name);
  }
  const down = engine(); bar(down, '09:00', 50); down.tick(at('09:05:03')); bar(down, '09:05', 50.5); down.setFeed(false);
  assert.deepEqual(down.tick(at('09:10:03')), []);
  down.setFeed(true); assert.deepEqual(types(down.tick(at('09:12:00'))), ['dt-ma-up'], 'evaluated once the feed is back and the bar is still the latest');
});

test('pending backfill holds signals; once filled the latest bar is evaluated, and a restart never repeats a bar', () => {
  const candle = (hm, close) => ({ date: `${date}T${hm}:00.000+08:00`, open: close, high: close, low: close, close, volume: 5 });
  const quote = { referencePrice: 50, closePrice: 50.5, closeTime: at('09:09:50') * 1000, lastUpdated: at('09:09:50') * 1000, avgPrice: 50.2, total: { tradeVolume: 100, tradeValue: 5.02e6 } };
  const e = engine(); e.markGap(['2330']);
  bar(e, '09:00', 50); bar(e, '09:05', 50.5);
  assert.deepEqual(e.tick(at('09:10:03')), []); assert.equal(e.ranking().list[0].pending, true);
  assert.equal(e.backfill('2330', { quote: null, candles: [] }), false, 'a failed response keeps the gap');
  assert.equal(e.backfill('2330', { quote, candles: [candle('09:00', 50), candle('09:05', 50.5)] }), true);
  assert.deepEqual(types(e.tick(at('09:10:30'))), ['dt-ma-up']);
  const restarted = engine(); restarted.restore(e.signals);
  bar(restarted, '09:00', 50); bar(restarted, '09:05', 50.5);
  assert.deepEqual(restarted.tick(at('09:10:40')), []); assert.equal(restarted.signals.length, 1);
  assert.equal(restarted.ranking().list[0].last.type, 'dt-ma-up');
});

test('exclusions: not day-tradable, disposition and suspended stocks; sell-first bans and price limits block one side only', () => {
  const run = (prep, settings) => { const e = engine({ prep, settings }); bar(e, '09:00', 50); e.tick(at('09:05:03')); bar(e, '09:05', 50.5); const up = e.tick(at('09:10:03')); bar(e, '09:10', 49.5); return [types(up), types(e.tick(at('09:15:03'))).sort(), e]; };
  const [u1, d1, banned] = run({ eligible: new Set(['2317']), disposition: new Set(['2330']) });
  assert.deepEqual([u1, d1], [[], []]);
  assert.deepEqual(banned.ranking().list[0].filters, ['noDayTrade', 'disposition']); assert.deepEqual(banned.ranking().excluded, { noDayTrade: 1, disposition: 1 });
  assert.deepEqual(run({ eligible: new Set(['2317']), disposition: new Set(['2330']) }, { eligibleOnly: false }).slice(0, 2), [['dt-ma-up'], ['dt-ma-down', 'dt-open-low']], 'the filter can be turned off');
  assert.deepEqual(run({ suspended: new Set(['2330']) }, { eligibleOnly: false }).slice(0, 2), [[], []], 'suspended stocks never signal');
  assert.deepEqual(run({ eligible: new Set(['2330']), sellFirstOff: new Set(['2330']) }).slice(0, 2), [['dt-ma-up'], []], 'no short signals when selling first is banned');
  assert.deepEqual(run({}).slice(0, 2), [['dt-ma-up'], ['dt-ma-down', 'dt-open-low']], 'an eligibility list that is not available does not block');
  const up = engine(); bar(up, '09:00', 50); up.tick(at('09:05:03')); bar(up, '09:05', 55);
  assert.deepEqual(up.tick(at('09:10:03')), [], 'limit-up: cannot buy');
  const dn = engine(); bar(dn, '09:00', 50.2, { low: 50 }); dn.tick(at('09:05:03')); bar(dn, '09:05', 45);
  assert.deepEqual(dn.tick(at('09:10:03')), [], 'limit-down: cannot sell');
});

test('history: the average continues from the previous session; without it the cross waits for 21 bars today; ex-dividend prices are rescaled', () => {
  const none = engine({ history: null });
  bar(none, '09:00', 50); none.tick(at('09:05:03')); bar(none, '09:05', 50.5);
  assert.deepEqual(none.tick(at('09:10:03')), []);
  assert.deepEqual(none.ranking().list[0].reasons, ['history']); assert.deepEqual(none.ranking().counts, { long: 0, short: 0, waiting: 1 });
  assert.equal(none.historyReady('2330'), false);
  // 今天自己累積 21 根後就能判斷（09:00–10:40 持平，10:40 那根站上）
  const self = engine({ history: null });
  for (let i = 0; i < 20; i++) { const m = 540 + i * 5; bar(self, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, 50); }
  self.tick(at('10:40:03')); bar(self, '10:40', 50.5);
  assert.deepEqual(types(self.tick(at('10:45:03'))), ['dt-ma-up']);
  // 除權息：歷史價格 100、今天參考價 50 → 歷史乘上 0.5，均線落在 50 附近
  const ex = engine({ history: histFive(100) });
  bar(ex, '09:00', 50); ex.tick(at('09:05:03')); bar(ex, '09:05', 50.5);
  assert.deepEqual(types(ex.tick(at('09:10:03'))), ['dt-ma-up']); assert.equal(ex.signals[0].bar.ma20, 50.025);
  assert.equal(engine().historyReady('2330'), true);
});

test('lite mode: aggregate quotes build the same 5-minute bars and signals', () => {
  const e = engine();
  const agg = (hms, close, vol) => ({ kind: 'agg', id: '2330', time: at(hms), tradeTime: at(hms), row: { close, total_volume: vol, total_amount: vol * close * 1000, volume_at_ask: vol / 2, volume_at_bid: vol / 2, change_price: close - 50 } });
  e.ingest([agg('09:00:10', 50, 10)]); e.ingest([agg('09:03:10', 50, 20)]);
  e.tick(at('09:05:03'));
  e.ingest([agg('09:06:10', 50.3, 30)]); e.ingest([agg('09:09:40', 50.5, 40)]);
  assert.deepEqual(types(e.tick(at('09:10:03'))), ['dt-ma-up']);
});

test('signals record the market regime at signal time (record only)', () => {
  const run = feed => { const e = engine(); feed?.(e); bar(e, '09:00', 50); e.tick(at('09:05:03')); bar(e, '09:05', 50.5); return [e.tick(at('09:10:03')), e]; };
  const [base, plain] = run();
  assert.equal(plain.signals[0].market.reason, 'noIndex');
  const [same, e] = run(x => { for (let m = 0; m < 11; m++) x.indexSample('twse', { at: at('09:00:50') + m * 60000, price: 22000 + m * 5, ref: 22000 }); });
  assert.deepEqual(same.map(a => [a.type, a.detail, a.close]), base.map(a => [a.type, a.detail, a.close]), 'index data never changes the signal');
  assert.equal(e.signals[0].market.index, 'twse');
  assert.equal(e.marketState(at('09:10:03')).tpex, null);
});

test('backfill after a reconnect restores totals, reference, book and minute bars', () => {
  const e = engine({ prep: {} }); e.markGap(['2330']);
  e.backfill('2330', { quote: { referencePrice: 48, openPrice: 48.5, highPrice: 50.5, lowPrice: 48.2, closePrice: 50, closeTime: at('10:00:00') * 1000, avgPrice: 49.5, lastUpdated: at('10:00:00') * 1000, total: { tradeVolume: 1000, tradeValue: 49.5e6, tradeVolumeAtBid: 400, tradeVolumeAtAsk: 600 }, lastTrade: { serial: 500 }, bids: [{ price: 49.9, size: 10 }], asks: [{ price: 50, size: 10 }] }, candles: [{ date: `${date}T09:00:00.000+08:00`, open: 48.5, high: 48.8, low: 48.2, close: 48.7, volume: 300 }] });
  assert.equal(e.gaps.size, 0);
  const r = e.row('2330');
  assert.deepEqual([r.close, r.change_price, r.total_volume, r.volume_at_ask, r.buy_price], [50, 2, 1000, 600, 49.9]);
  assert.equal(e.bars('2330').get(540).cv, 300);
  e.ingest([trade('2330', '10:00:01', 50, 5)]);
  assert.equal(e.row('2330').total_volume, 1000, 'trades with older serials are ignored');
});

test('lite mode: aggregate rows become minute bars from cumulative volume', () => {
  const e = engine();
  const agg = (hms, close, vol, ask, bid) => ({ kind: 'agg', id: '2330', time: at(hms), row: { close, total_volume: vol, total_amount: vol * close * 1000, volume_at_ask: ask, volume_at_bid: bid, change_price: close - 50 }, book: { bids: [{ price: close - 0.1, size: 10 }], asks: [{ price: close, size: 10 }] } });
  e.ingest([agg('09:00:10', 50, 100, 60, 40)]); e.ingest([agg('09:01:10', 50.2, 130, 80, 50)]);
  const bars = [...e.bars('2330').values()].sort((a, b) => a.m - b.m);
  assert.deepEqual(bars.map(b => [b.tv, b.ask, b.bid]), [[100, 60, 40], [30, 20, 10]]);
  assert.equal(e.row('2330').sell_price, 50.2);
});

test('review: net returns after slippage, fees and tax for both sides; statistics per signal type', () => {
  const bars = new Map([[575, { m: 575, h: 50.5, l: 50.3, c: 50.5 }], [580, { m: 580, h: 51, l: 50.4, c: 51 }], [590, { m: 590, h: 51.2, l: 50.6, c: 50.8 }], [810, { m: 810, h: 50, l: 49.8, c: 50 }]]);
  const o = evaluateSignal({ m: 575, price: 50.5, side: 'long' }, bars, tw, DT_DEFAULTS.costs);
  // 買 50.6（滑價 1 檔）；5 分鐘後 51 − 0.1 = 50.9 → +0.593% − 0.435% 成本
  assert.equal(o.r5, Math.round(((50.9 / 50.6 - 1) * 100 - 0.435) * 100) / 100);
  assert.equal(o.rClose, Math.round(((49.9 / 50.6 - 1) * 100 - 0.435) * 100) / 100);
  assert.equal(o.mfe, Math.round((51.2 / 50.6 - 1) * 10000) / 100);
  // 空方：賣 50.4（滑價 1 檔）；5 分鐘後以 51 + 0.1 = 51.1 買回 → 虧損；收盤 50 + 0.05（50 的跳動單位）買回 → 獲利
  const sh = evaluateSignal({ m: 575, price: 50.5, side: 'short' }, bars, tw, DT_DEFAULTS.costs);
  assert.equal(sh.r5, Math.round((-(51.1 / 50.4 - 1) * 100 - 0.435) * 100) / 100);
  assert.equal(sh.rClose, Math.round((-(50.1 / 50.4 - 1) * 100 - 0.435) * 100) / 100);
  assert.deepEqual([sh.mfe, sh.mae], [Math.round(-(50.4 / 50.4 - 1) * 10000) / 100, Math.round(-(51.2 / 50.4 - 1) * 10000) / 100], 'favourable is down for a short');
  assert.equal(evaluateSignal({ m: 575, price: 50.5, purpose: 'risk' }, bars, tw, DT_DEFAULTS.costs), null, 'v2 risk alerts are not entries');
  const v3 = (type, side, outcome, market) => ({ type, side, version: 3, outcome, market });
  const tail = { index: 'twse', chg: 0.5, r15: 0.1, vsAvg: 0.2, rs15: 0.3 };
  const stats = reviewStats([{ date, signals: [v3('dt-ma-up', 'long', o, tail), v3('dt-ma-up', 'long', { ...o, r15: 1 }, tail), v3('dt-ma-down', 'short', sh, tail), { type: 'dt-breakout', version: 2, purpose: 'opportunity', outcome: o }, { type: 'dt-breakout', outcome: o }, { type: 'dt-risk', version: 2, purpose: 'risk', outcome: { r15: 99 } }] }]);
  const up = stats.types.find(x => x.type === 'dt-ma-up');
  assert.deepEqual([stats.signals, up.n, up.win15, up.side, up.title, stats.types.map(x => x.version)], [5, 2, 50, 'long', '突破 20MA（多方）', [3, 3, 2, 1]]);
  assert.equal(regimeOf(tail), 'tailwind'); assert.equal(up.regimes.tailwind.n, 2);
  assert.deepEqual([stats.market.signals, stats.market.regimes.find(x => x.key === 'tailwind').n], [3, 2], 'market groups count long signals only');
});

test('Fugle stream events: trades, books, candles and aggregates', () => {
  const ev = streamEvent({ event: 'data', channel: 'trades', data: { symbol: '2330', price: 568, size: 4778, volume: 54538, bid: 567, ask: 568, serial: 6652422, time: 1685338200000000, isClose: true } });
  assert.deepEqual([ev.kind, ev.id, ev.time, ev.price, ev.size, ev.volume, ev.serial, ev.key], ['trade', '2330', 1685338200000, 568, 4778, 54538, 6652422, undefined]);
  const b = streamEvent({ event: 'data', channel: 'books', data: { symbol: '2330', bids: [{ price: 567, size: 87 }], asks: [{ price: 568, size: 800 }], time: 1685338200000000 } });
  assert.deepEqual([b.kind, b.key, b.bids[0].size, b.asks[0].price], ['book', 'b:2330', 87, 568]);
  const c = streamEvent({ event: 'data', channel: 'candles', data: { symbol: '2330', date: '2023-05-29T13:30:00.000+08:00', open: 568, high: 568, low: 568, close: 568, volume: 4778, average: 566.69 } });
  assert.deepEqual([c.kind, c.time, c.volume], ['candle', Date.parse('2023-05-29T05:30:00Z'), 4778]);
  assert.equal(streamEvent({ event: 'heartbeat', data: { time: 1 } }), null);
  const g = streamEvent({ event: 'data', channel: 'aggregates', data: { date: '2026-10-08', symbol: '2330', closePrice: 1460, change: 10, bids: [{ price: 1455, size: 1 }], total: { tradeVolume: 10, tradeValue: 14600000 }, lastUpdated: Date.UTC(2026, 9, 8, 2) * 1000 } }, { tz: 'Asia/Taipei', lot: 1000 });
  assert.deepEqual([g.kind, g.row.close, g.book.bids[0].price], ['agg', 1460, 1455]);
  assert.deepEqual([planOf({ tier: 'free' }, 'advanced'), planOf({ tier: 'paid' }, 'auto'), planOf({ tier: 'paid' }, 'advanced')], ['basic', 'developer', 'advanced']);
  assert.deepEqual(fugle.stream.channels.full, ['trades', 'candles', 'books']);
});

test('stream pool: symbols split into fixed groups, every channel subscribed on each connection', () => {
  const socks = [], states = [];
  class Sock extends EventTarget { constructor(url) { super(); this.sent = []; socks.push(this); } send(s) { this.sent.push(JSON.parse(s)); } close() { } emit(type, data) { this.dispatchEvent(data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) })); } }
  const ids = Array.from({ length: 281 }, (_, i) => String(1101 + i)), groups = splitSymbols(ids.slice().reverse(), 2).map(symbols => ({ symbols, channels: fugle.stream.channels.full }));
  assert.deepEqual(groups.map(g => g.symbols.length), [141, 140]);
  assert.equal(groups[0].symbols[0], '1101', 'sorted, so restarts give the same groups');
  const timers = { setTimeout: () => 0, clearTimeout() { }, setInterval: () => 0, clearInterval() { } };
  const pool = createStreamPool({ spec: fugle.stream, key: 'k', market: tw, groups, onEvents() { }, onStatus: s => states.push(s), connect: u => new Sock(u), timers });
  assert.equal(socks.length, 2);
  for (const s of socks) { s.emit('open'); s.emit('message', { event: 'authenticated' }); }
  const subs = socks.flatMap(s => s.sent.filter(m => m.event === 'subscribe'));
  assert.deepEqual(['trades', 'candles', 'books'].map(ch => subs.filter(m => m.data.channel === ch).reduce((a, m) => a + m.data.symbols.length, 0)), [281, 281, 281]);
  for (const s of socks) for (const m of s.sent.filter(x => x.event === 'subscribe')) s.emit('message', { event: 'subscribed', data: m.data.symbols.map(symbol => ({ symbol, channel: m.data.channel })) });
  const last = states.at(-1);
  assert.deepEqual([last.connected, last.expected, last.subscribed, last.connections.length], [true, 843, 843, 2]);
  pool.update([{ symbols: ids, channels: ['aggregates'] }]);
  assert.equal(pool.size, 1);
});

test('FinMind pre-market data: eligible list, ongoing suspensions, sell-first bans and reference prices', () => {
  const p = parseDayTradePrep({
    list: [{ date, stock_id: '2330', BuyAfterSale: 'Y' }, { date, stock_id: '2317', BuyAfterSale: '＊' }, { date: '2026-10-06', stock_id: '9999' }],
    suspended: [{ date: '2026-10-05', stock_id: '1234', resumption_date: '' }, { date: '2026-10-01', stock_id: '5678', resumption_date: '2026-10-03' }],
    sellFirst: [{ date: '2026-10-06', stock_id: '2317', end_date: '2026-10-09' }],
    limits: [{ date, stock_id: '2330', reference_price: 1450, limit_up: 1595, limit_down: 1305 }],
  }, date);
  assert.deepEqual([p.eligible, p.suspended, p.sellFirstOff, p.ref], [['2330', '2317'], ['1234'], ['2317'], { 2330: 1450 }]);
  assert.equal(parseDayTradePrep({ list: [] }, date).eligible, null, 'unknown when the list is not out yet');
});
