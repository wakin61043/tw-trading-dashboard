// 示意資料第二部分：族群排名、法人／期權、分點追蹤、大戶、AI 日報、雷達、當沖、話題、自訂提醒（全部是合成數字）
import fs from 'node:fs';
import path from 'node:path';
const DIR = process.env.EQUITY_DATA_DIR, NEX = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { loadDay } = await import(NEX + '/lib/replay.mjs');
const { buildGroupRanking, quotesFromReplay, compareRanks, RANK_RULES } = await import(NEX + '/lib/grouprank.mjs');
const { buildFlows } = await import(NEX + '/lib/flows.mjs');
const { branchDay, CHIP_DEFAULTS } = await import(NEX + '/lib/chipwatch.mjs');
const { warrantMaster, branchWarrants, turnoverByTarget } = await import(NEX + '/lib/warrants.mjs');
const { aggregateBrokers, holderSignal } = await import(NEX + '/lib/insight.mjs');
const R = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const W = (f, v) => { fs.mkdirSync(path.dirname(path.join(DIR, f)), { recursive: true }); fs.writeFileSync(path.join(DIR, f), JSON.stringify(v)); };
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const universe = R('universe.json'), groups = R('groups.json').groups, meta = R('demo-meta.json'), LAST = meta.last, PREV = meta.prev;
const watch = new Set(R('watchlist.json')), research = new Set(groups.flatMap(g => g.stockIds)), name = new Map(universe.map(s => [s.id, s.name]));
const stock = id => { try { return R(`stocks/${id}.json`); } catch { return null; } };
const heat = R(`heatmap-${LAST}.json`), heatById = new Map(heat.sectors.flatMap(s => s.stocks).map(s => [s.id, s]));

// 族群排名：前一日也建一份，才有名次變動
const day = loadDay(LAST), gm = new Map(universe.map(s => [s.id, { name: s.name }]));
const q = quotesFromReplay(day, gm), ranked = buildGroupRanking(groups, q);
const prevRank = { date: PREV, groups: ranked.map((g, i) => ({ ...g, rank: ((i * 3 + 2) % ranked.length) + 1 })) };
W(`grouprank-${PREV}.json`, { date: PREV, source: 'close', asOf: '13:30', builtAt: new Date().toISOString(), stocks: research.size, quoted: research.size, rules: RANK_RULES, compare: null, groups: prevRank.groups });
W(`grouprank-${LAST}.json`, { date: LAST, source: 'close', asOf: '13:30', builtAt: new Date().toISOString(), stocks: research.size, quoted: research.size, rules: RANK_RULES, compare: { date: PREV }, groups: compareRanks(ranked, prevRank) });

