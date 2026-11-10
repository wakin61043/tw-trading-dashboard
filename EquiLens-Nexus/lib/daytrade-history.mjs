// 當沖監控的歷史 5 分 K 載入器：一次只處理一檔，依交易日與資料源快取，失敗 10 分鐘後重試。
// 歷史資料只涵蓋今天以前，所以抓到但不足 20 根的股票（成交稀疏）當天也快取、不再重抓：
// 富果歷史 API 每分鐘只有 60 次，觀察名單數百檔時不能反覆重試。只把歷史資料交給引擎，不發通知。
import { prepareHistory } from './daytrade-context.mjs';
const CACHE_VERSION = 3;
export function createHistoryLoader({ read, write, fetchHistory, now = Date.now }) {
  const states = new Map(); let busy = false, generation = 0;
  return {
    reset() { generation++; states.clear(); },
    status(ids) { return ids.map(id => ({ id, ...(states.get(id) || { status: 'pending' }) })); },
    async load({ ids, date, source, engine, active = () => true, interval = 120 }) {
      if (busy) return;
      busy = true; const version = generation;
      try {
        for (const id of ids) {
          if (version !== generation || !active()) break;
          const state = states.get(id);
          if (state?.date === date && state.source === source && ((state.status === 'ready' && engine.historyReady(id)) || now() < state.retryAt)) continue;
          states.set(id, { date, source, status: 'loading' });
          try {
            const key = `daytrade-history/${id}.json`, cached = read(key, null);
            let value = cached?.date === date && cached.source === source && cached.version === CACHE_VERSION ? cached.value : null;
            const fetched = !value; if (fetched) value = prepareHistory(await fetchHistory(id, date, { interval }), date); // 只存整理好的 5 分 K
            if (version !== generation || !active()) break;
            engine.setHistory(id, value);
            const ready = engine.historyReady(id);
            if (fetched) write(key, { version: CACHE_VERSION, date, source, value });
            states.set(id, { date, source, status: ready ? 'ready' : 'incomplete', retryAt: ready ? now() + 600000 : Infinity });
          } catch (error) {
            if (version !== generation || !active()) break;
            states.set(id, { date, source, status: 'error', error: error.message, retryAt: now() + 600000 });
            if (['auth', 'quota', 'plan'].includes(error.code)) {
              for (const other of ids) if (states.get(other)?.status !== 'ready') states.set(other, { date, source, status: 'error', error: error.message, retryAt: now() + 600000 });
              break;
            }
          }
        }
      } finally { busy = false; }
    },
  };
}
