import test from 'node:test';
import assert from 'node:assert/strict';
import { findActant, suggestVerb, echoOf, frontier, reunions, apprQueue, mapPoints, distantPrompt, parseDistant, nearbyPlaces, isoLocal, fromInputValue, monthCells, gapLabel, autoSeason, nameChips } from '../js/ensen.js';

const acts = [
  { id: 'a1', type: '場所', name: 'スターバックス', aliases: '', lat: 35.0, lng: 139.0, first_seen: '2026-01-02T10:00:00+09:00', last_seen: '2026-10-01T10:00:00+09:00', count: 3 },
  { id: 'a2', type: '人', name: '山田さん', aliases: 'やまだ,ヤマダ', lat: null, lng: null, first_seen: '2025-05-01T10:00:00+09:00', last_seen: '2026-02-01T10:00:00+09:00', count: 2 },
];
const ev = (id, ts, o = {}) => ({ id, ts, type: '人', name: '山田さん', aid: 'a2', verb: '出会う', note: '', lat: null, lng: null, tags: '', ...o });

test('名寄せ: 別名・全角半角・場所は150m以内', () => {
  assert.equal(findActant(acts, '人', 'ﾔﾏﾀﾞ', null, null).id, 'a2'); // 半角カナもNFKCで別名ヤマダと一致
  assert.equal(findActant(acts, '人', 'ヤマダ', null, null).id, 'a2');
  assert.equal(findActant(acts, '場所', 'スターバックス 駅前', 35.0005, 139.0).id, 'a1');
  assert.equal(findActant(acts, '場所', 'スターバックス', 35.01, 139.0), null);
  assert.equal(suggestVerb('場所', null), '発見する');
  assert.equal(suggestVerb('人', acts[1]), '再会');
});

test('谺: 同じ actant の直前、なければ500m以内の同じ種別', () => {
  const events = [ev('e1', '2026-01-01T10:00:00+09:00'), ev('e2', '2026-03-01T10:00:00+09:00'), ev('e3', '2026-05-01T10:00:00+09:00'),
    ev('p1', '2026-02-01T10:00:00+09:00', { type: '場所', aid: 'x', name: '公園', lat: 35, lng: 139 })];
  assert.equal(echoOf(events, events[2]).e.id, 'e2');
  assert.equal(echoOf(events, events[0]), null);
  const r = echoOf(events, { id: 'n', ts: '2026-06-01T10:00:00+09:00', type: '場所', aid: 'y', lat: 35.001, lng: 139 });
  assert.equal(r.e.id, 'p1'); assert.equal(r.same, false);
});

test('初出の川・再会の川・地図', () => {
  const events = [ev('e1', '2026-01-01T10:00:00+09:00', { note: 'はじめて' }), ev('e2', '2026-09-01T10:00:00+09:00'),
    ev('h', '2026-09-02T20:00:00+09:00', { tags: '自宅,到着', aid: 'home', type: '場所', lat: 35, lng: 139 })];
  const f = frontier(acts, events);
  assert.equal(f[0].id, 'a1');
  assert.equal(f[1].note, 'はじめて');
  const r = reunions(events);
  assert.equal(r.length, 1); assert.equal(r[0].gap, 243);
  assert.equal(mapPoints(events).length, 0); // 自宅の出入りは地図に出さない
  const pts = mapPoints([ev('m1', '2026-01-01T10:00:00+09:00', { type: '場所', aid: 'a1', lat: 35, lng: 139 }), ev('m2', '2026-05-01T10:00:00+09:00', { type: '場所', aid: 'a1', lat: 35.0001, lng: 139 })]);
  assert.equal(pts.length, 1); assert.equal(pts[0].visits.length, 2); assert.equal(pts[0].lat, 35.0001);
});

