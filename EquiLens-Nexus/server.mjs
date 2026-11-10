import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, LOCAL, read, write, readStocks, safeSymbol } from './lib/storage.mjs';
import { getSecret, saveSecret, secretConfigured, deleteSecret, secretBackend } from './lib/secrets.mjs';
import { config, saveConfig, activeMarket, language, upColor, LANGUAGES, LLM_PROVIDERS, TUNNEL_MODES, HOST_RE, EMAIL_RE } from './lib/config.mjs';
import { MARKETS, MARKET_IDS, localParts, closeHM, clientMarket, minuteOf, elapsedTrading, limitPrices } from './lib/markets.mjs';
import { seriesFromBars, seriesFromReplay, seriesFromCandles, replayRef, vwapLine, groupLine } from './lib/intraday.mjs';
import { t, UserError, isUserError } from './lib/i18n.mjs';
import { data, PROVIDERS, CAPABILITIES, capabilityMap, providerInfo, setProviderInfo, setInterval_, hasKey, supports } from './lib/providers/index.mjs';
import { LLM_INFO, listModels } from './lib/llm.mjs';
import { recordFrame, listDays, loadDay, compactReplay, replaySummary, resetReplayCache, framePrice, frameAmount, prevPrice } from './lib/replay.mjs';
import { normalizeRadar, validRadarInput, createRadarState, seedRadarState, scanRadar } from './lib/radar.mjs';
import { normalizeRule, createRuleState, scanPriceAlerts, ruleLabel, RULE_KINDS, MAX_RULES } from './lib/pricealerts.mjs';
import { aggregateBrokers, brokerAnalysis, parseHolders, holderSignal, replayMinuteBars, fiveMinBars, dailyKRows, replayDayBar } from './lib/insight.mjs';
import { buildReportContext, generateReport, normalizeReportSettings, overnightOutlook } from './lib/report.mjs';
import { normalizeChipwatch, branchDay, brokerWatchAlerts, holderMarketDay, rankHolders, holderRankAlert, MAX_BRANCHES } from './lib/chipwatch.mjs';
import { warrantMaster, branchWarrants, turnoverByTarget, stockWarrants, WARRANT_ID } from './lib/warrants.mjs';
import { remoteConfig, isRemoteHost, verifyAccessJwt } from './lib/access.mjs';
import { FUTURES, nearMonth, retailPosition, marginSummary, indexRow, assembleCard } from './lib/market-card.mjs';
import { buildMarket, marketToday, WEIGHTS, FACTORS, minusDays, bars as priceBars } from './lib/engine.mjs';
import { fetchStock, fetchNews, isBulkInstitutional, bulkInstitutions, defaultSources } from './lib/research.mjs';
import { buildGroupRanking, compareRanks, quotesFromSnapshot, quotesFromReplay, quotesFromDaily, RANK_RULES } from './lib/grouprank.mjs';
import { EMPTY_SCOPE, validateScope, scopeIds, resolveScope, addGroup, renameGroup, removeGroup, reorderGroups, addStock, removeStock, importGroups, selectedUpdateIds } from './lib/scope.mjs';
import { patternSnapshot, clearPatterns, updatePatternData } from './lib/pattern-service.mjs';
import { createStreamPool, splitSymbols, spreadSymbols } from './lib/stream.mjs';
import { normalizeBooks, checkpoints, buildLiquidity, reduceDay, pickExtras, swapExtras, createBookRecorder, readMeta, writeMeta, compactDay, listBookDays, pruneDays, readStock, toCSV, exportDay } from './lib/bookrec.mjs';
import { createDayTrade, normalizeDaytrade, roundTripCost, tzOffset, evaluateSignal, reviewStats, signalTitle, rankTurnover, selectTurnover, DT_TITLES } from './lib/daytrade.mjs';
import { createHistoryLoader } from './lib/daytrade-history.mjs';
import { regimeOf, strengthOf } from './lib/daytrade-market.mjs';
import { dispositions, tpexDayTrade, callWarrantQuotes } from './lib/providers/twse.mjs';
import { cnyesNews } from './lib/providers/cnyes.mjs';
import { queryFlows, validFlowDate, cacheableFlow } from './lib/flows.mjs';
import { queryHeatmap, validHeatDate, cacheableHeatmap, buildLiveHeatmap, liveWindow, LIVE_REFRESH_MS } from './lib/heatmap.mjs';
import { focusNews, weekAgenda } from './lib/briefing.mjs';
import { normalizeNews, validNewsInput, createNewsState, scanNews, saveNewsState, quietNow } from './lib/newswatch.mjs';
import { normalizeWatchGroups, editWatchGroups, setWatch } from './lib/watchgroups.mjs';
export const APP_VERSION='3.0.0';
const PORT = Number(process.env.PORT || 4330), ORIGIN = `http://127.0.0.1:${PORT}`;
const csrf = crypto.randomBytes(32).toString('hex');
const defaults = { weights: WEIGHTS, updateTime: '19:30', autoUpdate: true, interval: 7000, autoScope: 'all', lastAutoDate: null };
// 目前研究的市場（一套衡析研究一個市場；時區、交易時段、代號格式都由市場設定決定）
const M=()=>activeMarket(), today=()=>marketToday(), clock=()=>localParts(M());
const validId=id=>typeof id==='string'&&safeSymbol(id)&&M().symbolRe.test(id);
// 資料源回報金鑰無效、額度用盡或方案不足：暫停自動請求一段時間
const blocked=e=>['auth','quota','plan'].includes(e?.code);
const idleJob=()=>({running:false,done:0,total:0,current:null,dataset:null,errors:[],message:t('尚未更新')});

/* ---------- 狀態（切換市場時整組重新載入） ---------- */
let settings = { ...defaults, ...read('settings.json', {}) };
let researchScope, universe, raw, evidence, watchlist, watchGroups, job, controller, marketCache, scopeError='';
let flowBusy=false,heatBusy=false,reportBusy=false;
let liveHeat=null,livePending=null,lastSnap=null,monitorPauseUntil=0,monitorError='';
// 盤中即時推播（WebSocket）：連線、狀態與各股最新一筆資料
let stream=null,streamState={provider:null,connected:false,symbols:0,subscribed:0,limit:0,lastAt:0,error:'',since:0},streamRows=new Map(),streamDate='',streamAsOf='',yvCache={date:'',map:new Map()};
// 當沖監控：引擎（每日一個）、股票資料、盤前資料、斷線補資料進度、今天是否因訂閱數不足改用精簡模式
let dt=null,dtMeta=new Map(),dtPrep={date:'',busy:false,data:null,at:0},dtSaved='',dtFallback='',backfill={busy:false,again:false,started:0,done:0,total:0,error:''};
const dtHistory=createHistoryLoader({read,write:(name,value)=>{fs.mkdirSync(path.join(LOCAL,'daytrade-history'),{recursive:true});write(name,value);},fetchHistory:(...args)=>data.streamHistory(...args)});
let subscribedIds=new Set();
// 五檔錄製器：今天的錄製檔、加錄清單與換股紀錄、收盤整理狀態
const BOOKS=path.join(LOCAL,'books');
let bookRec=null,bookDay={date:''},bookBusy=false,bookError='';
let uniCache={ref:null,scope:null,ids:new Set(),meta:new Map(),list:[]};
let radarState=null,radarPlans={at:0,map:new Map()},alertsBox={date:'',list:[]},alertSeq=Date.now();
// 自訂提醒：規則（.local/price-alerts.json，隨市場切換）與今天的比對狀態
let priceRules=[],ruleState=null;
let replayCache={key:'',data:null},boardGroupCache={key:'',data:null},calendarCache={date:'',dates:[]},heatSummaryCache=null;
let grLive={at:0,data:null},grAttempt={date:'',at:0};
let newsState=null,newsBusy=false,newsPauseUntil=0,newsStatus={at:0,error:'',found:0,seeded:false};
let reportError='',reportAttempt={date:'',n:0,at:0};
const kbarMiss=new Map(); // 資料源尚無分 K 的「股票:日期」，10 分鐘內不重查
let kbarDenied={until:0,error:''}; // 金鑰或方案不足時 1 小時內不再請求分 K，直接用時光機
setInterval_('finmind',settings.interval);

// 研究族群：沒有設定時從空白開始（可在設定頁建立或匯入）；格式不符目前市場時先備份原檔再從空白開始
function loadScope(){
  const saved=read('groups.json',null);if(!saved){scopeError='';return structuredClone(EMPTY_SCOPE);}
  try{const s=validateScope(saved);scopeError='';return s;}
  catch{const backup=`groups.invalid-${Date.now()}.json`;write(backup,saved);scopeError=t('研究族群設定與目前市場的代號格式不符，已備份為 {file}，請重新建立或匯入',{file:backup});return structuredClone(EMPTY_SCOPE);}
}
function loadMarketState(){
  researchScope=loadScope();universe=read('universe.json',[]);raw=readStocks(scopeIds(researchScope));evidence=read('evidence.json',[]);
  watchlist=read('watchlist.json',[]).filter(validId); // 自選可含研究名單以外的股票（例如型態選股挑到的）
  watchGroups=normalizeWatchGroups(read('watch-groups.json',{}),watchlist);
  job=read('last-job.json',null)||idleJob();if(job.running)job={...job,running:false,message:t('上次更新中斷，可重新執行續傳')};
  liveHeat=null;lastSnap=null;monitorPauseUntil=0;monitorError='';radarState=null;radarPlans={at:0,map:new Map()};alertsBox={date:'',list:[]};
  replayCache={key:'',data:null};boardGroupCache={key:'',data:null};calendarCache={date:'',dates:[]};heatSummaryCache=null;grLive={at:0,data:null};grAttempt={date:'',at:0};
  newsState=null;newsStatus={at:0,error:'',found:0,seeded:false};newsPauseUntil=0;kbarMiss.clear();priceRules=read('price-alerts.json',[]).filter(r=>r&&RULE_KINDS.includes(r.kind)&&validId(r.stockId));ruleState=null;kbarDenied={until:0,error:''};
  if(stream){stream.close();stream=null;}streamRows=new Map();streamDate='';streamAsOf='';streamState={...streamState,connected:false};
  if(bookRec){bookRec.close();bookRec=null;}bookDay={date:''};
  dtHistory.reset();subscribedIds=new Set();dt=null;dtMeta=new Map();dtSaved='';dtFallback='';{const p=read('daytrade-prep.json',null);dtPrep={date:p?.date||'',busy:false,data:p,at:0};}
  resetReplayCache();invalidate();
}
loadMarketState();

// 換市場：把目前市場的資料（股票清單、族群、自選、行情、紀錄）收進 .local/markets/<市場>/，再把目標市場先前收起來的資料搬回來
const MARKET_FILE=/^(universe|groups|watchlist|watch-groups|evidence|last-job|news-seen|pattern-active|pattern-calendar|pattern-ledger|bulk-ledger|daytrade-prep|price-alerts)\.json$|^(heatmap|flows|grouprank|alerts|index|card)-\d{4}-\d{2}-\d{2}\.json$/;
const MARKET_DIRS=['stocks','replay','reports','kbar','daily','brokers','holders','broker-watch','holders-all','warrants','institutions','pattern-snapshots','pattern-stocks','daytrade','daytrade-history'];
function switchMarket(next){
  const cur=config().market;if(next===cur)return;
  if(job.running||flowBusy||heatBusy||reportBusy||livePending)throw new UserError('請等待更新完成或停止後，再切換市場');
  const park=path.join(LOCAL,'markets',cur),from=path.join(LOCAL,'markets',next);
  fs.mkdirSync(park,{recursive:true});
  for(const f of fs.readdirSync(LOCAL))if(MARKET_FILE.test(f)||MARKET_DIRS.includes(f)){const to=path.join(park,f);fs.rmSync(to,{recursive:true,force:true});fs.renameSync(path.join(LOCAL,f),to);}
  if(fs.existsSync(from)){for(const f of fs.readdirSync(from)){const to=path.join(LOCAL,f);fs.rmSync(to,{recursive:true,force:true});fs.renameSync(path.join(from,f),to);}fs.rmSync(from,{recursive:true,force:true});}
  fs.mkdirSync(path.join(LOCAL,'stocks'),{recursive:true});
  saveConfig({market:next});loadMarketState();
}

function invalidate() { marketCache = null; clearPatterns(); }
// 目前資料源能提供的評分因子：沒有法人資料的市場不計籌碼分數
const factorsNow=()=>FACTORS.filter(f=>f!=='chips'||data.has('institutional')||data.has('institutionalAll'));
function market() { const day = today(); if (!marketCache || marketCache.cutoff !== day) marketCache = buildMarket(resolveScope(researchScope,universe), raw, evidence, day, settings.weights,researchScope.groups,{factors:factorsNow(),revenue:data.has('revenue'),lot:M().lot}); return marketCache; }
function inScope(id){return scopeIds(researchScope).includes(id);}
// 股票清單：資料源提供的全市場清單，加上研究名單的股票資料（沒有清單能力的資料源只靠後者）
function uniIndex(){
  if(uniCache.ref!==universe||uniCache.scope!==researchScope){const list=[...new Map([...(researchScope.stockMetadata||[]),...universe].map(s=>[s.id,s])).values()];uniCache={ref:universe,scope:researchScope,list,ids:new Set(list.map(s=>s.id)),meta:new Map(list.map(s=>[s.id,{name:s.name,sector:s.sector,market:s.market}]))};}
  return uniCache;
}
// 可加入自選：研究名單內，或股票清單中的股票
const watchable=id=>validId(id)&&(inScope(id)||uniIndex().ids.has(id));
function saveWatch(){watchGroups=normalizeWatchGroups(watchGroups,watchlist);write('watchlist.json',watchlist);write('watch-groups.json',watchGroups);}
function saveScope(){write('groups.json',researchScope);boardGroupCache={key:'',data:null};invalidate();}
// 研究名單以外的自選股：沒有四維評分，只提供名稱、最新價與型態訊號
function watchExtra(){
  const ids=watchlist.filter(id=>!inScope(id));if(!ids.length)return[];
  const pats=new Map();try{for(const s of patternSnapshot(universe).stocks)if(ids.includes(s.id))pats.set(s.id,s);}catch{}
  const {meta}=uniIndex();
  return boardData(ids).stocks.map(s=>{const p=pats.get(s.id),m=meta.get(s.id)||{};return{id:s.id,name:s.name,market:m.market||p?.market||'',sector:m.sector||p?.sector||'',price:s.quote?.close??p?.price??null,change:s.quote?.change??null,asOf:s.quote?.date||null,patterns:(p?.matches||[]).map(x=>({id:x.id,name:x.name,status:x.status,score:x.score}))};});
}
function saveSettings() { write('settings.json', settings); }
function heatFiles(){try{return fs.readdirSync(LOCAL).filter(f=>/^heatmap-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>f.slice(8,18)).sort();}catch{return [];}}
function heatSummary(){const date=heatFiles().at(-1);if(!date)return null;if(heatSummaryCache?.date!==date){const h=read('heatmap-'+date+'.json',null);if(!h)return null;heatSummaryCache={date,total:{money:h.total.money,change:h.total.change,up:h.total.up,down:h.total.down,limitUp:h.total.limitUp},top:h.sectors.slice(0,6).map(({name,share,change,moneyChange})=>({name,share,change,moneyChange}))};}return heatSummaryCache;}
async function ensureUniverse(options={}){if(universe.length||!data.has('universe'))return universe;const list=await data.universe(options);if(!list.length)throw new UserError('股票清單為空');universe=list;write('universe.json',universe);invalidate();return universe;}
// 熱浪圖分組：股票清單有產業別時用產業；沒有（例如國際資料商的清單）時改用研究族群
function groupSectorOf(){const g=new Map();for(const gr of researchScope.groups)for(const id of gr.stockIds)if(!g.has(id))g.set(id,gr.name);return s=>g.get(s.id)||s.sector||t('未分類');}
function heatSectorOf(){const list=uniIndex().list,known=list.filter(s=>s.sector&&s.sector!=='未分類').length;return list.length&&known/list.length>=.5?null:groupSectorOf();}

/* ---------- 盤中監控 ---------- */
// 盤中每 10 秒取一次即時快照：支援全市場快照的資料源 1 次請求取回全部；只能逐檔查詢的資料源只查研究名單與自選股，
// 並依每分鐘額度拉長間隔。同一份快照供即時熱浪圖、時光機錄製、異動雷達與即時看板使用；電腦版與手機版共用。
const ruleIds=()=>priceRules.filter(r=>r.active).map(r=>r.stockId);
const snapIds=()=>[...new Set([...scopeIds(researchScope),...watchlist,...ruleIds()])];
function snapPlan(){
  if(data.snapshotMode()!=='symbols')return{ids:null,every:LIVE_REFRESH_MS};
  const ids=snapIds().slice(0,300),per=data.snapshotLimit()||ids.length||1;
  return{ids,every:Math.max(LIVE_REFRESH_MS,Math.ceil(ids.length/per)*60e3)};
}
async function liveHeatmap(){
  const plan=snapPlan();
  if(liveHeat&&Date.now()-liveHeat.at<plan.every-1000)return liveHeat.data;
  if(!livePending)livePending=(async()=>{try{await ensureUniverse();const rows=await data.snapshot(plan.ids||[]);const heat=buildLiveHeatmap(rows,{universe:uniIndex().list,sectorOf:heatSectorOf(),refreshMs:plan.every});liveHeat={at:Date.now(),data:heat};monitorError='';onSnapshot(rows,heat);return heat;}finally{livePending=null;}})();
  return livePending;
}
function onSnapshot(rows,heat){
  const {ids}=uniIndex(),day=rows.filter(r=>ids.has(r.stock_id)&&String(r.date).slice(0,10)===heat.date);
  if(lastSnap?.date!==heat.date)try{compactReplay(heat.date);}catch{}
  lastSnap={at:Date.now(),date:heat.date,asOf:heat.asOf,rows:day,byId:new Map(day.map(r=>[r.stock_id,r]))};
  try{if(recordFrame(heat.date,String(heat.asOf||'').slice(11,16),day,ids,{all:rows})&&M().id==='TW'){const ix=id=>rows.find(r=>r.stock_id===id&&String(r.date).slice(0,10)===heat.date);write(`index-${heat.date}.json`,{twse:indexRow(ix('001')),tpex:indexRow(ix('101'))});}}catch(e){console.error(t('時光機記錄失敗：')+e.message);}
  try{dtIndexFromSnapshot(rows,heat);}catch{}
  // 有即時推播的股票由推播資料判斷異動，快照只負責其餘股票（避免兩份不同時間的報價混在一起）
  try{runRadar(heat.date,streamFresh()?day.filter(r=>!streamRows.has(r.stock_id)):day);}catch(e){console.error(t('異動雷達失敗：')+e.message);}
}
setInterval(()=>{
  if(settings.monitor===false||!liveWindow()||!data.has('snapshot')||Date.now()<monitorPauseUntil||livePending)return;
  if(liveHeat&&Date.now()-liveHeat.at<snapPlan().every-1500)return;
  liveHeatmap().catch(e=>{monitorError=e.message;if(e.code==='no-live')monitorPauseUntil=Date.now()+10*60e3;else if(blocked(e))monitorPauseUntil=Date.now()+30*60e3;});
},2000).unref();

