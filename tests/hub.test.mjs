import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHub } from './gas-mock.mjs';

const ev = (id, mtime, data) => ({ id, mtime, data: { id, ts: '2026-11-01T10:00:00+09:00', recorded_ts: '2026-11-01T10:01:00+09:00', type: '人', name: '山田さん', ...data } });
const byKind = (res, k) => res.items.filter(i => i.kind === k);

test('合言葉が違えば断る', () => {
  const hub = loadHub();
  assert.equal(hub.post({ token: 'x' }).error, 'unauthorized');
});

test('縁泉GASで入った縁・台帳・痕跡・試すをアプリへ流す', () => {
  const hub = loadHub();
  const aid = hub.gas.actant({ type: '場所', name: '近所の神社', keys: '{"lat":35.1,"lng":139.1}', count: 3 });
  hub.gas.event({ type: '場所', name: '近所の神社', aid, verb: '再会', lat: 35.1, lng: 139.1, enrich: '{"trace_id":"tr-x"}' });
  hub.gas.trace({ id: 'tr-1', lat: 35.1, lng: 139.1, place: '近所の神社' });
  hub.gas.intent({ what: '方丈記' });
  const res = hub.post({ token: hub.token, since: 0 });
  assert.equal(res.ok, true);
  assert.equal(byKind(res, 'events').length, 1);
  const e = byKind(res, 'events')[0].data;
  assert.equal(e.type, '場所'); assert.equal(e.aid, aid); assert.equal(e.trace_id, 'tr-x'); assert.equal(e.lat, 35.1);
  const a = byKind(res, 'actants')[0].data;
  assert.equal(a.lat, 35.1); assert.equal(a.count, 3);
  const t = byKind(res, 'traces')[0].data;
  assert.equal(t.thumb.length, 200); assert.equal(t.place, '近所の神社');
  assert.equal(byKind(res, 'intents')[0].data.status, 'open');
  // 何も変わっていなければ空
  const again = hub.post({ token: hub.token, since: res.rev });
  assert.equal(again.items.length, 0);
  assert.equal(again.rev, res.rev);
  // 台帳シートができている
  assert.ok(hub.ensen.getSheetByName('_sync'));
});

test('アプリの縁を events に追記し、台帳で再会を判定する', () => {
  const hub = loadHub();
  const aid = hub.gas.actant({ type: '人', name: '山田さん', aliases: 'やまだ', count: 2, last: '2026-05-01T00:00:00+09:00' });
  const first = hub.post({ token: hub.token, since: 0 });
  const res = hub.post({ token: hub.token, since: first.rev, push: { events: [ev('e1', 100, { name: 'やまだ', note: '=冗談' }), ev('e2', 101, { name: '初めての人' })] } });
  assert.deepEqual(res.rejected, []);
  const rows = hub.rows('events');
  assert.equal(rows.length, 3);
  const r1 = rows[1];
  assert.equal(r1[0], 'e1'); assert.equal(r1[8], aid); assert.equal(r1[9], '再会'); assert.equal(r1[10], '=冗談'); assert.equal(r1[13], 'home');
  assert.equal(rows[2][9], '出会う'); // 未知の人は 出会う
  // 台帳: 既知は count+1, 未知は新規
  const acts = hub.rows('actants');
  assert.equal(acts[1][7], 3);
  assert.equal(acts[1][6], '2026-11-01T10:00:00+09:00');
  assert.equal(acts.length, 3);
  // 返ってきた縁にはハブが決めた actant_id と動詞が入っている
  const got = Object.fromEntries(byKind(res, 'events').map(i => [i.id, i]));
  assert.equal(got.e1.data.aid, aid); assert.equal(got.e1.data.verb, '再会'); assert.equal(got.e1.mtime, 100);
  assert.equal(byKind(res, 'actants').length, 2);
  // 次の同期で、自分で書いた行を変更と誤認しない
  assert.equal(hub.post({ token: hub.token, since: res.rev }).items.length, 0);
  // 同じ縁を送り直しても2行にならない(追記専用・冪等)
  hub.post({ token: hub.token, since: res.rev, push: { events: [ev('e1', 100, { name: 'やまだ' })] } });
  assert.equal(hub.rows('events').length, 3);
});