test('評価の間は重複なく、未評価・一言なしを優先する', () => {
  const events = Array.from({ length: 40 }, (_, i) => ev('e' + i, `2026-01-${String(i % 28 + 1).padStart(2, '0')}T10:00:00+09:00`, { aid: 'x' + i, note: i < 20 ? 'あり' : '' }));
  const appr = events.slice(0, 20).map(e => ({ target: e.id, weight: 1, ts: '' }));
  let seed = 1; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const q = apprQueue(events, appr, 12, rand);
  assert.equal(new Set(q.map(x => x.id)).size, 12);
  assert.ok(q.filter(x => !x.evaluated).length >= 7);
});

test('遠い対: 送るのは名前・種別・一言だけ。返答の読み取り', () => {
  const c = [ev('a', '2026-01-01T10:00:00+09:00', { note: '秘密の場所 35.1,139.2', lat: 35, lng: 139 }), ev('b', '2026-01-02T10:00:00+09:00', { name: '方丈記', type: '作品' })];
  const p = distantPrompt(c);
  assert.ok(!p.includes('2026-01-01') && !p.includes('"lat"'));
  assert.equal(parseDistant('```json\n{"a":0,"b":1,"question":"問い？"}\n```', c).b.name, '方丈記');
  assert.equal(parseDistant('{"a":0,"b":0}', c), null);
});

test('日時と暦', () => {
  assert.match(isoLocal(new Date(2026, 10, 1, 9, 5, 7)), /^2026-11-01T09:05:07[+-]\d{2}:\d{2}$/);
  assert.equal(fromInputValue('2026-11-01T09:05').slice(0, 19), '2026-11-01T09:05:00');
  assert.equal(monthCells('2026-11').length % 7, 0);
  assert.equal(monthCells('2026-11')[0], '2026-11-01'); // 2026-11-01 は日曜
  assert.equal(gapLabel('2025-11-01T00:00', '2026-11-02T00:00'), '1年ぶり');
  assert.equal(autoSeason(new Date(2026, 3, 1, 12)), 'spring');
  assert.equal(autoSeason(new Date(2026, 3, 1, 21)), 'winter');
  assert.equal(nearbyPlaces(acts, 35.001, 139.0)[0].dist, 111);
  assert.deepEqual(nameChips(acts, '人').recent.map(a => a.id), ['a2']);
});

import { yearReview, yearStory, meshOf, seasonOf } from '../js/ensen.js';
test('一年をめぐる: 層・土地・挑戦・深まり', () => {
  const actants = [
    { id: 'a1', type: '場所', name: '喫茶', first_seen: '2026-04-03' },
    { id: 'a2', type: '人', name: '恩師', first_seen: '2024-05-01' },
    { id: 'a3', type: '食', name: '蕎麦', first_seen: '2025-07-10' },
  ];
  const events = [
    { id: 'e1', aid: 'a1', type: '場所', name: '喫茶', ts: '2026-04-03T12:00', lat: 35.0, lng: 139.0, place: '路地' },
    { id: 'e2', aid: 'a2', type: '人', name: '恩師', ts: '2024-05-01T12:00', lat: 35.0, lng: 139.0 },
    { id: 'e3', aid: 'a2', type: '人', name: '恩師', ts: '2026-06-01T12:00', lat: 35.5, lng: 139.5, place: '遠い町' },
    { id: 'e4', aid: 'a3', type: '食', name: '蕎麦', ts: '2025-07-10T12:00', lat: 35.01, lng: 139.0 },
    { id: 'h', ts: '2026-01-01T08:00', tags: '自宅,出発', lat: 40, lng: 140 },
  ];
  const intents = [{ id: 'i1', ts: '2026-03-01T00:00', what: '品書きの一番上', status: 'fulfilled', fulfilled_event_id: 'e1' }, { id: 'i2', ts: '2026-05-01T00:00', what: '山', status: 'open' }];
  const r = yearReview({ events, intents, actants }, 2026);
  assert.equal(seasonOf('2026-04-03'), '春');
  assert.equal(r.strata['2026']['春']['場所'], 1);
  assert.equal(r.typeTotal['2025']['食'], 1);
  assert.equal(r.challenge.placed.length, 2);
  assert.equal(r.challenge.cleared[0].clearedOn, '2026-04-03');
  assert.equal(r.deepen[0].name, '恩師');
  assert.ok(r.deepen[0].gap > 700);
  assert.ok(!r.land.cells.some(c => c.key === meshOf(40, 140)), '自宅の出入りは土地に入れない');
  assert.equal(r.land.newY.length, 1); // 喫茶は2024年に踏んだ区画と同じ
  assert.equal(r.land.farthest.label, '遠い町');
  const s = yearStory(r).join('');
  assert.match(s, /霧の中へ2つの試みを置き、1つが晴れました/);
  assert.match(s, /遠い町/);
  assert.match(s, /恩師、2年ぶり/);
});

