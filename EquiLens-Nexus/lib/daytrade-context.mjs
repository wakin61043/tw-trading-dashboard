// 當沖監控的 5 分 K 工具（台股現股時段）。時間戳一律是區間「起始」的毫秒；不補造 K 棒：整個區間沒有成交就沒有這根。
const MIN = 60000, OFFSET = 8 * 3600000, OPEN = 540, LAST = 805, CLOSE = 810; // 09:00、最後一根 13:25、收盤 13:30
export const MA_PERIOD = 20;                 // 5 分 K 均線期數
export const HISTORY_BARS = 80;              // 每檔保留幾根歷史 5 分 K（20MA 只需要前一個交易日尾端）
export const contextDate = time => new Date(time + OFFSET).toISOString().slice(0, 10);
const minute = time => Math.floor((time + OFFSET) / MIN) % 1440;
const finite = x => typeof x === 'number' && Number.isFinite(x);
export const validBar = b => b && [b.o, b.h, b.l, b.c, b.v].every(finite) && b.l > 0 && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c) && b.v >= 0;

// 1 分 K → 5 分 K：09:00 起每 5 分鐘一根，與一般看盤軟體相同。
// 最後一根是 13:25–13:30，收盤集合競價（13:30）的成交併入這一根，所以它的收盤價就是當日收盤價。
// 區間內有成交的分鐘才計入，缺分鐘不補。now：只回傳已走完的區間（結束時間 ≤ now）。
export function fiveMinuteBars(rows, now = Infinity) {
  const unique = new Map();
  for (const b of rows || []) if (validBar(b) && finite(b.time) && b.time % MIN === 0) unique.set(b.time, b);
  const buckets = new Map();
  for (const b of [...unique.values()].sort((a, b) => a.time - b.time)) {
    const m = minute(b.time); if (m < OPEN || m > CLOSE) continue;
    const start = b.time - (m >= LAST ? m - LAST : (m - OPEN) % 5) * MIN;
    if (start + 5 * MIN > now) continue;
    const xs = buckets.get(start) || []; xs.push(b); buckets.set(start, xs);
  }
  return [...buckets].map(([time, xs]) => ({ time, end: time + 5 * MIN, o: xs[0].o, h: Math.max(...xs.map(b => b.h)), l: Math.min(...xs.map(b => b.l)), c: xs.at(-1).c, v: xs.reduce((a, b) => a + b.v, 0) }));
}

// 歷史資料（今天以前）整理成 5 分 K：input 可以是資料源回傳的 1 分 K（{ minutes }），或已整理好的 { five }（快取）。
// rawClose：前一交易日收盤價，用來判斷今天是否除權息；只有最後一根是 13:25–13:30（含收盤集合競價）時才可信，否則為 null。
export function prepareHistory(input, date) {
  const before = b => finite(b?.time) && contextDate(b.time) < date;
  const five = (Array.isArray(input?.five) ? input.five.filter(b => before(b) && validBar(b) && finite(b.end)) : fiveMinuteBars((input?.minutes || []).filter(before)))
    .sort((a, b) => a.time - b.time).slice(-HISTORY_BARS);
  const last = five.at(-1);
  return { five, rawClose: last && minute(last.time) === LAST ? last.c : null, asOf: last ? contextDate(last.time) : null, source: input?.source || null };
}

const sma = (bars, n) => bars.length >= n ? bars.slice(-n).reduce((a, b) => a + b.c, 0) / n : null;
// 最新一根完成的 5 分 K 與 20MA 的關係。bars 由舊到新（歷史＋今天已完成的 5 分 K，跨日連續計算）。
// 突破：前一根收盤 ≤ 當時的 20MA，這一根收盤 > 20MA；跌破相反。均線不足 20 根（交叉需 21 根）時不判斷。
export function maState(bars, n = MA_PERIOD) {
  const b = bars.at(-1), prev = bars.at(-2), ma = sma(bars, n), prevMa = sma(bars.slice(0, -1), n);
  const ok = ma != null && prevMa != null;
  return { count: bars.length, close: b?.c ?? null, ma, prevClose: prev?.c ?? null, prevMa, above: ma == null ? null : b.c > ma, below: ma == null ? null : b.c < ma,
    crossUp: ok && prev.c <= prevMa && b.c > ma, crossDown: ok && prev.c >= prevMa && b.c < ma };
}

// 開盤低點：當日第一根 5 分 K（09:00–09:05；該區間沒有成交時取當日第一根有成交的 5 分 K）的最低價。
// 跌破：前一根當日 5 分 K 收盤 ≥ 開盤低點，這一根收盤 < 開盤低點。today：當日已完成的 5 分 K（由舊到新）。
export function openLowState(today) {
  const first = today[0], b = today.at(-1), prev = today.at(-2);
  if (!first) return { low: null, below: null, broke: false };
  return { low: first.l, below: today.length > 1 ? b.c < first.l : false, broke: today.length > 1 && prev.c >= first.l && b.c < first.l };
}
