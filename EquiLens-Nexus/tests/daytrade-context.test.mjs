// 當沖監控的 5 分 K 工具：1 分 K 彙整、歷史整理、20MA 交叉、開盤低點；富果歷史分 K；歷史載入器
import test from 'node:test';
import assert from 'node:assert/strict';
import { fiveMinuteBars, prepareHistory, maState, openLowState, validBar, contextDate, HISTORY_BARS } from '../lib/daytrade-context.mjs';
import { createDayTrade, DT_DEFAULTS } from '../lib/daytrade.mjs';
import fugle from '../lib/providers/fugle.mjs';
import { marketProfile } from '../lib/markets.mjs';
import { createHistoryLoader } from '../lib/daytrade-history.mjs';

const date = '2026-10-14', prev = '2026-10-13', market = marketProfile('TW');
const at = (t, d = date) => Date.parse(`${d}T${t}+08:00`);
const min = (hm, c, { o = c, h = Math.max(o, c), l = Math.min(o, c), v = 10, d = date } = {}) => ({ time: at(`${hm}:00`, d), o, h, l, c, v });
const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// 一整天的 1 分 K（09:00–13:24 每分鐘一根，加上 13:30 收盤集合競價）
const session = (d, px, close = px) => [...Array.from({ length: 265 }, (_, i) => min(hm(540 + i), px, { d })), min('13:30', close, { d, v: 500 })];
const closes = xs => xs.map(c => ({ c }));

test('5-minute bars start at 09:00; missing minutes are not filled, empty intervals have no bar, unfinished intervals are left out', () => {
  const rows = [min('09:00', 50, { o: 49.9, l: 49.8 }), min('09:01', 50.2), min('09:04', 50.1, { h: 50.4 }), min('09:05', 50.3), min('09:17', 50.6), min('08:59', 99), { ...min('09:02', 50), h: 1 }, min('09:00', 50, { o: 49.9, l: 49.8 })];
  const bars = fiveMinuteBars(rows);
  assert.deepEqual(bars.map(b => [hm((b.time / 60000 + 480) % 1440), b.o, b.h, b.l, b.c, b.v]), [['09:00', 49.9, 50.4, 49.8, 50.1, 30], ['09:05', 50.3, 50.3, 50.3, 50.3, 10], ['09:15', 50.6, 50.6, 50.6, 50.6, 10]]);
  assert.equal(bars[0].end, at('09:05:00'));
  assert.deepEqual(fiveMinuteBars(rows, at('09:09:59')).length, 1, 'the 09:05 bar is not finished until 09:10');
  assert.deepEqual(fiveMinuteBars(rows, at('09:10:00')).length, 2);
  assert.equal(validBar({ o: 1, h: 2, l: 1, c: 2, v: 0 }), true); assert.equal(validBar({ o: 1, h: 0.5, l: 1, c: 2, v: 0 }), false);
});

test('the last bar is 13:25–13:30 and takes the closing auction, so its close is the day close', () => {
  const bars = fiveMinuteBars(session(date, 50, 51.5));
  assert.equal(bars.length, 54);
  const last = bars.at(-1);
  assert.deepEqual([last.time, last.end, last.c, last.v], [at('13:25:00'), at('13:30:00'), 51.5, 500]);
  assert.equal(fiveMinuteBars([min('13:31', 50)]).length, 0, 'after the close');
});

test('history keeps the most recent 5-minute bars before today; the previous close is known only when the closing bar exists', () => {
  const h = prepareHistory({ minutes: [...session('2026-10-12', 48), ...session(prev, 50, 50.5), ...session(date, 99)], source: 'fixture' }, date);
  assert.equal(h.five.length, HISTORY_BARS); assert.equal(contextDate(h.five.at(-1).time), prev);
  assert.deepEqual([h.rawClose, h.asOf, h.source], [50.5, prev, 'fixture']);
  assert.deepEqual(prepareHistory(h, date), h, 'already prepared history (the cache) passes through unchanged');
  const noAuction = prepareHistory({ minutes: session(prev, 50).slice(0, -1) }, date);
  assert.equal(noAuction.five.length, 53); assert.equal(noAuction.rawClose, null);
  assert.deepEqual(prepareHistory(null, date), { five: [], rawClose: null, asOf: null, source: null });
});

test('20MA cross needs 21 bars; equal to the average is not a cross', () => {
  const flat = Array(20).fill(50);
  assert.deepEqual(maState(closes(flat)).ma, 50); assert.equal(maState(closes(flat)).crossUp, false, '20 bars: no previous average yet');
  assert.equal(maState(closes(flat.slice(1))).ma, null);
  const up = maState(closes([...flat, 50.5]));
  assert.deepEqual([up.count, up.close, up.ma, up.prevClose, up.prevMa, up.above, up.crossUp, up.crossDown], [21, 50.5, 50.025, 50, 50, true, true, false]);
  const down = maState(closes([...flat, 49.5]));
  assert.deepEqual([down.below, down.crossUp, down.crossDown], [true, false, true]);
  assert.deepEqual([maState(closes([...flat, 50.5, 50.6])).crossUp, maState(closes([...flat, 50.5, 50.6])).above], [false, true], 'already above: no new cross');
  const same = maState(closes([...flat, 50]));
  assert.deepEqual([same.above, same.below, same.crossUp, same.crossDown], [false, false, false, false]);
});

