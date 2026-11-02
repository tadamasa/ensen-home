import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { execSync } from 'child_process';
import { loadHub } from './gas-mock.mjs';

// 置き換え前のハブ(DayReaders に乗り換える前、PR #1 のマージ)。git の履歴がないところでは比べるテストを飛ばす
const OLD_HUB = (() => { try { return execSync('git show 5bd6cfc:hub/Code.gs', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } })();

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

test('地図の候補から選んだ場所は、IDを enrich と台帳の鍵に残し、名前が揺れても同じ場所として再会する', () => {
  const hub = loadHub();
  const aid = hub.gas.actant({ type: '場所', name: 'スターバックス', keys: '{"lat":35.0,"lng":139.0}' });
  hub.post({ token: hub.token, since: 0, push: { events: [
    ev('q1', 1, { type: '場所', name: 'スターバックス', lat: 35.0003, lng: 139.0, poi_id: 'osm:node/42' }),
    ev('q2', 2, { type: '場所', name: 'Starbucks Coffee 駅前店', lat: 35.0003, lng: 139.0, poi_id: 'osm:node/42' }),
    ev('q3', 3, { type: '場所', name: '新しい喫茶', lat: 35.1, lng: 139.1, poi_id: 'google:ChIJ_x' }),
    ev('q4', 4, { type: '場所', name: '変なID', lat: 35.2, lng: 139.2, poi_id: 'javascript:alert(1)' }),
  ] } });
  const rows = hub.rows('events');
  assert.equal(rows[1][8], aid); assert.equal(rows[2][8], aid); // 表記違いでも同じ台帳
  assert.equal(rows[2][9], '再会');
  assert.deepEqual(JSON.parse(rows[1][15]), { poi: 'osm:node/42' });
  assert.equal(rows[4][15], ''); // 形の違うIDは捨てる
  const acts = Object.fromEntries(hub.rows('actants').slice(1).map(r => [r[2], JSON.parse(r[4])]));
  assert.deepEqual(acts['スターバックス'], { lat: 35.0, lng: 139.0, poi: 'osm:node/42' }); // 位置は台帳のまま、IDだけ覚える
  assert.deepEqual(acts['新しい喫茶'], { lat: 35.1, lng: 139.1, poi: 'google:ChIJ_x' });
  const got = byKind(hub.post({ token: hub.token, since: 0 }), 'actants').find(a => a.id === aid);
  assert.equal(got.data.poi, 'osm:node/42');
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

// 2026-11-02 に本物のシートで確かめた見出し(tadamasa/diary-home の lib/day-readers/README.md)
const BOOKS_H = ['id', 'rev', 'mtime', 'deleted', 'title', 'author', 'status', 'category', 'score', 'finishedAt', 'json'];
const NOTES_H = ['id', 'rev', 'mtime', 'deleted', 'date', 'bookId', 'bookTitle', 'kind', 'text', 'quote', 'json'];
const VIEWS_H = ['id', 'rev', 'mtime', 'deleted', 'date', 'filmId', 'filmTitle', 'place', 'venue', 'score', 'text', 'json'];
const FILMS_H = ['id', 'rev', 'mtime', 'deleted', 'title', 'year', 'directors', 'status', 'lastSeen', 'seenCount', 'category', 'tmdbId', 'json'];
const DIARY_ID = '1yVC3q2dm4-LxrAg_lRDk8G3qqU-WNQnI5LznFPgxKp8', BOOKS_ID = '1WEsS95CKH7JPFuGf7BYzlTV-d6FyTVg0OCOymKHqsZg', MOVIES_ID = '156oktIUuxKOcFZn0QYrx6ncY3AFiY-7DjgAIYbiRCm4';
function aroundBooks(hub) {
  hub.addBook(DIARY_ID, { CoreData: [['Date', 'Time', 'Text', 'Feelings', 'Thinkings', 'Id'], ['2026-10-31', '22:00', '夜の散歩', '穏やか', '', 'd1'], ['2026-10-31', '08:00', '朝の珈琲', '', '考えた', 'd2'], ['2026-10-30', '21:00', '別の日', '', '', 'd3']] });
  hub.addBook(BOOKS_ID, {
    books: [BOOKS_H, ['b1', 1, 1, 'false', '方丈記', '鴨長明', '読了', '古典', '', '2026-10-31', '{"cover":"c.jpg"}'], ['b2', 1, 1, 'true', '消した本', '', '読了', '', '', '2026-10-31', '{}'], ['b3', 1, 1, 'false', '途中の本', '', '読書中', '', '', '2026-10-31', '{}'], ['b4', 1, 1, 'false', '別の日の本', '', '読了', '', '', '2026-10-12', '{}']],
    notes: [NOTES_H, ['n1', 1, 1, 'false', '2026-10-31', 'b1', '方丈記', 'memo', 'ゆく河の流れ', '', '{}']],
  });
  hub.addBook(MOVIES_ID, {
    views: [VIEWS_H, ['v1', 1, 1, 'false', '2026-10-31', 'f1', 'PERFECT DAYS', 'theater', '近所の映画館', 4, 'よかった', '{}'], ['v2', 1, 1, 'false', '2026-10', 'f1', '思い出し', 'tv', '', '', '', '{}'], ['v3', 1, 1, 'false', '2026-10-05', 'f2', '別の映画', 'stream', '', '', '', '{}']],
    films: [FILMS_H, ['f1', 1, 1, 'false', 'PERFECT DAYS', '2023', 'ヴィム・ヴェンダース', 'seen', '2026-10-31', 1, '', 1, '{"posterPath":"/p.jpg","genres":["ドラマ","音楽","x"]}']],
  });
}

test('その日のまわり: 日記・読み終えた本・観た映画を DayReaders で読むだけ', () => {
  const hub = loadHub();
  aroundBooks(hub);
  const d = hub.post({ token: hub.token, action: 'day', date: '2026-10-31' });
  assert.equal(d.ok, true);
  assert.deepEqual(d.diary.entries.map(e => e.text), ['朝の珈琲', '夜の散歩']);
  assert.equal(d.diary.url, 'https://tadamasa.github.io/diary-home/#day/2026-10-31');
  assert.deepEqual(d.books.books.map(b => b.title), ['方丈記']);
  assert.equal(d.books.books[0].cover, 'c.jpg');
  assert.equal(d.books.books[0].url, 'https://tadamasa.github.io/reading-memo/#book/b1');
  assert.equal(d.films.films.length, 1);
  const f = d.films.films[0];
  assert.equal(f.url, 'https://tadamasa.github.io/movie-memo/#film/f1');
  assert.equal(f.place, '映画館'); assert.equal(f.directors, 'ヴィム・ヴェンダース');
  assert.equal(f.poster, 'https://image.tmdb.org/t/p/w185/p.jpg'); // films の json は13列目(見出しで引くので出る)
  // シートIDとアプリURLはスクリプト プロパティから渡す
  hub.props.READING_APP_URL = 'https://example.com/r/';
  assert.equal(hub.post({ token: hub.token, action: 'day', date: '2026-10-31' }).books.books[0].url, 'https://example.com/r/#book/b1');
  // 月の印
  const m = hub.post({ token: hub.token, action: 'month', month: '2026-10' });
  assert.deepEqual(m.books, ['2026-10-12', '2026-10-31']);
  assert.deepEqual(m.films, ['2026-10-05', '2026-10-31']);
  assert.equal(hub.post({ token: hub.token, action: 'month', month: '2026/10' }).ok, false);
});

test('その日のまわり: 置き換え前のハブと同じ日記・本・映画・月の印が出る', { skip: !OLD_HUB && 'git の履歴がない' }, () => {
  const before = loadHub({ code: OLD_HUB, withReaders: false });
  const after = loadHub();
  aroundBooks(before); aroundBooks(after);
  for (const date of ['2026-10-31', '2026-10-30', '2026-10-12', '2026-10-05']) {
    const a = before.post({ token: before.token, action: 'day', date }), b = after.post({ token: after.token, action: 'day', date });
    assert.deepEqual(b.diary.entries.map(({ time, text, feelings }) => ({ time, text, feelings })), a.diary.entries, date);
    assert.equal(b.diary.url, a.diary.url);
    assert.deepEqual(b.books.books.map(({ title, author, cover, url }) => ({ title, author, cover, url })), a.books.books, date);
    // ポスターは置き換え前は10列目を json として読んでいたので空だった(直った不具合)。それ以外は同じ
    assert.deepEqual(b.films.films.map(({ genres, poster, ...x }) => x), a.films.films.map(({ poster, ...x }) => x), date);
  }
  assert.deepEqual(after.post({ token: after.token, action: 'month', month: '2026-10' }), before.post({ token: before.token, action: 'month', month: '2026-10' }));
});

test('ライブラリが追加されていなくても同期は動き、その日は理由つきで空', () => {
  const hub = loadHub({ withReaders: false });
  hub.gas.event({ name: '友人' });
  assert.equal(hub.post({ token: hub.token, since: 0 }).ok, true);
  const d = hub.post({ token: hub.token, action: 'day', date: '2026-10-31' });
  assert.equal(d.ok, true);
  assert.equal(d.books.ok, false);
  assert.match(d.books.error, /DayReaders/);
  assert.match(hub.post({ token: hub.token, action: 'month', month: '2026-10' }).error, /DayReaders/);
});

test('固定しているライブラリの版と、テストに写したライブラリの版が同じ', () => {
  const dep = JSON.parse(fs.readFileSync(new URL('../hub/appsscript.json', import.meta.url), 'utf8')).dependencies.libraries.find(l => l.userSymbol === 'DayReaders');
  assert.equal(dep.libraryId, '1AERbCrDNFVHKT1YDCTSensHNs4X8QrACyaS-p3xDFhqrUq2r7NGMuMwk');
  const src = fs.readFileSync(new URL('./lib/DayReaders.gs', import.meta.url), 'utf8');
  assert.equal(src.match(/var VERSION = (\d+);/)[1], dep.version);
  // 重複していた読み取りコードは消えた
  const code = fs.readFileSync(new URL('../hub/Code.gs', import.meta.url), 'utf8');
  for (const name of ['booksFor_', 'filmsFor_', 'diaryFor_', 'FILM_PLACE_LABEL', 'toDateStr_']) assert.ok(!code.includes(name), name);
});

test('試す: ブクログ取込の印(src)をアプリへ渡す', () => {
  const hub = loadHub();
  hub.gas.intent({ id: 'bl', what: '仮説力を鍛える', origin: '', enrich: '{"src_id":"booklog:4797343028:読みたい","backfill":"booklog","keys":{"isbn":"9784797343021"}}' });
  hub.gas.intent({ id: 'mine', what: '方丈記を読む' });
  const got = Object.fromEntries(byKind(hub.post({ token: hub.token, since: 0 }), 'intents').map(i => [i.id, i.data]));
  assert.equal(got.bl.src, 'booklog:4797343028:読みたい');
  assert.equal(got.bl.isbn, '9784797343021');
  assert.equal(got.mine.src, '');
});

// 照会先のふり: Overpass と Google Places(New) の返事を URL で分ける
function poiFetch(log) {
  return (url, o) => {
    log.push({ url, o });
    if (/overpass/.test(url)) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ elements: [
      { type: 'node', id: 11, lat: 35.0005, lon: 139.0, tags: { name: '喫茶ほとり', amenity: 'cafe' } },
      { type: 'way', id: 22, center: { lat: 35.002, lon: 139.0 }, tags: { name: 'Mizube Park', 'name:ja': 'みずべ公園', leisure: 'park' } },
      { type: 'node', id: 33, lat: 35.02, lon: 139.0, tags: { name: '遠すぎる店', shop: 'bakery' } },
    ] }) };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ places: [
      { id: 'ChIJ_hotori', displayName: { text: '喫茶 ほとり' }, location: { latitude: 35.0006, longitude: 139.0001 }, primaryType: 'cafe' },
      { id: 'ChIJ_small', displayName: { text: '小さな古書店' }, location: { latitude: 35.001, longitude: 139.0 }, primaryType: 'book_store' },
    ] }) };
  };
}