import { placeNameFor } from '../js/ensen.js';
test('場所名の修正: 自分への修正 → 150m以内の最寄り → 元の名前、空は取り消し', () => {
  const t = { id: 't1', lat: 35, lng: 139, place: '元の名' };
  const near = { id: 'f1', ts: '2026-11-01T10:00', trace_id: 'tX', lat: 35.0005, lng: 139, name: '路地の喫茶' }; // 約55m
  const far = { id: 'f2', ts: '2026-11-01T11:00', trace_id: '', lat: 35.01, lng: 139, name: '遠い' };
  assert.deepEqual(placeNameFor(t, []).name, '元の名');
  assert.equal(placeNameFor(t, [near, far]).name, '路地の喫茶');
  assert.equal(placeNameFor(t, [near, { id: 'f3', ts: '2026-11-01T12:00', trace_id: 't1', lat: 35, lng: 139, name: '我が家の前' }]).name, '我が家の前');
  // 同じ地点を直し直したら新しい方
  assert.equal(placeNameFor(t, [near, { ...near, id: 'f4', ts: '2026-11-02T00:00', name: '喫茶ことば' }]).name, '喫茶ことば');
  // 空で取り消し
  const undo = { ...near, id: 'f5', ts: '2026-11-03T00:00', name: '' };
  assert.equal(placeNameFor(t, [near, undo]).name, '元の名');
  assert.equal(placeNameFor(t, [near, undo]).fixed, false);
  assert.equal(placeNameFor({ ...t, lat: null, lng: null }, [near]).name, '元の名');
});

import { latestSpotFixes, applySpotFixes, spotSuspects, spotCandidates } from '../js/ensen.js';

test('スポットの位置の修正: 台帳ごとに最新の行が効き、undo で元に戻る', () => {
  const evs = [
    { id: 'e1', aid: 'a1', lat: 34.7638, lng: 135.5135, type: '場所', name: 'TOHOシネマズ伊丹' },
    { id: 'e2', aid: 'a2', lat: 34.7638, lng: 135.5135, type: '場所', name: '勝盛' },
    { id: 'e3', aid: 'a3', lat: 35, lng: 135, type: '場所', name: '別の場所' },
  ];
  const fixes = [
    { id: 'f1', ts: '2026-11-01T10:00', aid: 'a1', status: 'move', lat: 34.78, lng: 135.42 },
    { id: 'f2', ts: '2026-11-01T11:00', aid: 'a2', status: 'hide' },
    { id: 'f3', ts: '2026-11-01T09:00', aid: 'a2', status: 'move', lat: 1, lng: 1 },
    { id: 'f4', ts: '2026-11-01T09:00', aid: 'a3', status: 'move', lat: 1, lng: 1 },
    { id: 'f5', ts: '2026-11-01T12:00', aid: 'a3', status: 'undo' },
  ];
  const out = applySpotFixes(evs, fixes);
  assert.equal(out[0].lat, 34.78); assert.equal(out[0].orig.lat, 34.7638); assert.equal(out[0].posFix, 'move');
  assert.equal(out[1].lat, null); assert.equal(out[1].posFix, 'hide');
  assert.equal(out[2], evs[2]);
  assert.equal(latestSpotFixes(fixes).size, 2);
  assert.equal(evs[0].lat, 34.7638); // 元は書き換えない
  // 台帳にも当てられる
  assert.equal(applySpotFixes([{ id: 'a1', lat: 0, lng: 0 }], fixes, 'id')[0].lat, 34.78);
});