// 法人／期權：用 FinMind 的欄位格式產生原始資料，再交給 buildFlows
const info = universe.map(s => ({ stock_id: s.id, stock_name: s.name, industry_category: s.sector, type: s.market === '上櫃' ? 'tpex' : 'twse', date: '2026-10-01' }));
const stocks = [];
for (const s of universe) {
  const h = heatById.get(s.id); if (!h) continue; const lots = h.volume || 1000, tilt = (h.change || 0) / 4;
  for (const [n, k] of [['Foreign_Investor', 0.18], ['Investment_Trust', 0.05], ['Dealer_self', 0.02], ['Dealer_Hedging', 0.03]]) { const net = Math.round(lots * k * (tilt + (rnd() - 0.5) * 1.6) * 1000), base = Math.round(lots * k * 1000); stocks.push({ date: LAST, stock_id: s.id, name: n, buy: base + Math.max(0, net), sell: base + Math.max(0, -net) }); }
}
const total = [['Foreign_Investor', 18.6e9], ['Foreign_Dealer_Self', 0], ['Investment_Trust', 3.1e9], ['Dealer_self', -0.8e9], ['Dealer_Hedging', 1.2e9]].map(([n, v]) => ({ date: LAST, name: n, buy: 180e9 + Math.max(0, v), sell: 180e9 + Math.max(0, -v) }));
total.push({ date: LAST, name: 'total', buy: 900e9 + 22.1e9, sell: 900e9 });
const fdays = []; for (let d = Date.parse(LAST + 'T00:00:00Z'), n = 0; n < 30; d -= 864e5) { const x = new Date(d); if (x.getUTCDay() % 6) { fdays.unshift(x.toISOString().slice(0, 10)); n++; } }
const futures = fdays.map((d, i) => ({ date: d, futures_id: 'TX', institutional_investors: '外資', long_open_interest_balance_volume: 21000 + i * 120, short_open_interest_balance_volume: 48000 - i * 260 }));
const options = fdays.slice(-10).flatMap((d, i) => ['外資', '自營商'].flatMap(inv => ['買權', '賣權'].map(side => ({ date: d, option_id: 'TXO', institutional_investors: inv, call_put: side, long_open_interest_balance_volume: 30000 + i * 400 + (side === '買權' ? 6000 : 0), short_open_interest_balance_volume: 28000 + (inv === '外資' ? 2500 : 0) }))));
const optionDaily = [];
for (const d of fdays.slice(-2)) for (let k = 21800; k <= 24600; k += 200) for (const cp of ['call', 'put']) optionDaily.push({ date: d, option_id: 'TXO', contract_date: '202610', strike_price: k, call_put: cp, trading_session: 'position', open_interest: Math.round((cp === 'call' ? 9000 * Math.exp(-(((k - 24000) / 600) ** 2)) : 11000 * Math.exp(-(((k - 22400) / 500) ** 2))) + 300 + (d === LAST ? 200 : 0)) });
W(`flows-${LAST}.json`, buildFlows(LAST, { info, stocks, total, futures, options, optionDaily }));