test('events と appraisals の既存行には書き込まない(追記だけ)', () => {
  const hub = loadHub();
  hub.gas.event({ id: 'old' });
  hub.post({ token: hub.token, since: 0 });
  hub.ensen.log.length = 0;
  hub.post({ token: hub.token, since: 0, push: { events: [ev('old', 999, { name: '書き換え' }), ev('n1', 5, {})], appraisals: [{ id: 'ap1', mtime: 1, data: { target: 'old', weight: 2 } }] } });
  const touched = hub.ensen.log.filter(l => l.sheet === 'events' || l.sheet === 'appraisals');
  assert.ok(touched.every(l => l.op === 'append'), JSON.stringify(touched));
  assert.equal(hub.rows('events')[1][7], '友人');
  assert.deepEqual([...hub.rows('appraisals')[1]].slice(2, 4), ['old', 2]);
});

test('場所は150mより遠ければ同名でも別の場所', () => {
  const hub = loadHub();
  hub.gas.actant({ type: '場所', name: 'スターバックス', keys: '{"lat":35.0,"lng":139.0}' });
  hub.post({ token: hub.token, since: 0, push: { events: [
    ev('p1', 1, { type: '場所', name: 'スターバックス 駅前', lat: 35.0005, lng: 139.0 }),
    ev('p2', 2, { type: '場所', name: 'スターバックス', lat: 35.01, lng: 139.0 }),
  ] } });
  const rows = hub.rows('events');
  assert.equal(rows[1][9], '再会');
  assert.equal(rows[2][9], '発見する');
  assert.notEqual(rows[1][8], rows[2][8]);
});

test('語彙の外は断り、理由を返す', () => {
  const hub = loadHub();
  const res = hub.post({ token: hub.token, since: 0, push: { events: [ev('bad', 1, { type: '動物' }), ev('bad2', 1, { verb: '別れる' })], appraisals: [{ id: 'a', mtime: 1, data: { target: 'x', weight: 5 } }] } });
  assert.equal(res.rejected.length, 3);
  assert.equal(hub.rows('events').length, 1);
});