/* ---------- 盤中即時推播（WebSocket，例如富果）＋當沖監控 ---------- */
// 完整模式（例如富果進階方案）：每檔訂閱逐筆成交、1 分 K、五檔（3 個訂閱），依代號分成兩條連線，由當沖引擎整理成每檔的即時狀態；
// 精簡模式（開發者／基本方案，或訂閱數不足）：每檔 1 個聚合行情訂閱。兩種模式都驅動異動雷達與即時看板；熱浪圖、時光機仍用上面的快照。
// 訂閱順序：自選股優先，再來是研究名單；超過方案上限時只訂閱前面的股票。
// 連線且最近 75 秒內收過訊息（資料或伺服器心跳）才算運作中；個股沒成交時沿用最後一筆
const streamFresh=()=>!!stream&&streamState.connected&&Date.now()-(streamState.alive||0)<75e3;
const streamFor=id=>streamFresh()?streamRows.get(id):null;
// 行情時間：快照與推播取較新者
const liveAsOf=()=>{const a=lastSnap?.asOf||'',b=streamFresh()?streamAsOf:'';return(a>b?a:b)||null;};
// 某股某日最新的盤中資料：推播與快照取時間較新的一筆
function liveRow(id,date){
  const s=streamFor(id),f=lastSnap&&(!date||lastSnap.date===date)?lastSnap.byId.get(id):null;
  return s&&(!date||String(s.date).slice(0,10)===date)&&(!f||String(s.date)>=String(f.date))?s:f;
}
// 推播資料沒有昨量：用快照的昨量，或本機日 K 前一交易日的量（爆量判斷用）
function yesterdayVolume(id,date){
  if(yvCache.date!==date)yvCache={date,map:new Map()};
  if(!yvCache.map.has(id)){let v=Number(lastSnap?.byId.get(id)?.yesterday_volume);if(!(v>0)){const d=localDaily(id).filter(r=>r[0]<date).at(-1);v=d?Number(d[5]):0;}yvCache.map.set(id,v>0?v:null);}
  return yvCache.map.get(id);
}
function onStreamRows(rows){
  const date=today(),fresh=rows.filter(r=>String(r.date).slice(0,10)===date);
  if(streamDate!==date){streamDate=date;streamRows=new Map();streamAsOf='';}
  for(const r of fresh){r.yesterday_volume=yesterdayVolume(r.stock_id,date);streamRows.set(r.stock_id,r);if(String(r.date)>streamAsOf)streamAsOf=String(r.date);}
  streamState={...streamState,lastAt:Date.now()};
  if(fresh.length)try{runRadar(date,fresh);}catch(e){console.error(t('異動雷達失敗：')+e.message);}
}
// 即時推播訂閱的股票：自選、當沖觀察名單、研究族群、價格提醒；排在前面的優先（方案訂閱數不足時後面的不訂閱）
const streamUniverse=()=>[...new Set([...watchlist,...(dtSettings().enabled?dtScanIds():[]),...scopeIds(researchScope),...ruleIds()])];
// 當沖觀察名單：前一日全市場高周轉率個股＋全部研究族群（可在設定各自開關，也可加入自選）。
// 高周轉率名單來自盤前準備的排行（dtPrep.data.turnover），依設定取成交金額達下限的前 N 名；勾選「只對可當沖股票」時先排除不可當沖、處置與暫停交易
let dtPickCache={key:'',list:[]};
function dtTurnoverList(){
  const s=dtSettings(),d=dtPrep.date===today()?dtPrep.data:null,tv=d?.turnover;
  if(!s.sources.turnover||!tv?.list?.length)return[];
  const key=[dtPrep.at,d.date,s.turnoverTop,s.turnoverMinAmount,s.eligibleOnly].join('|');
  if(dtPickCache.key!==key){
    const el=s.eligibleOnly&&d.eligible?new Set(d.eligible):null,exclude=new Set(s.eligibleOnly?[...(d.disposition||[]),...(d.suspended||[])]:[]);
    dtPickCache={key,list:selectTurnover(el?tv.list.filter(x=>el.has(x.id)):tv.list,{top:s.turnoverTop,minAmount:s.turnoverMinAmount,exclude})};
  }
  return dtPickCache.list;
}
const dtScanIds=()=>{const s=dtSettings().sources;return[...new Set([...(s.watchlist?watchlist:[]),...dtTurnoverList().map(x=>x.id),...(s.groups?scopeIds(researchScope):[])])];};
// 開盤前 10 分鐘先連線並確認訂閱（台股 08:50），收盤集合競價結束後關閉
const feedWindow=()=>{const p=M(),x=clock();return x.weekday>=1&&x.weekday<=5&&x.minute>=p.open-10&&x.minute<p.close+p.settle;};
const dtSettings=()=>normalizeDaytrade(settings.daytrade);
// 訂閱規劃：方案（自動時付費方案先試進階，訂閱不足則今天改用開發者）、模式、頻道、股票與連線分組
function streamPlanNow(p,dtReady=true){
  const s=dtSettings(),want=s.plan==='auto'?(dtFallback===today()?'developer':'advanced'):s.plan;
  const planId=p.stream.plan?p.stream.plan(providerInfo()[p.id],want):'developer',plan=p.stream.plans?.[planId]||{limit:300,connections:1,perMinute:600},all=streamUniverse();
  // 完整模式（逐筆＋1 分 K＋五檔，每檔 3 個訂閱）：自選與當沖觀察名單都放得下才使用，否則用精簡模式（每檔 1 個）讓觀察名單都有報價
  const full=s.enabled&&dtReady&&dtFallback!==today()&&!!p.stream.channels?.full&&Math.max(watchlist.length,dtScanIds().length)*p.stream.channels.full.length<=plan.limit;
  const channels=full?p.stream.channels.full:(p.stream.channels?.lite||['aggregates']),ids=all.slice(0,Math.floor(plan.limit/channels.length));
  const groups=full&&plan.connections>1&&ids.length>1?splitSymbols(ids,plan.connections):[ids];
  // 五檔錄製器加錄：用剩下的訂閱數（保留 50 個餘裕），依代號固定分到各連線
  const slots=bookSlots(plan.limit-ids.length*channels.length),extra=slots>0?bookExtras(new Set(ids),slots):[];
  const ex=spreadSymbols(extra,groups.length),book=p.stream.channels?.book||['books'];
  return{planId,plan,full,channels,ids,total:all.length,slots,extra,groups:groups.map((symbols,i)=>({symbols,channels,extra:{symbols:ex[i]||[],channels:book}}))};
}
async function streamTick(){
  const p=data.pick('stream');
  if(settings.monitor===false||!feedWindow()||!p){if(stream){stream.close();stream=null;}if(bookRec){const r=bookRec;bookRec=null;r.close();}streamState={...streamState,connected:false,provider:p?.id||null};return;}
  bookPrepare(today());
  // 當沖引擎建立失敗時不影響推播：改用精簡模式（聚合行情）讓雷達與看板照常運作
  let dtReady=false,dtError='';
  if(dtSettings().enabled){try{ensureDt();dt.engine.syncIds(streamUniverse());refreshDtMeta(streamUniverse());dtReady=true;}catch(e){dtError=e.message;console.error(t('當沖監控計算失敗：')+e.message);}}
  const plan=streamPlanNow(p,dtReady);
  subscribedIds=new Set(plan.ids);
  if(dtReady){const e=dt.engine;dtHistory.load({ids:dtScanIds().filter(id=>subscribedIds.has(id)),date:dt.date,source:p.id,engine:e,active:()=>dt?.engine===e&&feedWindow(),interval:Math.ceil(60000/plan.plan.perMinute)+10}).catch(()=>{});}
  if(stream&&streamState.provider!==p.id){stream.close();stream=null;}
  streamState={...streamState,dtError};
  const meta={provider:p.id,mode:plan.full?'full':'lite',plan:plan.planId,limit:plan.plan.limit,perMinute:plan.plan.perMinute,total:plan.total};
  if(!stream){
    const key=await getSecret(p.id,p.keyEnv);if(!key)return;
    streamState={...meta,connected:false,symbols:plan.ids.length,subscribed:0,expected:plan.ids.length*plan.channels.length,lastAt:0,alive:0,error:'',since:0,resumed:0,connections:[]};
    stream=createStreamPool({spec:p.stream,key,market:M(),groups:plan.groups,flushMs:500,onEvents:onStreamEvents,onEvent:ev=>{onBookEvent(ev);if(ev.kind==='book'&&subscribedIds.has(ev.id))dt?.engine.ingest([ev]);},onStatus:onStreamStatus});
  }else{streamState={...streamState,...meta};stream.update(plan.groups);}
  bookStart(plan);
  // 自動判斷方案：完整模式連線 15 秒後訂閱仍不足（方案上限不夠），今天改用精簡模式
  if(plan.full&&dtSettings().plan==='auto'&&streamState.connected&&streamState.since&&Date.now()-streamState.since>15e3&&streamState.subscribed<streamState.expected){dtFallback=today();console.log(t('即時推播訂閱數不足，今天改用精簡模式（聚合行情）'));}
}
setInterval(()=>{streamTick().catch(e=>{streamState={...streamState,error:e.message};});},5000).unref();
// 即時推播斷線紀錄（今天）：時間、哪條連線、原因；畫面顯示次數與最近一次，供排查
let streamDrops={date:'',list:[]};
function onStreamStatus(s){
  if(streamState.connected&&s.connected===false){const d=today();if(streamDrops.date!==d)streamDrops={date:d,list:[]};const down=(s.connections||[]).map((c,i)=>c.connected?null:i+1).filter(Boolean);streamDrops.list.push({at:Date.now(),conns:down,reason:s.error||'close'});if(streamDrops.list.length>50)streamDrops.list.shift();console.log(t('即時推播斷線：連線 {conns}（{reason}）',{conns:down.join('、')||'—',reason:s.error||'close'}));}
  const prev=streamState.since;streamState={...streamState,...s};
  if(!s.connected&&dt){dt.engine.setFeed(false);dt.engine.markGap([...subscribedIds]);}
  // 盤中才連上或斷線重連：補資料完成前暫停訊號（盤前連線不需要）
  if(s.since&&s.since!==prev&&dt?.date===today()&&dt.engine.phase(Date.now())!=='pre')backfillAll();
  if(s.resumed&&bookDay.date===today()&&!bookDay.gap){bookDay.gap=true;saveBookMeta();} // 錄製有缺口：收盤後以 REST 補齊逐筆成交
}
// 推播事件：有當沖引擎時由引擎整理成快照列；沒有時（精簡模式且未開啟當沖監控）直接用聚合行情。
// 五檔錄製器加錄的股票只用於錄製，不進入當沖引擎與雷達
function onStreamEvents(all){
  const ex=bookDay.extraSet,events=ex?.size?all.filter(x=>!ex.has(x.id)):all;
  const e=dt?.date===today()?dt.engine:null;
  if(e){const changed=e.ingest(events.filter(x=>x.kind!=='book'));onStreamRows([...changed].map(id=>e.row(id)).filter(Boolean));}
  else onStreamRows(events.filter(x=>x.kind==='agg').map(x=>x.row));
}
const streamInfo=()=>({capable:data.has('stream'),provider:streamState.provider,active:streamFresh(),connected:streamState.connected,mode:streamState.mode||null,plan:streamState.plan||null,symbols:streamState.symbols,subscribed:streamState.subscribed,expected:streamState.expected||0,connections:streamState.connections||[],limit:streamState.limit,lastAt:streamState.lastAt||null,error:streamState.error,authFailed:!!streamState.authFailed,since:streamState.since||null,drops:streamDrops.date===today()?streamDrops.list.slice(-10):[],dropCount:streamDrops.date===today()?streamDrops.list.length:0,total:new Set([...watchlist,...scopeIds(researchScope)]).size});

/* ---------- 五檔錄製器 ---------- */
// 推播清單（研究名單＋自選）的五檔與逐筆成交本來就有訂閱，直接錄製；另用剩下的訂閱數「加錄」其他活躍股票的五檔。
// 開盤前依時光機近 20 日平均成交金額挑選加錄清單；盤中檢查點（開盤後 5 分鐘起每 30 分鐘）把冷清的換成爆量、大漲跌或族群轉強的股票；
// 收盤後以 REST 補齊加錄股票（及推播曾中斷時全部股票）的逐筆成交，整理成每檔一個檔案，保留最近 N 個交易日。
const bookSettings=()=>normalizeBooks(settings.books);
function bookSlots(spare){const s=bookSettings();return s.enabled?Math.max(0,Math.min(s.extra,spare-50)):0;}
function bookPrepare(date){
  if(bookDay.date===date||!bookSettings().enabled)return;
  const m=readMeta(BOOKS,date),p=M();let liq=null;
  try{const list=[];for(const d of listDays().filter(d=>d<date).slice(-20)){const x=loadDay(d);if(x)list.push(reduceDay(x,p));}if(list.length)liq=buildLiquidity(list,p);}catch(e){bookError=t('五檔錄製器選股失敗：')+e.message;}
  bookDay={date,liq,extras:m?.extras||(liq?null:[]),initial:m?.initial||null,ever:new Set(m?.ever||[]),swaps:m?.swaps||[],checks:new Set(m?.checks||[]),gap:!!m?.gap,main:m?.main||[],current:[],slots:0,extraSet:new Set(),fill:null};
}
function saveBookMeta(){
  const d=bookDay;if(!d.date)return;
  try{writeMeta(BOOKS,d.date,{date:d.date,main:d.main,initial:d.initial,extras:d.extras,ever:[...d.ever],swaps:d.swaps,checks:[...d.checks],gap:!!d.gap,compacted:false});}catch(e){bookError=e.message;}
}
// 今天的加錄清單：第一次用到時依平均成交金額挑選（股票清單內的普通股）
function bookExtras(main,slots){
  if(bookDay.date!==today())return[];
  if(!bookDay.extras){const {ids}=uniIndex();bookDay.extras=bookDay.liq?pickExtras(bookDay.liq,main,slots,ids.size?ids:null):[];bookDay.initial=[...bookDay.extras];saveBookMeta();}
  return bookDay.extras.filter(id=>!main.has(id)).slice(0,slots);
}
function bookStart(plan){
  if(!bookSettings().enabled||bookDay.date!==today()){if(bookRec){const r=bookRec;bookRec=null;r.close();}return;}
  if(!bookRec){
    try{bookRec=createBookRecorder({dir:BOOKS,date:today()});bookError='';}catch(e){bookError=e.message;return;}
    // 開盤後才開始錄（盤中重新啟動、金鑰修復後）：推播清單的逐筆也有缺口，收盤後一併以 REST 補齊
    if(clock().minute>M().open&&!bookDay.gap){bookDay.gap=true;saveBookMeta();}
  }
  const main=new Set(plan.ids);let added=false;for(const id of plan.extra)if(!bookDay.ever.has(id)){bookDay.ever.add(id);added=true;}
  bookDay.extraSet=new Set([...bookDay.ever].filter(id=>!main.has(id)));bookDay.current=plan.extra;bookDay.slots=plan.slots;
  if(added||String(plan.ids)!==String(bookDay.main)){bookDay.main=plan.ids;saveBookMeta();}
}
function onBookEvent(e){bookRec?.record(e);}
// 盤中檢查點換股（依全市場即時快照：累計成交金額、漲跌幅，與近 5 日同時點平均比較）
function bookSwap(){
  const s=bookSettings(),date=today();
  if(!s.enabled||!s.swap||bookDay.date!==date||!bookDay.extras||!bookRec||!lastSnap||lastSnap.date!==date)return;
  const hm=/(\d{2}):(\d{2})/.exec(String(lastSnap.asOf||'').slice(11));if(!hm)return;
  const p=M(),el=Number(hm[1])*60+Number(hm[2])-p.open,due=checkpoints(p).filter(m=>m<=el&&!bookDay.checks.has(m));if(!due.length)return;
  for(const m of due)bookDay.checks.add(m);
  const cp=due.at(-1),rows=new Map(lastSnap.rows.map(r=>[r.stock_id,{amount:Number(r.total_amount)||0,change:Number(r.change_rate)||0}]));
  const {meta}=uniIndex(),sectorOf=id=>{const x=meta.get(id)?.sector;return x&&x!=='未分類'?x:'';},main=new Set(bookDay.main);
  const r=swapExtras({extras:bookDay.extras.filter(id=>!main.has(id)),exclude:main,rows,base:bookDay.liq?.at.get(cp),sectorOf,slots:bookDay.slots||0});
  bookDay.extras=r.next;bookDay.swaps.push({at:String(lastSnap.asOf).slice(11,19),cp,added:r.added,dropped:r.dropped,sectors:r.sectors});saveBookMeta();
  if(r.added.length)console.log(t('五檔錄製器換股：加錄 {a} 檔、移除 {d} 檔',{a:r.added.length,d:r.dropped.length}));
}
// 收盤後整理：今天的錄製先以 REST 補齊逐筆成交；之前未整理完的日子（例如收盤時沒開機）直接整理
async function bookFinish(){
  if(bookBusy||bookRec)return;
  const x=clock(),p=M(),date=today();
  for(const d of listBookDays(BOOKS)){
    const m=readMeta(BOOKS,d)||{date:d};
    if(m.compacted){if(exportDue(m))await bookExport(d);continue;}
    if(d===date&&(feedWindow()||x.minute<p.close+p.settle+1))continue;
    bookBusy=true;
    try{
      if(d===date&&data.has('stream')){
        const ids=[...new Set([...(m.ever||[]),...(m.gap?m.main||[]:[])])],interval=Math.ceil(60000/(streamState.perMinute||600))+10;
        if(bookDay.date===d)bookDay.fill={done:0,total:ids.length};
        const rec=createBookRecorder({dir:BOOKS,date:d});
        try{for(const id of ids){try{for(const e of await data.streamTrades(id,{interval})||[])rec.record(e);}catch(e){bookError=e.message;if(blocked(e))break;}if(bookDay.date===d)bookDay.fill.done++;}}finally{await rec.close();}
      }
      const stocks=await compactDay(BOOKS,d);
      fs.writeFileSync(path.join(BOOKS,d,'index.json'),JSON.stringify(stocks));
      writeMeta(BOOKS,d,{...(readMeta(BOOKS,d)||m),compacted:true,stocks:Object.keys(stocks).length,at:new Date().toISOString()});
      pruneDays(BOOKS,bookSettings().keepDays);
    }finally{bookBusy=false;}
    if(exportDue(readMeta(BOOKS,d)||{}))await bookExport(d);
  }
}
// 每日匯出：整理完成後寫成 ZIP（每檔 CSV）到設定的匯出資料夾（例如 Dropbox 同步資料夾）；失敗時 1 小時後或改了資料夾再試
const exportDue=m=>{const dir=bookSettings().exportDir;return!!dir&&!!m.compacted&&!m.exported&&(!m.exportError||m.exportDirTried!==dir||Date.now()-(m.exportTriedAt||0)>3600e3);};
let bookExporting='';
async function bookExport(d){
  const dir=bookSettings().exportDir;if(!dir)return;
  bookBusy=true;bookExporting=d;
  try{const r=await exportDay(BOOKS,d,dir,bookStocks(d)||[],{tz:M().tz});writeMeta(BOOKS,d,{...readMeta(BOOKS,d),exported:{file:r.file,bytes:r.bytes,entries:r.entries,at:new Date().toISOString()},exportError:null});console.log(t('五檔成交已匯出：{file}',{file:r.file}));}
  catch(e){bookError=t('五檔匯出失敗：')+e.message;writeMeta(BOOKS,d,{...readMeta(BOOKS,d),exportError:e.message,exportTriedAt:Date.now(),exportDirTried:dir});}
  finally{bookBusy=false;bookExporting='';}
}
setInterval(()=>{try{bookSwap();}catch(e){bookError=e.message;}bookFinish().catch(e=>{bookError=e.message;});},20e3).unref();
function bookInfo(){
  const d=bookDay.date===today()?bookDay:null;
  const days=listBookDays(BOOKS).reverse().map(x=>{const m=readMeta(BOOKS,x)||{};return{date:x,compacted:!!m.compacted,exported:m.exported?{file:m.exported.file,bytes:m.exported.bytes,at:m.exported.at}:null,exportError:m.exportError||null,stocks:m.stocks??null,main:(m.main||[]).length,extra:(m.ever||[]).length,swaps:(m.swaps||[]).length,gap:!!m.gap};});
  return{settings:bookSettings(),recording:!!bookRec,stats:bookRec?.stats||null,busy:bookBusy,exporting:bookExporting||null,error:bookError,days,
    today:d?{main:d.main.length,extras:d.current.length,ever:d.ever.size,slots:d.slots,subscribed:streamState.extraSubscribed||0,liquidityDays:d.liq?.days||0,swaps:d.swaps.slice(-10),gap:!!d.gap,fill:d.fill}:null};
}
function bookStocks(date){
  const m=readMeta(BOOKS,date);if(!m)return null;
  let idx=null;try{idx=JSON.parse(fs.readFileSync(path.join(BOOKS,date,'index.json'),'utf8'));}catch{}
  const {meta}=uniIndex(),main=new Set(m.main||[]),ids=idx?Object.keys(idx):[...new Set([...(m.main||[]),...(m.ever||[])])];
  return ids.sort().map(id=>({id,name:meta.get(id)?.name||id,sector:meta.get(id)?.sector||'',main:main.has(id),...(idx?.[id]||{})}));
}