// 認購權證（示意）：熱門標的各 10–16 檔，發行商、履約價、行使比例、到期日、收盤與成交金額
const ISSUERS = ['凱基', '元大', '富邦', '群益', '統一', '元富', '永豐', '國泰'], short = n => n.replace(/-KY$|\*/g, '').slice(0, 3);
const wRows = [], wQuotes = {}; let wn = 30000;
for (const [tid, n, hot] of [['3017', 16, 6], ['3324', 12, 5], ['2421', 10, 4], ['6669', 14, 3], ['2330', 16, 3], ['2382', 12, 2], ['2368', 10, 2], ['1519', 10, 1]]) {
  const sClose = heatById.get(tid)?.close || 100;
  for (let k = 0; k < n; k++) {
    const id = String(++wn).padStart(6, '0'), issuer = ISSUERS[k % ISSUERS.length], strike = Math.round(sClose * (0.85 + rnd() * 0.45)), ratio = [0.02, 0.025, 0.04, 0.05, 0.1][k % 5], end = `2027-0${1 + (k % 8)}-1${k % 9}`;
    const days = (Date.parse(end) - Date.parse(LAST)) / 864e5, intrinsic = Math.max(0, sClose - strike) * ratio, close = Math.round((intrinsic + sClose * ratio * 0.12 * Math.sqrt(days / 365)) * 100) / 100;
    const value = Math.round((k < 4 ? hot * 4e6 : hot * 3e5) * (0.4 + rnd()));
    wRows.push({ stock_id: id, date: '2026-04-01', target_stock_id: tid, type: '認購', end_date: end, exercise_ratio: ratio, fulfillment_price: strike });
    wQuotes[id] = [`${short(name.get(tid))}${issuer}5${'ABC'[k % 3]}購${String(k + 1).padStart(2, '0')}`, close, Math.round(value / close), value];
  }
}
const wMaster = warrantMaster(wRows), wTurn = turnoverByTarget(wQuotes, wMaster, LAST);
W('warrants/master.json', { date: LAST, at: Date.now(), count: Object.keys(wMaster).length, m: wMaster });
W(`warrants/quotes-${LAST}.json`, { date: LAST, at: Date.now(), q: wQuotes, sources: { twse: Object.keys(wQuotes).length, tpex: 0 }, errors: [], complete: true });
for (const tid of new Set(wRows.map(r => r.target_stock_id))) W(`warrants/by-${tid}.json`, { date: LAST, at: Date.now(), rows: wRows.filter(r => r.target_stock_id === tid) });
const wTop = Object.entries(wQuotes).filter(([id]) => wMaster[id][0][0] === '3017').sort((a, b) => b[1][3] - a[1][3])[0][0];
W(`warrants/br-${wTop}-${LAST}.json`, aggregateBrokers([['9268', '凱基台北', 820], ['1650', '新加坡商瑞銀', 310], ['9A00', '永豐金', 120], ['9800', '元大', -540], ['9600', '富邦', -260], ['8440', '摩根大通', -90]].map(([sid, nm, lots]) => ({ securities_trader_id: sid, securities_trader: nm, price: wQuotes[wTop][1], buy: Math.max(0, lots) * 1000, sell: Math.max(0, -lots) * 1000 }))));
// 個股診斷用的主力分點（近 5 日）與大戶持股快取
for (const d of fdays.slice(-5)) W(`brokers/3017-${d}.json`, aggregateBrokers(['9268 凱基台北', '1650 新加坡商瑞銀', '8440 摩根大通', '9800 元大', '9600 富邦', '9A00 永豐金', '5920 元富', '9200 凱基', '1360 港商麥格理', '1440 美林'].map((x, i) => { const [sid, nm] = x.split(' '), lots = Math.round((i < 4 ? 1 : -1) * (80 + rnd() * 400)); return { securities_trader_id: sid, securities_trader: nm, price: heatById.get('3017').close * (0.98 + rnd() * 0.03), buy: Math.max(0, lots) * 1000, sell: Math.max(0, -lots) * 1000 }; })));
{ const wk = []; for (let d = Date.parse(LAST + 'T00:00:00Z'); wk.length < 12; d -= 7 * 864e5) wk.unshift(new Date(d).toISOString().slice(0, 10)); const series = wk.map((d, i) => ({ date: d, big1000: Math.round((61 + i * 0.22) * 100) / 100, big400: Math.round((68 + i * 0.2) * 100) / 100, small: Math.round((18 - i * 0.15) * 100) / 100, people: Math.round(64000 - i * 600) })); W('holders/3017.json', { at: Date.now(), data: { series, signal: holderSignal(series) } }); }

