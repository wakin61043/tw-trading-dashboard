import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MOBILE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-push-'));
const push = await import('../lib/push.mjs');

// 依 RFC 8291 以使用者端私鑰解密，驗證加密格式正確。
function decrypt(buf, uaEcdh, auth) {
  const salt = buf.subarray(0, 16), rs = buf.readUInt32BE(16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPub), ua = uaEcdh.getPublicKey();
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(rs, 4096); assert.equal(plain.at(-1), 2, 'last-record delimiter');
  return plain.subarray(0, -1).toString();
}

test('payload encryption round-trips with the subscriber keys', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const msg = JSON.stringify({ title: '台積電 急拉', body: '+2.1%' });
  assert.equal(decrypt(push.encryptPayload(msg, keys), ua, auth), msg);
  assert.throws(() => push.encryptPayload(msg, { p256dh: 'AAAA', auth: keys.auth }), /格式錯誤/);
});

test('VAPID JWT is ES256-signed for the push service origin', () => {
  // 聯絡網址：不接受 localhost 或非 https；接受 Nexus 設定的對外網址（只取網域）
  push.setSubject('http://localhost:4340'); push.setSubject('https://localhost'); push.setSubject('https://pocket.example.com/m/');
  const vapid = push.generateVapid(), header = push.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 1_700_000_000_000);
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header); assert.equal(k, vapid.publicKey);
  const [h, b, s] = t.split('.'), claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com'); assert.equal(claims.exp, 1_700_000_000 + 43200); assert.match(claims.sub, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/, 'Apple 推播要求有效的聯絡網址'); assert.doesNotMatch(claims.sub, /localhost/); assert.equal(claims.sub, 'https://pocket.example.com');
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('subscriptions are validated, deduplicated and pruned when the push service says gone', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = e => ({ endpoint: `https://push.example.com/${e}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
  assert.throws(() => push.subscribe({ endpoint: 'http://insecure', keys: {} }), /格式錯誤/);
  push.subscribe(sub('a')); push.subscribe(sub('a')); push.subscribe(sub('b'));
  assert.equal(push.subscriptionCount(), 2);
  const calls = [];
  const sent = await push.sendToAll({ title: 'x' }, { fetcher: async (url, opt) => { calls.push({ url, opt }); return { ok: !url.endsWith('/b'), status: url.endsWith('/b') ? 410 : 201 }; } });
  assert.equal(sent, 1); assert.equal(push.subscriptionCount(), 1, 'gone subscription removed');
  assert.equal(calls[0].opt.headers['Content-Encoding'], 'aes128gcm'); assert.match(calls[0].opt.headers.Authorization, /^vapid t=/);
});

test('alerts become concise notifications, batching bursts', () => {
  const a = (i, extra = {}) => ({ type: 'surge-up', stockId: '2330', name: `股${i}`, title: '急拉', close: 100, change: 2.5, detail: '5 分鐘內 +2.5%', watch: i === 0, ...extra });
  assert.deepEqual(push.notificationsFor([a(0)]).map(n => [n.title, n.url]), [['🚀 股0 2330 急拉', '/#live']]);
  const many = push.notificationsFor([...Array.from({ length: 6 }, (_, i) => a(i)), { type: 'report', detail: '電子股領漲' }]);
  assert.equal(many.length, 2); assert.equal(many[0].title, '📰 AI 盤後日報'); assert.match(many[1].title, /6 則/); assert.equal(many[1].body, '股0急拉');
  // 新聞：各自一則、點開到原文；夜間勿擾不推；不和雷達異動合併
  const n = (i, extra = {}) => ({ type: 'news', seq: 100 + i, stockId: '2330', name: '台積電', detail: `標題${i}`, source: '經濟日報', url: `https://news.example/${i}`, ...extra });
  assert.deepEqual(push.notificationsFor([n(1), n(2, { quiet: true }), a(0)]).map(x => [x.title, x.body, x.url]), [['🗞️ 台積電 2330', '標題1（經濟日報）', 'https://news.example/1'], ['🚀 股0 2330 急拉', '100（+2.5%）· 5 分鐘內 +2.5%', '/#live']]);
  const burst = push.notificationsFor(Array.from({ length: 6 }, (_, i) => n(i)));
  assert.equal(burst.length, 1); assert.equal(burst[0].title, '🗞️ 個股新聞 6 則'); assert.equal(burst[0].url, '/#live');
  // 個股事件照一般格式；不屬於個股的事件只顯示標題與說明；沒有對應圖示的事件用預設圖示
  const dt = push.notificationsFor([a(0, { type: 'dt-ma-up', title: '突破 20MA（多方）' }), { type: 'other', stockId: '', name: '', title: '系統提醒', detail: '說明文字' }]);
  assert.deepEqual(dt.map(x => [x.title, x.body]), [['📈 股0 2330 突破 20MA（多方）', '100（+2.5%）· 5 分鐘內 +2.5%'], ['📡 系統提醒', '說明文字']]);
});

test('custom alerts are never folded into the radar batch; chip summaries open the chips tab', () => {
  const a = i => ({ type: 'surge-up', stockId: '2330', name: `股${i}`, title: '急拉', close: 100, change: 2.5, detail: 'x', watch: false });
  const c = i => ({ type: 'custom', rule: `r${i}`, stockId: '2330', name: '台積電', title: '自訂提醒', close: 1001, change: 1.1, detail: `價格 ≥ 1000 · ${i}` });
  const out = push.notificationsFor([...Array.from({ length: 5 }, (_, i) => a(i)), c(1), c(2), { type: 'broker', title: '分點追蹤：凱基台北', detail: '2026-10-13 · 買超：台積電 +350', date: '2026-10-13' }]);
  assert.deepEqual(out.map(n => n.title), ['🔔 台積電 2330', '🔔 台積電 2330', '🏦 分點追蹤：凱基台北', '📡 盤中雷達：5 則異動']);
  assert.deepEqual(out.map(n => n.tag).slice(0, 3), ['custom:r1', 'custom:r2', 'broker:2026-10-13']);
  assert.equal(out[2].url, '/#flows');
  const burst = push.notificationsFor(Array.from({ length: 7 }, (_, i) => c(i)));
  assert.equal(burst.length, 1); assert.match(burst[0].title, /7 則/);
});

test('day-trade signals from one 5-minute bar go out as a single notification, grouped by long and short', () => {
  const TITLE = { 'dt-ma-up': '突破 20MA（多方）', 'dt-ma-down': '跌破 20MA（空方）', 'dt-open-low': '跌破開盤低點（空方）' }, SIDE = { 'dt-ma-up': 'long', 'dt-ma-down': 'short', 'dt-open-low': 'short' };
  const sig = (type, id, name, close = 50) => ({ type, side: SIDE[type], stockId: id, name, title: TITLE[type], close, change: 2.5, detail: '5 分 K 收 50，站上 20MA 49.8', t: '09:35:03', watch: false });
  const batch = [sig('dt-ma-up', '2330', '台積電', 1455), sig('dt-ma-down', '2317', '鴻海', 201), sig('dt-open-low', '2317', '鴻海', 201), sig('dt-ma-up', '3017', '奇鋐', 1030), { type: 'news', stockId: '2330', name: '台積電', title: '新聞', detail: 'y' }];
  const { signals, rest } = push.splitDayTrade(batch);
  assert.deepEqual([signals.length, rest.map(a => a.type)], [4, ['news']], 'other events keep their own notifications');
  const n = push.dayTradeNotification(signals);
  assert.match(n.title, /當沖訊號 09:35：多方 2 檔、空方 1 檔/, 'a stock with two short signals counts once');
  assert.deepEqual(n.body.split('\n'), ['📈 突破 20MA（多方）：台積電 1455、奇鋐 1030', '📉 跌破 20MA（空方）：鴻海 201', '🔻 跌破開盤低點（空方）：鴻海 201']);
  assert.deepEqual([n.tag, n.url], ['dt:09:35', '/#live']);
  const many = push.dayTradeNotification(Array.from({ length: 9 }, (_, i) => sig('dt-ma-up', String(1101 + i), `股${i}`)));
  assert.match(many.body, /股5 50…另 3 檔$/);
  const one = push.dayTradeNotification([sig('dt-open-low', '3406', '玉晶光')]);
  assert.match(one.title, /🔻 玉晶光 3406 跌破開盤低點（空方）/, 'a single signal keeps the normal format'); assert.match(one.body, /^50（\+2\.5%）· 5 分 K 收 50/);
  assert.equal(push.dayTradeNotification([]), null); assert.equal(push.dayTradeNotification(rest), null);
});

test('store app devices: registered with a public relay, delivered through it, pruned when the relay says gone', async () => {
  const token = t => `fcm-${t}:${'A'.repeat(140)}`, relay = 'https://push-relay.example.workers.dev/v1/send';
  for (const bad of [{ token: 'short', platform: 'android', relay }, { token: token('a'), platform: 'web', relay }, { token: token('a'), platform: 'ios', relay: 'http://push-relay.example.com/v1' },
    { token: token('a'), platform: 'ios', relay: 'https://localhost/v1' }, { token: token('a'), platform: 'ios', relay: 'https://192.168.1.2/v1' }, { token: 'bad token with spaces and more than twenty', platform: 'ios', relay }])
    assert.throws(() => push.subscribeApp(bad), /格式錯誤/, JSON.stringify(bad));
  const before = push.subscriptionCount();
  push.subscribeApp({ token: token('a'), platform: 'android', relay }); push.subscribeApp({ token: token('a'), platform: 'android', relay }); push.subscribeApp({ token: token('b'), platform: 'ios', relay });
  assert.equal(push.subscriptionCount(), before + 2, 'deduplicated by token'); assert.ok(push.hasApp(token('b'))); assert.ok(!push.hasApp('unknown'));
  const calls = [];
  const sent = await push.sendToAll({ title: '🚀 台積電 急拉', body: '+2.1%', tag: 'surge-up:2330', url: '/#live' }, { fetcher: async (url, opt) => {
    calls.push({ url, opt }); if (url !== relay) return { ok: true, status: 201 };
    const b = JSON.parse(opt.body); return { ok: b.token !== token('b'), status: b.token === token('b') ? 410 : 200 };
  } });
  const app = calls.filter(c => c.url === relay).map(c => JSON.parse(c.opt.body));
  assert.equal(app.length, 2); assert.deepEqual(Object.keys(app[0]).sort(), ['body', 'platform', 'tag', 'title', 'token', 'url']);
  assert.equal(app.find(x => x.platform === 'android').title, '🚀 台積電 急拉'); assert.equal(calls.find(c => c.url === relay).opt.headers['Content-Type'], 'application/json');
  assert.ok(sent >= 1); assert.ok(!push.hasApp(token('b')), 'gone app token removed'); assert.ok(push.hasApp(token('a')));
  push.unsubscribeApp(token('a')); assert.ok(!push.hasApp(token('a')));
});