/* ---------- 當沖監控 ---------- */
function refreshDtMeta(ids){
  const {meta}=uniIndex(),groups=new Map();
  for(const g of researchScope.groups)for(const id of g.stockIds){if(!groups.has(id))groups.set(id,[]);groups.get(id).push(g.id);}
  const rate=new Map(dtTurnoverList().map(x=>[x.id,x.rate]));
  for(const id of ids)dtMeta.set(id,{name:meta.get(id)?.name||id,groups:groups.get(id)||[],exchange:meta.get(id)?.market||null,turnover:rate.get(id)??null});
}
// 盤前資料：可當沖資格、處置、暫停交易、參考價（盤前資料沒有時用本機日 K 的前一日收盤）
function dtPrepFor(date,ids){
  const d=dtPrep.date===date?dtPrep.data:null,ref=new Map(Object.entries(d?.ref||{}));
  for(const id of ids){if(ref.has(id))continue;const last=localDaily(id).filter(r=>r[0]<date).at(-1);if(last?.[4]>0)ref.set(id,last[4]);}
  return{eligible:d?.eligible?new Set(d.eligible):null,disposition:new Set(d?.disposition||[]),suspended:new Set(d?.suspended||[]),sellFirstOff:new Set(d?.sellFirstOff||[]),ref};
}
function ensureDt(){
  const date=today();if(dt?.date===date)return dt.engine;
  dtHistory.reset();
  const ids=streamUniverse();refreshDtMeta(ids);
  const engine=createDayTrade({market:M(),date,ids,meta:dtMeta,watch:new Set(watchlist),scan:new Set(dtScanIds()),prep:dtPrepFor(date,ids),settings:settings.daytrade,offset:tzOffset(M().tz),lang:language()});
  engine.restore(read(`daytrade/${date}.json`,null)?.signals);
  dt={date,engine};return engine;
}
// 前一交易日全市場周轉率排行（當沖觀察名單用）：成交量與成交金額取自熱浪圖紀錄，沒有紀錄時查一次全市場單日行情；
// 股數取最近一份集保股權分散表。交易日曆只有平日清單時可能遇到假日，往前最多找 6 個交易日
async function dtTurnover(date){
  const lot=M().lot;let cal=[];try{cal=(await tradingDates()).filter(d=>d<date);}catch{}
  const days=[...new Set([...cal.slice(-6),...heatFiles().filter(d=>d<date).slice(-1)])].sort().reverse();
  for(const d of days){
    let h=read('heatmap-'+d+'.json',null);
    if(!h&&data.has('dailyAll')&&!heatBusy&&!job.running){try{const r=await runHeatmap(d);if(r?.date===d)h=r;}catch{}}
    const volumes={},amounts={};for(const sec of h?.sectors||[])for(const x of sec.stocks||[])if(x.volume>0){volumes[x.id]=x.volume*lot;amounts[x.id]=x.money;}
    if(h?.scope==='research'||!Object.keys(volumes).length)continue; // 只有研究名單的熱浪圖不是全市場資料，不能拿來排行
    const sh=await holderShares(d),list=rankTurnover({volumes,amounts,shares:sh.shares,allow:uniIndex().ids});
    if(list.length)return{date:d,sharesDate:sh.date,list};
  }
  return null;
}
// 盤前（台股 08:30 起）：FinMind 的可當沖標的、暫停交易、暫停先賣後買、參考價；證交所／櫃買的處置股；前一交易日周轉率排行
async function dtPrepare(){
  const date=today();if(dtPrep.busy)return;
  dtPrep={...dtPrep,busy:true};const errors=[];let fin=null,disp=null,otc=null;
  try{if(data.has('dayTrade'))fin=await data.dayTrade(date);}catch(e){errors.push(e.message);}
  try{if(M().id==='TW')disp=await dispositions(date);}catch(e){errors.push(e.message);}
  // 上櫃可當沖標的：FinMind 清單只有上市，另向櫃買中心取得（尚未公布時稍後重試）
  try{if(M().id==='TW')otc=await tpexDayTrade(date);}catch(e){errors.push(e.message);}
  const eligible=fin?.eligible||otc?.eligible?[...new Set([...(fin?.eligible||[]),...(otc?.eligible||[])])]:null;
  // 周轉率排行當天只需取得一次（重試可當沖清單時沿用）
  let turnover=dtPrep.data?.date===date?dtPrep.data.turnover||null:null;
  if(!turnover&&M().id==='TW'){try{turnover=await dtTurnover(date);if(!turnover)errors.push(t('前一交易日的全市場行情或集保股數尚未取得，高周轉率名單暫時是空的'));}catch(e){errors.push(e.message);}}
  const d={date,turnover,eligible,tpex:otc?otc.eligible.length:null,suspended:fin?.suspended||[],sellFirstOff:[...new Set([...(fin?.sellFirstOff||[]),...(otc?.sellFirstOff||[])])],ref:fin?.ref||{},disposition:disp?.ids||[],errors:[...errors,...(fin?.errors||[]),...(disp?.errors||[])],source:data.source('dayTrade'),at:new Date().toISOString()};
  dtPrep={date,busy:false,data:d,at:Date.now()};write('daytrade-prep.json',d);
  if(dt?.date===date){refreshDtMeta(dt.engine.ids);dt.engine.setPrep(dtPrepFor(date,dt.engine.ids));}
}
// 斷線重連（或盤中才啟動）後以 REST 補資料：自選股優先；單一執行，兩條連線同時重連只補一次
async function backfillAll(onlyGaps=false){
  const e=dt?.engine;if(!e)return;
  if(backfill.busy){if(Date.now()-backfill.started>30e3)backfill.again=true;return;}
  const ids=[...new Set([...dtScanIds(),...e.ids])].filter(id=>subscribedIds.has(id)&&(!onlyGaps||e.gaps.has(id)));
  e.markGap(ids);backfill={busy:true,again:false,started:Date.now(),done:0,total:ids.length,error:''};
  const interval=Math.ceil(60000/(streamState.perMinute||600))+10;
  try{for(const id of ids){if(dt?.engine!==e||!feedWindow())break;try{const value=await data.streamBackfill(id,{interval});if(dt?.engine!==e)break;e.backfill(id,value||{});const r=e.row(id);if(r)onStreamRows([r]);}catch(x){backfill.error=x.message;if(blocked(x))break;}backfill.done++;}}
  finally{backfill.busy=false;if(backfill.again)setTimeout(()=>backfillAll().catch(()=>{}),1000).unref();}
}
// 大盤環境紀錄（當沖，只記錄、不影響訊號）：快照中的加權（001）、櫃買（101）指數每 10 秒餵入引擎；全市場快照另提供上市／上櫃漲跌家數
function dtIndexFromSnapshot(rows,heat){
  const e=dt?.date===heat.date?dt.engine:null;if(!e||M().id!=='TW')return;
  const whole=data.snapshotMode()!=='symbols',now=Date.now();
  for(const [key,id] of [['twse','001'],['tpex','101']]){
    const r=rows.find(x=>x.stock_id===id&&String(x.date).slice(0,10)===heat.date),ix=indexRow(r);
    if(ix?.close>0)e.indexSample(key,{at:Date.parse(String(r.date).slice(0,19).replace(' ','T')+'+08:00'),price:ix.close,ref:ix.change!=null?ix.close-ix.change:null,source:'snapshot'});
    const b=heat.total?.[key];if(whole&&b?.count)e.indexBreadth(key,{up:b.up,down:b.down,at:now});
  }
}
// 快照沒有指數（例如快照來自富果）或服務盤中才啟動、缺少開盤後的資料時，改向富果取指數報價與當日 1 分 K：
// 每個指數每分鐘最多 1 次（報價＋1 分 K 共 2 個請求，與指數詳細資訊共用快取）；取不到時 5 分鐘後再試
const dtIndexPoll={at:{},until:0};
async function dtIndexFallback(){
  const e=dt?.date===today()?dt.engine:null,x=clock(),p=M(),now=Date.now();
  if(!e||p.id!=='TW'||!data.has('stream')||x.minute<p.open+1||x.minute>=p.close||now<dtIndexPoll.until)return;
  for(const [key,id] of [['twse','TAIEX'],['tpex','TPEX']]){
    if((e.indexAge(key,now)<90e3&&e.indexHasOpen(key))||now-(dtIndexPoll.at[key]||0)<60e3)continue;
    dtIndexPoll.at[key]=now;
    const r=await indexReport(id);
    if(r?.source!=='fugle'||!r.minutes.m.length){dtIndexPoll.until=now+5*60e3;return;}
    const at=r.quote.time?Date.parse(`${r.date}T${r.quote.time}+08:00`):now;
    e.indexSeries(key,{ref:r.ref,price:r.quote.last,at,minutes:r.minutes.m.map((m,i)=>[m,r.minutes.c[i]]),source:'fugle'});
  }
}
function saveDtLog(extra={}){if(!dt)return;fs.mkdirSync(path.join(LOCAL,'daytrade'),{recursive:true});write(`daytrade/${dt.date}.json`,{date:dt.date,mode:streamState.mode||null,plan:streamState.plan||null,signals:dt.engine.signals,...extra});}
// 收盤後：以分 K 檢討今天每個訊號（扣除滑價、手續費、證交稅）
function dtClose(){
  const costs=dtSettings().costs,e=dt.engine;
  const signals=e.signals.map(s=>({...s,outcome:evaluateSignal(s,e.bars(s.id),M(),costs)}));
  fs.mkdirSync(path.join(LOCAL,'daytrade'),{recursive:true});write(`daytrade/${dt.date}.json`,{date:dt.date,mode:streamState.mode||null,plan:streamState.plan||null,costs,signals,closedAt:new Date().toISOString()});dtSaved=dt.date;
}
// 每秒：更新分數與排名、偵測訊號（訊號進入異動雷達並推播到手機）
setInterval(()=>{
  if(!dt||dt.date!==today()||!feedWindow())return;
  const e=dt.engine;e.setFeed(streamFresh()&&streamState.subscribed>=streamState.expected);e.setWatch(new Set(watchlist));e.setScan(new Set(dtScanIds()));
  const count=e.signals.length;let alerts=[];try{alerts=e.tick(Date.now());}catch(x){console.error(t('當沖監控計算失敗：')+x.message);}
  if(alerts.length)addAlerts(today(),alerts);
  if(alerts.length||e.signals.length!==count)saveDtLog();
},1000).unref();
// 每 20 秒：盤前準備（08:30 起；可當沖清單未公布時 10 分鐘後再試）、收盤後檢討
setInterval(()=>{
  const x=clock(),p=M();if(!data.has('stream')||!dtSettings().enabled||x.weekday<1||x.weekday>5)return;
  const date=today();
  if(dt?.date===date&&dt.engine.gaps.size&&streamState.connected&&Date.now()-backfill.started>60000)backfillAll(true).catch(()=>{});
  dtIndexFallback().catch(()=>{});
  if(x.minute>=p.open-30&&x.minute<p.close&&(dtPrep.date!==date||((!dtPrep.data?.eligible||(M().id==='TW'&&(dtPrep.data?.tpex==null||!dtPrep.data?.turnover)))&&Date.now()-dtPrep.at>10*60e3&&x.minute<p.open+30)))dtPrepare().catch(()=>{dtPrep={...dtPrep,busy:false};});
  if(x.minute>=p.close+p.settle+1&&dt?.date===date&&dtSaved!==date)try{dtClose();}catch(e){console.error(t('當沖訊號檢討失敗：')+e.message);}
},20e3).unref();
const PHASES={pre:'盤前',opening:'開盤觀察',scan:'掃描中',stop:'停止新訊號',auction:'收盤集合競價',closed:'收盤'};
function dtInfo(){
  const s=dtSettings(),p=data.pick('stream'),n=streamUniverse().length,scanIds=dtScanIds(),e=dt?.date===today()?dt.engine:null,r=e?.ranking(),pd=dtPrep.date===today()?dtPrep.data:null;
  const plan=p?.stream?.plan?p.stream.plan(providerInfo()[p.id],s.plan==='auto'?(dtFallback===today()?'developer':'advanced'):s.plan):null;
  const hs=dtHistory.status(scanIds),rows=(r?.list||[]).filter(x=>x.scan),picks=dtTurnoverList(),tv=pd?.turnover;
  return{enabled:s.enabled,capable:!!p,provider:p?.id||null,settings:s,cost:Math.round(roundTripCost(s.costs)*1000)/1000,
    history:{total:hs.length,ready:hs.filter(x=>x.status==='ready').length,short:hs.filter(x=>x.status==='incomplete').length,errors:hs.filter(x=>x.error).slice(0,3).map(x=>({id:x.id,error:x.error}))},
    // 觀察名單的組成（同一檔可能同時屬於兩種來源）
    sources:{total:scanIds.length,subscribed:scanIds.filter(id=>subscribedIds.has(id)).length,turnover:picks.length,groups:s.sources.groups?scopeIds(researchScope).length:0,watchlist:s.sources.watchlist?watchlist.length:0},
    need:{symbols:n,watched:watchlist.length,scanned:scanIds.length,full:n*(p?.stream?.channels?.full?.length||3),lite:n},plans:p?.stream?.plans||null,plan,fallback:dtFallback===today(),
    feed:{...streamInfo(),window:feedWindow(),backfill:{busy:backfill.busy,done:backfill.done,total:backfill.total,error:backfill.error},pending:e?e.gaps.size:0},
    prep:pd?{date:pd.date,eligible:pd.eligible?pd.eligible.length:null,tpex:pd.tpex??null,disposition:pd.disposition.length,suspended:pd.suspended.length,sellFirstOff:pd.sellFirstOff.length,ref:Object.keys(pd.ref||{}).length,
      turnover:tv?{date:tv.date,sharesDate:tv.sharesDate,ranked:tv.list.length,picked:picks.length,minRate:picks.at(-1)?.rate??null}:null,errors:pd.errors,at:pd.at}:null,
    phase:e&&feedWindow()?e.phase(Date.now()):null,phaseName:e&&feedWindow()?PHASES[e.phase(Date.now())]:null,
    asOf:r?.at||null,marketChange:r?.marketChange??null,market:e&&feedWindow()?e.marketState(Date.now()):null,
    counts:r?.counts||null,excluded:r?.excluded||{},top:rows.slice(0,s.top),total:scanIds.length,listed:rows.length,
    signals:(e?.signals||[]).slice(-60).reverse().map(({type,side,id,name,t,price,detail,turnover,bar})=>({type,side,id,name,t,price,detail,turnover:turnover??null,bar:bar?{close:bar.close,ma20:bar.ma20,openLow:bar.openLow}:null})),signalCount:e?.signals.length||0};
}
// 個股即時走勢（手機版與電腦版點個股）：每分鐘價量、當日均價線、所屬族群均價線、五檔、最近成交。
// 來源依序：當沖引擎的即時推播（逐筆、1 分 K、五檔）→ 富果盤中 REST（未訂閱即時推播的股票；3 次請求，3 秒內共用）→ 時光機每分鐘畫格。
const restQuoteCache=new Map();
async function restQuote(id){
  const c=restQuoteCache.get(id);if(c&&Date.now()-c.at<3000)return c.data;
  if(!data.pick('stream')?.quoteDetail||!liveWindow()&&c)return c?.data||null;
  try{const d=await data.streamQuote(id,{interval:40});restQuoteCache.set(id,{at:Date.now(),data:d});if(restQuoteCache.size>200)restQuoteCache.delete(restQuoteCache.keys().next().value);return d;}catch{return c?.data||null;}
}
const usHms=v=>{const n=Number(v);if(!(n>0))return null;return new Date((n>1e14?n/1000:n>1e11?n:n*1000)+tzOffset(M().tz)).toISOString().slice(11,19);};
async function intradayReport(id,groupId){
  const date=today(),p=M(),e=dt?.date===date?dt.engine:null,q=e?.bars(id)?.size?e.quote(id):null;
  let day=null;const replay=()=>day??=loadDay(date);
  const seriesOf=x=>{const b=e?.bars(x);if(b?.size)return{s:seriesFromBars(b,p),ref:e.quote(x)?.ref};const d=replay();return{s:seriesFromReplay(d,x,p),ref:replayRef(d,x,p)};};
  // 沒有即時推播資料的股票：富果盤中 REST
  const rest=q?null:await restQuote(id),rq=rest?.quote&&String(rest.quote.date||'')===date?rest.quote:null;
  let me=seriesOf(id),source=q?'stream':null;
  if(!q&&rq){const s=seriesFromCandles(rest.candles,p);if(s.m.length){me={s,ref:rq.referencePrice??rq.previousClose??me.ref};source='rest';}}
  if(!source)source=me.s.m.length?'replay':null;
  const s=me.s,ref=q?.ref??(rq?.referencePrice??rq?.previousClose)??me.ref??null;
  const groups=researchScope.groups.filter(g=>g.stockIds.includes(id)),g=groups.find(x=>x.id===groupId)||groups[0]||null;
  const members=g?g.stockIds.map(x=>x===id?me:seriesOf(x)).filter(x=>x.s.m.length):[];
  const line=g&&members.length>=2?groupLine(s.m,members,ref):[];
  const vw=vwapLine(s),lim=ref>0?limitPrices(p,ref):null,sum=a=>(a||[]).slice(0,5).reduce((n,l)=>n+(l.size||0),0);
  const last=q?.last??(rq?(rq.lastPrice??rq.closePrice):null)??s.c.at(-1)??null,t=rq?.total||{};
  const book=q?.book||(rq&&(rq.bids||rq.asks)?{bids:rq.bids||[],asks:rq.asks||[]}:null);
  const tape=q?(q.tape||[]).slice().reverse().map(([at,px,size,side])=>[e.hmsOf(at),px,size,side]):(rest?.trades||[]).map(x=>[usHms(x.time),x.price,x.size,x.ask>0&&x.price>=x.ask?1:x.bid>0&&x.price<=x.bid?-1:0]);
  const hmOf=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  return{id,name:uniIndex().meta.get(id)?.name||rq?.name||id,date,source,live:liveWindow()&&(source==='stream'?streamFresh():source==='rest'),open:p.open,close:p.close,ref,limitUp:lim?.up??null,limitDown:lim?.down??null,
    quote:{last,change:ref>0&&last>0?Math.round((last/ref-1)*1e4)/100:null,changePrice:ref>0&&last>0?Math.round((last-ref)*1e4)/1e4:null,open:q?.open??rq?.openPrice??s.c[0]??null,high:q?.high??rq?.highPrice??(s.c.length?Math.max(...s.c):null),low:q?.low??rq?.lowPrice??(s.c.length?Math.min(...s.c):null),
      volume:q?.cumVol||t.tradeVolume||s.cv.at(-1)||0,vwap:vw.at(-1)??q?.vwap??rq?.avgPrice??null,lastSize:q?.tape?.at(-1)?.[2]??rq?.lastTrade?.size??null,
      time:q?.lastAt?e.hmsOf(q.lastAt):rq?usHms(rq.lastUpdated??t.time):s.m.length?hmOf(s.m.at(-1)):null,atAsk:q?.atAsk??t.tradeVolumeAtAsk??null,atBid:q?.atBid??t.tradeVolumeAtBid??null},
    minutes:{m:s.m,c:s.c,v:s.v,vwap:vw.map(x=>x==null?null:Math.round(x*1e4)/1e4),group:line},
    group:g?{id:g.id,name:g.name,members:members.length,choices:groups.map(x=>({id:x.id,name:x.name}))}:null,
    book:book?{bids:(book.bids||[]).slice(0,5),asks:(book.asks||[]).slice(0,5),bidTotal:sum(book.bids),askTotal:sum(book.asks),time:q?.bookAt?e.hmsOf(q.bookAt):rq?usHms(rq.lastUpdated):null}:null,tape};
}
// 指數詳細資訊（加權指數 TAIEX＝IX0001、櫃買指數 TPEX＝IX0043）：即時報價、當日 1 分 K（量＝成交金額）、日 K、上市／上櫃漲跌家數
const INDEXES={TAIEX:{symbol:'IX0001',name:'加權指數',market:'twse'},TPEX:{symbol:'IX0043',name:'櫃買指數',market:'tpex'}};
const indexCache=new Map(),indexDailyCache=new Map();
async function indexReport(id){
  const ix=INDEXES[id],date=today(),p=M(),c=indexCache.get(id);
  if(c&&Date.now()-c.at<(liveWindow()?5000:60000))return c.data;
  let detail=null,daily=indexDailyCache.get(id)?.date===date?indexDailyCache.get(id).rows:null;
  try{detail=await data.indexDetail(ix.symbol,{interval:40});}catch{}
  if(!daily){try{const rows=await data.indexDaily(ix.symbol,minusDays(date,200),minusDays(date,1),{interval:1100});if(rows?.length){daily=rows;indexDailyCache.set(id,{date,rows});}}catch{}}
  const q=detail?.quote||null,s=seriesFromCandles(detail?.candles,p),t=q?.total||{};
  const fileIx=read(`index-${date}.json`,null)?.[ix.market]||null,heat=liveHeat?.data?.date===date?liveHeat.data:read('heatmap-'+(heatFiles().at(-1)||'')+'.json',null);
  const ref=q?.referencePrice??q?.previousClose??(fileIx?fileIx.close-fileIx.change:null),last=q?(q.lastPrice??q.closePrice):fileIx?.close??null,b=heat?.total?.[ix.market]||null;
  const out={id,name:ix.name,symbol:ix.symbol,date:q?.date||heat?.date||date,source:q?'fugle':fileIx?'snapshot':null,live:liveWindow()&&!!q,open:p.open,close:p.close,ref,
    quote:{last,change:ref>0&&last>0?Math.round((last/ref-1)*1e4)/100:null,changePrice:ref>0&&last>0?Math.round((last-ref)*100)/100:null,open:q?.openPrice??null,high:q?.highPrice??null,low:q?.lowPrice??null,
      amount:t.tradeValue??fileIx?.amount??null,volume:t.tradeVolume??null,transactions:t.transaction??null,bidVolume:t.bidVolume??null,askVolume:t.askVolume??null,bidOrders:t.bidOrders??null,askOrders:t.askOrders??null,time:q?usHms(q.lastUpdated??t.time):fileIx?.time??null},
    minutes:{m:s.m,c:s.c,v:s.v.map(v=>Math.round(v/1e6)/100),vwap:s.m.map(()=>null),group:s.m.map(()=>null)},
    breadth:b?{up:b.up,down:b.down,flat:b.flat,limitUp:b.limitUp,limitDown:b.limitDown,count:b.count,money:b.money,date:heat.date}:null,
    daily:(daily||[]).slice(-120)};
  indexCache.set(id,{at:Date.now(),data:out});return out;
}
// 今日盤勢的大盤卡：加權／櫃買指數（盤中每分鐘由快照寫入 index-日期.json）
function indexSummary(){
  let files=[];try{files=fs.readdirSync(LOCAL).filter(f=>/^index-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();}catch{}
  const f=files.at(-1);if(!f)return null;const d=read(f,null);return d?{date:f.slice(6,16),twse:d.twse||null,tpex:d.tpex||null}:null;
}
function dtReview(){
  const dir=path.join(LOCAL,'daytrade');let files=[];try{files=fs.readdirSync(dir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-60);}catch{}
  const days=files.map(f=>read(`daytrade/${f}`,null)).filter(d=>d?.closedAt);
  return{...reviewStats(days),cost:Math.round(roundTripCost(dtSettings().costs)*1000)/1000,recent:days.slice(-5).reverse().map(d=>({date:d.date,mode:d.mode,signals:d.signals.map(({type,side,id,name,t,price,score,outcome,purpose,reference,version,market})=>({purpose,side:side||null,reference,version,type,title:signalTitle({type,version}),id,name,t,price,score,outcome,market:market||null,regime:regimeOf(market),strength:strengthOf(market)}))}))};
}

/* ---------- 異動雷達 ---------- */
function alertsFor(date){if(alertsBox.date!==date)alertsBox={date,list:read(`alerts-${date}.json`,[])};return alertsBox;}
function addAlerts(date,items){
  if(!items.length)return;const box=alertsFor(date);
  for(const a of items){alertSeq=Math.max(alertSeq+1,Date.now());box.list.push({...a,seq:alertSeq,at:new Date().toISOString()});}
  if(box.list.length>3000)box.list=box.list.slice(-3000);write(`alerts-${date}.json`,box.list);
}
function radarPlanMap(){
  if(Date.now()-radarPlans.at<10*60e3)return radarPlans.map;const map=new Map();
  try{for(const s of patternSnapshot(universe).stocks)for(const m of s.matches){if(!(m.plan?.entry>0))continue;if(!map.has(s.id))map.set(s.id,[]);map.get(s.id).push({key:m.id,name:m.name,entry:m.plan.entry,entryMax:m.plan.entryMax,stop:m.plan.stop});}}catch{}
  radarPlans={at:Date.now(),map};return map;
}
function runRadar(date,rows){
  runPriceAlerts(date,rows);
  const rs=normalizeRadar(settings.radar);if(!rs.enabled)return;
  if(radarState?.date!==date)radarState=seedRadarState(createRadarState(date),alertsFor(date).list);
  addAlerts(date,scanRadar(radarState,rows,{settings:rs,meta:uniIndex().meta,watch:new Set(watchlist),research:new Set(scopeIds(researchScope)),plans:radarPlanMap(),market:M(),lang:language()}));
}

/* ---------- 自訂提醒 ---------- */
const savePriceRules=()=>write('price-alerts.json',priceRules);
function runPriceAlerts(date,rows){
  if(!priceRules.some(r=>r.active))return;
  if(ruleState?.date!==date)ruleState=createRuleState(date);
  const {alerts,changed}=scanPriceAlerts(ruleState,rows,priceRules,{meta:uniIndex().meta,watch:new Set(watchlist),market:M(),lang:language()});
  if(changed.length)savePriceRules();
  addAlerts(date,alerts);
}
// 規則清單附上名稱與最新報價（介面顯示與目前距離門檻多遠）
function priceRulesInfo(){
  const {meta}=uniIndex();
  return{rules:priceRules.map(r=>{const q=quoteOf(r.stockId);return{...r,name:meta.get(r.stockId)?.name||r.stockId,label:ruleLabel(r),close:q?.close??null,change:q?.change??null};}),max:MAX_RULES,live:!!lastSnap&&liveWindow()};
}

/* ---------- 即時看板 ---------- */
// 看板與走勢圖（含點卡片開啟的日 K／5 分 K）只用資料源的盤中快照（例如 FinMind，每 10 秒）；即時推播只給異動雷達與當沖掃描。
// 今日報價：盤中用最新快照；重新啟動後改用時光機最後一個畫格。
function replayToday(){const days=listDays(),date=days.at(-1);return date?loadDay(date):null;}
const snapRow=(id,date)=>lastSnap&&(!date||lastSnap.date===date)?lastSnap.byId.get(id)||null:null;
// 時間（HH:MM 或 HH:MM:SS）在全日交易時段中的位置（0–1，扣除午休）
const sessionPos=t=>{const m=minuteOf(t);if(m==null)return null;const p=M(),sec=Number(String(t).slice(6,8))||0;return Math.min(1,Math.max(0,(elapsedTrading(p,m)+sec/60)/(p.length||1)));};
function quoteOf(id,{board=false}={}){
  const r=board?snapRow(id):liveRow(id); // 看板只用快照；其他（例如新聞事件）用推播與快照中較新的一筆
  if(r){const close=Number(r.close),ch=Number(r.change_price),prev=close-ch,n=v=>v==null||v===''?null:Number(v);return{close,change:prev>0?Math.round(ch/prev*1e4)/100:null,changePrice:ch,open:Number(r.open),high:Number(r.high),low:Number(r.low),volume:Number(r.total_volume),amount:Number(r.total_amount),yesterdayVolume:Number(r.yesterday_volume),bid:Number(r.buy_price),ask:Number(r.sell_price),volumeAtBid:n(r.volume_at_bid),volumeAtAsk:n(r.volume_at_ask),source:r===streamFor(id)?'stream':'snapshot',time:String(r.date).slice(11,19),date:String(r.date).slice(0,10)};}
  return null;
}
function boardData(ids){
  const day=replayToday(),idx=day?new Map(day.ids.map((id,i)=>[id,i])):new Map(),m=market(),{meta}=uniIndex();
  const stocks=ids.map(id=>{
    const s=m.stocks.find(x=>x.id===id),q=quoteOf(id,{board:true}),i=idx.get(id);
    // 全日走勢圖：時光機每分鐘一點，橫軸位置＝該時間在全日交易時段中的比例（0＝開盤、1＝收盤）；最後一點換成最新快照（每 10 秒移動）
    const pts=i==null?[]:day.frames.map(f=>[sessionPos(f.t),framePrice(day,f,i)]).filter(([x,v])=>x!=null&&v>0);
    if(q?.close>0&&day?.date===q.date&&pts.length){const pt=[sessionPos(q.time),q.close];if(q.time.slice(0,5)===day.frames.at(-1)?.t)pts[pts.length-1]=pt;else if(pt[0]>=pts.at(-1)[0])pts.push(pt);}
    let quote=q;if(!quote&&i!=null&&day.frames.length){const f=day.frames.at(-1),close=framePrice(day,f,i),prev=prevPrice(day,i);if(close>0)quote={close,change:prev>0?Math.round((close/prev-1)*1e4)/100:null,changePrice:prev>0?Math.round((close-prev)*1e4)/1e4:null,amount:frameAmount(day,f,i),time:f.t,date:day.date};}
    const step=Math.max(1,Math.ceil(pts.length/135)),use=pts.filter((_,k)=>k%step===0||k===pts.length-1);
    return{id,name:s?.name||meta.get(id)?.name||id,sector:s?.sector||meta.get(id)?.sector||'',score:s?.score??null,prev:i==null?null:prevPrice(day,i),quote,daily:s?{price:s.price,change:s.change,asOf:s.asOf}:null,spark:use.map(p=>p[1]),sparkX:use.map(p=>Math.round(p[0]*1e4)/1e4)};
  });
  return{live:!!lastSnap&&liveWindow(),stream:false,asOf:lastSnap?.asOf||null,date:lastSnap?.date||day?.date||null,stocks};
}
// 看板族群切換列：研究總覽各族群目前的量能加權漲幅（與族群排名同算法；同一份快照只算一次）
function boardGroups(){
  const key=lastSnap?`s${lastSnap.at}`:`r${listDays().at(-1)||''}:${researchScope.groups.length}`;
  if(boardGroupCache.key===key)return boardGroupCache.data;
  let quotes=new Map();
  if(lastSnap)quotes=quotesFromSnapshot(lastSnap.rows,grMeta());else{const day=replayToday();if(day?.frames.length)quotes=quotesFromReplay(day,grMeta());}
  const stats=new Map(buildGroupRanking(researchScope.groups,quotes).map(g=>[g.id,g]));
  const groups=researchScope.groups.map(g=>{const s=stats.get(g.id);return{id:g.id,name:g.name,count:g.stockIds.length,score:s?.score??null,rank:s?.rank??null,up:s?.up??0,down:s?.down??0,amount:s?.amount||0};});
  boardGroupCache={key,data:groups};return groups;
}

/* ---------- 分點、大戶、K 線（依需求查詢並快取） ---------- */
async function tradingDates(){
  const d=today();if(calendarCache.date===d)return calendarCache.dates;
  const dates=await data.calendar(minusDays(d,60));
  calendarCache={date:d,dates:[...new Set(dates)].filter(x=>x<=d).sort()};return calendarCache.dates;
}
// 台股在地模組（券商分點、股權分散、期貨、融資、法人總覽）目前只有 FinMind 提供
function finmind(cap){const fm=data.finmind();if(!fm||(cap&&!supports(PROVIDERS.finmind,cap)))throw new UserError('此功能需要台股 FinMind 資料源（{cap}）',{cap:t(CAPABILITIES[cap]||cap)});return fm;}
const fmOpt=()=>({interval:settings.interval});
const insightPending=new Map();
function once(key,fn){if(!insightPending.has(key))insightPending.set(key,fn().finally(()=>insightPending.delete(key)));return insightPending.get(key);}
async function brokerReport(id,n){
  const fm=finmind('brokers'),dates=(await tradingDates()).filter(d=>d<today()||clock().hour>=21).slice(-n);
  const days=[];
  for(const date of dates){
    const name=`brokers/${id}-${date}.json`;let brokers=read(name,null);
    if(!brokers){const rows=await fm('TaiwanStockTradingDailyReport',{data_id:id,start_date:date},fmOpt());if(!rows.length)continue;brokers=aggregateBrokers(rows);fs.mkdirSync(path.join(LOCAL,'brokers'),{recursive:true});write(name,brokers);}
    days.push({date,brokers});
  }
  if(!days.length)throw new UserError('近期查無券商分點資料（每日約 21:00 公布）');
  return{...brokerAnalysis(days),tracked:chipSettings().branches.map(b=>b.id)};
}
async function holderReport(id){
  const fm=finmind('holders'),name=`holders/${id}.json`,cached=read(name,null);
  if(cached&&Date.now()-cached.at<12*3600e3)return cached.data;
  const rows=await fm('TaiwanStockHoldingSharesPer',{data_id:id,start_date:minusDays(today(),130)},fmOpt());
  const series=parseHolders(rows).slice(-16);if(!series.length)throw new UserError('查無股權分散資料');
  const result={series,signal:holderSignal(series)};fs.mkdirSync(path.join(LOCAL,'holders'),{recursive:true});write(name,{at:Date.now(),data:result});return result;
}
// 個股 K 線：日 K／5 分 K，列格式 [日期或時間, 開, 高, 低, 收, 量（顯示單位）]；5MA、20MA 由前端依完整序列計算。
// 一分 K：已收盤的交易日用資料源的分 K（存檔後不再請求）；盤中（或資料源尚未公布）改用時光機畫格＋最新快照，不額外請求。
const tickLabel=d=>{const m=/(\d{2}):(\d{2}):(\d{2})/.exec(String(d||''));if(!m)return'';const x=Number(m[1])*60+Number(m[2])+(Number(m[3])>0?1:0);return`${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`;};
async function minuteRows(id,date){
  const name=`kbar/${id}-${date}.json`,cached=read(name,null);if(cached?.bars?.length)return{rows:cached.bars,start:true,source:cached.source||'finmind'};
  const key=`${id}:${date}`,x=clock(),intraday=date===x.date&&(liveWindow()||x.minute<M().close+30);let error='';
  if(data.has('intraday')&&!intraday&&Date.now()>kbarDenied.until&&Date.now()-(kbarMiss.get(key)||0)>10*60e3){
    try{
      const bars=await data.intraday(id,date),source=data.source('intraday');
      if(bars.length){fs.mkdirSync(path.join(LOCAL,'kbar'),{recursive:true});write(name,{date,source,bars});return{rows:bars,start:true,source};}
    }catch(e){error=e.message;if(blocked(e))kbarDenied={until:Date.now()+3600e3,error};}
    kbarMiss.set(key,Date.now());
  }
  if(!error&&Date.now()<kbarDenied.until)error=kbarDenied.error;
  const day=loadDay(date),r=snapRow(id,date),tl=r?tickLabel(r.date):'';
  const tick=tl?{t:tl,close:Number(r.close),volume:Number(r.total_volume),amount:Number(r.total_amount),high:Number(r.high),low:Number(r.low)}:null;
  const rows=day||tick?replayMinuteBars(day,id,{open:r?Number(r.open):null,tick}):[];
  return{rows,start:false,source:rows.length?'replay':'none',error};
}
// 本機日 K（研究名單日成交，或先前查過的非名單個股快取），供昨收與當日開高低收使用，不發請求
const localDaily=id=>{const s=market().stocks.find(x=>x.id===id);return s?.bars?.length?dailyKRows(s.bars):read(`daily/${id}.json`,null)?.rows||[];};
// 某交易日的昨收：時光機表頭 → 本機日 K 前一日收盤
function prevCloseOf(id,date,daily=localDaily(id)){
  const day=loadDay(date),i=day?day.ids.indexOf(id):-1;if(i>=0&&day.prev[i]>0)return prevPrice(day,i);
  return daily.filter(r=>r[0]<date).at(-1)?.[4]??null;
}
// 當日開高低收量：即時快照 → 本機日成交 → 5 分 K 彙總（時光機組成時開盤為第一個畫格，近似值）
function sessionBar(id,date,bars5,daily=localDaily(id)){
  const r=snapRow(id,date);
  if(r&&Number(r.open)>0)return[date,Number(r.open),Number(r.high),Number(r.low),Number(r.close),Math.round(Number(r.total_volume)||0)];
  const own=daily.find(x=>x[0]===date);if(own)return own;
  const xs=bars5.filter(b=>b[0].startsWith(date));return xs.length?[date,xs[0][1],Math.max(...xs.map(b=>b[2])),Math.min(...xs.map(b=>b[3])),xs.at(-1)[4],xs.reduce((a,b)=>a+b[5],0)]:null;
}
// 5 分 K：最近三個有資料的交易日連續排列（20MA 需要前一日的資料才能從開盤就畫出）
async function chart5m(id){
  const d=today(),dates=(await tradingDates()).filter(x=>x<=d).slice(-5),days=[];let error='';
  for(const date of dates){const m=await minuteRows(id,date);if(m.error)error=m.error;if(m.rows.length)days.push({date,source:m.source,bars:fiveMinBars(m.rows,{start:m.start})});}
  const use=days.slice(-3);if(!use.length&&error)throw new UserError(error);
  const daily=localDaily(id),bars=use.flatMap(x=>x.bars.map(b=>[`${x.date} ${b[0]}`,...b.slice(1)])),last=use.at(-1)?.date;
  return{bars,days:use.map(x=>({date:x.date,source:x.source,prev:prevCloseOf(id,x.date,daily)})),session:last?sessionBar(id,last,bars,daily):null,notice:error&&use.some(x=>x.source==='replay')?t('{error}；已改用本機時光機紀錄',{error}):''};
}
// 日 K：研究名單內用本機日成交資料（不還原），其他股票或本機資料過舊時向資料源取近 240 天並快取；
// 當日最後一根以即時快照組成（盤後沒有快照時用時光機畫格近似）。
async function dailyHistory(id){
  const d=today(),done=(await tradingDates()).filter(x=>x<d).at(-1)||'';
  const s=market().stocks.find(x=>x.id===id),own=dailyKRows(s?.bars||[]);
  if(own.length>=60&&own.at(-1)[0]>=done)return own;
  const name=`daily/${id}.json`,c=read(name,null);
  if(c?.rows?.length&&(c.rows.at(-1)[0]>=done||Date.now()-c.at<20*60e3))return c.rows;
  if(!data.has('daily'))return c?.rows?.length?c.rows:own;
  const got=await data.daily(id,minusDays(d,240),d),rows=dailyKRows(priceBars(Array.isArray(got)?got:got?.price||[]));
  fs.mkdirSync(path.join(LOCAL,'daily'),{recursive:true});write(name,{at:Date.now(),rows});
  return rows.length?rows:own;
}
async function chartDay(id){
  let rows=await dailyHistory(id),bar=null;const lastDate=rows.at(-1)?.[0]||'',r=snapRow(id),rDate=r?String(r.date).slice(0,10):'';
  if(r&&rDate>lastDate&&Number(r.close)>0){const c=Number(r.close);bar=[rDate,Number(r.open)||c,Number(r.high)||c,Number(r.low)||c,c,Math.round(Number(r.total_volume)||0)];}
  else{const day=replayToday();if(day&&day.date>lastDate)bar=replayDayBar(day,id);}
  if(bar)rows=[...rows,bar];
  return{bars:rows.slice(-160),today:bar?bar[0]:null,session:rows.at(-1)||null};
}
async function chartReport(id,period){
  const info=boardData([id]).stocks[0],result=period==='day'?await chartDay(id):await chart5m(id);
  return{id,name:info.name,sector:info.sector,score:info.score,period,prev:info.prev,quote:info.quote,daily:info.daily,inScope:inScope(id),live:!!lastSnap&&liveWindow(),stream:false,asOf:lastSnap?.asOf||null,...result};
}

/* ---------- 籌碼追蹤：分點追蹤、大戶集中度排行 ---------- */
const chipSettings=()=>normalizeChipwatch(settings.chipwatch);
const chipCapable=()=>{try{finmind('brokers');return true;}catch{return false;}};
const listDir=(dir,re)=>{try{return fs.readdirSync(path.join(LOCAL,dir)).map(f=>re.exec(f)?.[1]).filter(Boolean).sort();}catch{return[];}};
const bwDates=()=>listDir('broker-watch',/^(\d{4}-\d{2}-\d{2})\.json$/);
let bw={busy:false,error:'',date:'',done:0,total:0,attempt:{date:'',n:0,at:0}},branchInfo=null;
// 券商分點清單（TaiwanSecuritiesTraderInfo，7 天更新一次）：追蹤設定的搜尋用
async function branchList(){
  if(branchInfo&&Date.now()-branchInfo.at<7*864e5)return branchInfo.list;
  const c=read('broker-branches.json',null);if(c?.list?.length&&Date.now()-c.at<7*864e5){branchInfo=c;return c.list;}
  const rows=await finmind('brokers')('TaiwanSecuritiesTraderInfo',{},fmOpt());
  const list=rows.map(r=>({id:String(r.securities_trader_id),name:String(r.securities_trader||r.securities_trader_id)})).filter(b=>/^\w{1,10}$/.test(b.id));
  if(!list.length)throw new UserError('查無券商分點清單');
  branchInfo={at:Date.now(),list};write('broker-branches.json',branchInfo);return list;
}
// 指定日期所有追蹤分點的進出（每個分點 1 次請求）。全部分點都查無資料時視為尚未公布，不存檔
// manual：手動查詢（尚未公布時把原因留給畫面顯示）；bw.date／done／total 供畫面顯示進度
async function runBrokerWatch(date,{alert=false,manual=false}={}){
  const cs=chipSettings();if(!cs.branches.length)throw new UserError('請先加入要追蹤的券商分點');
  if(bw.busy)throw new UserError('分點追蹤查詢中，請稍候');
  const fm=finmind('brokers');bw.busy=true;bw.error='';bw.date=date;bw.done=0;bw.total=cs.branches.length;
  try{
    const prev=bwDates().filter(d=>d<date).slice(-10).map(d=>read(`broker-watch/${d}.json`,null)).filter(Boolean);
    const {meta}=uniIndex(),watch=new Set(watchlist),research=new Set(scopeIds(researchScope)),branches=[];let any=false;
    const vol=await dayVolumes(date),sh=await holderShares(date),wc=cs.warrants?await warrantContext(date):null;
    for(const b of cs.branches){
      try{
        const rows=await fm('/taiwan_stock_trading_daily_report',{securities_trader_id:b.id,date},fmOpt());
        if(rows.length)any=true;
        const name=String(rows[0]?.securities_trader||b.name);
        const history=prev.map(d=>d.branches.find(x=>x.id===b.id)?.nets||{});
        branches.push({id:b.id,name,...branchDay(rows,{meta,watch,research,history,volumes:vol.volumes,shares:sh.shares,settings:cs})});
        // 同一分點的認購權證進出（每個分點再 1 次請求）；方案或額度不足時其餘分點不再查權證
        if(wc?.master&&!wc.blocked){
          try{const wr=await fm('/taiwan_stock_warrant_trading_daily_report',{securities_trader_id:b.id,date},fmOpt());
            branches.at(-1).warrants=branchWarrants(wr,{date,branchName:name,master:wc.master.m,quotes:wc.quotes?.q||{},turnover:wc.turnover,meta,watch,research,history:prev.map(d=>d.branches.find(x=>x.id===b.id)?.warrants?.nets||{}),settings:cs});}
          catch(e){branches.at(-1).warrants={error:e.message};if(blocked(e))wc.blocked=e.message;}
        }
      }catch(e){branches.push({id:b.id,name:b.name,error:e.message,count:0,buy:[],sell:[],mine:[],nets:{}});if(blocked(e))break;}
      bw.done++;
    }
    const doc={date,builtAt:new Date().toISOString(),rules:{dayPct:cs.dayPct,minAmount:cs.minAmount,accumPct:cs.accumPct,accumDays:cs.accumDays},volumeSource:vol.source,sharesDate:sh.date,branches,
      ...(wc?{warrantRules:{amount:cs.warrantAmount,pct:cs.warrantPct,days:cs.warrantDays},warrantInfo:{masterDate:wc.master?.date||null,stale:!!wc.master?.stale,quotes:wc.quotes?.sources||null,turnover:!!wc.turnover,error:wc.error||wc.blocked||''}}:{})};
    if(!any){const err=branches.find(b=>b.error)?.error;if(err)throw new UserError(err);if(manual)bw.error=t('{date} 的分點資料尚未公布（約 18:00 後更新）',{date});return{...doc,empty:true};}
    fs.mkdirSync(path.join(LOCAL,'broker-watch'),{recursive:true});write(`broker-watch/${date}.json`,doc);
    if(alert)addAlerts(today(),brokerWatchAlerts(doc,{lot:M().lot,lang:language()}));
    return doc;
  }catch(e){bw.error=t('{date} 查詢失敗：{msg}',{date,msg:e.message});throw e;}finally{bw.busy=false;}
}
// 當日各股成交股數（單日主導用）：熱浪圖紀錄 → 時光機收盤畫格 → 查一次全市場單日行情（建立熱浪圖）
async function dayVolumes(date){
  const lot=M().lot,fromHeat=h=>{const out={};for(const s of h?.sectors||[])for(const x of s.stocks||[])if(x.volume>0)out[x.id]=x.volume*lot;return out;};
  let out=fromHeat(read('heatmap-'+date+'.json',null));if(Object.keys(out).length)return{volumes:out,source:'heatmap'};
  const day=loadDay(date),f=day?.frames.at(-1);
  if(f?.v&&f.t>=closeHM(M())){day.ids.forEach((id,i)=>{if(f.v[i]>0)out[id]=f.v[i]*lot;});if(Object.keys(out).length)return{volumes:out,source:'replay'};}
  if(data.has('dailyAll')&&!heatBusy&&!job.running){try{const h=await runHeatmap(date);if(h.date===date){out=fromHeat(h);if(Object.keys(out).length)return{volumes:out,source:'heatmap'};}}catch{}}
  return{volumes:{},source:null};
}
// 各股集保總股數（多日吃貨用）：日期不晚於查詢日的最近一份全市場股權分散表；沒有紀錄或舊紀錄沒有股數時先更新一次
async function holderShares(date){
  const pick=()=>{for(const d of hdDates().filter(x=>x<=date).reverse()){const doc=read(`holders-all/${d}.json`,null),s={};for(const [id,v] of Object.entries(doc?.s||{}))if(v[4]>0)s[id]=v[4];if(Object.keys(s).length)return{date:d,shares:s};}return null;};
  let r=pick();if(!r&&!hd.busy){try{await refreshHolders();}catch{}r=pick();}
  return r||{date:null,shares:{}};
}
/* ----- 權證追蹤（只看認購權證） ----- */
// 權證標的對照表（FinMind，約 1 分鐘）：每天最多取 1 次，保留最後交易日在 45 天內以後的權證；取不到時沿用上次（標示為舊資料）
let wm={busy:null,error:''},wq=new Map();
async function warrantMasterDoc(){
  const d=today(),c=read('warrants/master.json',null);if(c?.date===d&&c.m)return c;
  if(wm.busy)return wm.busy;
  wm.busy=(async()=>{try{
    const rows=await finmind('brokers')('TaiwanStockInfoWithWarrantSummary',{start_date:minusDays(d,800)},{...fmOpt(),timeout:180000});
    const m=warrantMaster(rows,{keepFrom:minusDays(d,45)});if(!Object.keys(m).length)throw new UserError('查無權證標的對照資料');
    const doc={date:d,at:Date.now(),count:Object.keys(m).length,m};fs.mkdirSync(path.join(LOCAL,'warrants'),{recursive:true});write('warrants/master.json',doc);wm.error='';
    // 清掉 40 天前的行情與權證分點快取
    try{for(const f of fs.readdirSync(path.join(LOCAL,'warrants'))){const x=/(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1];if(x&&x<minusDays(d,40))fs.rmSync(path.join(LOCAL,'warrants',f),{force:true});}}catch{}
    return doc;
  }catch(e){wm.error=e.message;if(c?.m)return{...c,stale:true};throw e;}finally{wm.busy=null;}})();
  return wm.busy;
}
// 認購權證收盤行情（證交所＋櫃買，免金鑰）：每個交易日一份；只取到一邊時 30 分鐘後再試
async function warrantQuotesFor(date){
  const name=`warrants/quotes-${date}.json`,c=read(name,null);if(c?.q&&c.complete)return c;
  if(c?.q&&Date.now()-(wq.get(date)||0)<30*60e3)return c;
  wq.set(date,Date.now());
  const r=await callWarrantQuotes(date),doc={date,at:Date.now(),q:r.q,sources:r.sources,errors:r.errors,complete:r.sources.twse>0&&r.sources.tpex>0};
  if(!Object.keys(r.q).length)return c||doc;
  fs.mkdirSync(path.join(LOCAL,'warrants'),{recursive:true});write(name,doc);return doc;
}
// 分點追蹤用的權證資料：對照表、當日行情、各標的認購權證成交金額
async function warrantContext(date){
  try{const master=await warrantMasterDoc();let quotes=null;try{quotes=await warrantQuotesFor(date);}catch{}
    return{master,quotes,turnover:quotes&&Object.keys(quotes.q).length?turnoverByTarget(quotes.q,master.m,date):null,error:'',blocked:''};}
  catch(e){return{master:null,error:e.message,blocked:''};}
}
// 某股某日收盤：熱浪圖紀錄 → 本機日 K
function closeOn(id,date){
  for(const s of read('heatmap-'+date+'.json',null)?.sectors||[])for(const x of s.stocks||[])if(x.id===id&&x.close>0)return x.close;
  const r=(raw[id]?.price||[]).find(x=>x.date===date);return r?.close>0?r.close:null;
}
// 個股的認購權證：清單（依標的查對照表，12 小時快取）、當日行情、追蹤分點最近一次紀錄中這檔的權證進出
async function warrantReport(id){
  const fm=finmind('brokers'),x=clock(),ds=await tradingDates(),date=ds.filter(d=>d<x.date||x.hm>='15:00').at(-1),brokerDate=ds.filter(d=>d<x.date||x.hm>='18:30').at(-1);
  if(!date)throw new UserError('查無交易日');
  const name=`warrants/by-${id}.json`;let c=read(name,null);
  if(!c||c.date!==date||Date.now()-c.at>12*3600e3){
    const rows=await fm('TaiwanStockInfoWithWarrantSummary',{data_id:id,start_date:minusDays(date,800)},{...fmOpt(),timeout:120000});
    c={date,at:Date.now(),rows:rows.filter(r=>/購/.test(r.type||'')&&String(r.end_date||'').slice(0,10)>=date).map(({stock_id,date,target_stock_id,type,end_date,exercise_ratio,fulfillment_price})=>({stock_id,date,target_stock_id,type,end_date,exercise_ratio,fulfillment_price}))};
    fs.mkdirSync(path.join(LOCAL,'warrants'),{recursive:true});write(name,c);
  }
  let quotes=null;try{quotes=await warrantQuotesFor(date);}catch{}
  const close=closeOn(id,date),r=stockWarrants(c.rows,{id,date,quotes:quotes?.q||{},close,targetName:uniIndex().meta.get(id)?.name||''});
  const bd=bwDates().at(-1),doc=bd?read(`broker-watch/${bd}.json`,null):null;
  const tracked=(doc?.branches||[]).flatMap(b=>{const w=b.warrants;if(!w||w.error)return[];const x=[...(w.buy||[]),...(w.sell||[]),...(w.mine||[])].find(v=>v.id===id);return x?[{branch:b.name,branchId:b.id,netAmt:x.netAmt,share:x.share,streak:x.streak,big:!!x.big,run:!!x.run,warrants:x.warrants}]:[];});
  return{id,date,close,...r,quotes:quotes?{sources:quotes.sources,complete:!!quotes.complete}:null,tracked,trackedDate:bd||null,brokerDate:brokerDate||null};
}
// 單一權證某日的分點進出（依權證代號查詢，1 次請求，查過的日子保存）
async function warrantBrokers(wid,date){
  const name=`warrants/br-${wid}-${date}.json`;let rows=read(name,null);
  if(!rows){rows=aggregateBrokers(await finmind('brokers')('/taiwan_stock_warrant_trading_daily_report',{data_id:wid,date},fmOpt()));if(rows.length){fs.mkdirSync(path.join(LOCAL,'warrants'),{recursive:true});write(name,rows);}}
  const sorted=rows.slice().sort((a,b)=>b.net-a.net);
  return{wid,date,count:rows.length,buy:sorted.filter(x=>x.net>0).slice(0,8),sell:sorted.filter(x=>x.net<0).reverse().slice(0,8),tracked:chipSettings().branches.map(b=>b.id)};
}
// 平日 18:30 後（FinMind 約 18:00 更新）自動查當天，尚未公布時每 30 分鐘重試，最多 8 次
setInterval(()=>{
  const cs=chipSettings(),x=clock(),date=x.date;
  if(!cs.auto||!cs.branches.length||bw.busy||x.weekday<1||x.weekday>5||x.hm<'18:30'||bwDates().includes(date)||!chipCapable())return;
  if(bw.attempt.date!==date)bw.attempt={date,n:0,at:0};
  if(bw.attempt.n>=8||Date.now()-bw.attempt.at<30*60e3)return;
  if(!replayToday()||replayToday().date!==date)return; // 今天沒有盤中紀錄（休市）時略過
  bw.attempt.n++;bw.attempt.at=Date.now();
  runBrokerWatch(date,{alert:true}).catch(e=>console.error(t('分點追蹤失敗：')+e.message));
},60e3).unref();
function chipwatchInfo(date){
  const dates=bwDates();if(!date||date==='latest')date=dates.at(-1)||null;
  return{capable:chipCapable(),settings:chipSettings(),maxBranches:MAX_BRANCHES,dates:dates.slice(-30),date,report:date?read(`broker-watch/${date}.json`,null):null,busy:bw.busy,error:bw.error,
    query:bw.busy||bw.date?{date:bw.date,done:bw.done,total:bw.total}:null,holders:holderStatus(),warrants:{busy:!!wm.busy,error:wm.error}};
}

// 大戶集中度：每週股權分散表（全市場一次取回，每個日期存一份精簡檔）；最多每 6 小時確認一次是否有新的一週
const hdDates=()=>listDir('holders-all',/^(\d{4}-\d{2}-\d{2})\.json$/);
let hd={busy:false,error:'',probeAt:0,cache:{key:'',data:null}};
async function holderDay(date){
  const name=`holders-all/${date}.json`,c=read(name,null);if(c?.s&&Object.values(c.s)[0]?.length>=5)return c; // 舊紀錄沒有集保股數時重新取得
  const rows=await finmind('brokers')('TaiwanStockHoldingSharesPer',{start_date:date},fmOpt()),s=holderMarketDay(rows,date);
  if(!Object.keys(s).length)return null;
  const doc={date,at:Date.now(),s};fs.mkdirSync(path.join(LOCAL,'holders-all'),{recursive:true});write(name,doc);return doc;
}
// 以台積電確認近期有哪些公布日期，再補齊最新、前 1 週、前 4 週三個日期；回傳是否有新的一週
async function refreshHolders(){
  if(hd.busy)throw new UserError('大戶資料更新中，請稍候');
  hd.busy=true;hd.error='';hd.probeAt=Date.now();
  try{
    const probe=await finmind('brokers')('TaiwanStockHoldingSharesPer',{data_id:'2330',start_date:minusDays(today(),45)},fmOpt());
    const dates=[...new Set(probe.map(r=>r.date))].sort();if(!dates.length)throw new UserError('查無股權分散資料');
    const had=hdDates().at(-1)||'';
    for(const d of [dates.at(-1),dates.at(-2),dates.at(-5)].filter(Boolean))await holderDay(d);
    // 只保留最近 12 週
    for(const d of hdDates().slice(0,-12))fs.rmSync(path.join(LOCAL,'holders-all',`${d}.json`),{force:true});
    hd.cache={key:'',data:null};
    return dates.at(-1)>had;
  }catch(e){hd.error=e.message;throw e;}finally{hd.busy=false;}
}
function holderRank(scope='mine',date){
  const ds=hdDates();if(!date||date==='latest')date=ds.at(-1);if(!date)return null;
  const key=`${scope}:${date}:${ds.length}:${watchlist.length}:${scopeIds(researchScope).length}`;if(hd.cache.key===key)return hd.cache.data;
  const i=ds.indexOf(date);if(i<0)return null;
  const day=d=>d?read(`holders-all/${d}.json`,null):null,before=ds.slice(0,i);
  // 前 1 週與前 4 週：依日期找最接近的紀錄（5–9 天前、26–32 天前）
  const near=(lo,hi)=>before.filter(d=>{const n=(Date.parse(date)-Date.parse(d))/864e5;return n>=lo&&n<=hi;}).at(-1);
  const {meta}=uniIndex(),research=scopeIds(researchScope),ids=scope==='market'?null:[...new Set([...watchlist,...research])];
  const r=rankHolders({latest:day(date),prev1:day(near(5,9)),prev4:day(near(24,32))},{ids,meta,watch:new Set(watchlist),research:new Set(research),minPeople:scope==='market'?1000:0});
  // 全市場只回傳集中與渙散兩端各 60 檔
  const data=r&&scope==='market'?{...r,rows:[...r.rows.slice(0,60),...r.rows.slice(60).slice(-60)]}:r;
  hd.cache={key,data};return data;
}
const holderStatus=()=>({dates:hdDates().slice(-12),busy:hd.busy,error:hd.error,checkedAt:hd.probeAt||null});
setInterval(()=>{
  if(hd.busy||Date.now()-hd.probeAt<6*3600e3||!chipCapable())return;
  hd.probeAt=Date.now();
  refreshHolders().then(fresh=>{if(fresh&&chipSettings().holdersPush){const a=holderRankAlert(holderRank('mine'),{lang:language()});if(a)addAlerts(today(),[a]);}}).catch(e=>console.error(t('大戶資料更新失敗：')+e.message));
},10*60e3).unref();

/* ---------- 族群排名 ---------- */
// 研究總覽各族群成分股的漲幅排名（低量排除＋√成交金額加權，避免冷門股極端漲幅或單一權值股造成失真）。
// 盤中查詢用即時快照（盤中監控在跑時不需額外請求）；收盤 5 分鐘後自動以收盤資料存紀錄，隔日標示名次變動。
const grDates=()=>{try{return fs.readdirSync(LOCAL).map(f=>/^grouprank-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter(Boolean).sort();}catch{return[];}};
// 前一個「有排名」的收盤紀錄（略過資料不足的空紀錄）
const grPrev=date=>{for(const d of grDates().filter(x=>x<date).reverse()){const r=read(`grouprank-${d}.json`,null);if(r?.groups?.some(g=>g.rank))return r;}return null;};
const grMeta=()=>new Map(market().stocks.map(s=>[s.id,{name:s.name}]));
const grCover=q=>{const scope=new Set(researchScope.groups.flatMap(g=>g.stockIds));return scope.size?[...scope].filter(id=>q.has(id)).length/scope.size:0;};
// 收盤紀錄來源依序：時光機收盤畫格 → 當日快照 → 本機日成交（每日更新後才有），取第一個涵蓋八成以上成分股者
function grCloseQuotes(date){
  const day=loadDay(date);
  if(day?.frames.length&&day.frames.at(-1).t>=closeHM(M())){const q=quotesFromReplay(day,grMeta());if(grCover(q)>=.8)return q;}
  if(lastSnap?.date===date){const q=quotesFromSnapshot(lastSnap.rows,grMeta());if(grCover(q)>=.8)return q;}
  const q=quotesFromDaily(market().stocks,date);return grCover(q)>=.8?q:null;
}
function grPack(date,quotes,source){
  const ranked=buildGroupRanking(researchScope.groups,quotes),prev=grPrev(date),times=[...quotes.values()].map(q=>q.time).filter(Boolean).sort();
  const scope=new Set(researchScope.groups.flatMap(g=>g.stockIds));
  return{date,source,asOf:times.at(-1)||null,builtAt:new Date().toISOString(),stocks:scope.size,quoted:[...scope].filter(id=>quotes.has(id)).length,rules:RANK_RULES,compare:prev?{date:prev.date}:null,groups:compareRanks(ranked,prev)};
}
// 最新一個交易日的快照列（盤中監控 15 秒內的資料直接沿用）
async function latestSnapRows(){
  if(lastSnap&&Date.now()-lastSnap.at<15000)return{date:lastSnap.date,rows:lastSnap.rows};
  if(!data.has('snapshot'))throw new UserError('目前的資料源不支援盤中即時報價');
  const {ids}=uniIndex(),all=(await data.snapshot(snapPlan().ids||[])).filter(r=>ids.has(r.stock_id)),date=all.map(r=>String(r.date).slice(0,10)).sort().at(-1);
  return{date,rows:all.filter(r=>String(r.date).slice(0,10)===date)};
}
async function queryGroupRank(force=false){
  if(!force&&grLive.data&&Date.now()-grLive.at<10000)return grLive.data;
  // 非盤中且已有當日收盤紀錄時直接沿用
  if(!liveWindow()){const last=grDates().at(-1),rec=last?read(`grouprank-${last}.json`,null):null;if(rec&&rec.date>=(lastSnap?.date||today())){grLive={at:Date.now(),data:rec};return rec;}}
  const {date,rows}=await latestSnapRows();if(!rows.length)throw new UserError('目前取不到行情快照');
  const pack=grPack(date,quotesFromSnapshot(rows,grMeta()),date===today()&&liveWindow()?'live':'close');
  grLive={at:Date.now(),data:pack};return pack;
}
setInterval(()=>{
  const x=clock(),date=x.date;
  if(!researchScope.groups.length||x.weekday<1||x.weekday>5||x.minute<M().close+5||grDates().includes(date))return;
  if(grAttempt.date===date&&Date.now()-grAttempt.at<5*60e3)return;grAttempt={date,at:Date.now()};
  // 優先用本機資料（時光機收盤畫格、快照、日成交，不需請求）；都不足時再取一次快照。資料日期不是今天（休市）或涵蓋不足就不存，5 分鐘後重試
  const q=grCloseQuotes(date);if(q){write(`grouprank-${date}.json`,grPack(date,q,'close'));return;}
  if(Date.now()<monitorPauseUntil||!data.has('snapshot'))return; // 快照暫停中（例如方案不足），等每日更新後用日成交補建
  latestSnapRows().then(({date:d,rows})=>{const q=d===date?quotesFromSnapshot(rows,grMeta()):null;if(q&&grCover(q)>=.8)write(`grouprank-${date}.json`,grPack(date,q,'close'));}).catch(e=>console.error(t('族群排名收盤紀錄失敗：')+e.message));
},30000).unref();

/* ---------- 新聞推播 ---------- */
// 開啟後每分鐘取一次資料源的全市場當日新聞（1 次請求；當地 00:00–08:00 另取前一日，因部分來源以 UTC 標示日期），
// 研究名單成分股第一次出現的新聞記為雷達事件（type: news），由手機版推播、電腦版桌面通知或彈窗提醒。
function newsAlert(a,{meta,watch,quiet,time}){
  const names=a.ids.map(id=>meta.get(id)?.name||id),q=quoteOf(a.ids[0]),w=a.ids.some(id=>watch.has(id));
  return{type:'news',t:time,stockId:a.ids[0],ids:a.ids.slice(0,8),names:names.slice(0,8),name:a.ids.length>1?t('{name} 等 {n} 檔',{name:names[0],n:a.ids.length}):names[0],title:t('新聞'),detail:a.title,source:a.source,url:/^https?:\/\//i.test(a.link||'')?a.link:'',watch:w,level:w?'hi':'mid',quiet,close:q?.close??null,change:q?.change??null};
}
// 新聞來源：資料源的全市場新聞（例如 FinMind，額度或金鑰問題時暫停 30 分鐘）＋台股的鉅亨網（各自失敗不影響另一個）
const cnyesOn=()=>M().id==='TW';
async function scanNewsOnce(){
  const x=clock(),dates=x.hour<8?[minusDays(x.date,1),x.date]:[x.date],rows=[],cn=[],errors=[];
  if(data.has('marketNews')&&Date.now()>=newsPauseUntil)try{for(const d of dates)rows.push(...await data.marketNews(d));}catch(e){errors.push(e.message);if(blocked(e))newsPauseUntil=Date.now()+30*60e3;}
  if(cnyesOn())try{cn.push(...await cnyesNews());}catch(e){errors.push(t('鉅亨網：')+e.message);}
  if(!rows.length&&!cn.length&&errors.length)throw new Error(errors.join('；'));
  if(!newsState)newsState=createNewsState(read('news-seen.json',null));
  // 一律以整個研究名單判斷「是否看過」，切換推播範圍時才不會把舊聞當新聞；新加入的鉅亨網第一次只記錄
  const first=cn.length&&!newsState.sources.has('cnyes');
  const ns=normalizeNews(settings.news),watch=new Set(watchlist),{fresh,seeded}=scanNews(newsState,first?rows:[...rows,...cn],{scope:new Set(scopeIds(researchScope)),seedOnly:first?cn:[]});
  if(first)newsState.sources.add('cnyes');
  write('news-seen.json',saveNewsState(newsState));
  const list=ns.scope==='watch'?fresh.filter(a=>a.ids.some(id=>watch.has(id))):fresh,quiet=quietNow(x.hour,ns.quiet),{meta}=uniIndex();
  if(list.length)addAlerts(x.date,list.map(a=>newsAlert(a,{meta,watch,quiet,time:x.hms})));
  newsStatus={at:Date.now(),error:errors.join('；'),found:list.length,seeded};
}
setInterval(()=>{
  if(!normalizeNews(settings.news).enabled||!(data.has('marketNews')||cnyesOn())||newsBusy||Date.now()-newsStatus.at<58e3)return;
  newsBusy=true;
  scanNewsOnce().catch(e=>{newsStatus={...newsStatus,at:Date.now(),error:e.message};}).finally(()=>{newsBusy=false;});
},5000).unref();
const newsInfo=()=>({...normalizeNews(settings.news),capable:data.has('marketNews')||cnyesOn(),sources:[data.has('marketNews')?data.source('marketNews'):null,cnyesOn()?'cnyes':null].filter(Boolean),status:{at:newsStatus.at||null,error:newsStatus.error,found:newsStatus.found,seeded:newsStatus.seeded,today:alertsFor(today()).list.filter(a=>a.type==='news').length,pausedUntil:newsPauseUntil>Date.now()?newsPauseUntil:null}});

/* ---------- 推理模型 ---------- */
// 金鑰以服務代號保存（anthropic、openai、gemini、compatible）；OpenAI 相容端點（例如本機模型）可不設金鑰
function llmConfigured(){const l=config().llm,info=LLM_INFO[l.provider];if(!info||(info.needsBaseUrl&&!l.baseUrl))return false;return !!info.keyOptional||secretConfigured(l.provider,info.keyEnv);}
async function llmOptions(){const l=config().llm,info=LLM_INFO[l.provider];return{provider:l.provider,key:await getSecret(l.provider,info.keyEnv),model:l.model||info.defaultModel,baseUrl:l.baseUrl,effort:l.effort};}
const marketName=()=>{const n=M().name;return n[language()]||n.en;};

/* ---------- AI 盤後日報 ---------- */
const reportDates=()=>{try{return fs.readdirSync(path.join(LOCAL,'reports')).map(f=>/^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter(Boolean).sort();}catch{return[];}};
async function generateDaily(date){
  if(reportBusy)throw new UserError('日報產生中，請稍候');
  if(!llmConfigured())throw new UserError('請先在「資料與設定」設定推理模型與金鑰');
  reportBusy=true;reportError='';
  try{
    let heat=read('heatmap-'+date+'.json',null);
    if(!heat&&!heatBusy&&!job.running&&!flowBusy){try{const h=await runHeatmap(date);if(h.date===date)heat=h;}catch{}}
    if(!heat&&liveHeat?.data?.date===date)heat=liveHeat.data;
    let flows=read('flows-'+date+'.json',null);const fm=data.finmind();
    if(!flows&&fm&&!heatBusy&&!job.running&&!flowBusy){flowBusy=true;try{const r=await queryFlows(date,{requestData:fm,...fmOpt()});if(cacheableFlow(r))write('flows-'+date+'.json',r);flows=r;}catch{}finally{flowBusy=false;}}
    const lang=language(),board=boardData(watchlist);
    const chips=reportChips(date),hr=new Map((chips?.rank?.rows||[]).map(x=>[x.id,x])),fired=alertsFor(date).list.filter(a=>a.type==='custom');
    // 自選股逐檔資料：報價、量比、大戶週變化、追蹤分點進出、今天觸發的自訂提醒（自選股最多 30 檔）
    const watch=board.stocks.slice(0,30).map(s=>{const q=s.quote,h=hr.get(s.id),ratio=q?.volume&&q?.yesterdayVolume?Math.round(q.volume/q.yesterdayVolume*100)/100:null,br=(chips?.brokers?.branches||[]).flatMap(b=>b.mine.filter(x=>x.id===s.id).map(x=>`${b.name} ${x.net>0?'+':''}${Math.round(x.net/M().lot)}`));
      return{[t('代碼')]:s.id,[t('名稱')]:s.name,[t('收盤')]:q?.close??s.daily?.price,[t('漲跌')]:q?.change??s.daily?.change,[t('綜合分數')]:s.score,...(q?.high?{[t('高低')]:`${q.high}/${q.low}`}:{}),...(ratio?{[t('量 ÷ 昨量')]:ratio}:{}),...(h?{[t('千張大戶')]:`${h.big1000}%（4 週 ${h.d4??'—'}）`}:{}),...(br.length?{[t('追蹤分點')]:br.join('、')}:{}),...(fired.some(a=>a.stockId===s.id)?{[t('自訂提醒')]:fired.filter(a=>a.stockId===s.id).map(a=>a.detail).slice(0,3)}:{})};});
    const research=boardData(scopeIds(researchScope)).stocks.filter(s=>s.quote?.change!=null).sort((a,b)=>b.quote.change-a.quote.change);
    const pick=s=>`${s.id} ${s.name} ${s.quote.change>0?'+':''}${s.quote.change}%`;
    let patterns=[];try{patterns=patternSnapshot(universe).stocks.flatMap(s=>s.matches.filter(m=>['量價確認','突破待次日確認'].includes(m.status)).map(m=>`${s.id} ${s.name} ${t(m.name)} ${t(m.status)} ${t('強度')}${m.score}`)).slice(0,15);}catch{}
    let news=[],agenda=null;
    try{news=(await focusNews({offset:0})).items.slice(0,20).map(i=>`[${t(i.category)}]${i.must?`[${t('必讀')}]`:''} ${i.title}`);}catch{}
    let outlook=null;
    try{const w=await weekAgenda();outlook=overnightOutlook(date,w,{market:M(),lang});agenda={[t('經濟數據')]:w.macro.filter(e=>e.date>=date&&e.impact==='High').slice(0,12).map(e=>`${e.date} ${e.countryName} ${e.title}`),[t('財報')]:w.earnings.filter(e=>e.date>=date).slice(0,12).map(e=>`${e.date} ${(lang==='zh-TW'&&e.zh)||e.name}(${e.symbol}) ${e.timing}`)};}catch{}
    // 大盤與籌碼數據（指數、融資券、期貨、散戶多空、法人、選擇權 P/C）：與圖卡同一份資料
    let market=null;try{if(data.finmind())market=assembleCard({date,heat,flows,...await marketInputs(date),report:null});}catch{}
    const chipCtx=chips?{...(chips.brokers?{[t('追蹤分點')]:{[t('日期')]:chips.brokers.date,[t('分點')]:chips.brokers.branches.filter(b=>b.count).map(b=>({[t('名稱')]:b.name,[t('買超')]:b.buy.slice(0,5).map(x=>`${x.name} +${Math.round(x.net/M().lot)}`),[t('賣超')]:b.sell.slice(0,5).map(x=>`${x.name} ${Math.round(x.net/M().lot)}`),[t('自選／研究')]:b.mine.slice(0,8).map(x=>`${x.name} ${x.net>0?'+':''}${Math.round(x.net/M().lot)}`),...(b.warrants?.buy?.length?{[t('認購權證淨買（萬元）')]:b.warrants.buy.slice(0,5).map(x=>`${x.name} +${Math.round(x.netAmt/1e4)}${x.streak>=2?`（${t('連 {n} 日',{n:x.streak})}）`:''}`)}:{})}))}}:{}),...(chips.rank?{[t('千張大戶')]:{[t('日期')]:chips.rank.date,[t('集中')]:chips.rank.rows.filter(x=>x.tone==='籌碼集中').slice(0,8).map(x=>`${x.name} ${x.big1000}%（4 週 +${x.d4}）`),[t('渙散')]:chips.rank.rows.filter(x=>x.tone==='籌碼渙散').slice(-8).map(x=>`${x.name} ${x.big1000}%（4 週 ${x.d4}）`)}}:{})}:null;
    const context=buildReportContext({date,heat,flows,market,outlook,chips:chipCtx&&Object.keys(chipCtx).length?chipCtx:null,alerts:alertsFor(date).list.filter(a=>!['report','news','broker','holders'].includes(a.type)),watch,movers:{[t('漲幅前5')]:research.slice(0,5).map(pick),[t('跌幅前5')]:research.slice(-5).reverse().map(pick)},patterns,news,agenda},lang);
    const r=await generateReport({llm:await llmOptions(),context,lang,marketName:marketName(),hasFlows:!!flows});
    const doc={date,createdAt:new Date().toISOString(),provider:config().llm.provider,model:r.model,usage:r.usage,lang,...r.report};
    fs.mkdirSync(path.join(LOCAL,'reports'),{recursive:true});write(`reports/${date}.json`,doc);
    try{await buildMarketCard(date);}catch(e){console.error(t('圖卡數據彙整失敗：')+e.message);}
    addAlerts(today(),[{type:'report',title:t('AI 盤後日報'),detail:doc.headline,stockId:'',name:'',t:clock().hms,level:'hi',watch:false,date}]);
    return doc;
  }catch(e){reportError=e.message;throw e;}finally{reportBusy=false;}
}
// 日報用的籌碼資料：日期不晚於日報日的最新分點追蹤紀錄，與自選＋研究名單的大戶排行（沒有 Sponsor 方案時為 null）
function reportChips(date){
  try{const d=bwDates().filter(x=>x<=date).at(-1),brokers=d?read(`broker-watch/${d}.json`,null):null,rank=hdDates().length?holderRank('mine'):null;return brokers||rank?{brokers,rank}:null;}catch{return null;}
}
// 盤後籌碼整理圖卡數據：熱浪圖與日報為共通部分；台股另有加權／櫃買指數、融資、期貨與散戶多空（FinMind，約 11 次請求）
let marketMemo={date:'',at:0,data:null};
// 大盤數據：加權／櫃買指數、融資券、期貨近月、散戶小台／微台多空（日報與圖卡共用，30 分鐘內沿用）
async function marketInputs(date){
  if(marketMemo.date===date&&Date.now()-marketMemo.at<30*60e3)return marketMemo.data;
  const fm=data.finmind(),safe=async(ds,params)=>{try{return await fm(ds,params,fmOpt());}catch{return[];}};
  let index=read(`index-${date}.json`,null),margin=null;const futures=[],retail={};
  if(fm){
    if(!index?.twse&&date===today()&&data.has('snapshot')){try{const rows=await data.snapshot([]),ix=id=>rows.find(r=>r.stock_id===id&&String(r.date).slice(0,10)===date);index={twse:indexRow(ix('001')),tpex:indexRow(ix('101'))};if(index.twse)write(`index-${date}.json`,index);}catch{}}
    margin=marginSummary(await safe('TaiwanStockTotalMarginPurchaseShortSale',{start_date:minusDays(date,7),end_date:date}),date);
    for(const [id,name] of FUTURES){const n=nearMonth(await safe('TaiwanFuturesDaily',{data_id:id,start_date:date,end_date:date}),date);if(n)futures.push({id,name:t(name),close:Number(n.close),change:Number(n.spread),pct:Number(n.spread_per)});}
    for(const id of ['MTX','TMF'])retail[id]=retailPosition(await safe('TaiwanFuturesInstitutionalInvestors',{data_id:id,start_date:minusDays(date,10),end_date:date}),await safe('TaiwanFuturesDaily',{data_id:id,start_date:date,end_date:date}),date);
  }
  const out={index,margin,futures,retail:{mini:retail.MTX,micro:retail.TMF}};
  if(fm)marketMemo={date,at:Date.now(),data:out};
  return out;
}
async function buildMarketCard(date){
  const heat=read('heatmap-'+date+'.json',null)||(liveHeat?.data?.date===date?liveHeat.data:null),flows=read('flows-'+date+'.json',null);
  const card=assembleCard({date,heat,flows,...await marketInputs(date),report:read(`reports/${date}.json`,null)});
  write(`card-${date}.json`,card);return card;
}
setInterval(()=>{
  const rs=normalizeReportSettings(settings.report);if(!rs.auto||reportBusy||!llmConfigured())return;
  const x=clock(),date=x.date;
  if(x.weekday<1||x.weekday>5||x.hm<rs.time||reportDates().includes(date))return;
  if(!replayToday()||replayToday().date!==date)return; // 今天沒有盤中紀錄（休市或監控關閉）時不自動產生
  if(reportAttempt.date!==date)reportAttempt={date,n:0,at:0};
  if(reportAttempt.n>=3||Date.now()-reportAttempt.at<20*60e3)return;
  reportAttempt.n++;reportAttempt.at=Date.now();
  generateDaily(date).catch(e=>console.error(t('AI 日報產生失敗：')+e.message));
},30000).unref();
compactReplay(today());

/* ---------- 熱浪圖 ---------- */
// 資料源支援「全市場單日行情」時涵蓋整個市場；不支援時改用研究名單的本機日成交資料（以研究族群分組）
function localDailyAll(date){const rows=[];for(const id of scopeIds(researchScope))for(const r of raw[id]?.price||[])if(r.date===date)rows.push(r);return rows;}
async function runHeatmap(date,options={}){
  heatBusy=true;
  try{
    let result,min=100;
    if(data.has('dailyAll')){await ensureUniverse(options);result=await queryHeatmap(date,{universe,sectorOf:heatSectorOf(),...options});}
    else{
      const list=resolveScope(researchScope,universe);if(!list.length)throw new UserError('請先建立研究族群並更新資料');
      result=await queryHeatmap(date,{universe:list,fetchCalendar:()=>tradingDates(),fetchDaily:async d=>localDailyAll(d),sectorOf:groupSectorOf(),...options});
      result.scope='research';min=Math.max(5,Math.floor(list.length*.8));
    }
    if(cacheableHeatmap(result,min)){write('heatmap-'+result.date+'.json',result);heatSummaryCache=null;}
    return result;
  }finally{heatBusy=false;}
}

/* ---------- 每日更新 ---------- */
let frontCache={at:0,id:''};
function frontBuild(){
  if(Date.now()-frontCache.at<5000)return frontCache.id;
  const sig=[];const walk=dir=>{for(const f of fs.readdirSync(dir).sort()){const p=path.join(dir,f),st=fs.statSync(p);if(st.isDirectory())walk(p);else sig.push(`${f}:${st.mtimeMs}`);}};walk(path.join(ROOT,'public'));
  let h=0;for(const c of sig.join('|'))h=(h*31+c.charCodeAt(0))>>>0;frontCache={at:Date.now(),id:h.toString(36)};return frontCache.id;
}
function json(res, code, value) { res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); }
async function body(req, max = 64000) { let s = ''; for await (const chunk of req) { s += chunk; if (s.length > max) throw new UserError('請求內容過大'); } try { return JSON.parse(s || '{}'); } catch { throw new UserError('資料格式錯誤'); } }
function safeURL(v) { try { const u = new URL(v); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }
// 當日資料約在收盤 1.5 小時後才齊全：之前更新以前一日為基準
function cutoffForUpdate() { const x = clock(); return x.minute < M().close + 90 ? minusDays(x.date,1) : x.date; }
// 法人買賣超只能整批取得時（證交所開放資料）：每日檔只存研究名單相關個股
const instStore={
  get:(date,want)=>{const c=read(`institutions/${date}.json`,null);if(!c?.ids)return null;const have=new Set(c.ids);return [...want].every(id=>have.has(id))?c.rows.filter(r=>want.has(r.stock_id)):null;},
  set:(date,rows,want)=>{fs.mkdirSync(path.join(LOCAL,'institutions'),{recursive:true});write(`institutions/${date}.json`,{ids:[...want],rows});},
};
async function refresh(scope, ids) {
  controller = new AbortController();
  job = { running:true, done:0, total:0, current:t('股票清單'), dataset:'universe', errors:[], message:t('讀取股票清單…'), startedAt:new Date().toISOString() };
  write('last-job.json',job);
  try {
    const options = { signal:controller.signal }, cutoff = cutoffForUpdate();
    // 股票清單只是名稱與產業的參考：取不到時沿用上次清單與研究族群的股票資料，不中斷個股更新
    if (data.has('universe')) {
      try { const list = await data.universe(options); if (!list.length) throw new UserError('股票清單為空，保留上次資料'); universe = list; write('universe.json', universe); invalidate(); }
      catch (e) { if (controller.signal.aborted) throw e; job.errors.push({ dataset:'universe', message:e.message }); }
    }
    const queue = selectedUpdateIds(researchScope,scope,ids,watchlist);
    let inst = null;
    if (queue.length && isBulkInstitutional()) {
      job.dataset = 'institutionalAll'; job.message = t('讀取法人買賣超（全市場逐日）…');
      try { inst = await bulkInstitutions(queue, cutoff, { signal:controller.signal, store:instStore, onProgress:p => { job.message = t('讀取法人買賣超 {done}/{total} 日', p); } }); }
      catch (e) { if (e.fatal) throw e; job.errors.push({ dataset:'institutions', message:e.message }); }
    }
    job.total = queue.length;
    const skipped = new Set();
    for (const id of queue) {
      if (controller.signal.aborted) break;
      job.current = id; job.message = t('更新 {id}，{done}/{total}', { id, done:job.done, total:job.total });
      // 次要資料（營收、估值、法人）的資料源額度用完或方案不足時：本次更新略過該項，股價等其他資料照常更新
      for (;;) {
        try { raw[id] = await fetchStock(id, raw[id], { ...options, cutoff, onDataset: d => job.dataset = d, sources: defaultSources(options).filter(s => !skipped.has(s.label)) }); break; }
        catch (e) {
          if (e.partial) raw[id] = e.partial;
          if (e.source && e.source !== 'daily' && !controller.signal.aborted && ['quota', 'plan', 'auth'].includes(e.code)) { skipped.add(e.source); job.errors.push({ dataset:e.source, message:e.message }); continue; }
          if (raw[id]) write(`stocks/${id}.json`, raw[id]); throw e;
        }
      }
      if (inst?.get(id)?.length) { raw[id].institutions = inst.get(id); raw[id].checked = { ...raw[id].checked, institutions:cutoff }; delete raw[id].errors?.institutions; }
      write(`stocks/${id}.json`, raw[id]);
      for (const [dataset,message] of Object.entries(raw[id].errors || {})) job.errors.push({ id, dataset, message });
      job.done++; invalidate();
    }
    job.message = controller.signal.aborted ? t('更新已停止，資料已保留') : t('已完成 {n} 檔更新', { n:job.done }) + (job.errors.length ? t('，部分資料未取得') : '');
  } catch (e) { job.message = e.message; job.errors.push({ message:e.message }); }
  finally { job.running = false; job.finishedAt = new Date().toISOString(); job.dataset = null; write('last-job.json', job); invalidate(); }
}
async function refreshPatternMarket(){
  controller=new AbortController();job={running:true,done:0,total:0,current:t('股票清單'),errors:[],message:t('準備全市場型態資料'),startedAt:new Date().toISOString()};write('last-job.json',job);
  try{
    const options={cutoff:cutoffForUpdate(),signal:controller.signal};
    if(data.has('universe')){const next=await data.universe(options);if(!next.length)throw new UserError('股票清單為空');universe=next;write('universe.json',universe);}
    const result=await updatePatternData(universe,{...options,onProgress:p=>Object.assign(job,p)});
    job.message=controller.signal.aborted?t('型態更新已停止；保留上次完整快照'):result.complete?t('型態資料更新完成'):t('部分日期未回傳資料；保留上次完整快照，請重試');
    if(!result.complete&&!controller.signal.aborted)job.errors.push({message:t('型態快照未完成')});
  }catch(e){job.message=e.message;job.errors.push({message:e.message});}
  finally{job.running=false;job.finishedAt=new Date().toISOString();job.dataset=null;raw=readStocks(scopeIds(researchScope));invalidate();write('last-job.json',job);}
}
function validateWeights(weights) { return weights && Object.keys(WEIGHTS).every(k => Number.isInteger(weights[k]) && weights[k] >= 0 && weights[k] <= 100) && Object.keys(WEIGHTS).reduce((s,k) => s + weights[k],0) === 100; }

/* ---------- 設定：市場、語言、資料源、推理模型 ---------- */
const providerStatus=()=>{const c=config(),info=providerInfo();return Object.values(PROVIDERS).map(p=>({id:p.id,name:t(p.name),site:p.site,docs:p.docs,markets:p.markets,key:p.key,keyEnv:p.keyEnv||null,configured:hasKey(p),enabled:c.providers.enabled.includes(p.id),supportsMarket:p.markets.includes(c.market),caps:Object.keys(CAPABILITIES).filter(cap=>supports(p,cap)),plan:info[p.id]?{plan:info[p.id].plan,tier:info[p.id].tier,checkedAt:info[p.id].checkedAt}:null}));};
const llmStatus=()=>{const l=config().llm;return{...l,configured:llmConfigured(),providers:LLM_PROVIDERS.map(id=>({id,name:t(LLM_INFO[id].name),site:LLM_INFO[id].site,keyEnv:LLM_INFO[id].keyEnv,defaultModel:LLM_INFO[id].defaultModel,suggested:LLM_INFO[id].suggested||[],keyOptional:!!LLM_INFO[id].keyOptional,needsBaseUrl:!!LLM_INFO[id].needsBaseUrl,configured:secretConfigured(id,LLM_INFO[id].keyEnv)}))};};
function configInfo(){
  const c=config();
  return{config:{market:c.market,language:c.language,setupDone:c.setupDone,publicUrl:c.publicUrl,upColor:c.upColor,providers:c.providers},
    market:clientMarket(M()),markets:MARKET_IDS.map(id=>({id,name:MARKETS[id].name,tz:MARKETS[id].tz,currency:MARKETS[id].currency,sample:MARKETS[id].sample,providers:Object.values(PROVIDERS).filter(p=>p.markets.includes(id)).map(p=>p.id)})),
    languages:LANGUAGES,upColor:upColor(),providers:providerStatus(),capabilities:capabilityMap(),capabilityLabels:Object.fromEntries(Object.entries(CAPABILITIES).map(([k,v])=>[k,t(v)])),
    llm:llmStatus(),secretBackend:secretBackend(),groups:researchScope.groups.length,remote:remoteInfo()};
}
/* ---------- 遠端存取：手機版網域與通道方式、推播聯絡信箱、電腦版遠端存取（Cloudflare Access） ---------- */
const hostOf=u=>{try{return new URL(u).host.toLowerCase();}catch{return'';}};
// 手機版允許的網域＝對外網址的主機＋其他網域（提供給 Pocket 作為主機名稱白名單）
function remoteInfo(){
  const c=config(),r=c.remote;
  return{tunnel:r.tunnel,publicUrl:c.publicUrl,pocketHosts:r.pocketHosts,hosts:[...new Set([hostOf(c.publicUrl),...r.pocketHosts].filter(Boolean))],contact:r.contact,
    access:{hosts:r.access.hosts,teamDomain:r.access.teamDomain,aud:r.access.aud,ready:!!(r.access.hosts.length&&r.access.teamDomain&&r.access.aud)}};
}
const cleanHost=h=>String(h).trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'');
function saveRemote(b){
  const c=config(),r=c.remote,a=b.access||{},bad=[];
  const list=v=>{if(v===undefined)return undefined;if(!Array.isArray(v)||v.length>10)throw new UserError('網域格式錯誤：{list}',{list:String(v).slice(0,80)});return [...new Set(v.map(cleanHost).filter(Boolean))].filter(h=>{if(HOST_RE.test(h))return true;bad.push(h.slice(0,60));return false;});};
  const tunnel=b.tunnel??r.tunnel;if(!TUNNEL_MODES.includes(tunnel))throw new UserError('設定無效');
  const pocketHosts=list(b.pocketHosts)??r.pocketHosts,accessHosts=list(a.hosts)??r.access.hosts;
  if(bad.length)throw new UserError('網域格式錯誤：{list}',{list:bad.join(', ')});
  const contact=b.contact===undefined?r.contact:String(b.contact||'').trim();if(contact&&!EMAIL_RE.test(contact))throw new UserError('推播聯絡信箱格式錯誤');
  const teamDomain=a.teamDomain===undefined?r.access.teamDomain:cleanHost(a.teamDomain||'');if(teamDomain&&!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain))throw new UserError('Team domain 格式應為 xxx.cloudflareaccess.com');
  const aud=a.aud===undefined?r.access.aud:String(a.aud||'').trim();if(aud&&!/^[A-Za-z0-9-]{8,128}$/.test(aud))throw new UserError('Application Audience (AUD) Tag 格式錯誤');
  let publicUrl=c.publicUrl;if(b.publicUrl!==undefined){if(b.publicUrl&&(!safeURL(b.publicUrl)||!/^https:/.test(b.publicUrl)))throw new UserError('對外網址必須是 https:// 開頭的有效網址');publicUrl=b.publicUrl?b.publicUrl.replace(/\/+$/,''):'';}
  // 手機版與電腦版是不同的服務，同一個網域只能指向其中一個
  const pocketAll=new Set([hostOf(publicUrl),...pocketHosts].filter(Boolean)),clash=accessHosts.filter(h=>pocketAll.has(h));
  if(clash.length)throw new UserError('同一個網域不能同時給手機版與電腦版使用：{list}',{list:clash.join(', ')});
  saveConfig({publicUrl,remote:{tunnel,pocketHosts,contact,access:{hosts:accessHosts,teamDomain,aud}}});
  return remoteInfo();
}
// 資料源或金鑰變更後：重新評估可用因子、清除暫停狀態
function providersChanged(){invalidate();calendarCache={date:'',dates:[]};monitorPauseUntil=0;monitorError='';kbarDenied={until:0,error:''};newsPauseUntil=0;}
const keyText=(k,min=8)=>typeof k==='string'&&k.length>=min&&k.length<=10000&&!/\s/.test(k);
async function saveProviderKey(id,key){
  const p=PROVIDERS[id];if(!p||p.key==='none')throw new UserError('此資料源不需要金鑰');
  if(!keyText(key))throw new UserError('請輸入有效的金鑰');
  if(job.running)throw new UserError('請等待更新完成或停止後，再變更金鑰');
  // 以資料源的驗證端點測試金鑰並記錄方案等級；金鑰本身不會出現在網址、紀錄或回應中
  const info=await p.validate(key);await saveSecret(p.id,key);setProviderInfo(p.id,info||{});
  const c=config();if(!c.providers.enabled.includes(p.id))saveConfig({providers:{...c.providers,enabled:[...c.providers.enabled,p.id]}});
  providersChanged();return info;
}
async function saveLlmKey(provider,key,baseUrl){
  const info=LLM_INFO[provider];if(!info)throw new UserError('不支援的推理模型服務：{provider}',{provider});
  if(key!==undefined&&key!==''&&!keyText(key,10))throw new UserError('請輸入有效的 API 金鑰');
  if(!key&&!info.keyOptional)throw new UserError('請輸入有效的 API 金鑰');
  const l=config().llm,base=info.needsBaseUrl?(baseUrl??l.baseUrl):'';
  if(info.needsBaseUrl&&!safeURL(base||''))throw new UserError('請先設定 OpenAI 相容端點的網址');
  // 讀取模型清單即可驗證金鑰，不產生費用
  const models=await listModels({provider,key:key||'',baseUrl:base});
  if(key)await saveSecret(provider,key);
  const keep=l.provider===provider&&l.model&&models.includes(l.model)?l.model:info.defaultModel&&models.includes(info.defaultModel)?info.defaultModel:l.provider===provider?l.model:'';
  saveConfig({llm:{...l,provider,baseUrl:base,model:keep}});
  return models;
}
const SETTINGS_KEYS=['weights','updateTime','autoUpdate','autoScope','interval','monitor','radar','news','report'];
function exportBundle(){
  const c=config();
  return{app:'equilens',kind:'settings',version:1,exportedAt:new Date().toISOString(),market:c.market,language:c.language,
    groups:researchScope.groups.map(g=>({name:g.name,stockIds:g.stockIds})),watchlist,watchGroups,
    settings:Object.fromEntries(SETTINGS_KEYS.filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]])),
    providers:c.providers,llm:{provider:c.llm.provider,model:c.llm.model,baseUrl:c.llm.baseUrl,effort:c.llm.effort},upColor:c.upColor,publicUrl:c.publicUrl,remote:c.remote};
}
// 匯入設定檔（不含金鑰）：族群合併、自選與分組取代、各項設定逐項檢查後套用；其他市場的族群不匯入
function importBundle(b,parts){
  if(!b||b.app!=='equilens'||b.kind!=='settings')throw new UserError('不是衡析的設定檔');
  const want=k=>!Array.isArray(parts)||parts.includes(k),out={};
  const sameMarket=b.market===config().market;
  if(want('groups')&&Array.isArray(b.groups)){if(!sameMarket)out.groups={skipped:true,reason:t('設定檔的市場與目前不同，族群未匯入')};else{const r=importGroups(researchScope,b.groups,universe);researchScope=r.scope;raw={...readStocks(scopeIds(researchScope)),...raw};saveScope();out.groups={added:r.added,skipped:r.skipped};}}
  if(want('watch')&&sameMarket&&Array.isArray(b.watchlist)){watchlist=[...new Set(b.watchlist.filter(watchable))].slice(0,2500);watchGroups=normalizeWatchGroups(b.watchGroups||{},watchlist);saveWatch();out.watch={count:watchlist.length};}
  if(want('settings')&&b.settings&&typeof b.settings==='object'){
    const s=b.settings,next={...settings};
    if(validateWeights(s.weights))next.weights=s.weights;
    if(/^([01]\d|2[0-3]):[0-5]\d$/.test(s.updateTime||''))next.updateTime=s.updateTime;
    if(typeof s.autoUpdate==='boolean')next.autoUpdate=s.autoUpdate;
    if(['watchlist','all'].includes(s.autoScope))next.autoScope=s.autoScope;
    if([7000,13000,3000,1000].includes(s.interval))next.interval=s.interval;
    if(typeof s.monitor==='boolean')next.monitor=s.monitor;
    if(validRadarInput(s.radar))next.radar=normalizeRadar(s.radar);
    if(validNewsInput(s.news))next.news=normalizeNews(s.news);
    if(s.report)next.report=normalizeReportSettings(s.report);
    settings=next;saveSettings();setInterval_('finmind',settings.interval);invalidate();out.settings=true;
  }
  if(want('config')){const patch={};if(b.providers)patch.providers=b.providers;if(b.llm)patch.llm={...config().llm,...b.llm};if(b.upColor!==undefined)patch.upColor=b.upColor;if(b.publicUrl!==undefined)patch.publicUrl=b.publicUrl;if(b.remote&&typeof b.remote==='object')patch.remote=b.remote;if(LANGUAGES.includes(b.language))patch.language=b.language;saveConfig(patch);providersChanged();out.config=true;}
  return out;
}