// 分點追蹤：兩個追蹤分點、最近 5 日
const branches = [{ id: '9268', name: '凱基台北' }, { id: '1650', name: '新加坡商瑞銀' }, { id: '8440', name: '摩根大通' }];
const bdays = fdays.slice(-5), history = { };
const vols = Object.fromEntries([...heatById.values()].map(s => [s.id, (s.volume || 0) * 1000]));
const shares = Object.fromEntries(universe.map(s => [s.id, Math.round(2e10 / (heatById.get(s.id)?.close || 100))]));
for (const d of bdays) {
  const doc = { date: d, builtAt: `${d}T10:31:00.000Z`, rules: { dayPct: 10, minAmount: 1e7, accumPct: 0.3, accumDays: 5 }, volumeSource: 'heatmap', sharesDate: '2026-10-16', branches: [],
    warrantRules: { amount: 5e6, pct: 10, days: 3 }, warrantInfo: { masterDate: LAST, stale: false, quotes: { twse: Object.keys(wQuotes).length, tpex: 0 }, turnover: true, error: '' } };
  for (const b of branches) {
    const rows = [];
    const picks = universe.filter(() => rnd() < 0.35).slice(0, 26);
    for (const s of picks) { const px = heatById.get(s.id)?.close || 100, big = ['3324', '2421', '3017'].includes(s.id) && b.id === '9268'; const lots = Math.round((big ? 900 + rnd() * 500 : 30 + rnd() * 400) * (rnd() < (big ? 0.95 : 0.55) ? 1 : -1)); rows.push({ date: d, stock_id: s.id, securities_trader: b.name, securities_trader_id: b.id, price: px, buy: Math.max(0, lots) * 1000 + Math.round(rnd() * 50) * 1000, sell: Math.max(0, -lots) * 1000 + Math.round(rnd() * 50) * 1000 }); }
    const h = (history[b.id] ||= []);
    doc.branches.push({ id: b.id, name: b.name, ...branchDay(rows, { meta: gm, watch, research, history: h, volumes: vols, shares, settings: CHIP_DEFAULTS }) });
    h.push(doc.branches.at(-1).nets);
    // 同一分點的認購權證：凱基台北連日大買散熱股的權證
    const wr = Object.entries(wQuotes).filter(() => rnd() < 0.3).map(([id, q]) => { const tid = wMaster[id][0][0], hotW = b.id === '9268' && ['3017', '3324'].includes(tid); const units = Math.round((hotW ? 1.2e6 + rnd() * 1.5e6 : 5e4 + rnd() * 6e5) * (rnd() < (hotW ? 0.95 : 0.55) ? 1 : -1)); return { stock_id: id, price: q[1], buy: Math.max(0, units), sell: Math.max(0, -units) }; });
    const wh = (history['w' + b.id] ||= []);
    doc.branches.at(-1).warrants = branchWarrants(wr, { date: d, branchName: b.name, master: wMaster, quotes: wQuotes, turnover: wTurn, meta: gm, watch, research, history: wh });
    wh.push(doc.branches.at(-1).warrants.nets);
  }
  W(`broker-watch/${d}.json`, doc);
}
// 大戶：每週五一份全市場股權分散表（最近 12 週）
const fridays = []; for (let d = Date.parse(LAST + 'T00:00:00Z'); fridays.length < 12; d -= 7 * 864e5) fridays.unshift(new Date(d).toISOString().slice(0, 10));
const hbase = Object.fromEntries(universe.map(s => [s.id, { b: 35 + rnd() * 45, p: Math.round(20000 + rnd() * 400000), trend: (research.has(s.id) ? 0.25 : 0) + (rnd() - 0.55) * 0.5 }]));
fridays.forEach((d, i) => W(`holders-all/${d}.json`, { date: d, at: Date.now(), s: Object.fromEntries(universe.map(s => { const h = hbase[s.id], b = Math.round((h.b + h.trend * i) * 100) / 100; return [s.id, [b, Math.round((b + 6) * 100) / 100, Math.round((100 - b - 20) * 100) / 100, Math.round(h.p * (1 - h.trend * i / 40)), shares[s.id]]]; })) }));

