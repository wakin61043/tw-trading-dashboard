// 電腦版與手機版共用的圖表與卡片產生器（兩邊各放一份相同檔案）。顏色一律取 CSS 變數，深淺主題自動適用。
import * as MK from './market.js';
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (v, n = 0) => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: n, minimumFractionDigits: n });
export const pct = (v, n = 2) => v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, n)}%`;
export const cls = v => v == null ? 'muted' : v > 0 ? 'up' : v < 0 ? 'down' : 'muted';
const TXT = 'var(--text,var(--ink))';
const lots = shares => fmt(shares / 1000, 0);

/* ---------- 盤中走勢小圖：以昨收為基準線 ---------- */
// xs（選填）：每一點在全日交易時段中的位置（0＝開盤、1＝收盤）。有 xs 時橫軸固定為全日，線只畫到目前時間，並標出盤中參考時間
export function sparkSVG(values, prev, { w = 120, h = 38, xs = null } = {}) {
  const P = (values || []).map((p, i) => [xs ? xs[i] : null, p]).filter(([, p]) => p > 0), full = !!xs && P.every(([x]) => x != null);
  const grid = full ? MK.axis().slice(1, -1).map(t => { const gx = (MK.elapsed(t) / MK.sessionLength() * (w - 2) + 1).toFixed(1); return `<line x1="${gx}" x2="${gx}" y1="0" y2="${h}" stroke="var(--line2)" stroke-width=".6"/>`; }).join('') : '';
  if (P.length < 2) return `<svg class="ix-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${grid}</svg>`;
  const v = P.map(q => q[1]), base = prev > 0 ? prev : v[0], lo = Math.min(...v, base), hi = Math.max(...v, base), rg = hi - lo || 1;
  const x = i => (full ? P[i][0] : i / (v.length - 1)) * (w - 2) + 1, y = p => 2 + (hi - p) / rg * (h - 4);
  const up = v.at(-1) >= base, col = up ? 'var(--up)' : 'var(--down)', pts = v.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  return `<svg class="ix-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${grid}<line x1="0" x2="${w}" y1="${y(base)}" y2="${y(base)}" stroke="var(--soft)" stroke-dasharray="2 3" stroke-width=".8"/><polygon points="${x(0).toFixed(1)},${y(base)} ${pts} ${x(v.length - 1).toFixed(1)},${y(base)}" fill="${col}" opacity=".13"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

/* ---------- K 線（日 K／5 分 K）：K 棒＋5MA／20MA＋成交量；滑鼠移動或點擊顯示該根數值 ---------- */
// bars：[日期或「日期 時間」, 開, 高, 低, 收, 量（張）]，由舊到新。均線用完整序列計算，只畫最後 show 根。
export const MA_LINES = [[5, 'var(--amber)'], [20, 'var(--violet)']];
export function maOf(closes, n) { const out = []; let s = 0; closes.forEach((c, i) => { s += c; if (i >= n) s -= closes[i - n]; out.push(i >= n - 1 ? s / n : null); }); return out; }
const CK = new Map(), ckHover = new Map(); let ckSeq = 0; // 已繪製的 K 線（供讀值）、游標停留的那根（10 秒重繪後保留）
const axis = p => fmt(p, p < 100 ? 2 : p < 1000 ? 1 : 0);
const ckTime = (k, period) => period === 'day' ? k.slice(0, 10).replaceAll('-', '/') : `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))} ${k.slice(11)}`;
function ckRef(d, k) { // 漲跌幅基準：日 K 比前一日收盤；5 分 K 比該日昨收（prevs 由伺服器提供，沒有時用序列中前一日最後一根）
  if (d.period === 'day') return d.bars[k - 1]?.[4] ?? null;
  const day = d.bars[k][0].slice(0, 10); if (d.prevs?.[day] > 0) return d.prevs[day];
  for (let j = k - 1; j >= 0; j--) if (d.bars[j][0].slice(0, 10) !== day) return d.bars[j][4];
  return d.prev ?? null;
}
function ckRead(d, i) {
  const k = d.off + i, b = d.bars[k], ref = ckRef(d, k), chg = ref > 0 ? (b[4] / ref - 1) * 100 : null;
  return `<b class="ck-t">${ckTime(b[0], d.period)}</b><span>開 ${fmt(b[1], 2)}</span><span>高 ${fmt(b[2], 2)}</span><span>低 ${fmt(b[3], 2)}</span><span>收 <b class="${cls(chg)}">${fmt(b[4], 2)}</b></span><span class="${cls(chg)}">${pct(chg)}</span><span>量 ${fmt(b[5])} ${MK.unit()}</span>${d.mas.map(m => `<span style="color:${m.col}">MA${m.n} <b>${m.v[k] == null ? '—' : fmt(m.v[k], 2)}</b></span>`).join('')}`;
}
export function candleSVG(bars, { w = 640, h = 300, show = 90, period = 'day', key = '', prev = null, prevs = null } = {}) {
  if (!bars?.length) return '<div class="ix-empty">尚無 K 線資料</div>';
  const mas = MA_LINES.map(([n, col]) => ({ n, col, v: maOf(bars.map(b => b[4]), n) }));
  const off = Math.max(0, bars.length - show), vis = bars.slice(off), n = vis.length;
  const L = 4, R = 58, top = 8, ph = Math.round(h * .7), vt = ph + 8, vb = h - 18, slot = (w - L - R) / Math.max(n, period === 'day' ? 40 : 54);
  const vals = vis.flatMap((b, i) => [b[2], b[3], ...mas.map(m => m.v[off + i]).filter(v => v != null)]);
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * .06 || hi * .01 || 1; lo -= pad; hi += pad;
  const X = i => L + (i + .5) * slot, Y = p => top + (hi - p) / (hi - lo) * (ph - top), cw = Math.max(1, slot * .66), f1 = v => v.toFixed(1);
  const vmax = Math.max(...vis.map(b => b[5])) || 1, V = v => vb - v / vmax * (vb - vt);
  const color = i => { const b = vis[i], pc = bars[off + i - 1]?.[4] ?? b[4]; return b[4] > b[1] ? 'var(--up)' : b[4] < b[1] ? 'var(--down)' : b[4] > pc ? 'var(--up)' : b[4] < pc ? 'var(--down)' : 'var(--soft)'; };
  let g = '';
  for (let k = 0; k <= 4; k++) { const p = lo + (hi - lo) * k / 4; g += `<line x1="0" x2="${w - R}" y1="${f1(Y(p))}" y2="${f1(Y(p))}" stroke="var(--line)"/><text x="${w - R + 4}" y="${f1(Y(p) + 3.5)}" font-size="10" fill="var(--soft)">${axis(p)}</text>`; }
  g += `<line x1="0" x2="${w - R}" y1="${vt}" y2="${vt}" stroke="var(--line)"/>`;
  let lastLabel = -1e9; // 日 K 標月份、5 分 K 標日期（換日畫虛線）
  vis.forEach((b, i) => {
    const pk = (i ? vis[i - 1][0] : bars[off - 1]?.[0]) || '', newDay = period !== 'day' && b[0].slice(0, 10) !== pk.slice(0, 10), newMonth = period === 'day' && b[0].slice(0, 7) !== pk.slice(0, 7);
    if (newDay && i) g += `<line x1="${f1(X(i) - slot / 2)}" x2="${f1(X(i) - slot / 2)}" y1="${top}" y2="${vb}" stroke="var(--line2,var(--line))" stroke-dasharray="3 3"/>`;
    if ((newDay || newMonth) && X(i) - lastLabel > 46) { g += `<text x="${f1(X(i) - slot / 2 + 2)}" y="${h - 4}" font-size="10" fill="var(--soft)">${period === 'day' ? `${i && b[0].slice(0, 4) !== pk.slice(0, 4) ? b[0].slice(0, 4) + '/' : ''}${Number(b[0].slice(5, 7))}月` : `${Number(b[0].slice(5, 7))}/${Number(b[0].slice(8, 10))}`}</text>`; lastLabel = X(i); }
  });
  vis.forEach((b, i) => {
    const c = color(i), x = f1(X(i)), yo = Y(b[1]), yc = Y(b[4]), bx = f1(X(i) - cw / 2);
    g += `<line x1="${x}" x2="${x}" y1="${f1(Y(b[2]))}" y2="${f1(Y(b[3]))}" stroke="${c}"/><rect x="${bx}" y="${f1(Math.min(yo, yc))}" width="${f1(cw)}" height="${f1(Math.max(1, Math.abs(yo - yc)))}" fill="${c}"/><rect x="${bx}" y="${f1(V(b[5]))}" width="${f1(cw)}" height="${f1(vb - V(b[5]))}" fill="${c}" opacity=".45"/>`;
  });
  for (const m of mas) { const pts = vis.map((_, i) => m.v[off + i] == null ? null : `${f1(X(i))},${f1(Y(m.v[off + i]))}`).filter(Boolean); if (pts.length > 1) g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${m.col}" stroke-width="1.5" stroke-linejoin="round"/>`; }
  const lc = color(n - 1), ly = Y(vis[n - 1][4]);
  g += `<line x1="0" x2="${w - R}" y1="${f1(ly)}" y2="${f1(ly)}" stroke="${lc}" stroke-dasharray="2 3" opacity=".75"/><rect x="${w - R + 1}" y="${f1(ly - 8)}" width="${R - 2}" height="16" rx="3" fill="${lc}"/><text x="${w - R + 4}" y="${f1(ly + 3.5)}" font-size="10" font-weight="700" fill="#fff">${axis(vis[n - 1][4])}</text>`;
  g += `<text x="${w - R + 4}" y="${vt + 11}" font-size="10" fill="var(--soft)">${vmax >= 1e4 ? fmt(vmax / 1e4, 1) + '萬' : fmt(vmax)} ${MK.unit()}</text>`;
  const id = `ck${++ckSeq}`, d = { bars, off, n, mas, X, slot, L, w, period, key, prev, prevs }; CK.set(id, d); if (CK.size > 8) CK.delete(CK.keys().next().value);
  const hk = ckHover.get(key), at = hk ? vis.findIndex(b => b[0] === hk) : -1;
  g += `<line class="ck-x" x1="${at >= 0 ? f1(X(at)) : 0}" x2="${at >= 0 ? f1(X(at)) : 0}" y1="${top}" y2="${vb}" stroke="var(--text,var(--ink))" stroke-width=".8" stroke-dasharray="2 2" opacity="${at >= 0 ? .6 : 0}"/><rect x="${L}" y="0" width="${w - L - R}" height="${h}" fill="transparent"/>`;
  return `<div class="ck-wrap"><div class="ck-read num" id="${id}-r">${ckRead(d, at >= 0 ? at : n - 1)}</div><svg class="ix-candle" id="${id}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${period === 'day' ? '日 K' : '5 分 K'}線圖，含 5 日與 20 日均線">${g}</svg>
  <div class="ck-legend">${mas.map(m => `<span><i style="background:${m.col}"></i>MA${m.n}</span>`).join('')}<span class="soft">${period === 'day' ? '日 K · 不還原' : '5 分 K'}${MK.unit() ? ` · 量：${MK.unit()}` : ''}</span></div></div>`;
}
function ckPoint(e) {
  const svg = e.target.closest?.('svg.ix-candle'), d = svg && CK.get(svg.id); if (!d) return;
  const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * d.w, i = Math.max(0, Math.min(d.n - 1, Math.floor((x - d.L) / d.slot)));
  const line = svg.querySelector('.ck-x'), lx = d.X(i).toFixed(1); line.setAttribute('x1', lx); line.setAttribute('x2', lx); line.setAttribute('opacity', '.6');
  const out = svg.ownerDocument.getElementById(svg.id + '-r'); if (out) out.innerHTML = ckRead(d, i);
  ckHover.set(d.key, d.bars[d.off + i][0]);
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointermove', ckPoint); document.addEventListener('pointerdown', ckPoint);
  document.addEventListener('pointerout', e => { // 滑鼠離開圖表：回到最新一根
    const svg = e.target.closest?.('svg.ix-candle'), d = svg && CK.get(svg.id); if (!d || e.pointerType !== 'mouse' || svg.contains(e.relatedTarget)) return;
    ckHover.delete(d.key); svg.querySelector('.ck-x').setAttribute('opacity', '0');
    const out = svg.ownerDocument.getElementById(svg.id + '-r'); if (out) out.innerHTML = ckRead(d, d.n - 1);
  });
}