test('写真は Drive に置き、events には URL だけ', () => {
  const hub = loadHub();
  hub.post({ token: hub.token, since: 0, push: { events: [ev('ph', 1, { type: 'モノ', name: '湯呑み', photo: 'data:image/jpeg;base64,' + Buffer.from('jpeg').toString('base64') })] } });
  assert.equal(hub.drive.files.length, 1);
  assert.equal(hub.drive.files[0].name, 'ensen_20261101_100000.jpg');
  assert.match(hub.rows('events')[1][11], /^https:\/\/drive\.google\.com\//);
});

test('痕跡からの昇格は enrich に trace_id を残す', () => {
  const hub = loadHub();
  hub.post({ token: hub.token, since: 0, push: { events: [ev('t1', 1, { trace_id: 'tr-9' })] } });
  assert.equal(hub.rows('events')[1][15], '{"trace_id":"tr-9"}');
});

test('試す: 新規は追記、状態はアプリの操作だけで変え、古い操作は無視', () => {
  const hub = loadHub();
  const iid = hub.gas.intent({ what: '方丈記を読む' });
  const r0 = hub.post({ token: hub.token, since: 0, push: { intents: [{ id: 'i-new', mtime: 10, data: { what: '湯治に行く', type: '場所', origin: '偶然' } }] } });
  assert.equal(hub.rows('intents')[2][6], 'open');
  const r1 = hub.post({ token: hub.token, since: r0.rev, push: { intents: [{ id: iid, mtime: Date.now() + 1000, data: { status: 'fulfilled', fulfilled_event_id: 'e1' } }] } });
  assert.deepEqual([...hub.rows('intents')[1]].slice(6, 8), ['fulfilled', 'e1']);
  assert.equal(byKind(r1, 'intents')[0].data.status, 'fulfilled');
  hub.post({ token: hub.token, since: r1.rev, push: { intents: [{ id: iid, mtime: 5, data: { status: 'open' } }] } });
  assert.equal(hub.rows('intents')[1][6], 'fulfilled');
});

test('夜間エンリッチが tags/enrich を足した行を変更として流す', () => {
  const hub = loadHub();
  const id = hub.gas.event({});
  const r0 = hub.post({ token: hub.token, since: 0 });
  hub.rows('events')[1][14] = 'カフェ';
  const r1 = hub.post({ token: hub.token, since: r0.rev });
  assert.equal(r1.items.length, 1);
  assert.equal(r1.items[0].id, id);
  assert.equal(r1.items[0].data.tags, 'カフェ');
});

test('多いときは分けて返し、続きは more で取る', () => {
  const hub = loadHub();
  for (let i = 0; i < 1900; i++) hub.gas.event({ id: 'g' + i });
  let since = 0, got = 0, calls = 0, more = true;
  while (more && calls < 10) { const r = hub.post({ token: hub.token, since }); got += r.items.length; since = r.rev; more = r.more; calls++; }
  assert.equal(got, 1900);
  assert.equal(calls, 3);
});

test('痕跡のサムネが大きいときは少なめに分ける', () => {
  const hub = loadHub();
  for (let i = 0; i < 120; i++) hub.gas.trace({ thumb: 'B'.repeat(40000) });
  const r = hub.post({ token: hub.token, since: 0 });
  assert.equal(r.more, true);
  assert.ok(r.items.length < 120 && r.items.length > 20);
});

test('その日のまわり: 日記・読み終えた本・観た映画を読むだけ', () => {
  const hub = loadHub();
  hub.addBook('1yVC3q2dm4-LxrAg_lRDk8G3qqU-WNQnI5LznFPgxKp8', { CoreData: [['Date', 'Time', 'Text', 'Feelings', 'Thinkings'], ['2026-10-31', '22:00', '夜の散歩', '穏やか', ''], ['2026-10-30', '21:00', '別の日', '', '']] });
  hub.addBook('1WEsS95CKH7JPFuGf7BYzlTV-d6FyTVg0OCOymKHqsZg', { books: [['id'], ['b1', 1, 1, 'false', '方丈記', '鴨長明', '読了', '', '', '2026-10-31', '{"cover":"c.jpg"}']] });
  hub.addBook('156oktIUuxKOcFZn0QYrx6ncY3AFiY-7DjgAIYbiRCm4', { views: [['id'], ['v1', 1, 1, 'false', '2026-10-31', 'f1', 'PERFECT DAYS', 'theater', '近所の映画館']] });
  const d = hub.post({ token: hub.token, action: 'day', date: '2026-10-31' });
  assert.equal(d.ok, true);
  assert.equal(d.diary.entries.length, 1);
  assert.equal(d.diary.entries[0].text, '夜の散歩');
  assert.equal(d.diary.url, 'https://tadamasa.github.io/diary-home/#day/2026-10-31');
  assert.equal(d.books.books[0].cover, 'c.jpg');
  assert.equal(d.films.films[0].url, 'https://tadamasa.github.io/movie-memo/#film/f1');
});

test('近くの場所の候補はキーがあるときだけ', () => {
  const hub = loadHub();
  assert.equal(hub.post({ token: hub.token, action: 'poi', lat: 35, lng: 139 }).provider, 'none');
  hub.props.GOOGLE_PLACES_API_KEY = 'k';
  const r = hub.post({ token: hub.token, action: 'poi', lat: 35, lng: 139 });
  assert.equal(r.poi[0].name, '近くの喫茶');
});

test('場所名の修正を place_names に追記する(シートがなければ作る)', () => {
  const hub = loadHub();
  const first = hub.post({ token: hub.token, since: 0 });
  const fix = { id: 'fx-1', mtime: 5, data: { id: 'fx-1', ts: '2026-11-01T13:00:00+09:00', trace_id: 'tr-1', lat: 35.1, lng: 139.1, name: '=路地の喫茶' } };
  const res = hub.post({ token: hub.token, since: first.rev, push: { place_names: [fix, { id: 'fx-2', data: { name: '位置なし' } }] } });
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].id, 'fx-2');
  const sh = hub.ensen.getSheetByName('place_names');
  assert.ok(sh);
  const got = byKind(res, 'place_names')[0].data;
  assert.equal(got.name, '=路地の喫茶'); assert.equal(got.trace_id, 'tr-1'); assert.equal(got.lat, 35.1); assert.equal(got.source, 'home');
  // 追記専用: 同じidは二度書かない
  hub.post({ token: hub.token, since: res.rev, push: { place_names: [fix] } });
  assert.equal(sh.getLastRow(), 2);
});