// AI 盤後日報（示意內容）
W(`reports/${LAST}.json`, { date: LAST, createdAt: `${LAST}T08:31:00.000Z`, provider: 'anthropic', model: 'demo', lang: 'zh-TW',
  headline: '散熱與 AI 伺服器領漲，加權收復 23,000 點、外資回補',
  summary: '加權指數上漲 182 點（+0.79%）收 23,187 點，成交金額放大；散熱族群雙鴻、建準漲停，AI 伺服器與 PCB 同步走強，航運與重電回檔。外資現貨買超 186 億元，台指期淨空單連續第 5 日減少。',
  sections: [
    { title: '盤勢與量能', points: ['加權指數 +0.79%，上漲 60 家、下跌 30 家，量增 66%。', '櫃買指數 +0.71%，中小型電子股表現優於權值股。'] },
    { title: '族群與資金', points: ['散熱族群量能加權漲幅 +7.9% 居首，雙鴻、建準漲停。', 'AI 伺服器 +3.3%，緯穎、鴻海成交金額居前。', '重電與航運各跌 2–3%，資金自防禦族群移出。'] },
    { title: '法人與期權', points: ['外資買超 186 億元、投信買超 31 億元。', '外資台指期淨空單減少約 400 口，選擇權 P/C 比升至 1.18。'] },
  ],
  watchlist: [],
  notes: [
    { id: '2330', name: '台積電', stance: '偏多', note: '收在月線之上，外資連 3 日買超；量能溫和。' },
    { id: '3017', name: '奇鋐', stance: '偏多', note: '族群領漲帶動放量突破前高，留意隔日追價力道。' },
    { id: '2382', name: '廣達', stance: '中性', note: '跟漲但量能未明顯放大，仍在區間上緣。' },
    { id: '1519', name: '華城', stance: '偏空', note: '跌破季線、投信連續賣超，短線結構轉弱。' },
  ],
  tomorrow: ['【大盤】加權量增站回 23,000 點，下一個觀察點為前高 23,400 點附近的量能是否延續。', '【法人籌碼】外資現貨連 3 日買超、期貨淨空單減少，偏多但未翻多。', '【期權】週選 22,400 點賣權未平倉最大，為短線支撐參考。', '【國際】今晚美國公布零售銷售與費城半導體成分股財報，留意美債殖利率反應。'],
  risks: ['漲勢集中在 AI 與散熱，族群輪動過快時易出現急漲急殺。', '融資餘額連續增加，留意槓桿過熱。'],
  card: { highlights: ['加權 +182 點收 23,187', '散熱族群漲 7.9% 居首', '外資買超 186 億元', '台指期外資淨空單減少', '航運、重電回檔 2–3%', '上漲 60 家、下跌 30 家'], watch: ['前高 23,400 點量能', '外資期貨淨空單變化', '週選 22,400 點支撐', '今晚美國零售銷售', '融資餘額增幅'] } });

// 異動雷達（含當沖、自訂提醒、分點追蹤、日報）
const A = (t, type, id, title, detail, extra = {}) => { const h = heatById.get(id); return { type, title, detail, stockId: id, name: id ? name.get(id) : '', close: h?.close ?? null, change: h?.change ?? null, t, watch: watch.has(id), level: watch.has(id) ? 'hi' : 'mid', ...extra }; };
const alerts = [
  A('09:05:12', 'volume', '3324', '爆量', '預估全日量為昨量 3.2 倍，成交金額 18.6 億'),
  A('09:18:40', 'surge-up', '2421', '急拉', '1 分鐘內上漲 2.4%'),
  A('09:31:05', 'limit-up', '3324', '觸及漲停', '漲停價 869.00'),
  A('09:40:03', 'dt-ma-up', '3017', '突破 20MA（多方）', '5 分 K 收 1,018，站上 20MA 1,012.4（前一根收 1,010，在均線 1,011.8 之下）', { side: 'long' }),
  A('10:05:33', 'custom', '2330', '自訂提醒', '台積電 站上 1,450（現價 1,455）'),
  A('10:12:47', 'surge-down', '2609', '急殺', '1 分鐘內下跌 2.1%'),
  A('10:25:03', 'dt-open-low', '2609', '跌破開盤低點（空方）', '5 分 K 收 71.2，跌破開盤低點 71.6', { side: 'short' }),
  A('10:58:21', 'limit-up', '2421', '觸及漲停', '漲停價 129.50'),
  A('11:20:02', 'pattern-entry', '2368', '型態進場', '杯柄突破條件進場價 360.0'),
  A('12:41:30', 'stop', '1519', '跌破防守', '跌破結構防守價 790'),
  { ...A('16:31:00', 'report', '', 'AI 盤後日報', '散熱與 AI 伺服器領漲，加權收復 23,000 點、外資回補'), date: LAST },
  { ...A('21:12:00', 'broker', '', '分點追蹤：凱基台北', `${LAST} · 單日主導：雙鴻 +1,206 張（占成交量 13.2%、10.48 億）`), date: LAST, branch: '9268' },
];
W(`alerts-${LAST}.json`, alerts.map((a, i) => ({ ...a, seq: 1760000000000 + i, at: `${LAST}T0${1 + Math.floor(i / 6)}:00:00.000Z` })));