/* ---------- 大戶持股：千張大戶比例（線）＋股東人數（柱） ---------- */
export function holdersSVG(series, { w = 640, h = 200 } = {}) {
  if (!series?.length) return '';
  const L = 40, R = 52, T = 14, B = 22, n = series.length, bw = (w - L - R) / n;
  const bv = series.map(s => s.big1000), lo = Math.min(...bv), hi = Math.max(...bv), rg = hi - lo || 1;
  const pv = series.map(s => s.people), pmin = Math.min(...pv) * 0.995, pmax = Math.max(...pv), pr = pmax - pmin || 1;
  const x = i => L + (i + .5) * bw, y = v => T + (hi - v) / rg * (h - T - B);
  let g = '';
  series.forEach((s, i) => { const bh = (s.people - pmin) / pr * (h - T - B) * .85 + 2; g += `<rect x="${x(i) - bw * .32}" y="${h - B - bh}" width="${bw * .64}" height="${bh}" fill="var(--violet)" opacity=".28"/>`; });
  g += `<polyline points="${series.map((s, i) => `${x(i)},${y(s.big1000)}`).join(' ')}" fill="none" stroke="var(--amber)" stroke-width="2"/>`;
  series.forEach((s, i) => { g += `<circle cx="${x(i)}" cy="${y(s.big1000)}" r="2.6" fill="var(--amber)"><title>${s.date} 千張大戶 ${s.big1000}% · 股東 ${fmt(s.people)} 人</title></circle>`; });
  g += `<text x="${L - 6}" y="${y(hi) + 4}" font-size="10" fill="var(--amber)" text-anchor="end">${fmt(hi, 2)}%</text><text x="${L - 6}" y="${y(lo) + 4}" font-size="10" fill="var(--amber)" text-anchor="end">${fmt(lo, 2)}%</text>`;
  g += `<text x="${w - R + 4}" y="${T + 8}" font-size="10" fill="var(--violet)">${fmt(pmax / 1000, 1)}k 人</text><text x="${w - R + 4}" y="${h - B}" font-size="10" fill="var(--violet)">${fmt(pmin / 1000, 1)}k</text>`;
  g += `<text x="${L}" y="${h - 4}" font-size="10" fill="var(--soft)">${series[0].date.slice(5)}</text><text x="${w - R}" y="${h - 4}" font-size="10" fill="var(--soft)" text-anchor="end">${series.at(-1).date.slice(5)}</text>`;
  return `<svg class="ix-holders" viewBox="0 0 ${w} ${h}" role="img" aria-label="千張大戶持股比例與股東人數">${g}</svg>`;
}