test('位置の怪しいスポット: いつもの場所の近くの一度きり・寄り集まり・ばらつき', () => {
  const H = [34.76382, 135.51355];
  const ev = (id, aid, name, lat, lng, ts = '2015-01-12T21:06:45+09:00') => ({ id, aid, name, type: '場所', lat, lng, ts });
  const evs = [];
  for (let i = 0; i < 6; i++) evs.push(ev(`lib${i}`, 'lib', '図書館', H[0] + i * 0.0001, H[1]));
  evs.push(ev('t', 'toho', 'TOHOシネマズ伊丹', H[0], H[1] + 0.0002));
  evs.push(ev('j', 'jula', 'PET SHOP JULA', H[0] - 0.0005, H[1]));        // 約55m
  evs.push(ev('far', 'cafe', '遠くの喫茶', 35.0, 135.0));                   // 関係なし
  // 旅先の宿から3か所まとめて
  evs.push(ev('m1', 'm1', '美術館', 34.4851, 136.7231), ev('m2', 'm2', '農業館', 34.4851, 136.7232), ev('m3', 'm3', '徴古館', 34.4852, 136.7231));
  // 同じ寺の記録が3km離れている
  evs.push(ev('z1', 'zen', '禅操寺', 35.2, 134.8), ev('z2', 'zen', '禅操寺', 35.2, 134.835));
  evs.push({ ...ev('h', 'home', '自宅', H[0], H[1]), tags: '自宅,到着' });
  const g = spotSuspects(evs, []);
  const anchor = g.find(x => x.reason === 'anchor');
  assert.equal(anchor.anchor, '図書館');
  assert.deepEqual(anchor.items.map(i => i.aid).sort(), ['jula', 'toho']);
  assert.deepEqual(g.find(x => x.reason === 'cluster').items.map(i => i.aid).sort(), ['m1', 'm2', 'm3']);
  assert.equal(g.find(x => x.reason === 'spread').items[0].aid, 'zen');
  assert.ok(!g.some(x => x.items.some(i => i.aid === 'cafe' || i.aid === 'lib' || i.aid === 'home')));
  // 確かめたものは出ない
  const g2 = spotSuspects(evs, [{ id: 'f', ts: '1', aid: 'toho', status: 'ok' }, { id: 'f2', ts: '1', aid: 'm1', status: 'hide' }]);
  assert.deepEqual(g2.find(x => x.reason === 'anchor').items.map(i => i.aid), ['jula']);
  assert.deepEqual(g2.find(x => x.reason === 'cluster').items.map(i => i.aid).sort(), ['m2', 'm3']);
});

