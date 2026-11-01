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