/* ---------- 板塊輪動：每 N 分鐘新增成交金額的板塊占比（100% 堆疊面積） ---------- */
export const PALETTE = ['#22e6ff', '#ff4fd8', '#ffc34d', '#9b8cff', '#16e38b', '#ff8a3d', '#4d8dff', '#ff3d5a', '#7d8ba1'];
export function rotationData(sum, { top = 8, bucket = 5 } = {}) {
  const idx = []; sum.times.forEach((t, i) => { const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); if (i === 0 || i === sum.times.length - 1 || m % bucket === 0) idx.push(i); });
  const uniq = [...new Set(idx)]; if (uniq.length < 3) return null;
  const names = sum.sectors.slice(0, top).map(s => s.name), rows = [];
  for (let k = 1; k < uniq.length; k++) {
    const a = uniq[k - 1], b = uniq[k], incs = sum.sectors.map(s => Math.max(0, s.a[b] - s.a[a])), tot = incs.reduce((x, y) => x + y, 0) || 1;
    const main = incs.slice(0, top), other = incs.slice(top).reduce((x, y) => x + y, 0);
    rows.push({ i: b, t: sum.times[b], shares: [...main, other].map(v => v / tot), money: tot });
  }
  return { names: [...names, '其他'], rows };
}
export function rotationSVG(rot, { w = 640, h = 200, cursor = null } = {}) {
  if (!rot) return '<div class="ix-empty">錄製超過 15 分鐘後即可看到板塊輪動。</div>';
  const n = rot.rows.length, x = k => k / (n - 1 || 1) * w, layers = rot.names.map(() => []);
  rot.rows.forEach((r, k) => { let acc = 0; r.shares.forEach((s, j) => { layers[j].push([x(k), acc, acc + s]); acc += s; }); });
  const Y = v => (1 - v) * (h - 16);
  let g = layers.map((L, j) => `<polygon points="${[...L.map(p => `${p[0].toFixed(1)},${Y(p[2]).toFixed(1)}`), ...L.slice().reverse().map(p => `${p[0].toFixed(1)},${Y(p[1]).toFixed(1)}`)].join(' ')}" fill="${PALETTE[j % PALETTE.length]}" opacity="${j === rot.names.length - 1 ? .35 : .78}"><title>${esc(rot.names[j])}</title></polygon>`).join('');
  const ticks = [0, Math.floor((n - 1) / 2), n - 1];
  g += ticks.map(k => `<text x="${x(k)}" y="${h - 3}" font-size="10" fill="var(--soft)" text-anchor="${k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle'}">${rot.rows[k].t}</text>`).join('');
  if (cursor != null) { const k = rot.rows.findIndex(r => r.i >= cursor); if (k >= 0) g += `<line x1="${x(k)}" x2="${x(k)}" y1="0" y2="${h - 16}" stroke="${TXT}" stroke-width="1.5" stroke-dasharray="3 2"/>`; }
  return `<svg class="ix-rotation" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="板塊輪動">${g}</svg><div class="ix-legend">${rot.names.map((nm, j) => `<span><i style="background:${PALETTE[j % PALETTE.length]}"></i>${esc(nm)}</span>`).join('')}</div>`;
}
// 時光機畫格 → 熱浪圖使用的個股資料
export function replayStocks(sum, frame) {
  const out = [];
  sum.stocks.forEach((s, i) => { const p = frame.p[i] / 100, a = frame.a[i] * 1e6; if (!(p > 0 && a > 0)) return; out.push({ id: s.id, name: s.name, sector: s.sector, market: s.market, close: p, money: a, change: s.prev > 0 ? Math.round((p / s.prev - 1) * 1e4) / 100 : null, prevMoney: null, volume: null, open: null, high: null, low: null }); });
  return out;
}