test('近くの場所の候補: 既定は OSM、Google はキーがあるときだけ足し、同じ店は OSM を残す', () => {
  const log = [];
  const hub = loadHub({ fetch: poiFetch(log) });
  const a = hub.post({ token: hub.token, action: 'poi', lat: 35, lng: 139 });
  assert.deepEqual([...a.providers], ['osm']);
  assert.deepEqual(a.poi.map(p => p.name), ['喫茶ほとり', 'みずべ公園']); // 近い順・300m の外は落とす・name:ja を使う
  assert.equal(a.poi[0].id, 'osm:node/11');
  assert.equal(a.poi[0].category, 'amenity=cafe');
  assert.equal(a.poi[1].dist, 222);
  assert.match(log[0].url, /maps\.mail\.ru/);
  assert.match(log[0].o.payload.data, /around:300,35,139/);
  // 二度目はキャッシュ
  assert.equal(hub.post({ token: hub.token, action: 'poi', lat: 35, lng: 139 }).cached, true);
  hub.props.GOOGLE_PLACES_API_KEY = 'k';
  const b = hub.post({ token: hub.token, action: 'poi', lat: 35, lng: 139, radius: 500 });
  assert.deepEqual([...b.providers], ['osm', 'google']);
  assert.deepEqual(b.poi.map(p => p.id), ['osm:node/11', 'google:ChIJ_small', 'osm:way/22']);
  assert.equal(JSON.parse(log.at(-1).o.payload).locationRestriction.circle.radius, 500);
  // 止める
  hub.props.OVERPASS_ENDPOINT = 'off'; delete hub.props.GOOGLE_PLACES_API_KEY;
  assert.equal(hub.post({ token: hub.token, action: 'poi', lat: 35, lng: 139 }).provider, 'none');
});