test('置き直す先の候補: ほかの回の位置と、その日に撮った写真の撮影地', () => {
  const item = { aid: 'toho', lat: 34.7638, lng: 135.5135, events: [{ ts: '2015-01-12T21:06:45+09:00', lat: 34.7638, lng: 135.5135 }] };
  const traces = [
    { id: 'p1', ts: '2015-01-12T18:10:00+09:00', lat: 34.7826, lng: 135.4201, place: '伊丹市中央' },
    { id: 'p2', ts: '2015-01-12T18:20:00+09:00', lat: 34.7827, lng: 135.4202, place: '伊丹市中央' }, // 150m以内はまとめる
    { id: 'p3', ts: '2015-01-12T22:00:00+09:00', lat: 34.7639, lng: 135.5135, place: '自宅' },        // 今の点の近くは出さない
    { id: 'p4', ts: '2015-01-13T12:00:00+09:00', lat: 35.0, lng: 135.7, place: '別の日' },
  ];
  const c = spotCandidates(item, traces, [{ id: 'f', ts: '1', trace_id: 'p2', name: 'TOHOのあたり' }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'photo'); assert.equal(c[0].lat, 34.7827); // 縁の時刻に近い方
  assert.match(c[0].label, /^18:20の写真・TOHOのあたり$/);
});

test('スポットの位置の修正: ts が同じ秒なら、後に追記された行(seq が大きい・まだ表にない)が勝つ', async () => {
  const { latestSpotFixes } = await import('../js/ensen.js');
  const T = '2026-11-02T10:00:00+09:00';
  const rows = [
    { id: 'x2', ts: T, aid: 'a1', status: 'hide', seq: 5 },
    { id: 'x1', ts: T, aid: 'a1', status: 'move', lat: 1, lng: 1, seq: 3 },
  ];
  assert.equal(latestSpotFixes(rows).get('a1').id, 'x2'); // 並びが逆でも表の下の行
  assert.equal(latestSpotFixes([...rows, { id: 'local', ts: T, aid: 'a1', status: 'ok' }]).get('a1').id, 'local'); // 手元の未送信は一番後ろ
  assert.equal(latestSpotFixes([{ id: 'p', ts: T, aid: 'a1', status: 'ok' }, { id: 'q', ts: T, aid: 'a1', status: 'hide' }]).get('a1').id, 'q'); // どちらも seq なし: 後に並んだ方
  assert.equal(latestSpotFixes([{ id: 'new', ts: '2026-11-02T10:00:01+09:00', aid: 'a1', status: 'ok', seq: 1 }, ...rows]).get('a1').id, 'new'); // 秒が違えば ts で決まる
});

test('霧の中へ: ブクログ由来の読みたいを見分け、読書メモで突き合わせる CSV にする', async () => {
  const { isBooklogIntent, booklogItemId, booklogCsv } = await import('../js/ensen.js');
  const list = [
    { id: '1', what: '仮説力を鍛える (SB新書)', src: 'booklog:4797343028:読みたい', isbn: '9784797343021', status: 'fulfilled' },
    { id: '2', what: '造形と科学の新しい風景', src: 'booklog:B000JABQI6:読みたい', isbn: '', status: 'open' },
    { id: '3', what: 'デジャヴ, "特別版"', src: 'booklog:B000PTYQZ6:読みたい', isbn: '4959241933119' },
    { id: '4', what: '自分で置いた本', src: '', origin: '本', status: 'open' },
    { id: '5', what: 'テスト', src: 'ZZTEST-booklog-want-1', status: 'open' },
  ];
  assert.deepEqual(list.map(isBooklogIntent), [true, true, true, false, false]);
  assert.equal(booklogItemId(list[1]), 'B000JABQI6');
  assert.equal(booklogCsv(list), [
    'itemId,isbn13,title,status',
    '4797343028,9784797343021,仮説力を鍛える (SB新書),fulfilled',
    'B000JABQI6,,造形と科学の新しい風景,open',
    'B000PTYQZ6,4959241933119,"デジャヴ, ""特別版""",open',
  ].join('\r\n') + '\r\n');
});

test('近くの場所: 種類を一語に、台帳と重なる候補は除く', async () => {
  const { poiLabel, poiChoices } = await import('../js/ensen.js');
  assert.equal(poiLabel('amenity=cafe'), 'カフェ');
  assert.equal(poiLabel('google=ramen_restaurant'), '飲食店');
  assert.equal(poiLabel('google=pet_store'), '店');
  assert.equal(poiLabel('craft=brewery'), '');
  const near = [{ name: '吹田市立中央図書館', poi: '' }, { name: 'いつもの喫茶', poi: 'osm:node/5' }];
  const poi = [{ id: 'osm:node/1', name: '吹田市立 中央図書館' }, { id: 'osm:node/5', name: 'Kissa' }, { id: 'osm:node/7', name: '公園' }];
  assert.deepEqual(poiChoices(near, poi).map(x => x.id), ['osm:node/7']);
});