/* ---------- 券商分點 ---------- */
export function brokerHTML(b) {
  if (!b) return '<div class="ix-empty">查無分點資料</div>';
  const tracked = new Set(b.tracked || []);
  const row = (x, side) => `<tr class="${x.dayTrader ? 'ix-dt' : ''}"><td>${esc(x.name)}${tracked.has(x.id) ? '<em class="ix-badge acc">追蹤</em>' : ''}${x.dayTrader ? '<em class="ix-badge warn">隔日沖</em>' : ''}${Math.abs(x.streak) >= 3 ? `<em class="ix-badge ${x.streak > 0 ? 'up' : 'down'}">連${Math.abs(x.streak)}${x.streak > 0 ? '買' : '賣'}</em>` : ''}</td><td class="num ${side}">${x.net > 0 ? '+' : ''}${lots(x.net)}</td><td class="num">${fmt(side === 'up' ? x.avgBuy : x.avgSell, 2)}</td><td class="num ${cls(x.cumNet)}">${x.cumNet > 0 ? '+' : ''}${lots(x.cumNet)}</td></tr>`;
  const table = (list, side, title) => `<div class="ix-btable"><h5 class="${side}">${title}</h5><table><thead><tr><th>分點</th><th>淨張</th><th>均價</th><th>${b.dates.length}日累計</th></tr></thead><tbody>${list.map(x => row(x, side)).join('') || '<tr><td colspan="4" class="muted">無</td></tr>'}</tbody></table></div>`;
  return `<div class="ix-bmeta"><span>${esc(b.date)}</span><span>${fmt(b.brokerCount)} 個分點 · 成交 ${lots(b.volume)} 張</span><span>主力集中度 <b class="${cls(b.concentration)}">${pct(b.concentration, 1)}</b></span></div>
  <div class="ix-bgrid">${table(b.buy.slice(0, 8), 'up', '買超前 8')}${table(b.sell.slice(0, 8), 'down', '賣超前 8')}</div>
  ${b.dayTraders.length ? `<p class="ix-note">⚠️ 疑似隔日沖：${b.dayTraders.map(d => `${esc(d.name)}（前日 +${lots(d.prevNet)} → 今日 ${lots(d.net)} 張）`).join('、')}</p>` : ''}
  <p class="ix-foot">主力集中度 =（前 15 大買超 − 前 15 大賣超）÷ 成交量 · 隔日沖：前日大買、今日賣出六成以上 · 分點資料每日約 21:00 公布</p>`;
}

/* ---------- 大戶持股 ---------- */
export function holderHTML(h) {
  if (!h?.series?.length) return '<div class="ix-empty">查無股權分散資料</div>';
  const last = h.series.at(-1), s = h.signal;
  return `<div class="ix-bmeta"><span class="ix-pill ${s?.tone === '籌碼集中' ? 'up' : s?.tone === '籌碼渙散' ? 'down' : ''}">${esc(s?.tone || '資料累積中')}</span><span>千張大戶 <b>${fmt(last.big1000, 2)}%</b>${s ? `（週 <span class="${cls(s.d1)}">${s.d1 > 0 ? '+' : ''}${fmt(s.d1, 2)}</span>・4 週 <span class="${cls(s.d4)}">${s.d4 > 0 ? '+' : ''}${fmt(s.d4, 2)}</span>）` : ''}</span><span>股東 ${fmt(last.people)} 人${s?.peopleChange4w != null ? `（4 週 <span class="${cls(-s.peopleChange4w)}">${pct(s.peopleChange4w, 1)}</span>）` : ''}</span></div>
  ${holdersSVG(h.series)}<div class="ix-legend"><span><i style="background:var(--amber)"></i>千張大戶 %</span><span><i style="background:var(--violet);opacity:.5"></i>股東人數</span><span class="muted">400 張以上 ${fmt(last.big400, 2)}% · 50 張以下 ${fmt(last.small, 2)}% · ${esc(last.date)}</span></div>`;
}

/* ---------- 雷達事件 ---------- */
export const ALERT_ICON = { volume: '🔥', 'surge-up': '🚀', 'surge-down': '⚡', 'limit-up': '🔺', 'limit-down': '🔻', 'limit-up-open': '⚠️', 'limit-down-open': '↗️', 'pattern-entry': '🎯', stop: '🛑', report: '📰', news: '🗞️', 'dt-ma-up': '📈', 'dt-ma-down': '📉', 'dt-open-low': '🔻', 'dt-breakout': '💥', 'dt-vwap': '📈', 'dt-bid': '🟢', 'dt-stop': '⏰', custom: '🔔', broker: '🏦', holders: '🐋' };
export const ALERT_GROUPS = [['all', '全部'], ['watch', '自選'], ['custom', '自訂'], ['daytrade', '當沖'], ['volume', '爆量'], ['surge', '急拉急殺'], ['limit', '漲跌停'], ['pattern', '型態／防守'], ['news', '新聞'], ['chips', '籌碼']];
export function alertMatch(a, g) { return g === 'all' || (g === 'watch' && a.watch) || (g === 'daytrade' && a.type.startsWith('dt-')) || (g === 'volume' && a.type === 'volume') || (g === 'surge' && a.type.startsWith('surge')) || (g === 'limit' && a.type.startsWith('limit')) || (g === 'pattern' && ['pattern-entry', 'stop'].includes(a.type)) || (g === 'news' && a.type === 'news') || (g === 'custom' && a.type === 'custom') || (g === 'chips' && (a.type === 'broker' || a.type === 'holders')); }
export const isMove = a => !['report', 'news', 'broker', 'holders'].includes(a.type); // 盤中異動（不含日報、新聞與盤後籌碼摘要）
export function alertRow(a) {
  if (a.type === 'news') { // 個股新聞：點擊開啟原文
    const inner = `<span class="ix-at num">${esc(a.t?.slice(0, 5))}</span><span class="ix-ai">🗞️</span><span class="ix-ab"><b>${esc(a.name)} <small class="num">${esc(a.stockId)}</small>${a.watch ? '<em class="ix-badge acc">自選</em>' : ''} <em class="ix-tag news">${esc(a.source || '新聞')}</em></b><small>${esc(a.detail)}</small></span><span class="ix-ap num ${cls(a.change)}">${a.close != null ? fmt(a.close, 2) : ''}<small>${a.change != null ? pct(a.change) : ''}</small></span>`;
    return /^https?:\/\//i.test(a.url || '') ? `<a class="ix-alert t-news lv-${esc(a.level)}" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<div class="ix-alert t-news lv-${esc(a.level)}">${inner}</div>`;
  }
  if (a.type === 'report') return `<button class="ix-alert t-report" data-open-report="${esc(a.date || '')}"><span class="ix-at num">${esc(a.t?.slice(0, 5))}</span><span class="ix-ai">📰</span><span class="ix-ab"><b>AI 盤後日報</b><small>${esc(a.detail)}</small></span></button>`;
  if (a.type === 'broker' || a.type === 'holders') return `<button class="ix-alert t-report lv-${esc(a.level)}" data-open-chips="${a.type}"><span class="ix-at num">${esc(a.t?.slice(0, 5))}</span><span class="ix-ai">${ALERT_ICON[a.type]}</span><span class="ix-ab"><b>${esc(a.title)}</b><small>${esc(a.detail)}</small></span></button>`;
  if (!a.stockId) return `<div class="ix-alert t-report lv-${esc(a.level)}"><span class="ix-at num">${esc(a.t?.slice(0, 5))}</span><span class="ix-ai">${ALERT_ICON[a.type] || '📡'}</span><span class="ix-ab"><b>${esc(a.title)}</b><small>${esc(a.detail)}</small></span></div>`; // 不屬於個股的提醒（例如當沖停止新增部位）
  const tone = a.type === 'custom' ? (a.dir || 'hot') : ['surge-up', 'limit-up', 'pattern-entry', 'limit-down-open', 'dt-ma-up', 'dt-breakout', 'dt-vwap', 'dt-bid'].includes(a.type) ? 'up' : ['surge-down', 'limit-down', 'stop', 'limit-up-open', 'dt-ma-down', 'dt-open-low'].includes(a.type) ? 'down' : 'hot';
  return `<button class="ix-alert lv-${a.level} tone-${tone}" data-alert-stock="${esc(a.stockId)}"><span class="ix-at num">${esc(a.t?.slice(0, 5))}</span><span class="ix-ai">${ALERT_ICON[a.type] || '📡'}</span><span class="ix-ab"><b>${esc(a.name)} <small class="num">${esc(a.stockId)}</small>${a.watch ? '<em class="ix-badge acc">自選</em>' : ''} <em class="ix-tag ${tone}">${esc(a.title)}</em></b><small>${esc(a.detail)}</small></span><span class="ix-ap num ${cls(a.change)}">${fmt(a.close, 2)}<small>${pct(a.change)}</small></span></button>`;
}