test('近くの場所の候補: 名前で探す(5km 以内、名前の近い順)。失敗は静かに空で返す', () => {
  const log = [];
  const hub = loadHub({ fetch: poiFetch(log) });
  const r = hub.post({ token: hub.token, action: 'poi', lat: 35, lng: 139, q: '遠すぎ(る)店' });
  // SpotMatch.gs を足していないハブでも動く(名前の近さは Code.gs にある)
  const bare = loadHub({ fetch: poiFetch([]), withSpotMatch: false });
  bare.props.GOOGLE_PLACES_API_KEY = 'k';
  assert.equal(bare.post({ token: bare.token, action: 'poi', lat: 35, lng: 139 }).poi.length, 3);
  assert.equal(bare.post({ token: bare.token, action: 'poi', lat: 35, lng: 139, q: '店' }).ok, true);
  assert.match(log[0].o.payload.data, /around:5000,35,139\)\["name"~"遠すぎ\.る\.店",i\]/);
  assert.equal(r.poi[0].name, '遠すぎる店');
  const bad = loadHub({ fetch: () => ({ getResponseCode: () => 504, getContentText: () => 'timeout' }) });
  const e = bad.post({ token: bad.token, action: 'poi', lat: 35, lng: 139 });
  assert.equal(e.ok, true); assert.equal(e.poi.length, 0); assert.match(e.error, /osm 504/);
  assert.notEqual(bad.post({ token: bad.token, action: 'poi', lat: 35, lng: 139 }).cached, true); // 失敗は覚えない
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

test('スポットの位置の修正を spot_fixes に追記する(シートがなければ作る)', () => {
  const hub = loadHub();
  const first = hub.post({ token: hub.token, since: 0 });
  const mv = { id: 'sf-1', mtime: 5, data: { id: 'sf-1', ts: '2026-11-01T22:00:00+09:00', aid: 'a-toho', event_id: 'e-1', lat: 34.7826, lng: 135.4201, status: 'move' } };
  const bad = [
    { id: 'sf-2', data: { aid: 'a-x', status: 'move' } },          // 位置がない
    { id: 'sf-3', data: { aid: 'a-x', status: 'delete' } },        // 語彙の外
    { id: 'sf-4', data: { status: 'ok' } },                         // 台帳がない
  ];
  const ok = { id: 'sf-5', mtime: 6, data: { id: 'sf-5', aid: 'a-lib', status: 'ok', lat: 1, lng: 2 } };
  const res = hub.post({ token: hub.token, since: first.rev, push: { spot_fixes: [mv, ...bad, ok] } });
  assert.deepEqual(res.rejected.map(r => r.id).sort(), ['sf-2', 'sf-3', 'sf-4']);
  const sh = hub.ensen.getSheetByName('spot_fixes');
  assert.ok(sh);
  assert.equal(sh.getLastRow(), 3);
  const got = byKind(res, 'spot_fixes');
  const m = got.find(x => x.id === 'sf-1').data;
  assert.equal(m.aid, 'a-toho'); assert.equal(m.event_id, 'e-1'); assert.equal(m.lat, 34.7826); assert.equal(m.status, 'move'); assert.equal(m.source, 'home');
  const o = got.find(x => x.id === 'sf-5').data;
  assert.equal(o.lat, null); // ok には位置を残さない
  hub.post({ token: hub.token, since: res.rev, push: { spot_fixes: [mv] } });
  assert.equal(sh.getLastRow(), 3); // 追記専用
});

test('スポットを名前で突き合わせ、正しそうな位置を spot_fixes に足す', () => {
  const HOME = [34.7638, 135.5135];
  const OSM = {
    'TOHOシネマズ伊丹': [{ name: 'TOHOシネマズ伊丹', lat: '34.7826', lon: '135.4201', category: 'amenity' }],
    '吹田市立中央図書館': [{ name: '吹田市立中央図書館', lat: '34.7641', lon: '135.5160', category: 'amenity' }],
    'セブンイレブン': [{ name: 'セブン-イレブン', lat: '34.770', lon: '135.52', category: 'shop' }, { name: 'セブン-イレブン', lat: '34.80', lon: '135.55', category: 'shop' }],
    '勝盛': [{ name: '勝盛', lat: '34.95', lon: '136.2', category: 'amenity' }], // 1つだけで50km先: 同名の別の店かもしれない
  };
  const urls = [];
  const fetch = (url) => {
    urls.push(url);
    const q = decodeURIComponent(String(url).split('&q=')[1] || '');
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(OSM[q] || []) };
  };
  const geocode = q => (q === 'PET SHOP JULA 桃山台店'
    ? { status: 'OK', results: [{ types: ['establishment', 'point_of_interest'], address_components: [{ long_name: 'PET SHOP JULA 桃山台店' }], geometry: { location: { lat: 34.7840, lng: 135.4990 } } }] }
    : q === 'TOHOシネマズ伊丹'
      ? { status: 'OK', results: [{ types: ['movie_theater', 'establishment'], address_components: [{ long_name: 'TOHOシネマズ伊丹' }], geometry: { location: { lat: 34.7828, lng: 135.4203 } } }] }
      : { status: 'OK', results: [{ types: ['locality', 'political'], partial_match: true, address_components: [{ long_name: '吹田市' }], geometry: { location: { lat: 34.76, lng: 135.51 } } }] });
  const hub = loadHub({ fetch, geocode });
  const place = (name, aid, lat = HOME[0], lng = HOME[1], tags = '') => hub.gas.event({ type: '場所', name, aid, lat, lng, verb: '発見する', source: 'swarm_backfill', tags });
  place('TOHOシネマズ伊丹', 'a-toho');
  place('PET SHOP JULA 桃山台店', 'a-jula', HOME[0] - 0.0005);
  place('吹田市立中央図書館', 'a-lib', 34.7640, 135.5158);
  place('セブンイレブン', 'a-711');
  place('勝盛', 'a-katsu');
  place('自宅', 'a-home', HOME[0], HOME[1], '自宅,到着');
  place('手で直した店', 'a-hand');
  hub.post({ token: hub.token, since: 0, push: { spot_fixes: [{ id: 'h1', mtime: 1, data: { aid: 'a-hand', status: 'hide' } }] } });

  const r = hub.ctx.matchSpots();
  assert.equal(r.rest, 0);
  const rows = hub.rows('spot_match');
  const v = Object.fromEntries(rows.slice(1).map(x => [x[0], x]));
  assert.equal(v['a-toho'][11], 'move'); assert.equal(v['a-toho'][10], 2);      // OSMとGoogleが一致
  assert.equal(v['a-jula'][11], 'move'); assert.equal(v['a-jula'][7], 'geocoder'); // 1か所だけでも名前が一致し30km以内
  assert.equal(v['a-lib'][11], 'ok');
  assert.equal(v['a-711'][11], 'unknown');   // チェーン店は決めない
  assert.equal(v['a-katsu'][11], 'unknown'); // 一つの照会先だけで遠すぎる
  assert.ok(!v['a-home'] && !v['a-hand']);   // 自宅の出入りと、手で直した場所は照会しない
  assert.ok(urls.every(u => /nominatim/.test(u)));

  const a = hub.ctx.applySpotMatches();
  assert.deepEqual({ ...a }, { added: 3, moved: 2 });
  const fx = hub.rows('spot_fixes').slice(1);
  const toho = fx.find(x => x[2] === 'a-toho');
  assert.equal(toho[6], 'move'); assert.equal(toho[7], 'auto'); assert.ok(Math.abs(toho[4] - 34.7826) < 0.001);
  // アプリへは次の同期で届く
  const got = hub.post({ token: hub.token, since: 0 }).items.filter(i => i.kind === 'spot_fixes').map(i => i.data);
  assert.equal(got.filter(d => d.source === 'auto').length, 3);
  // 二度目は足さない・取り消しは auto だけ
  assert.equal(hub.ctx.applySpotMatches().added, 0);
  assert.equal(hub.ctx.undoAutoSpotFixes().added, 3);
  assert.equal(hub.rows('spot_fixes').slice(1).filter(x => x[6] === 'undo').length, 3);
});