test('opening low is the low of the first 5-minute bar of the day; a break needs a close below it after a close at or above it', () => {
  const b = (l, c) => ({ l, c });
  assert.deepEqual(openLowState([]), { low: null, below: null, broke: false });
  assert.deepEqual(openLowState([b(49.8, 50)]), { low: 49.8, below: false, broke: false }, 'the opening bar itself cannot break its own low');
  assert.deepEqual(openLowState([b(49.8, 50), b(49.5, 49.8)]), { low: 49.8, below: false, broke: false }, 'equal is not a break');
  assert.deepEqual(openLowState([b(49.8, 50), b(49.5, 49.7)]), { low: 49.8, below: true, broke: true });
  assert.deepEqual(openLowState([b(49.8, 50), b(49.5, 49.7), b(49.4, 49.6)]), { low: 49.8, below: true, broke: false }, 'still below: not a new break');
  assert.equal(openLowState([b(49.8, 50), b(49.5, 49.7), b(49.6, 49.9), b(49.3, 49.4)]).broke, true, 'breaks again after recovering');
});

test('Fugle history: one 1-minute request per stock, keeping the last three sessions before today', async () => {
  const original = globalThis.fetch, calls = [];
  const days = ['2026-10-07', '2026-10-08', '2026-10-12', prev, date];
  globalThis.fetch = async url => { calls.push(new URL(url)); return Response.json({ data: days.flatMap(d => [{ date: `${d}T09:00:00.000+08:00`, open: 50, high: 51, low: 49, close: 50, volume: 12 }, { date: `${d}T13:30:00.000+08:00`, open: 50.5, high: 50.5, low: 50.5, close: 50.5, volume: 300 }]) }); };
  try {
    const h = await fugle.streamHistory('2330', date, { key: 'fixture', interval: 0, historyInterval: 0 });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].searchParams.get('timeframe'), calls[0].searchParams.get('from'), calls[0].searchParams.get('to')], ['1', '2026-09-30', prev]);
    assert.deepEqual([...new Set(h.minutes.map(m => contextDate(m.time)))], ['2026-10-08', '2026-10-12', prev], 'today and older sessions are dropped');
    assert.deepEqual([h.minutes[0].o, h.minutes[0].v, h.source], [50, 12, 'fugle']);
    assert.equal(prepareHistory(h, date).rawClose, 50.5);
  } finally { globalThis.fetch = original; }
});

test('Fugle historical API: 429 waits for Retry-After and retries instead of failing every stock', async () => {
  const original = globalThis.fetch; let n = 0;
  globalThis.fetch = async () => (++n === 1 ? new Response(JSON.stringify({ statusCode: 429, message: 'Rate limit exceeded' }), { status: 429, headers: { 'retry-after': '0.01' } }) : Response.json({ data: [] }));
  try {
    const h = await fugle.streamHistory('2330', date, { key: 'fixture', interval: 0, historyInterval: 0 });
    assert.equal(n, 2, 'retried once'); assert.deepEqual(h.minutes, []);
  } finally { globalThis.fetch = original; }
});

const engine = () => createDayTrade({ market, date, ids: ['2330'], scan: new Set(['2330']), settings: DT_DEFAULTS });
const raw = { minutes: session(prev, 50), source: 'fixture' };
test('history loader stores prepared 5-minute bars, retries errors after 10 minutes; a reset cannot populate another engine', async () => {
  let calls = 0, clock = 0; const files = new Map(), e = engine();
  const loader = createHistoryLoader({ read: k => files.get(k), write: (k, v) => files.set(k, v), now: () => clock, fetchHistory: async () => { if (!calls++) throw new Error('offline'); return raw; } });
  const args = { ids: ['2330'], date, source: 'fixture', engine: e };
  await loader.load(args); assert.equal(loader.status(['2330'])[0].status, 'error');
  await loader.load(args); assert.equal(calls, 1);
  clock = 600001; await loader.load(args); assert.equal(e.historyReady('2330'), true); assert.equal(loader.status(['2330'])[0].status, 'ready');
  const saved = files.get('daytrade-history/2330.json');
  assert.deepEqual([saved.version, saved.date, saved.value.five.length, saved.value.minutes], [3, date, 54, undefined], 'only the 5-minute bars are cached');
  loader.reset(); const other = engine(); await loader.load({ ...args, engine: other }); assert.equal(calls, 2, 'served from the cache'); assert.equal(other.historyReady('2330'), true);
  let release; const pending = createHistoryLoader({ read: () => null, write() { throw Error('should not write'); }, fetchHistory: () => new Promise(r => { release = r; }) });
  const work = pending.load(args); pending.reset(); release(raw); await work; assert.equal(pending.status(['2330'])[0].status, 'pending');
});

test('history loader caches thin history for the day instead of refetching every 10 minutes; older cache versions are refetched', async () => {
  let calls = 0, clock = 0; const files = new Map(), e = engine();
  const thin = { minutes: [min('09:00', 50, { d: prev }), min('10:00', 50, { d: prev })], source: 'fixture' }; // 成交稀疏：只有 2 根
  const make = () => createHistoryLoader({ read: k => files.get(k), write: (k, v) => files.set(k, v), now: () => clock, fetchHistory: async () => { calls++; return thin; } });
  const loader = make(), args = { ids: ['2330'], date, source: 'fixture', engine: e };
  await loader.load(args); assert.equal(loader.status(['2330'])[0].status, 'incomplete'); assert.equal(files.size, 1);
  clock = 3600e3; await loader.load(args); assert.equal(calls, 1, 'not refetched');
  await make().load({ ...args, engine: engine() }); assert.equal(calls, 1, 'cache used after a restart');
  files.set('daytrade-history/2330.json', { version: 2, date, source: 'fixture', value: { daily: [], minutes: [] } });
  await make().load({ ...args, engine: engine() }); assert.equal(calls, 2, 'the v2 cache (30-day history) is not reused');
});