/* ---------- AI 盤後日報 ---------- */
export function reportHTML(r, { compact = false } = {}) {
  if (!r) return '';
  const list = (title, items, icon) => items?.length ? `<section class="ix-rsec"><h4>${icon} ${title}</h4><ul>${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>` : '';
  return `<article class="ix-report"><p class="ix-rdate num">${esc(r.date)} 盤後</p><h3 class="ix-rh">${esc(r.headline)}</h3><p class="ix-rs">${esc(r.summary)}</p>
  ${(r.sections || []).map((s, i) => `<details class="ix-rsec" ${compact && i > 0 ? '' : 'open'}><summary>${esc(s.title)}</summary><ul>${s.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul></details>`).join('')}
  ${r.watchlist?.length ? `<section class="ix-rsec"><h4>👀 值得注意</h4><div class="ix-rwatch">${r.watchlist.map(w => `<button data-stock="${esc(w.id)}"><b>${esc(w.name)} <small class="num">${esc(w.id)}</small></b><span>${esc(w.note)}</span></button>`).join('')}</div></section>` : ''}
  ${r.notes?.length ? `<section class="ix-rsec"><h4>📋 自選股逐檔</h4><div class="ix-rnotes">${r.notes.map(w => `<button data-stock="${esc(w.id)}"><b>${esc(w.name)} <small class="num">${esc(w.id)}</small>${w.stance ? `<em class="ix-badge ${w.stance === '偏多' ? 'up' : w.stance === '偏空' ? 'down' : ''}">${esc(w.stance)}</em>` : ''}</b><span>${esc(w.note)}</span></button>`).join('')}</div></section>` : ''}
  ${list('明日觀察', r.tomorrow, '🗓')}${list('風險提醒', r.risks, '⚠️')}
  <p class="ix-foot">由 <span translate="no">${esc(r.model || 'AI')}</span> 依當日資料產生 · ${esc(MK.dateTime(r.createdAt))}${r.usage ? ` · ${fmt(r.usage.input)} / ${fmt(r.usage.output)} tokens` : ''} · 研究紀錄，非投資建議</p></article>`;
}

/* ---------- 自訂提醒：規則清單與新增表單（電腦版個股視窗、盤中雷達頁；手機版個股頁、盤中分頁） ---------- */
export const RULE_KINDS = [['above', '價格 ≥'], ['below', '價格 ≤'], ['pct-up', '漲幅 ≥ %'], ['pct-down', '跌幅 ≥ %'], ['volume', '預估量 ≥ 倍昨量']];
// stock：{ id, name, close }（個股頁預填；沒有時顯示代號輸入框）
export function priceRuleForm(stock = null) {
  const hint = stock?.close > 0 ? `現價 ${fmt(stock.close, 2)}` : '';
  return `<form class="ix-pa-form" data-pa-form>${stock ? `<input type="hidden" name="stockId" value="${esc(stock.id)}">` : '<input name="stockId" placeholder="股票代號" required maxlength="16" autocomplete="off" inputmode="text" aria-label="股票代號">'}
  <select name="kind" aria-label="提醒條件">${RULE_KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
  <input name="value" type="number" step="any" min="0" required placeholder="${stock?.close > 0 ? fmt(stock.close, 2).replace(/,/g, '') : '數值'}" aria-label="門檻數值">
  <input name="note" maxlength="60" placeholder="備註（選填）" aria-label="備註">
  <label class="ix-pa-rep"><input type="checkbox" name="repeat">重複提醒</label><button type="submit" class="primary">＋ 新增提醒</button>${hint ? `<small class="ix-pa-hint num">${hint}</small>` : ''}</form>`;
}
export function priceRulesHTML(info, { stockId = null, empty = '尚未設定提醒' } = {}) {
  const rules = (info?.rules || []).filter(r => !stockId || r.stockId === stockId);
  if (!rules.length) return `<p class="ix-empty">${empty}</p>`;
  return `<div class="ix-pa-list">${rules.map(r => `<div class="ix-pa-row ${r.active ? '' : 'off'}">${stockId ? '' : `<button class="ix-pa-stock" data-alert-stock="${esc(r.stockId)}"><b>${esc(r.name)}</b><small class="num">${esc(r.stockId)}</small></button>`}
    <span class="ix-pa-cond"><b>${esc(r.label)}</b>${r.repeat ? '<em class="ix-badge acc">重複</em>' : ''}${!r.active ? '<em class="ix-badge">已停用</em>' : ''}${r.note ? `<small>${esc(r.note)}</small>` : ''}<small class="num">${r.close != null ? `現價 ${fmt(r.close, 2)}（${pct(r.change)}）` : ''}${r.firedAt ? `${r.close != null ? ' · ' : ''}上次提醒 ${esc(MK.dateTime(r.firedAt))} · 共 ${r.hits} 次` : ''}</small></span>
    <span class="ix-pa-act"><button data-pa-toggle="${esc(r.id)}" data-on="${r.active ? '0' : '1'}" title="${r.active ? '停用' : '重新啟用'}">${r.active ? '⏸' : '▶'}</button><button data-pa-del="${esc(r.id)}" title="刪除" aria-label="刪除提醒">✕</button></span></div>`).join('')}</div>`;
}
// 表單內容 → API 參數
export function priceRuleBody(form) { const f = form.elements; return { stockId: f.stockId.value.trim().toUpperCase(), kind: f.kind.value, value: Number(f.value.value), note: f.note.value.trim(), repeat: f.repeat.checked }; }

/* ---------- 分點追蹤 ---------- */
const yi8 = v => fmt(v / 1e8, Math.abs(v) >= 1e10 ? 0 : 2);
const streakBadge = x => Math.abs(x.streak) >= 2 ? `<em class="ix-badge ${x.streak > 0 ? 'up' : 'down'}">連${Math.abs(x.streak)}${x.streak > 0 ? '買' : '賣'}</em>` : '';
const mineBadge = x => x.watch ? '<em class="ix-badge acc">自選</em>' : x.research ? '<em class="ix-badge">研究</em>' : '';
const wan = v => fmt(v / 1e4, 0);
// 分點的認購權證進出（依標的彙總）：達提醒條件、淨買前 8
function branchWarrantHTML(w) {
  if (!w) return '';
  if (w.error) return `<p class="ix-note">🎫 認購權證：${esc(w.error)}</p>`;
  if (!w.count) return '<p class="ix-foot">🎫 當日沒有認購權證進出</p>';
  const sh = v => v == null ? '—' : `${fmt(v, 1)}%`, sk = w.skipped || {};
  const row = x => `<tr class="${x.big || x.run ? 'ix-cw-hit' : ''}"><td><button class="ix-cw-stock" data-alert-stock="${esc(x.id)}">${esc(x.name)} <small class="num">${esc(x.id)}</small></button>${mineBadge(x)}${x.big ? '<em class="ix-badge acc">大買</em>' : ''}${x.streak >= 2 ? `<em class="ix-badge ${x.run ? 'warn' : 'up'}">連${x.streak}買</em>` : ''}</td><td class="num ${cls(x.netAmt)}">${x.netAmt > 0 ? '+' : ''}${wan(x.netAmt)}</td><td class="num">${sh(x.share)}</td><td class="num">${x.count}</td><td class="ix-wlist">${(x.warrants || []).slice(0, 2).map(v => `${esc(v.name)} <small class="num ${cls(v.netAmt)}">${v.netAmt > 0 ? '+' : ''}${wan(v.netAmt)}</small>`).join('<br>')}</td></tr>`;
  const table = (list, title, side) => `<div class="ix-btable"><h5 class="${side}">${title}</h5><table><thead><tr><th>標的</th><th>淨買萬元</th><th>占權證成交</th><th>權證檔數</th><th>主要權證（萬元）</th></tr></thead><tbody>${list.map(row).join('') || '<tr><td colspan="5" class="muted">無</td></tr>'}</tbody></table></div>`;
  return `<div class="ix-cw-w"><h5 class="ix-cw-wh">🎫 認購權證 <small>${fmt(w.count)} 個標的 · ${fmt(w.warrants)} 檔 · 買進 ${wan(w.buyAmt)} 萬 · 賣出 ${wan(w.sellAmt)} 萬${sk.issuer ? ` · 不含發行商總公司 ${sk.issuer} 檔` : ''}</small></h5>${w.signals?.length ? table(w.signals, '🔔 達提醒條件', 'up') : ''}${table((w.buy || []).slice(0, 8), '淨買前 8', 'up')}</div>`;
}
export function branchHTML(b, { top = 10 } = {}) {
  if (b.error) return `<section class="ix-cw"><h4>🏦 ${esc(b.name)} <small class="num">${esc(b.id)}</small></h4><p class="ix-note">⚠️ ${esc(b.error)}</p></section>`;
  if (!b.count) return `<section class="ix-cw"><h4>🏦 ${esc(b.name)} <small class="num">${esc(b.id)}</small></h4><p class="ix-empty">當日沒有股票進出</p>${branchWarrantHTML(b.warrants)}</section>`;
  // 占量：淨買賣超占當日成交量；占股本：最近 N 日累計淨買賣超占集保總股數（N 依設定，紀錄不足時為實際天數）
  const p = (v, n = 1) => v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, n)}%`;
  const row = x => `<tr class="${x.day || x.accum ? 'ix-cw-hit' : ''}"><td><button class="ix-cw-stock" data-alert-stock="${esc(x.id)}">${esc(x.name)} <small class="num">${esc(x.id)}</small></button>${mineBadge(x)}${streakBadge(x)}${x.day ? '<em class="ix-badge acc">主導</em>' : ''}${x.accum ? '<em class="ix-badge warn">吃貨</em>' : ''}</td><td class="num ${cls(x.net)}">${x.net > 0 ? '+' : ''}${lots(x.net)}</td><td class="num ${cls(x.netAmt)}">${x.netAmt > 0 ? '+' : ''}${yi8(x.netAmt)}</td><td class="num">${p(x.volPct)}</td><td class="num">${x.accumPct == null ? '—' : `${p(x.accumPct, 2)}<small class="muted"> ${x.accumDays}日</small>`}</td><td class="num">${fmt(x.net > 0 ? x.avgBuy : x.avgSell, 2)}</td></tr>`;
  const table = (list, title, side) => `<div class="ix-btable"><h5 class="${side}">${title}</h5><table><thead><tr><th>股票</th><th>淨張</th><th>淨額億</th><th>占量</th><th>累計占股本</th><th>均價</th></tr></thead><tbody>${list.map(row).join('') || '<tr><td colspan="6" class="muted">無</td></tr>'}</tbody></table></div>`;
  return `<section class="ix-cw"><h4>🏦 ${esc(b.name)} <small class="num">${esc(b.id)}</small></h4><div class="ix-bmeta"><span>${fmt(b.count)} 檔</span><span>買進 <b>${yi8(b.buyAmt)}</b> 億</span><span>賣出 <b>${yi8(b.sellAmt)}</b> 億</span><span>淨額 <b class="${cls(b.buyAmt - b.sellAmt)}">${yi8(b.buyAmt - b.sellAmt)}</b> 億</span></div>
  ${b.signals?.length ? table(b.signals, '🔔 達提醒條件', 'up') : ''}${b.mine.length ? table(b.mine, '自選／研究名單進出', '') : ''}<div class="ix-bgrid">${table(b.buy.slice(0, top), `買超前 ${top}`, 'up')}${table(b.sell.slice(0, top), `賣超前 ${top}`, 'down')}</div>${branchWarrantHTML(b.warrants)}</section>`;
}
// 分點追蹤的日期選單（電腦版與手機版共用）：已有紀錄的日期、目前檢視的日期，以及「其他日期…」（展開日期欄位，可查詢任一交易日）
export function cwDateHTML(info, { picking = false, pickDate = '', cls = '' } = {}) {
  const cur = info?.date || '', dates = [...new Set([...(info?.dates || []), ...(cur ? [cur] : [])])].sort().reverse(), have = new Set(info?.dates || []);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const sel = `<select ${cls ? `class="${cls}"` : ''} data-cw-date aria-label="追蹤紀錄日期">${dates.length ? '' : '<option value="">尚無紀錄</option>'}${dates.map(d => `<option value="${d}" ${d === cur && !picking ? 'selected' : ''}>${d}${have.has(d) ? '' : '（尚無紀錄）'}</option>`).join('')}<option value="__pick" ${picking ? 'selected' : ''}>其他日期…</option></select>`;
  return picking ? `${sel}<span class="ix-cw-pick"><input type="date" data-cw-pick max="${today}" min="2015-01-05" value="${esc(pickDate || cur)}" aria-label="查詢日期"><button data-cw="pick">查詢此日</button></span>` : sel;
}
export function chipwatchHTML(info) {
  const r = info?.report, q = info?.busy && info.query;
  const prog = q ? `<p class="ix-note">⏳ 正在查詢 ${esc(q.date)}：${fmt(q.done)}／${fmt(q.total)} 個分點${info.settings?.warrants !== false ? '（含認購權證，每個分點 2 次請求）' : ''}，完成後自動顯示</p>` : '';
  if (!r) return `${prog}<p class="ix-empty">${!info?.settings?.branches?.length ? '先在上方加入要追蹤的券商分點。' : q ? '' : info?.date ? `${esc(info.date)} 尚無追蹤紀錄。 <button class="ix-wbtn" data-cw="requery" data-date="${esc(info.date)}">查詢此日</button>` : '尚無追蹤紀錄。平日 18:30 後自動查詢，也可以立即查詢。'}</p>`;
  const R = r.rules, src = { heatmap: '熱浪圖', replay: '時光機' }[r.volumeSource];
  const rules = R ? `<span>單日主導：占成交量 ≥ ${fmt(R.dayPct)}% 且 ≥ ${fmt(R.minAmount / 1e4)} 萬元</span><span>多日吃貨：${R.accumDays} 日累計占股本 ≥ ${fmt(R.accumPct, 2)}%</span>` : '';
  const WR = r.warrantRules, WI = r.warrantInfo;
  const wrules = WR ? `<span>認購權證大買：淨買 ≥ ${wan(WR.amount)} 萬且占該標的權證成交 ≥ ${fmt(WR.pct)}%</span><span>連續買進：連 ${WR.days} 日淨買、累計 ≥ ${wan(WR.amount)} 萬</span>` : '';
  const gaps = R ? [!src ? '當日成交量未取得，無法判斷單日主導' : '', !r.sharesDate ? '尚無股權分散表，無法判斷多日吃貨' : '',
    WI?.error ? `認購權證：${WI.error}` : '', WI && !WI.error && !WI.turnover ? '認購權證行情未取得，權證大買只看金額' : '', WI?.stale ? '權證標的對照表為舊資料' : ''].filter(Boolean) : [];
  return `${prog}<div class="ix-bmeta"><span><b>${esc(r.date)}</b> 盤後</span><span>${r.branches.length} 個分點</span>${rules}${wrules}<span class="muted">${esc(MK.dateTime(r.builtAt))} 取得</span>${q || !info?.settings?.branches?.length ? '' : `<button class="ix-wbtn" data-cw="requery" data-date="${esc(r.date)}">重新查詢此日</button>`}</div>${gaps.length ? `<p class="ix-note">⚠️ ${gaps.join('；')}</p>` : ''}${r.branches.map(b => branchHTML(b)).join('')}
  <p class="ix-foot">FinMind 券商分點（依券商代碼查詢）· 約 18:00 更新 · 占量＝淨買賣超 ÷ 當日成交量${src ? `（${src}）` : ''} · 累計占股本＝最近 N 日累計淨買賣超 ÷ 集保總股數${r.sharesDate ? `（${esc(r.sharesDate)} 股權分散表）` : ''} · 「連 N 買／賣」與累計以本機已保存的追蹤紀錄計算${WR ? ' · 認購權證：FinMind 權證分點、證交所／櫃買權證行情，占權證成交＝淨買 ÷ 該標的當日認購權證成交金額，發行券商總公司的自家權證進出不列入' : ''}</p>`;
}
// 提醒條件設定（電腦版與手機版共用）
export function branchRulesForm(s) {
  const sel = (k, opts, label) => `<select data-cw-opt="${k}" aria-label="${label}">${opts.map(([v, l]) => `<option value="${v}" ${Number(s?.[k]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<div class="ix-cw-rules"><div><b>單日主導</b><span>淨買超占當日成交量 ≥ ${sel('dayPct', [5, 10, 15, 20, 30].map(v => [v, `${v}%`]), '占成交量門檻')}，且淨買超金額 ≥ ${sel('minAmount', [[5e6, '500 萬'], [1e7, '1,000 萬'], [3e7, '3,000 萬'], [5e7, '5,000 萬'], [1e8, '1 億']], '金額門檻')}</span></div>
  <div><b>多日吃貨</b><span>最近 ${sel('accumDays', [3, 5, 10, 20].map(v => [v, `${v} 日`]), '累計天數')} 累計淨買超占集保總股數 ≥ ${sel('accumPct', [0.1, 0.2, 0.3, 0.5, 1].map(v => [v, `${v}%`]), '占股本門檻')}</span></div>
  <div><b>認購權證</b><span><label class="checkbox"><input type="checkbox" data-cw-opt="warrants" ${s?.warrants !== false ? 'checked' : ''}>一起查詢（每個分點多 1 次請求）</label> 單日淨買 ≥ ${sel('warrantAmount', [[1e6, '100 萬'], [3e6, '300 萬'], [5e6, '500 萬'], [1e7, '1,000 萬'], [3e7, '3,000 萬']], '權證金額門檻')}，且占該標的權證成交 ≥ ${sel('warrantPct', [5, 10, 20, 30].map(v => [v, `${v}%`]), '權證占比門檻')}；或連 ${sel('warrantDays', [2, 3, 5].map(v => [v, `${v} 日`]), '權證連續天數')} 淨買、累計達同一金額</span></div></div>`;
}
export function branchChips(settings) {
  const list = settings?.branches || [];
  return `<div class="ix-cw-chips">${list.map(b => `<span class="ix-cw-chip">${esc(b.name)} <small class="num">${esc(b.id)}</small><button data-cw-del="${esc(b.id)}" aria-label="移除 ${esc(b.name)}">✕</button></span>`).join('') || '<span class="muted">尚未追蹤任何分點</span>'}</div>`;
}
export function branchSearchHTML(list, settings) {
  const have = new Set((settings?.branches || []).map(b => b.id));
  return list.length ? `<div class="ix-cw-found">${list.map(b => `<button data-cw-add="${esc(b.id)}" data-name="${esc(b.name)}" ${have.has(b.id) ? 'disabled' : ''}>${esc(b.name)} <small class="num">${esc(b.id)}</small>${have.has(b.id) ? ' ✓' : ' ＋'}</button>`).join('')}</div>` : '<p class="ix-empty">找不到符合的分點</p>';
}

/* ---------- 個股的認購權證 ---------- */
export function warrantHTML(d) {
  if (!d) return '<div class="ix-empty">查無權證資料</div>';
  if (!d.count) return `<div class="ix-empty">${esc(d.date || '')} 沒有交易中的認購權證</div>`;
  const q = d.quotes, note = !q ? '權證行情未取得，只顯示權證條件' : !q.complete ? (q.sources?.twse ? '上櫃權證行情未取得' : '上市權證行情未取得') : '';
  const tr = (d.tracked || []).map(x => `<span class="ix-wt ${x.big || x.run ? 'hit' : ''}">${esc(x.branch)} <b class="${cls(x.netAmt)}">${x.netAmt > 0 ? '+' : ''}${wan(x.netAmt)} 萬</b>${x.share != null ? ` · 占 ${fmt(x.share, 1)}%` : ''}${x.streak >= 2 ? ` · 連 ${x.streak} 日` : ''}</span>`).join('');
  const mny = v => v == null ? '—' : `${v >= 0 ? '價內' : '價外'} ${fmt(Math.abs(v), 1)}%`;
  const row = x => `<tr><td>${esc(x.name)}<small class="num ix-wid">${esc(x.id)}</small></td><td class="num">${x.strike ? fmt(x.strike, 2) : '—'}<small class="${cls(x.moneyness)}">${mny(x.moneyness)}</small></td><td class="num">${fmt(x.days)} 天<small>比例 ${x.ratio == null ? '—' : fmt(x.ratio, 3)}</small></td><td class="num">${x.close == null ? '—' : fmt(x.close, 2)}<small>${x.value ? `${wan(x.value)} 萬` : '—'}</small></td><td class="num">${x.leverage == null ? '—' : `${fmt(x.leverage, 1)} 倍`}</td><td>${d.brokerDate ? `<button class="ix-wbtn" data-wbr="${esc(x.id)}" data-date="${esc(d.brokerDate)}">分點</button>` : ''}</td></tr><tr class="ix-wbr" data-wbr-row="${esc(x.id)}" hidden><td colspan="6"></td></tr>`;
  return `<div class="ix-bmeta"><span>${esc(d.date)}</span><span>交易中 ${fmt(d.count)} 檔 · 有成交 ${fmt(d.traded)} 檔</span><span>認購權證成交 <b>${yi8(d.turnover)}</b> 億</span>${d.close ? `<span>標的收盤 ${fmt(d.close, 2)}</span>` : ''}</div>
  ${tr ? `<div class="ix-wtrack"><b>追蹤分點 ${esc(d.trackedDate || '')}</b>${tr}</div>` : ''}${note ? `<p class="ix-note">⚠️ ${note}</p>` : ''}
  <div class="ix-btable ix-wtable"><table><thead><tr><th>權證</th><th>履約價／價內外</th><th>剩餘天數</th><th>收盤／成交</th><th>名目槓桿</th><th></th></tr></thead><tbody>${d.list.map(row).join('')}</tbody></table></div>
  <p class="ix-foot">只列認購權證，依當日成交金額排序（最多 ${d.list.length} 檔）· 價內外＝標的收盤 ÷ 履約價 − 1 · 名目槓桿＝標的收盤 × 行使比例 ÷ 權證收盤（未考慮 Delta）· 「分點」查詢該權證 ${esc(d.brokerDate || '')} 的分點進出，每檔 1 次 FinMind 請求 · 權證有時間價值遞減、槓桿高、流動性可能不足，僅供研究</p>`;
}
export function warrantBrokersHTML(d) {
  if (!d?.count) return '<p class="muted">當日沒有分點進出</p>';
  const tracked = new Set(d.tracked || []);
  const list = (xs, side) => xs.map(x => `<span class="${side}">${esc(x.name)}${tracked.has(x.id) ? '<em class="ix-badge acc">追蹤</em>' : ''} <b class="num">${x.net > 0 ? '+' : ''}${lots(x.net)}</b> 張</span>`).join('');
  return `<div class="ix-wbrs"><div><b class="up">買超</b>${list(d.buy, 'up') || '<span class="muted">—</span>'}</div><div><b class="down">賣超</b>${list(d.sell, 'down') || '<span class="muted">—</span>'}</div></div>`;
}

/* ---------- 大戶集中度排行 ---------- */
export function holderRankHTML(rank, { limit = 40 } = {}) {
  if (!rank?.rows?.length) return '<p class="ix-empty">尚無股權分散紀錄。每週五公布後自動取得，也可以立即更新。</p>';
  const d = v => v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 2)}`;
  const row = x => `<tr><td><button class="ix-cw-stock" data-alert-stock="${esc(x.id)}">${esc(x.name)} <small class="num">${esc(x.id)}</small></button>${mineBadge(x)}</td><td><span class="ix-pill ${x.tone === '籌碼集中' ? 'up' : x.tone === '籌碼渙散' ? 'down' : ''}">${esc(x.tone)}</span></td><td class="num">${fmt(x.big1000, 2)}%</td><td class="num ${cls(x.d1)}">${d(x.d1)}</td><td class="num ${cls(x.d4)}">${d(x.d4)}</td><td class="num ${cls(x.dp4 == null ? null : -x.dp4)}">${x.dp4 == null ? '—' : pct(x.dp4, 1)}</td></tr>`;
  const rows = rank.rows.length > limit ? [...rank.rows.slice(0, limit / 2), null, ...rank.rows.slice(-limit / 2)] : rank.rows;
  return `<div class="ix-bmeta"><span><b>${esc(rank.date)}</b> 股權分散</span><span>比較 ${esc(rank.prev1 || '—')}（1 週）· ${esc(rank.prev4 || '—')}（4 週）</span><span>${fmt(rank.count)} 檔</span></div>
  <div class="ix-btable ix-hr"><table><thead><tr><th>股票</th><th>判讀</th><th>千張大戶</th><th>1 週</th><th>4 週</th><th>股東人數 4 週</th></tr></thead><tbody>${rows.map(x => x ? row(x) : '<tr><td colspan="6" class="muted" style="text-align:center">⋯</td></tr>').join('')}</tbody></table></div>
  <p class="ix-foot">依千張大戶比例 4 週變化排序 · 集中＝4 週增加 0.5 個百分點以上且股東人數未增加；渙散相反 · 集保每週五資料</p>`;
}
