// 截圖與商店版 App 示意模式共用的示意資料：當沖觀察名單（盤中才有內容）與大盤分時走勢（示意資料沒有指數分時資料）
// st：Nexus /api/state 的股票（Map：代號 → 股票），價格取自示意資料；20MA 與開盤低點依現價推算
export function dayTradeScan(st) {
  const r2 = v => Math.round(v * 100) / 100, TITLE = { 'dt-ma-up': '突破 20MA（多方）', 'dt-ma-down': '跌破 20MA（空方）', 'dt-open-low': '跌破開盤低點（空方）' };
  // dist：現價與 20MA 的距離（%）；turnover：前一日周轉率（高周轉率名單才有）；last：最近訊號
  const item = (id, name, dist, turnover, last, belowOpen = false) => { const s = st.get(id); if (!(s?.price > 0)) return null; const price = s.price, ma20 = r2(price / (1 + dist / 100)), openLow = r2(price * (belowOpen ? 1.006 : 0.985));
    return { id, name, watch: false, scan: true, turnover, grouped: true, price, change: s.change, vwap: r2(price * 0.992), five: { end: '10:35', close: price, ma20, dist, above: dist > 0, bars: 61, openLow, belowOpen }, filters: [], pending: false, reasons: [], last, at: '10:36:12' }; };
  const top = [
    item('3017', '奇鋐', 0.42, 6.85, { type: 'dt-ma-up', side: 'long', t: '10:35:03' }),
    item('2609', '陽明', -0.61, 4.12, { type: 'dt-open-low', side: 'short', t: '10:35:03' }, true),
    item('6669', '緯穎', 0.88, null, { type: 'dt-ma-up', side: 'long', t: '10:20:03' }),
    item('1519', '華城', -0.37, 5.4, { type: 'dt-ma-down', side: 'short', t: '10:10:03' }),
    item('2368', '金像電', 0.06, 3.96, null),
    item('3037', '欣興', -0.12, null, null),
    item('2382', '廣達', 0.31, null, null),
  ].filter(Boolean);
  const sig = (x, type, t) => ({ type, side: type === 'dt-ma-up' ? 'long' : 'short', id: x.id, name: x.name, t, price: x.price, turnover: x.turnover,
    detail: type === 'dt-open-low' ? `5 分 K 收 ${x.price}，跌破開盤低點 ${x.five.openLow}` : `5 分 K 收 ${x.price}，${type === 'dt-ma-up' ? '站上' : '跌破'} 20MA ${x.five.ma20}`, title: TITLE[type], bar: { close: x.price, ma20: x.five.ma20, openLow: x.five.openLow } });
  const by = Object.fromEntries(top.map(x => [x.id, x])), signals = [['3017', 'dt-ma-up', '10:35:03'], ['2609', 'dt-open-low', '10:35:03'], ['2609', 'dt-ma-down', '10:25:03'], ['6669', 'dt-ma-up', '10:20:03'], ['1519', 'dt-ma-down', '10:10:03'], ['2368', 'dt-ma-up', '09:40:03']].filter(([id]) => by[id]).map(([id, type, t]) => sig(by[id], type, t));
  return {
    phaseName: '掃描中', market: { twse: { chg: 0.62, r15: 0.18, avg: 23102.3, vsAvg: 0.21, up: 612, down: 301, regime: 'tailwind', stale: false }, tpex: { chg: 0.48, r15: -0.06, avg: 261.4, vsAvg: 0.12, up: 455, down: 330, regime: 'neutral', stale: false } },
    feed: { window: true, connected: true, mode: 'full', subscribed: 279, expected: 279, connections: [1, 2] }, plan: 'advanced', plans: { advanced: { limit: 2000 } },
    prep: { eligible: 1612, disposition: 14, suspended: 3, sellFirstOff: 22, ref: 1980, turnover: { date: '2026-10-15', sharesDate: '2026-10-09', ranked: 500, picked: 50, minRate: 3.12 }, errors: [] },
    sources: { total: 93, subscribed: 93, turnover: 50, groups: 43, watchlist: 0 }, history: { total: 93, ready: 91, short: 2, errors: [] },
    counts: { long: 52, short: 36, waiting: 5 }, excluded: { disposition: 2 }, marketChange: 1.12, total: 93, listed: 93, top, signals, signalCount: 18,
  };
}
// 大盤分時：從昨收平滑走到收盤價，量在開收盤較大
export function indexMinutes(ref, last) {
  const m = [], c = [], v = [];
  for (let t = 540; t <= 810; t++) { const k = (t - 540) / 270; m.push(t); c.push(Math.round((ref + (last - ref) * k + Math.sin(t / 9) * ref * .0012 + Math.sin(t / 37) * ref * .002) * 100) / 100); v.push(t < 560 || t > 790 ? 30 + t % 9 : 6 + t % 5); }
  c[c.length - 1] = last; return { m, c, v, vwap: m.map(() => null), group: m.map(() => null) };
}