// 當沖訊號紀錄（收盤檢討過）
const out = (r15, rClose = r15 / 2) => ({ r5: Math.round(r15 * 50) / 100, r15, r30: Math.round(r15 * 120) / 100, rClose, mfe: Math.round((Math.abs(r15) + 0.4) * 100) / 100, mae: Math.round((-0.3 - Math.max(0, -r15)) * 100) / 100, cost: 0.435 });
const mk = (r15, vsAvg, rs15) => ({ index: 'twse', chg: 0.6, r15, vsAvg, rs15, stock: { chg: 2, r15: r15 + rs15 }, rs: 1.4 });
const SIDE = { 'dt-ma-up': 'long', 'dt-ma-down': 'short', 'dt-open-low': 'short' };
const sig = (date, type, t, id, price, o, m) => ({ type, side: SIDE[type], version: 3, id, name: name.get(id), t, m: 600, price, outcome: o, market: m });
for (const [d, list] of [[PREV, [sig(PREV, 'dt-ma-up', '09:45:03', '2368', 352, out(0.62), mk(0.15, 0.1, 0.4)), sig(PREV, 'dt-ma-down', '10:30:03', '2382', 296, out(-0.48), mk(-0.4, -0.1, -0.2)), sig(PREV, 'dt-open-low', '11:05:03', '3037', 184, out(0.21), mk(0.05, 0.2, 0.3))]],
  [LAST, [sig(LAST, 'dt-ma-up', '09:40:03', '3017', 1018, out(1.35), mk(0.3, 0.2, 1.1)), sig(LAST, 'dt-ma-up', '10:20:03', '6669', 2745, out(0.44), mk(0.12, 0.15, 0.3)), sig(LAST, 'dt-ma-down', '10:10:03', '1519', 803, out(0.52), mk(-0.62, 0.05, -0.3)), sig(LAST, 'dt-open-low', '10:25:03', '2609', 71.2, out(-0.33), mk(0.1, 0.1, -0.5))]]])
  W(`daytrade/${d}.json`, { date: d, mode: 'full', plan: 'advanced', costs: { feeRate: 0.001425, feeDiscount: 0.28, taxRate: 0.0015, slipTicks: 1 }, closedAt: `${d}T05:40:00Z`, signals: list });

// 話題追蹤（人工判讀的事件）
W('evidence.json', [
  { id: 'e1', stockId: '3017', title: '液冷散熱模組獲北美雲端業者新平台認證', url: 'https://example.com/demo/1', date: '2026-10-08', direction: 'positive', stage: 'confirmed', note: '示意事件' },
  { id: 'e2', stockId: '2330', title: '先進封裝產能擴充進度提前', url: 'https://example.com/demo/2', date: '2026-10-02', direction: 'positive', stage: 'realized', note: '示意事件' },
  { id: 'e3', stockId: '1519', title: '電網標案交期延後一季', url: 'https://example.com/demo/3', date: '2026-10-12', direction: 'negative', stage: 'watch', note: '示意事件' },
]);
// 自訂提醒、籌碼追蹤設定
W('price-alerts.json', [
  { id: 'p1', stockId: '2330', name: '台積電', kind: 'above', value: 1450, repeat: false, active: false, firedDate: LAST, createdAt: '2026-10-14T01:00:00Z' },
  { id: 'p2', stockId: '3017', name: '奇鋐', kind: 'pct-up', value: 5, repeat: true, active: true, createdAt: '2026-10-14T01:00:00Z' },
  { id: 'p3', stockId: '1519', name: '華城', kind: 'below', value: 780, repeat: false, active: true, createdAt: '2026-10-15T01:00:00Z' },
  { id: 'p4', stockId: '6669', name: '緯穎', kind: 'volume', value: 2, repeat: false, active: true, createdAt: '2026-10-15T01:00:00Z' },
]);
let settings = {}; try { settings = R('settings.json'); } catch { }
W('settings.json', { ...settings, autoUpdate: false, chipwatch: { branches, auto: true, dayPct: 10, minAmount: 1e7, accumPct: 0.3, accumDays: 5, holdersPush: true } });
console.log('ok part 2');