/* ---------- HTTP ---------- */
const STATIC = { '/':'index.html', '/app.js':'app.js', '/heatmap.js':'heatmap.js', '/briefing.js':'briefing.js','/flow-cards.js':'flow-cards.js', '/live.js':'live.js', '/insight-ui.js':'insight-ui.js', '/report-card.js':'report-card.js', '/save-image.js':'save-image.js', '/prefs.js':'prefs.js', '/grouprank.js':'grouprank.js', '/i18n.js':'i18n.js', '/setup.js':'setup.js', '/market.js':'market.js', '/daytrade.js':'daytrade.js', '/intraday.js':'intraday.js', '/chipwatch.js':'chipwatch.js', '/hud.css':'hud.css', '/favicon.svg':'favicon.svg' };
// 舊版模組丟出的一般錯誤（尚未改成 UserError）中，可以直接顯示的訊息
const LEGACY_MESSAGE=/FinMind|金鑰|股票|族群|設定|格式|請|更新|無效|內容|行情|休市|公布|日期|查無|日報|雷達|時光機|畫格|分組|自選/;
const server = http.createServer(async (req,res) => {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  // 本機直接使用；遠端（remote.json 列出的主機）必須帶有效的 Cloudflare Access 憑證
  const isLocal=[`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(req.headers.host), isRemote=!isLocal&&isRemoteHost(req.headers.host);
  if (!isLocal&&!isRemote) return json(res,403,{ error:t('僅允許本機存取') });
  if (isRemote) { try { req.accessUser=await verifyAccessJwt(req.headers['cf-access-jwt-assertion'],remoteConfig()); } catch(e) { res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}); return res.end(t('衡析 Nexus 遠端存取需要經過 Cloudflare Access 驗證：')+e.message); } }
  try {
    const url = new URL(req.url,ORIGIN), route = url.pathname;
    if (route.startsWith('/api/') && req.method !== 'GET') {
      if (req.method !== 'POST' || req.headers['x-csrf-token'] !== csrf || (req.headers.origin && ![ORIGIN,`http://localhost:${PORT}`,...(isRemote?[`https://${req.headers.host}`]:[])].includes(req.headers.origin))) return json(res,403,{ error:t('請重新整理本機頁面後再試') });
    }
    if((flowBusy||heatBusy)&&req.method==='POST'&&['/api/update','/api/pattern-update','/api/news','/api/token','/api/provider-key','/api/config'].includes(route))return json(res,409,{error:t('即時查詢進行中，請稍候')});
    if(route==='/api/heatmap'&&req.method==='GET'){const dates=heatFiles();let date=url.searchParams.get('date');if(!date||date==='latest')date=dates.at(-1)||null;else if(!validHeatDate(date))throw new UserError('請選擇有效日期');return json(res,200,{data:date?read('heatmap-'+date+'.json',null):null,dates:dates.slice(-60),scope:data.has('dailyAll')?'market':'research'});}
    if(route==='/api/heatmap/live'&&req.method==='GET'){
      if(!liveWindow())return json(res,200,{live:false,data:liveHeat?.data?.date===today()?liveHeat.data:null,refreshMs:snapPlan().every});
      if(!data.has('snapshot'))throw new UserError('目前的資料源不支援盤中即時報價');
      return json(res,200,{live:true,data:await liveHeatmap(),refreshMs:snapPlan().every});
    }
    /* ----- 設定精靈與設定頁 ----- */
    if(route==='/api/config'&&req.method==='GET')return json(res,200,configInfo());
    if(route==='/api/config'&&req.method==='POST'){
      const b=await body(req),patch={};
      if(b.language!==undefined){if(!LANGUAGES.includes(b.language))throw new UserError('不支援的語言');patch.language=b.language;}
      if(b.publicUrl!==undefined){if(b.publicUrl&&(!safeURL(b.publicUrl)||!/^https:/.test(b.publicUrl)))throw new UserError('對外網址必須是 https:// 開頭的有效網址');patch.publicUrl=b.publicUrl||'';}
      if(b.upColor!==undefined){if(!['','red','green'].includes(b.upColor))throw new UserError('設定無效');patch.upColor=b.upColor;}
      if(b.setupDone!==undefined){if(typeof b.setupDone!=='boolean')throw new UserError('設定無效');patch.setupDone=b.setupDone;}
      if(b.market!==undefined){if(!MARKETS[b.market])throw new UserError('不支援的市場');switchMarket(b.market);}
      if(Object.keys(patch).length)saveConfig(patch);
      if(b.language!==undefined)invalidate();
      return json(res,200,{ok:true,...configInfo()});
    }
    if(route==='/api/remote'&&req.method==='POST'){const b=await body(req);return json(res,200,{ok:true,remote:saveRemote(b)});}
    if(route==='/api/providers'&&req.method==='POST'){
      const b=await body(req);
      if(!Array.isArray(b.enabled)||b.enabled.length>20||!b.enabled.every(id=>PROVIDERS[id])||new Set(b.enabled).size!==b.enabled.length)throw new UserError('資料源設定格式錯誤');
      const prefer=b.prefer&&typeof b.prefer==='object'?b.prefer:{};
      if(!Object.entries(prefer).every(([k,v])=>CAPABILITIES[k]&&PROVIDERS[v]))throw new UserError('資料源設定格式錯誤');
      saveConfig({providers:{enabled:b.enabled,prefer}});providersChanged();return json(res,200,{ok:true,...configInfo()});
    }
    if(route==='/api/provider-key'&&req.method==='POST'){
      const b=await body(req);
      if(b.remove){if(!PROVIDERS[b.id])throw new UserError('資料源設定格式錯誤');await deleteSecret(b.id);providersChanged();return json(res,200,{ok:true,...configInfo()});}
      const info=await saveProviderKey(b.id,b.key);return json(res,200,{ok:true,plan:info?{plan:info.plan,tier:info.tier}:null,...configInfo()});
    }
    if(route==='/api/provider-check'&&req.method==='POST'){ // 重新驗證已保存的金鑰（例如續訂付費方案後）
      const b=await body(req),p=PROVIDERS[b.id];if(!p||p.key==='none'||!hasKey(p))throw new UserError('請先設定此資料源的金鑰');
      const info=await p.validate(await getSecret(p.id,p.keyEnv));setProviderInfo(p.id,info||{});providersChanged();return json(res,200,{ok:true,...configInfo()});
    }
    if(route==='/api/llm'&&req.method==='POST'){
      const b=await body(req),l=config().llm;
      if(b.provider!==undefined&&!LLM_PROVIDERS.includes(b.provider))throw new UserError('不支援的推理模型服務：{provider}',{provider:String(b.provider).slice(0,40)});
      if(b.model!==undefined&&(typeof b.model!=='string'||b.model.length>120||/[\s<>"']/.test(b.model)))throw new UserError('模型名稱格式錯誤');
      if(b.effort!==undefined&&!['low','medium','high','xhigh'].includes(b.effort))throw new UserError('設定無效');
      if(b.baseUrl!==undefined&&b.baseUrl&&!safeURL(b.baseUrl))throw new UserError('請先設定 OpenAI 相容端點的網址');
      saveConfig({llm:{...l,...Object.fromEntries(['provider','model','effort','baseUrl'].filter(k=>b[k]!==undefined).map(k=>[k,b[k]]))}});return json(res,200,{ok:true,llm:llmStatus()});
    }
    if(route==='/api/llm-key'&&req.method==='POST'){
      const b=await body(req);
      if(b.remove){if(!LLM_INFO[b.provider])throw new UserError('不支援的推理模型服務：{provider}',{provider:''});await deleteSecret(b.provider);return json(res,200,{ok:true,llm:llmStatus()});}
      const models=await saveLlmKey(b.provider,b.key,b.baseUrl);return json(res,200,{ok:true,models,llm:llmStatus()});
    }
    if(route==='/api/llm-models'&&req.method==='GET'){
      const provider=url.searchParams.get('provider')||config().llm.provider,info=LLM_INFO[provider];if(!info)throw new UserError('不支援的推理模型服務：{provider}',{provider:''});
      const key=await getSecret(provider,info.keyEnv);if(!key&&!info.keyOptional)throw new UserError('請先設定此服務的 API 金鑰');
      return json(res,200,{models:await listModels({provider,key,baseUrl:config().llm.baseUrl})});
    }
    if(route==='/api/export'&&req.method==='GET')return json(res,200,exportBundle());
    if(route==='/api/import'&&req.method==='POST'){
      if(job.running)throw new UserError('請等待更新完成或停止後再匯入');
      const b=await body(req,1e6);return json(res,200,{ok:true,result:importBundle(b.bundle,b.parts)});
    }
    // 舊版前端的金鑰設定（FinMind、Claude）
    if(route==='/api/token'&&req.method==='POST'){
      const b=await body(req);if(b.remove){await deleteSecret('finmind');providersChanged();return json(res,200,{ok:true});}
      if(typeof b.token!=='string'||b.token.length<10)throw new UserError('請輸入有效的 FinMind Token');
      await saveProviderKey('finmind',b.token);return json(res,200,{ok:true});
    }
    if(route==='/api/claude-key'&&req.method==='POST'){
      const b=await body(req);if(b.remove){await deleteSecret('anthropic');return json(res,200,{ok:true});}
      await saveLlmKey('anthropic',b.key);return json(res,200,{ok:true});
    }
    /* ----- 盤中監控、雷達、看板、時光機 ----- */
    if(route==='/api/monitor'&&req.method==='GET')return json(res,200,{enabled:settings.monitor!==false,capable:data.has('snapshot'),mode:data.snapshotMode(),every:snapPlan().every,window:liveWindow(),lastAt:liveHeat?.at||null,asOf:liveHeat?.data?.asOf||null,error:monitorError,pausedUntil:monitorPauseUntil>Date.now()?monitorPauseUntil:null,radar:normalizeRadar(settings.radar),replayDays:listDays(),news:newsInfo(),stream:streamInfo()});
    if(route==='/api/news/settings'&&req.method==='POST'){
      const b=await body(req);if(!validNewsInput(b))throw new UserError('新聞推播設定格式錯誤');
      const was=normalizeNews(settings.news).enabled;settings={...settings,news:normalizeNews(b)};saveSettings();
      if(!was&&settings.news.enabled){newsStatus={...newsStatus,at:0,error:''};newsPauseUntil=0;} // 剛開啟：立即掃描（第一次只記錄現有新聞）
      return json(res,200,{ok:true,news:newsInfo()});
    }
    if(route==='/api/daytrade'&&req.method==='GET')return json(res,200,dtInfo());
    if(route==='/api/daytrade/review'&&req.method==='GET')return json(res,200,dtReview());
    if(route==='/api/daytrade/settings'&&req.method==='POST'){
      const b=await body(req);if(!b||typeof b!=='object'||Array.isArray(b))throw new UserError('當沖監控設定格式錯誤');
      settings={...settings,daytrade:normalizeDaytrade({...dtSettings(),...b,version:dtSettings().version,sources:{...dtSettings().sources,...b.sources},signals:{...dtSettings().signals,...b.signals},costs:{...dtSettings().costs,...b.costs}})};saveSettings();
      if(dt)dt.engine.setSettings(settings.daytrade);
      return json(res,200,{ok:true,settings:settings.daytrade});
    }
    if(route==='/api/books'&&req.method==='GET')return json(res,200,bookInfo());
    if(route==='/api/books/stocks'&&req.method==='GET'){const date=url.searchParams.get('date')||'';if(!validHeatDate(date))throw new UserError('請選擇有效日期');return json(res,200,{date,stocks:bookStocks(date)||[]});}
    if(route==='/api/books/export'&&req.method==='GET'){
      const date=url.searchParams.get('date')||'',id=url.searchParams.get('id')||'';
      if(!validHeatDate(date))throw new UserError('請選擇有效日期');if(!validId(id))throw new UserError('股票代號格式錯誤');
      const rows=await readStock(BOOKS,date,id);if(!rows?.length)return json(res,404,{error:t('{id} 在 {date} 沒有五檔錄製資料',{id,date})});
      const name=uniIndex().meta.get(id)?.name||'',file=`${id}${name?'-'+name:''}-${date}-五檔.csv`;
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${id}-${date}.csv"; filename*=UTF-8''${encodeURIComponent(file)}`,'Cache-Control':'no-store'});
      return res.end(toCSV(rows,{tz:M().tz}));
    }
    if(route==='/api/books/settings'&&req.method==='POST'){
      const b=await body(req);if(!b||typeof b!=='object'||Array.isArray(b))throw new UserError('五檔錄製設定格式錯誤');
      settings={...settings,books:normalizeBooks({...bookSettings(),...b})};saveSettings();return json(res,200,{ok:true,books:bookInfo()});
    }
    if(route==='/api/monitor/settings'&&req.method==='POST'){
      const b=await body(req);if(typeof b.monitor!=='boolean'||!validRadarInput(b.radar))throw new UserError('雷達設定格式錯誤');
      settings={...settings,monitor:b.monitor,radar:normalizeRadar(b.radar)};saveSettings();return json(res,200,{ok:true,radar:settings.radar});
    }
    if(route==='/api/price-alerts'&&req.method==='GET')return json(res,200,priceRulesInfo());
    if(route==='/api/price-alerts'&&req.method==='POST'){
      const b=await body(req);if(!b||typeof b!=='object'||Array.isArray(b))throw new UserError('提醒設定格式錯誤');
      const prev=b.id?priceRules.find(r=>r.id===b.id):null;if(b.id&&!prev)throw new UserError('找不到這則提醒');
      if(!prev){if(!watchable(b.stockId))throw new UserError('股票代碼無效或不在股票清單中');if(priceRules.length>=MAX_RULES)throw new UserError('自訂提醒已達上限 {n} 則',{n:MAX_RULES});}
      const r=normalizeRule(b,prev);if(r.error)throw new UserError(r.error);
      priceRules=prev?priceRules.map(x=>x.id===r.id?r:x):[...priceRules,r];ruleState?.cond.delete(r.id);savePriceRules();
      return json(res,200,{ok:true,rule:r,...priceRulesInfo()});
    }
    if(route==='/api/price-alerts/delete'&&req.method==='POST'){
      const b=await body(req);priceRules=priceRules.filter(r=>r.id!==b.id);savePriceRules();return json(res,200,{ok:true,...priceRulesInfo()});
    }
    /* ----- 籌碼追蹤 ----- */
    if(route==='/api/chipwatch'&&req.method==='GET'){const date=url.searchParams.get('date');if(date&&date!=='latest'&&!validHeatDate(date))throw new UserError('請選擇有效日期');return json(res,200,chipwatchInfo(date));}
    if(route==='/api/chipwatch/branches'&&req.method==='GET'){
      const q=(url.searchParams.get('q')||'').trim().toUpperCase().slice(0,30);finmind('brokers');
      const list=await once('branches',()=>branchList());
      return json(res,200,{branches:q?list.filter(b=>`${b.id} ${b.name}`.toUpperCase().includes(q)).slice(0,40):[]});
    }
    if(route==='/api/chipwatch/settings'&&req.method==='POST'){
      const b=await body(req),cur=chipSettings();
      if(b.branches!==undefined&&(!Array.isArray(b.branches)||b.branches.length>MAX_BRANCHES))throw new UserError('最多追蹤 {n} 個分點',{n:MAX_BRANCHES});
      settings={...settings,chipwatch:normalizeChipwatch({...cur,...Object.fromEntries(['branches','auto','dayPct','minAmount','accumPct','accumDays','holdersPush','warrants','warrantAmount','warrantPct','warrantDays'].filter(k=>b[k]!==undefined).map(k=>[k,b[k]]))})};saveSettings();
      return json(res,200,{ok:true,...chipwatchInfo()});
    }
    if(route==='/api/chipwatch/query'&&req.method==='POST'){
      // 在背景查詢（分點多、加查權證時可能要幾分鐘），立即回傳；畫面以 GET /api/chipwatch?date= 追蹤進度與結果
      const b=await body(req);let date=b.date;finmind('brokers');
      if(!chipSettings().branches.length)throw new UserError('請先加入要追蹤的券商分點');
      if(bw.busy)throw new UserError('分點追蹤查詢中，請稍候');
      if(date&&!validHeatDate(date))throw new UserError('請選擇有效日期');
      const x=clock(),ds=(await tradingDates()).filter(d=>d<=x.date);
      // 今天有盤中紀錄但交易日曆還沒列入今天時，仍視為交易日
      if(x.weekday>=1&&x.weekday<=5&&ds.at(-1)<x.date&&replayToday()?.date===x.date)ds.push(x.date);
      if(date&&ds.length&&date>=ds[0]&&!ds.includes(date))throw new UserError('{date} 不是交易日',{date});
      // 未指定日期：今天 18:30 後查今天，否則查前一個交易日
      if(!date)date=ds.at(-1)===x.date&&x.hm<'18:30'?ds.at(-2):ds.at(-1);
      if(!date)throw new UserError('查無交易日');
      runBrokerWatch(date,{manual:true}).catch(e=>console.error(t('分點追蹤失敗：')+e.message));
      return json(res,202,{ok:true,started:true,...chipwatchInfo(date)});
    }
    if(route==='/api/holders/rank'&&req.method==='GET'){
      const scope=url.searchParams.get('scope')==='market'?'market':'mine',date=url.searchParams.get('date');
      if(date&&date!=='latest'&&!validHeatDate(date))throw new UserError('請選擇有效日期');
      return json(res,200,{capable:chipCapable(),rank:holderRank(scope,date),...holderStatus()});
    }
    if(route==='/api/holders/rank/query'&&req.method==='POST'){
      finmind('brokers');await refreshHolders();return json(res,200,{capable:true,rank:holderRank('mine'),...holderStatus()});
    }
    if(route==='/api/alerts'&&req.method==='GET'){
      let date=url.searchParams.get('date')||today();
      if(date==='latest'){const files=fs.readdirSync(LOCAL).map(f=>/^alerts-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter(Boolean).sort();date=files.at(-1)||today();}
      if(!validHeatDate(date))throw new UserError('請選擇有效日期');
      const since=Number(url.searchParams.get('since')||0),list=alertsFor(date).list;
      return json(res,200,{date,latest:list.at(-1)?.seq||0,alerts:list.filter(a=>a.seq>since).slice(-300)});
    }
    if(route==='/api/board'&&req.method==='GET'){
      const q=url.searchParams.get('ids');
      if(q){const ids=[...new Set(q.split(','))].slice(0,60);if(!ids.every(validId))throw new UserError('股票代碼格式錯誤');return json(res,200,boardData(ids));}
      // 看板可切換「自選」或研究總覽任一族群；指定的族群不存在（例如已刪除）時退回預設
      const groups=boardGroups(),want=url.searchParams.get('group');
      const gid=want==='watch'||groups.some(g=>g.id===want)?want:watchlist.length||!groups.length?'watch':groups[0].id;
      const ids=gid==='watch'?watchlist:researchScope.groups.find(g=>g.id===gid).stockIds;
      return json(res,200,{...boardData(ids),group:gid,groups,watchCount:watchlist.length});
    }
    if(route==='/api/replay/days'&&req.method==='GET')return json(res,200,{days:listDays()});
    if(route==='/api/replay'&&req.method==='GET'){
      const date=url.searchParams.get('date')||listDays().at(-1);const day=date&&validHeatDate(date)?loadDay(date):null;
      if(!day||!day.frames.length)throw new UserError('此日沒有時光機紀錄（盤中監控啟動後才會錄製）');
      const key=`${date}:${day.frames.length}`;if(replayCache.key!==key)replayCache={key,data:replaySummary(day,uniIndex().list)};
      return json(res,200,replayCache.data);
    }
    if(route==='/api/replay/frame'&&req.method==='GET'){
      const date=url.searchParams.get('date'),i=Number(url.searchParams.get('i'));const day=validHeatDate(date||'')?loadDay(date):null;
      const f=day?.frames[i];if(!f)throw new UserError('時光機畫格不存在');return json(res,200,{t:f.t,p:f.p,a:f.a});
    }
    if(route==='/api/intraday'&&req.method==='GET'){
      const id=url.searchParams.get('id'),group=url.searchParams.get('group')||'';
      if(!validId(id))throw new UserError('股票代碼格式錯誤');if(group&&!/^[\w-]{1,40}$/.test(group))throw new UserError('資料格式錯誤');
      return json(res,200,await intradayReport(id,group));
    }
    if(route==='/api/index'&&req.method==='GET'){
      const id=url.searchParams.get('id');if(!INDEXES[id])throw new UserError('資料格式錯誤');
      return json(res,200,await indexReport(id));
    }
    if(route==='/api/chart'&&req.method==='GET'){
      const id=url.searchParams.get('id'),period=url.searchParams.get('period')==='day'?'day':'5m';
      if(!validId(id))throw new UserError('股票代碼格式錯誤');
      return json(res,200,await once(`c:${id}:${period}`,()=>chartReport(id,period)));
    }
    if(route==='/api/brokers'&&req.method==='GET'){
      const id=url.searchParams.get('id'),n=Math.min(10,Math.max(2,Number(url.searchParams.get('days')||5)));
      if(!validId(id))throw new UserError('股票代碼格式錯誤');
      return json(res,200,await once(`b:${id}:${n}`,()=>brokerReport(id,n)));
    }
    if(route==='/api/warrants'&&req.method==='GET'){
      const id=url.searchParams.get('id');if(!validId(id))throw new UserError('股票代碼格式錯誤');
      return json(res,200,await once(`w:${id}`,()=>warrantReport(id)));
    }
    if(route==='/api/warrants/brokers'&&req.method==='GET'){
      const wid=String(url.searchParams.get('wid')||'').toUpperCase(),date=url.searchParams.get('date');
      if(!WARRANT_ID.test(wid)||!validHeatDate(date))throw new UserError('資料格式錯誤');
      return json(res,200,await once(`wb:${wid}:${date}`,()=>warrantBrokers(wid,date)));
    }
    if(route==='/api/holders'&&req.method==='GET'){
      const id=url.searchParams.get('id');if(!validId(id))throw new UserError('股票代碼格式錯誤');
      return json(res,200,await once(`h:${id}`,()=>holderReport(id)));
    }
    /* ----- 族群排名 ----- */
    if(route==='/api/grouprank/query'&&req.method==='POST')return json(res,200,await once('grouprank',()=>queryGroupRank()));
    if(route==='/api/grouprank/close'&&req.method==='POST'){ // 以時光機紀錄或本機日成交補建指定交易日的收盤排名
      const b=await body(req);if(!validHeatDate(b.date))throw new UserError('請選擇有效日期');const q=grCloseQuotes(b.date);
      if(!q)throw new UserError('此日沒有足夠的收盤資料（時光機紀錄或本機日成交），無法補建族群排名');
      const d=grPack(b.date,q,'close');write(`grouprank-${b.date}.json`,d);return json(res,200,d);
    }
    if(route==='/api/grouprank'&&req.method==='GET'){
      const dates=grDates();let date=url.searchParams.get('date');if(!date||date==='latest')date=dates.at(-1)||null;else if(!validHeatDate(date))throw new UserError('請選擇有效日期');
      return json(res,200,{record:date?read(`grouprank-${date}.json`,null):null,dates:dates.slice(-30),live:grLive.data&&Date.now()-grLive.at<600e3?grLive.data:null});
    }
    /* ----- AI 盤後日報 ----- */
    if(route==='/api/report'&&req.method==='GET'){
      const dates=reportDates();let date=url.searchParams.get('date');if(!date||date==='latest')date=dates.at(-1)||null;else if(!validHeatDate(date))throw new UserError('請選擇有效日期');
      return json(res,200,{report:date?read(`reports/${date}.json`,null):null,dates:dates.slice(-30),busy:reportBusy,error:reportError,configured:llmConfigured(),llm:{provider:config().llm.provider,model:config().llm.model||LLM_INFO[config().llm.provider]?.defaultModel||''},settings:normalizeReportSettings(settings.report)});
    }
    if(route==='/api/report/card'&&req.method==='GET'){
      const date=url.searchParams.get('date')||reportDates().at(-1);if(!date||!validHeatDate(date))throw new UserError('請選擇有效日期');
      const cached=read(`card-${date}.json`,null),rep=read(`reports/${date}.json`,null);
      if(cached&&url.searchParams.get('refresh')!=='1'&&(!rep||cached.builtAt>=rep.createdAt))return json(res,200,cached);
      return json(res,200,await once(`card:${date}`,()=>buildMarketCard(date)));
    }
    if(route==='/api/report/generate'&&req.method==='POST'){
      const b=await body(req),date=b.date||today();if(!validHeatDate(date))throw new UserError('請選擇有效日期');
      if(reportBusy)return json(res,409,{error:t('日報產生中，請稍候')});
      if(!llmConfigured())throw new UserError('請先在「資料與設定」設定推理模型與金鑰');
      generateDaily(date).catch(e=>console.error(t('AI 日報產生失敗：')+e.message));return json(res,202,{ok:true});
    }
    if(route==='/api/report/settings'&&req.method==='POST'){
      const b=await body(req);if(typeof b.auto!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time||''))throw new UserError('日報設定格式錯誤');
      settings={...settings,report:normalizeReportSettings(b)};saveSettings();return json(res,200,{ok:true,settings:settings.report});
    }
    if(route==='/api/heatmap/query'&&req.method==='POST'){
      const b=await body(req);if(!validHeatDate(b.date))throw new UserError('請選擇 2015-01-05 至今天的有效日期');
      if(job.running||flowBusy||heatBusy)return json(res,409,{error:t('已有資料更新或查詢進行中，請稍候再查詢熱浪圖')});
      const result=await runHeatmap(b.date);return json(res,200,{data:result,dates:heatFiles().slice(-60)});
    }
    if(route==='/api/briefing/news'&&req.method==='GET'){const offset=Number(url.searchParams.get('offset')||0);if(![0,1].includes(offset))throw new UserError('請選擇有效日期');return json(res,200,await focusNews({offset,refresh:url.searchParams.get('refresh')==='1'}));}
    if(route==='/api/briefing/week'&&req.method==='GET')return json(res,200,await weekAgenda({refresh:url.searchParams.get('refresh')==='1'}));
    if(route==='/api/flows'&&req.method==='GET'){const date=url.searchParams.get('date');if(!validFlowDate(date))throw new UserError('請選擇有效日期');return json(res,200,{data:read('flows-'+date+'.json',null)});}
    if(route==='/api/flows/query'&&req.method==='POST'){
      if(job.running||flowBusy||heatBusy)return json(res,409,{error:t('已有資料更新或查詢進行中，請稍候')});
      const b=await body(req);if(!validFlowDate(b.date))throw new UserError('請選擇 2018-06-05 至今天的有效日期');const fm=finmind('flows');
      if(job.running||flowBusy||heatBusy)return json(res,409,{error:t('已有資料更新或查詢進行中，請稍候')});flowBusy=true;
      try{const result=await queryFlows(b.date,{requestData:fm,...fmOpt()});if(cacheableFlow(result))write('flows-'+b.date+'.json',result);return json(res,200,{data:result});}finally{flowBusy=false;}
    }
    if (route === '/api/state') {
      const m = market(), c = config();
      const headlines=m.stocks.flatMap(s=>(raw[s.id]?.news||[]).filter(n=>n.date.slice(0,10)>=minusDays(m.cutoff,30)).map(n=>({stockId:s.id,name:s.name,title:n.title,date:n.date,url:n.link,source:n.source}))).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,60);
      return json(res,200,{ ...m, appVersion:APP_VERSION, heatDates:heatFiles().slice(-60), heatSummary:heatSummary(),indexSummary:indexSummary(), groups:researchScope.groups, scopeSource:researchScope.source, scopeEntries:researchScope.groups.reduce((n,g)=>n+g.stockIds.length,0), scopeError, stocks:m.stocks.map(({bars,adjustedBars,...s}) => ({...s,chips:{...s.chips,flow:undefined}})), headlines, watchlist, watchGroups, watchExtra:watchExtra(), settings,
        config:{market:c.market,language:c.language,setupDone:c.setupDone,publicUrl:c.publicUrl}, marketProfile:clientMarket(M()), upColor:upColor(), capabilities:capabilityMap(), dataConfigured:Object.values(capabilityMap()).some(Boolean),
        tokenConfigured:secretConfigured('finmind','FINMIND_API_TOKEN'), llmConfigured:llmConfigured(), claudeConfigured:llmConfigured(), llm:{provider:c.llm.provider,model:c.llm.model||LLM_INFO[c.llm.provider]?.defaultModel||''},
        viewer:req.accessUser?.email||null, monitor:{enabled:settings.monitor!==false,capable:data.has('snapshot'),window:liveWindow(),error:monitorError,lastAt:liveHeat?.at||null}, csrf, job, evidenceCount:evidence.filter(e=>inScope(e.stockId)).length });
    }
    if(route==='/api/catalog' && req.method==='GET'){
      const q=(url.searchParams.get('q')||'').trim().slice(0,80);
      if(!q)return json(res,200,{stocks:[]});
      const qu=q.toUpperCase(),known=uniIndex().list;
      return json(res,200,{stocks:known.filter(s=>`${s.id} ${s.name}`.toUpperCase().includes(qu)).sort((a,b)=>(b.id.toUpperCase()===qu)-(a.id.toUpperCase()===qu)||a.id.localeCompare(b.id)).slice(0,40).map(s=>({id:s.id,name:s.name,market:s.market,listingNote:s.listingNote||null,inScope:inScope(s.id)})),canAddUnlisted:!data.has('universe')});
    }
    /* ----- 研究族群管理 ----- */
    if(route==='/api/groups' && req.method==='POST'){
      const b=await body(req);
      const result=addGroup(researchScope,b.name);researchScope=result.scope;saveScope();return json(res,201,{group:result.group});
    }
    if(route==='/api/groups/rename'&&req.method==='POST'){const b=await body(req);researchScope=renameGroup(researchScope,b.groupId,b.name);saveScope();return json(res,200,{ok:true,groups:researchScope.groups});}
    if(route==='/api/groups/delete'&&req.method==='POST'){const b=await body(req);researchScope=removeGroup(researchScope,b.groupId);saveScope();return json(res,200,{ok:true,groups:researchScope.groups});}
    if(route==='/api/groups/order'&&req.method==='POST'){const b=await body(req);researchScope=reorderGroups(researchScope,b.ids);saveScope();return json(res,200,{ok:true,groups:researchScope.groups});}
    // 範例族群（data/templates/<市場>.json，只含公開的大型股，供第一次使用時參考）
    if(route==='/api/template'&&req.method==='GET'){const file=path.join(ROOT,'data','templates',`${config().market}.json`);return json(res,200,{template:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null});}
    if(route==='/api/groups/import'&&req.method==='POST'){const b=await body(req,1e6);const named=Array.isArray(b.stocks)?b.stocks.filter(s=>validId(s?.id)&&typeof s.name==='string').slice(0,2000).map(s=>({id:s.id,name:s.name.slice(0,60),sector:'',market:''})):[];const r=importGroups(researchScope,b.groups,[...universe,...named]);researchScope=r.scope;raw={...readStocks(scopeIds(researchScope)),...raw};saveScope();return json(res,200,{ok:true,added:r.added,skipped:r.skipped,groups:researchScope.groups});}
    if(route==='/api/group-stocks' && req.method==='POST'){
      const b=await body(req);
      if(b.remove){const r=removeStock(researchScope,b.groupId,b.stockId);researchScope=r.scope;saveScope();return json(res,200,{removed:r.removed,stockId:b.stockId});}
      // 資料源沒有股票清單時，可直接加入符合市場代號格式的股票（名稱可自訂，之後更新資料時確認）
      const extra=!data.has('universe')&&validId(b.stockId)&&!uniIndex().ids.has(b.stockId)?[{id:b.stockId,name:typeof b.name==='string'&&b.name.trim()?b.name.trim().slice(0,60):b.stockId,sector:'',market:''}]:[];
      const result=addStock(researchScope,b.groupId,b.stockId,[...universe,...extra]);researchScope=result.scope;saveScope();
      if(!raw[b.stockId])raw[b.stockId]=read(`stocks/${b.stockId}.json`,{});
      return json(res,200,{added:result.added,stockId:b.stockId,needsUpdate:!raw[b.stockId]?.price?.length});
    }
    if(route==='/api/patterns'&&req.method==='GET'){const snapshot=patternSnapshot(universe);return json(res,200,{...snapshot,stocks:snapshot.stocks.map(({bars,...s})=>s),scope:data.has('dailyAll')?'market':'local'});}
    if(route==='/api/pattern-detail'&&req.method==='GET'){const s=patternSnapshot(universe).stocks.find(x=>x.id===url.searchParams.get('id'));return s?json(res,200,s):json(res,404,{error:t('此股票目前沒有符合的型態')});}
    if(route==='/api/pattern-update'&&req.method==='POST'){
      if(job.running)return json(res,409,{error:t('已有更新進行中')});
      if(!data.has('dailyAll'))throw new UserError('目前的資料源不支援全市場單日行情；型態選股只掃描已有資料的研究名單與自選股');
      void refreshPatternMarket();
      return json(res,202,{ok:true});
    }
    if (route === '/api/health') return json(res,200,{ ok:true, app:'equilens-nexus',version:APP_VERSION, market:config().market, language:language() });
    // 手機版（Pocket）用：市場、語言、配色與可用功能（不含任何金鑰）
    if (route === '/api/profile' && req.method === 'GET') { const c = config(); return json(res,200,{ language:c.language, market:clientMarket(M()), upColor:upColor(), capabilities:capabilityMap(), publicUrl:c.publicUrl, remote:(({tunnel,hosts,contact})=>({tunnel,hosts,contact}))(remoteInfo()), setupDone:c.setupDone, llmConfigured:llmConfigured(), dataConfigured:Object.values(capabilityMap()).some(Boolean) }); }
    if (route === '/api/job' && req.method === 'GET') return json(res,200,{ job, busy:flowBusy||heatBusy });
    if (route === '/api/detail') { const s = market().stocks.find(s => s.id === url.searchParams.get('id')); return s ? json(res,200,{ ...s, news:raw[s.id]?.news || [], evidence:evidence.filter(e => e.stockId === s.id) }) : json(res,404,{ error:t('找不到此股票') }); }
    if (route === '/api/update' && req.method === 'POST') {
      if (job.running) return json(res,409,{ error:t('已有更新進行中') });
      const b = await body(req);
      if (!['watchlist','all','selected','universe'].includes(b.scope)) throw new UserError('更新範圍無效');
      if (b.scope === 'selected' && (!Array.isArray(b.ids) || b.ids.length > 100 || !b.ids.every(validId))) throw new UserError('股票代碼格式錯誤');
      if (!data.has('daily')) throw new UserError('目前啟用的資料源不支援「{cap}」，請到「資料與設定 → 資料來源」啟用支援的資料源', { cap:t(CAPABILITIES.daily) });
      selectedUpdateIds(researchScope,b.scope,b.ids||[],watchlist);
      void refresh(b.scope, b.ids || []);
      return json(res,202,{ ok:true });
    }
    if (route === '/api/cancel' && req.method === 'POST') { controller?.abort(); return json(res,200,{ ok:true }); }
    if (route === '/api/watchlist' && req.method === 'POST') {
      const b = await body(req); if (!Array.isArray(b.ids) || b.ids.length > 2500 || !b.ids.every(watchable)) throw new UserError('股票代碼無效或不在股票清單中');
      watchlist = [...new Set(b.ids)]; saveWatch(); return json(res,200,{ ok:true });
    }
    if (route === '/api/watch/set' && req.method === 'POST') { // 加入／移除單一自選股並指定分組
      const b = await body(req); if (!watchable(b.id) || typeof b.on !== 'boolean' || (b.group !== undefined && (typeof b.group !== 'string' || b.group.length > 8))) throw new UserError('股票代碼或自選分組格式錯誤');
      if (b.on && !watchlist.includes(b.id) && watchlist.length >= 2500) throw new UserError('自選股已達上限');
      ({ watchlist, groups: watchGroups } = setWatch({ watchlist, groups: watchGroups }, b.id, b.on, b.group)); saveWatch();
      return json(res,200,{ ok:true, watchlist, watchGroups });
    }
    if (route === '/api/watch/groups' && req.method === 'POST') { // 自選分組：新增、改名、刪除、排序
      const b = await body(req); watchGroups = editWatchGroups(watchGroups, b.groups, watchlist); saveWatch();
      return json(res,200,{ ok:true, watchGroups });
    }
    if (route === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      if (!validateWeights(b.weights) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.updateTime) || ![7000,13000,3000,1000].includes(b.interval) || !['watchlist','all'].includes(b.autoScope) || typeof b.autoUpdate !== 'boolean') throw new UserError('設定無效，四項權重合計須為 100%');
      settings = { ...settings, weights:b.weights, updateTime:b.updateTime, interval:b.interval, autoScope:b.autoScope, autoUpdate:b.autoUpdate }; saveSettings(); setInterval_('finmind',settings.interval); invalidate(); return json(res,200,{ ok:true });
    }
    if (route === '/api/news' && req.method === 'POST') {
      const b = await body(req); if (!inScope(b.id)) throw new UserError('股票不在研究範圍內，請先加入族群');
      if (job.running) throw new UserError('請等待價格更新完成，再取得新聞');
      if (!data.has('news')) throw new UserError('目前啟用的資料源不支援「{cap}」，請到「資料與設定 → 資料來源」啟用支援的資料源', { cap:t(CAPABILITIES.news) });
      job = { running:true, done:0, total:3, current:b.id, dataset:'news', errors:[], message:t('讀取近三個日曆日新聞…') }; controller = new AbortController();
      void (async () => { try { const news = await fetchNews(b.id,raw[b.id]?.news, { cutoff:today(), signal:controller.signal }); raw[b.id] = { ...(raw[b.id] || {}), news }; write(`stocks/${b.id}.json`,raw[b.id]); job.done=3; job.message=t('近三個日曆日新聞已更新'); } catch(e) { job.message=e.message; } finally { job.running=false; invalidate(); } })();
      return json(res,202,{ ok:true });
    }
    if (route === '/api/evidence' && req.method === 'POST') {
      const b = await body(req);
      if (b.deleteId) { evidence=evidence.filter(e=>e.id!==b.deleteId); write('evidence.json',evidence); invalidate(); return json(res,200,{ok:true}); }
      if (!inScope(b.stockId) || typeof b.title !== 'string' || b.title.trim().length < 3 || b.title.length > 180 || !safeURL(b.url) || b.url.length>2048 || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !Number.isFinite(Date.parse(b.date)) || new Date(b.date).toISOString().slice(0,10)!==b.date || b.date > today() || !['positive','neutral','negative'].includes(b.direction) || !['watch','confirmed','realized'].includes(b.stage)) throw new UserError('請填入有效股票、日期、原文網址及判讀');
      if(evidence.some(e=>e.stockId===b.stockId&&e.url===b.url&&e.date===b.date))throw new UserError('同一股票、來源與日期已有紀錄，請先移除原判讀再更新');
      evidence.push({ id:crypto.randomUUID(), stockId:b.stockId, title:b.title.trim(), url:b.url, date:b.date, direction:b.direction, stage:b.stage, createdAt:new Date().toISOString() });
      write('evidence.json',evidence); invalidate(); return json(res,200,{ ok:true });
    }
    if (route.startsWith('/api/')) return json(res,404,{error:t('不存在的操作')});
    if (req.method !== 'GET') return json(res,405,{error:t('不支援的請求')});
    const loc = /^\/locales\/([a-z]{2}(?:-[A-Z]{2})?)\.json$/.exec(route);
    const file = STATIC[route] || (loc && LANGUAGES.includes(loc[1]) && loc[1] !== 'zh-TW' ? `locales/${loc[1]}.json` : null);
    if (!file || !fs.existsSync(path.join(ROOT,'public',file))) return json(res,404,{error:t('頁面不存在')});
    // 遠端經 Cloudflare 時 js／css 會被快取 4 小時：頁面與模組 import 一律加上版本號（public 檔案修改時間雜湊）
    let content = fs.readFileSync(path.join(ROOT,'public',file));
    if (file==='index.html') content = content.toString('utf8').replace(/(\/(?:app\.js|hud\.css))"/g,`$1?v=${frontBuild()}"`).replace(/<html lang="[^"]*"/, `<html lang="${language()}"`);
    else if (file.endsWith('.js')) content = content.toString('utf8').replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\/[\w-]+\.js)\2/g,`$1$2$3?v=${frontBuild()}$2`);
    res.writeHead(200,{ 'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.json')?'application/json; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-cache' }); res.end(content);
  } catch(e) {
    const shown = isUserError(e) ? e.message : e instanceof Error && LEGACY_MESSAGE.test(e.message) ? e.message : t('操作失敗，請稍後再試');
    if (!isUserError(e) && !(e instanceof Error && LEGACY_MESSAGE.test(e.message))) console.error(e?.message || e);
    json(res, isUserError(e) && e.status >= 400 && e.status < 500 ? e.status : 400, { error: shown });
  }
});
server.listen(PORT,'127.0.0.1',() => console.log(`EquiLens Nexus ready: ${ORIGIN}`));
server.on('error',e => { console.error(e.code==='EADDRINUSE'?t('連接埠已使用；請開啟現有頁面，或以 PORT 環境變數設定其他連接埠'):t('本機服務啟動失敗')); process.exit(1); });
let autoRetryAt=0,autoAttempts=0,autoAttemptDate='';
setInterval(() => {
  if (!settings.autoUpdate || job.running || flowBusy || heatBusy || !data.has('daily')) return;
  const x = clock(), date = x.date;
  if (x.weekday < 1 || x.weekday > 5 || x.hm < settings.updateTime || settings.lastAutoDate === date) return;
  if(autoAttemptDate!==date){autoAttemptDate=date;autoAttempts=0;autoRetryAt=0;}
  if(Date.now()<autoRetryAt||autoAttempts>=3)return;autoAttempts++;autoRetryAt=Date.now()+30*60*1000;
  // 熱浪圖：有全市場單日行情時先查；沒有時等研究名單更新完，再用本機日成交組成
  const heat=async()=>{if(!heatFiles().includes(date)){try{await runHeatmap(date);}catch(e){console.error(t('熱浪圖自動更新失敗：')+e.message);}}};
  void (async()=>{
    if(data.has('dailyAll'))await heat();
    await refresh(settings.autoScope,[]);const firstOk=!job.errors.length;
    if(!data.has('dailyAll'))await heat();
    if(controller?.signal.aborted){settings.lastAutoDate=date;saveSettings();return;}
    if(data.has('dailyAll'))await refreshPatternMarket();
    if(!firstOk){job.errors.push({message:t('族群研究更新未全部成功，稍後自動重試')});job.message+=t('；族群研究仍有更新失敗項目');write('last-job.json',job);}
    if(controller?.signal.aborted||firstOk&&!job.errors.length){settings.lastAutoDate=date;saveSettings();}
  })();
},30000).unref();
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{controller?.abort();server.close(()=>process.exit(0));});
