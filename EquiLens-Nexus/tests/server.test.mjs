import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('local API persists watchlist/evidence, validates settings, blocks cross-origin writes and leaks',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'equilens-test-'));
  fs.writeFileSync(path.join(directory,'universe.json'),JSON.stringify([{id:'2330',name:'台積電',sector:'半導體業',market:'上市'}]));
  fs.writeFileSync(path.join(directory,'groups.json'),JSON.stringify({version:1,groups:[{id:'test',name:'測試族群',stockIds:['2330']}],stockMetadata:[]}));
  const catalog=JSON.parse(fs.readFileSync(path.join(directory,'universe.json'),'utf8'));catalog.push({id:'2454',name:'聯發科',sector:'半導體業',market:'上市'});fs.writeFileSync(path.join(directory,'universe.json'),JSON.stringify(catalog));
  const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/pattern-fixtures.json'),'utf8'))[0];const fixtureToday=new Date().toISOString().slice(0,10),shift=Date.parse(fixtureToday)-Date.parse(fixture.price.at(-1).date);for(const key of ['price','adjusted'])fixture[key]=fixture[key].map(r=>({...r,date:new Date(Date.parse(r.date)+shift).toISOString().slice(0,10)}));catalog.push(fixture.stock);fs.writeFileSync(path.join(directory,'universe.json'),JSON.stringify(catalog));fs.mkdirSync(path.join(directory,'stocks'),{recursive:true});fs.writeFileSync(path.join(directory,'stocks',fixture.stock.id+'.json'),JSON.stringify(fixture));
  // 時光機紀錄（09:00、11:15、13:30 三個畫格）：看板走勢圖的橫軸位置應為全日的 0、0.5、1
  fs.mkdirSync(path.join(directory,'replay'),{recursive:true});
  fs.writeFileSync(path.join(directory,'replay','2026-10-07.ndjson'),[{v:2,date:'2026-10-07',ids:['2330'],prev:[100000],ps:100,as:1e6},{t:'09:00',p:[100500],a:[10],v:[5]},{t:'11:15',p:[101000],a:[20],v:[9]},{t:'13:30',p:[100800],a:[30],v:[12]}].map(x=>JSON.stringify(x)).join('\n')+'\n');
  // 已收盤檢討過的當沖訊號紀錄（未檢討完的不計入）
  fs.mkdirSync(path.join(directory,'daytrade'),{recursive:true});
  const outcome={r5:0.3,r15:-0.2,r30:0.5,rClose:-1,mfe:1.2,mae:-0.4,cost:0.435};
  fs.writeFileSync(path.join(directory,'daytrade','2026-10-06.json'),JSON.stringify({date:'2026-10-06',mode:'full',closedAt:'2026-10-06T05:36:00Z',signals:[{type:'dt-breakout',id:'2330',name:'台積電',t:'09:40:01',price:1450,score:72,outcome},{type:'dt-bid',id:'2330',name:'台積電',t:'10:05:00',price:1460,score:65,outcome:{...outcome,r15:0.4}},{type:'dt-vwap',version:2,purpose:'opportunity',id:'2330',name:'台積電',t:'10:30:00',price:1470,score:80,outcome,market:{index:'twse',chg:0.5,r15:0.2,vsAvg:0.1,rs15:0.3}}]}));
  fs.writeFileSync(path.join(directory,'daytrade','2026-10-07.json'),JSON.stringify({date:'2026-10-07',signals:[{type:'dt-vwap',id:'2330',price:1,m:600}]}));
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'4399',EQUITY_DATA_DIR:directory,FINMIND_API_TOKEN:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(new Error(`Server exited ${c}`)));setTimeout(()=>reject(new Error('Server startup timeout')),10000).unref();});
    const base='http://127.0.0.1:4399/api/';
    const s=await (await fetch(base+'state')).json();assert.equal(s.tokenConfigured,false);assert(s.csrf);assert.equal(s.stocks[0].price,null);
    let r=await fetch(base+'watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"ids":[]}'});assert.equal(r.status,403);
    const headers={'Content-Type':'application/json','X-CSRF-Token':s.csrf};
    assert.equal((await fetch(base+'flows?date=../../secret')).status,400);
    assert.equal((await fetch(base+'flows/query',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'flows/query',{method:'POST',headers,body:'{"date":"2026-02-30"}'})).status,400);
    assert.equal((await (await fetch(base+'flows?date=2026-09-01')).json()).data,null);
    r=await fetch(base+'watchlist',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{"ids":[]}'});assert.equal(r.status,403);
    r=await fetch(base+'watchlist',{method:'POST',headers,body:'{"ids":["2330"]}'});assert.equal(r.status,200);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'watchlist.json'),'utf8')),['2330']);
    r=await fetch(base+'settings',{method:'POST',headers,body:JSON.stringify({weights:{technical:100,chips:100,topic:0,industry:0},updateTime:'19:30',interval:7000,autoUpdate:false,autoScope:'all'})});assert.equal(r.status,400);
    assert.equal(s.stocks.length,1);
    const patterns=await(await fetch(base+'patterns')).json();assert.equal(patterns.universe,3);assert.equal(patterns.matched,1);assert.equal(patterns.stocks[0].id,fixture.stock.id);assert.equal(patterns.stocks[0].bars,undefined);
    assert.equal((await fetch(base+'pattern-detail?id='+fixture.stock.id)).status,200);assert.equal((await fetch(base+'detail?id='+fixture.stock.id)).status,404);
    assert.equal((await fetch(base+'pattern-update',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'detail?id=2454')).status,404);
    for(const endpoint of ['watchlist','news','update']){const body=endpoint==='watchlist'?{ids:['9998']}:endpoint==='news'?{stockId:'2454'}:{scope:'selected',ids:['2454']};const blocked=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(blocked.status,400,endpoint);}
    // 自選可加入研究名單以外、但在股票清單中的股票（例如型態選股挑到的），並可指定自訂分組
    r=await fetch(base+'watchlist',{method:'POST',headers,body:'{"ids":["2330","2454"]}'});assert.equal(r.status,200);
    const wg=await(await fetch(base+'watch/groups',{method:'POST',headers,body:JSON.stringify({groups:[{name:'核心持股'},{name:'觀察'}]})})).json();assert.deepEqual(wg.watchGroups.groups.map(g=>g.name),['核心持股','觀察']);
    assert.equal((await fetch(base+'watch/groups',{method:'POST',headers,body:JSON.stringify({groups:[{name:'重複'},{name:'重複'}]})})).status,400);
    const core=wg.watchGroups.groups[0].id;let ws=await(await fetch(base+'watch/set',{method:'POST',headers,body:JSON.stringify({id:'2454',on:true,group:core})})).json();assert.equal(ws.watchGroups.assign['2454'],core);
    assert.equal((await fetch(base+'watch/set',{method:'POST',headers,body:JSON.stringify({id:'2454',on:true,group:'w99'})})).status,400,'unknown group');
    const st=await(await fetch(base+'state')).json();assert.deepEqual(st.watchlist,['2330','2454']);assert.deepEqual(st.watchExtra.map(x=>[x.id,x.name]),[['2454','聯發科']]);assert.equal(st.watchGroups.assign['2454'],core);
    ws=await(await fetch(base+'watch/set',{method:'POST',headers,body:JSON.stringify({id:'2454',on:false})})).json();assert.deepEqual(ws.watchlist,['2330']);assert.equal(ws.watchGroups.assign['2454'],undefined);
    let created=await fetch(base+'groups',{method:'POST',headers,body:JSON.stringify({name:'新族群'})});assert.equal(created.status,201);
    const saved=JSON.parse(fs.readFileSync(path.join(directory,'groups.json'),'utf8'));const gid=saved.groups.at(-1).id;
    assert.equal((await fetch(base+'groups',{method:'POST',headers,body:JSON.stringify({name:'新族群'})})).status,400);
    for(const groupId of ['test',gid]){assert.equal((await fetch(base+'group-stocks',{method:'POST',headers,body:JSON.stringify({groupId,stockId:'2454'})})).status,200);}
    const after=await (await fetch(base+'state')).json();assert.equal(after.stocks.length,2);assert.equal(after.stocks.find(x=>x.id==='2454').groupIds.length,2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'groups.json'),'utf8')).groups.at(-1).stockIds[0],'2454');
    const event={stockId:'2330',title:'測試事件請勿交易',url:'https://example.com/evidence',date:'2026-09-18',direction:'neutral',stage:'watch'};
    r=await fetch(base+'evidence',{method:'POST',headers,body:JSON.stringify({...event,url:'javascript:alert(1)'})});assert.equal(r.status,400);
    r=await fetch(base+'evidence',{method:'POST',headers,body:JSON.stringify(event)});assert.equal(r.status,200);
    const d=await (await fetch(base+'detail?id=2330')).json();assert.equal(d.evidence.length,1);assert.equal(d.topic.score,50);
    r=await fetch(base+'evidence',{method:'POST',headers,body:JSON.stringify({deleteId:d.evidence[0].id})});assert.equal(r.status,200);
    assert.equal((await fetch('http://127.0.0.1:4399/.local/finmind.dpapi')).status,404);
    const heat=await(await fetch(base+'heatmap')).json();assert.equal(heat.data,null);assert.deepEqual(heat.dates,[]);
    assert.equal((await fetch(base+'heatmap?date=../../x')).status,400);
    assert.equal((await fetch(base+'heatmap/query',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"date":"2026-09-21"}'})).status,403);
    assert.equal((await fetch(base+'heatmap/query',{method:'POST',headers,body:'{"date":"2026-02-30"}'})).status,400);
    assert.equal((await fetch('http://127.0.0.1:4399/heatmap.js')).status,200);assert.equal((await fetch('http://127.0.0.1:4399/hud.css')).status,200);assert.equal((await fetch('http://127.0.0.1:4399/style.css')).status,404);
    assert.equal((await(await fetch(base+'health')).json()).app,'equilens-nexus');
    // 沒有支援即時推播的資料源金鑰時，雷達維持快照，狀態不顯示推播
    const mon=await(await fetch(base+'monitor')).json();assert.deepEqual([mon.stream.capable,mon.stream.active,mon.stream.symbols],[false,false,0]);
    // 當沖監控：沒有推播資料源時不啟動；設定需 CSRF、數值會被正規化；檢討在沒有紀錄時為空
    const dtx=await(await fetch(base+'daytrade')).json();assert.deepEqual([dtx.capable,dtx.top.length,dtx.need.full,dtx.cost,dtx.settings.version,dtx.signals,dtx.sources.turnover,dtx.history.total===dtx.sources.total],[false,0,dtx.need.symbols*3,0.435,3,[],0,true]);
    assert.equal((await fetch(base+'daytrade/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"plan":"advanced"}'})).status,403);
    const dts=await(await fetch(base+'daytrade/settings',{method:'POST',headers,body:JSON.stringify({plan:'advanced',top:999,turnoverTop:100,sources:{watchlist:true},signals:{openLow:false},costs:{feeDiscount:0.28}})})).json();
    assert.deepEqual([dts.settings.plan,dts.settings.top,dts.settings.turnoverTop,dts.settings.sources,dts.settings.signals,dts.settings.costs.feeDiscount,dts.settings.costs.taxRate],['advanced',30,100,{turnover:true,groups:true,watchlist:true},{maUp:true,maDown:true,openLow:false},0.28,0.0015]);
    assert.equal((await(await fetch(base+'daytrade')).json()).cost,0.23);
    const rv=await(await fetch(base+'daytrade/review')).json();
    assert.deepEqual([rv.days,rv.signals,rv.types.map(x=>[x.type,x.n,x.win15]).sort()],[1,3,[['dt-bid',1,100],['dt-breakout',1,0],['dt-vwap',1,0]]]);
    assert.deepEqual([rv.market.signals,rv.market.recorded,rv.market.since,rv.market.regimes.find(x=>x.key==='tailwind').n],[1,1,'2026-10-06',1]);
    assert.deepEqual([rv.recent[0].signals[2].regime,rv.recent[0].signals[2].strength,rv.recent[0].signals[0].regime],['tailwind','strong',null]);
    assert.equal(rv.recent[0].signals[0].title,'爆量突破');
    const bd=(await(await fetch(base+'board?ids=2330')).json()).stocks[0];assert.deepEqual([bd.spark,bd.sparkX,bd.prev],[[1005,1010,1008],[0,0.5,1],1000]);
    assert.equal((await fetch(base+'detail?id=999999')).status,404);
  }finally{child.kill();await new Promise(r=>child.once('close',r));fs.rmSync(directory,{recursive:true,force:true});}
});
test('Windows credential encryption round trip uses isolated test directory',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'equilens-secret-test-'));
  const run=code=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['--input-type=module','-e',code],{cwd:root,env:{...process.env,EQUITY_DATA_DIR:directory,FINMIND_API_TOKEN:''},windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';c.stdout.on('data',x=>output+=x);c.on('close',n=>n===0?resolve(output):reject(new Error('Credential test failed')));c.on('error',reject);});
  try{await run("import {saveSecret} from './lib/secrets.mjs';await saveSecret('finmind','test-credential-only');");const ciphertext=fs.readFileSync(path.join(directory,'finmind.dpapi'),'utf8');assert(!ciphertext.includes('test-credential-only'));assert.equal(await run("import {getSecret,secretConfigured} from './lib/secrets.mjs';console.log((await getSecret('finmind','FINMIND_API_TOKEN'))==='test-credential-only'&&secretConfigured('finmind','FINMIND_API_TOKEN'));"),'true\n');
    await run("import {deleteSecret,secretConfigured} from './lib/secrets.mjs';await deleteSecret('finmind');if(secretConfigured('finmind'))process.exit(1);");assert(!fs.existsSync(path.join(directory,'finmind.dpapi')));}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