test('spot_fixes の ts は書き込みの入口で yyyy-MM-ddTHH:mm:ss+09:00 にそろえる', () => {
  const hub = loadHub();
  const fx = (id, ts) => ({ id, mtime: 1, data: { id, ts, aid: 'a-' + id, status: 'ok' } });
  hub.post({ token: hub.token, since: 0, push: { spot_fixes: [
    fx('z', '2026-11-02T01:02:03.456Z'),        // UTC・ミリ秒付き → 東京時間
    fx('n', '2026-11-02T10:02'),                // オフセットなし・秒なし → 東京時間とみなす
    fx('o', '2026-11-02T03:02:03+0200'),        // ほかのオフセット
    fx('k', '2026-11-02T10:02:03+09:00'),       // そのまま
    fx('bad', 'きのう'),                         // 読めない → 受け取った時刻
  ] } });
  const ts = Object.fromEntries(hub.rows('spot_fixes').slice(1).map(r => [r[0], r[1]]));
  assert.equal(ts.z, '2026-11-02T10:02:03+09:00');
  assert.equal(ts.n, '2026-11-02T10:02:00+09:00');
  assert.equal(ts.o, '2026-11-02T10:02:03+09:00');
  assert.equal(ts.k, '2026-11-02T10:02:03+09:00');
  assert.match(ts.bad, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  // アプリへは表の何行目か(seq)も返す
  const got = hub.post({ token: hub.token, since: 0 }).items.filter(i => i.kind === 'spot_fixes').map(i => i.data);
  assert.deepEqual(got.map(d => d.seq).sort(), [2, 3, 4, 5, 6]);
});

test('返す形を変えた送り直しでは mtime を進めず、手元の未送信の操作を退けない', () => {
  const before = loadHub({ code: OLD_HUB || undefined });
  const iid = before.gas.intent({ what: '方丈記を読む' });
  const r0 = before.post({ token: before.token, since: 0 });
  const old = r0.items.find(i => i.id === iid).mtime;
  // 同じシートを新しいハブで開く(形の印が変わる)
  const after = loadHub();
  after.ensen.sheets.clear();
  for (const [n, sh] of before.ensen.sheets) after.ensen.sheets.set(n, sh);
  after.props.REV = before.props.REV;
  after.props.TOKEN = before.token;
  const r1 = after.post({ token: before.token, since: r0.rev, push: { intents: [{ id: iid, mtime: old + 1, data: { status: 'released' } }] } });
  assert.equal(after.rows('intents')[1][6], 'released');
  assert.equal(r1.items.find(i => i.id === iid).data.status, 'released');
});
