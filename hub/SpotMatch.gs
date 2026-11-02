// ============================================================
// スポットの位置を名前で突き合わせる(縁泉ハブに足すファイル)
// ============================================================
// Swarm から取り込んだ場所の緯度経度は「チェックインした時のiPhoneの位置」なので、
// 家などから後でチェックインした店がそこに重なっている。店の名前で地図を引き直して、正しそうな位置を探す。
//
// 使い方(スクリプトエディタで関数を選んで「実行」):
//   1) matchSpots   … 名前で照会して、結果をシート「spot_match」に書く(縁は書き換えない)。
//                     6分で止まるので、続きは1分後に自動で走る。全部終わると実行ログに集計が出る
//   2) applySpotMatches … spot_match の判定が move/ok のものを spot_fixes に追記する(source=auto)。
//                     アプリはこれを読んで位置を直す。手で決めた場所(source=home)は上書きしない
//   取り消すときは undoAutoSpotFixes(source=auto の行を打ち消す undo 行を追記する)
//
// 照会先(どれも無料の範囲):
//   - Google Places(Text Search) … スクリプトプロパティ GOOGLE_PLACES_API_KEY があるときだけ。店名に強い
//   - Google の Maps サービス(Geocoder) … Apps Script に組み込み。施設として見つかったときだけ使う
//   - OpenStreetMap(Nominatim) … 1秒に1回まで。名前が似ている結果だけ使う
// 判定:
//   ok      … 見つかった場所が今の点から200m以内(今の位置で正しい)
//   move    … 今の点から離れていて、(2つ以上の照会先が500m以内で一致) または (名前がよく一致し、30km以内)
//   unknown … 見つからない・照会先が食い違う・同名の別の店かもしれない → アプリの「確かめる」で手で直す

const SPOT_MATCH_HEADERS = ['actant_id', 'name', 'visits', 'cur_lat', 'cur_lng', 'lat', 'lng', 'src', 'found_name', 'dist_m', 'agree', 'verdict', 'detail', 'checked_at'];
const SPOT_MATCH_OK_M = 200;
const SPOT_MATCH_AGREE_M = 500;
const SPOT_MATCH_ONE_SOURCE_MAX_M = 30000;
const SPOT_MATCH_BUDGET_MS = 5 * 60 * 1000;

function matchSpots() {
  const started = Date.now();
  const ss = db_();
  const sh = ss.getSheetByName('spot_match') || ss.insertSheet('spot_match');
  if (sh.getLastRow() === 0) sh.appendRow(SPOT_MATCH_HEADERS);
  const done = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { done[String(r[0])] = true; });
  const decided = spotFixedAids_(ss, 'home'); // 手で決めた場所は照会しない
  const spots = spotsFromEvents_(ss).filter(function (s) { return !done[s.aid] && !decided[s.aid]; });
  const key = PropertiesService.getScriptProperties().getProperty('GOOGLE_PLACES_API_KEY');
  const flags = { geocoder: true, places: !!key };
  let n = 0;
  for (let i = 0; i < spots.length; i++) {
    if (Date.now() - started > SPOT_MATCH_BUDGET_MS) break;
    const s = spots[i];
    const cands = [];
    if (flags.places) tryAdd_(cands, function () { return placesLookup_(s, key); }, function () { flags.places = false; });
    if (flags.geocoder) tryAdd_(cands, function () { return geocoderLookup_(s); }, function () { flags.geocoder = false; });
    tryAdd_(cands, function () { return osmLookup_(s); }, function () {});
    const v = judgeSpot_(s, cands);
    sh.appendRow([s.aid, safe_(s.name), s.visits, s.lat, s.lng, v.lat, v.lng, v.src, safe_(v.found_name), v.dist, v.agree, v.verdict, JSON.stringify(cands).slice(0, 2000), isoNow_()]);
    n++;
  }
  const rest = spots.length - n;
  clearSpotTriggers_();
  if (rest > 0) {
    ScriptApp.newTrigger('matchSpots').timeBased().after(60 * 1000).create();
    Logger.log('照会 ' + n + ' 件。残り ' + rest + ' 件は1分後に続けます');
  } else {
    Logger.log('照会がすべて終わりました。' + spotMatchSummary_(sh));
  }
  return { done: n, rest: rest };
}

function applySpotMatches() {
  const ss = db_();
  const sh = ss.getSheetByName('spot_match');
  if (!sh || sh.getLastRow() < 2) throw new Error('先に matchSpots を実行してください');
  const fixed = spotFixedAids_(ss, ''); // 手でも自動でも、すでに行がある場所は飛ばす
  const fx = spotFixSheet_(ss);
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, SPOT_MATCH_HEADERS.length).getValues();
  const out = [];
  const now = spotTs_(); // spot_fixes の ts は spotTs_ を通す(Code.gs)
  rows.forEach(function (r) {
    const aid = String(r[0]), verdict = String(r[11]);
    if (!aid || fixed[aid]) return;
    if (verdict === 'move') out.push([Utilities.getUuid(), now, aid, '', Number(r[5]), Number(r[6]), 'move', 'auto']);
    else if (verdict === 'ok') out.push([Utilities.getUuid(), now, aid, '', '', '', 'ok', 'auto']);
    fixed[aid] = true;
  });
  if (out.length) fx.getRange(fx.getLastRow() + 1, 1, out.length, 8).setValues(out);
  const moved = out.filter(function (r) { return r[6] === 'move'; }).length;
  Logger.log('spot_fixes に ' + out.length + ' 行を足しました(置き直し ' + moved + '・そのまま ' + (out.length - moved) + ')。アプリは次の同期で受け取ります');
  return { added: out.length, moved: moved };
}

// 自動で足した修正(source=auto)を打ち消す。手で直したものには触れない
function undoAutoSpotFixes() {
  const ss = db_();
  const fx = ss.getSheetByName('spot_fixes');
  if (!fx || fx.getLastRow() < 2) return { added: 0 };
  const latest = {};
  fx.getRange(2, 1, fx.getLastRow() - 1, 8).getValues().forEach(function (r) {
    const aid = String(r[2]), ts = isoString_(r[1]);
    if (!latest[aid] || ts >= latest[aid].ts) latest[aid] = { ts: ts, status: String(r[6]), source: String(r[7]) };
  });
  const now = spotTs_(); // spot_fixes の ts は spotTs_ を通す(Code.gs)
  const out = Object.keys(latest).filter(function (a) { return latest[a].source === 'auto' && latest[a].status !== 'undo'; })
    .map(function (a) { return [Utilities.getUuid(), now, a, '', '', '', 'undo', 'auto']; });
  if (out.length) fx.getRange(fx.getLastRow() + 1, 1, out.length, 8).setValues(out);
  Logger.log('自動の修正 ' + out.length + ' 件を取り消しました');
  return { added: out.length };
}

// ---------- 照会する場所の一覧 ----------
// 台帳(actant_id)ごとに、記録の位置の「真ん中」(ほかの記録との距離の合計が最小の点)を今の位置とする
function spotsFromEvents_(ss) {
  const sh = ss.getSheetByName('events');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const by = {};
  sh.getRange(2, 1, last - 1, 15).getValues().forEach(function (r) {
    const lat = Number(r[3]), lng = Number(r[4]), aid = String(r[8] || '');
    if (String(r[6]) !== '場所' || !aid || r[3] === '' || r[4] === '' || !isFinite(lat) || !isFinite(lng)) return;
    if (String(r[14] || '').indexOf('自宅') >= 0) return;
    (by[aid] = by[aid] || { aid: aid, name: String(r[7] || r[5] || ''), pts: [] }).pts.push([lat, lng]);
  });
  return Object.keys(by).map(function (aid) {
    const s = by[aid];
    let best = s.pts[0], bestSum = Infinity;
    s.pts.forEach(function (p) {
      let sum = 0;
      s.pts.forEach(function (q) { sum += haversineM_(p[0], p[1], q[0], q[1]); });
      if (sum < bestSum) { bestSum = sum; best = p; }
    });
    return { aid: aid, name: s.name, visits: s.pts.length, lat: best[0], lng: best[1] };
  }).filter(function (s) { return s.name && s.name !== '自宅'; });
}

// ---------- 照会先 ----------
function tryAdd_(cands, fn, onFatal) {
  try { (fn() || []).forEach(function (c) { cands.push(c); }); }
  catch (e) {
    const m = String(e && e.message || e);
    if (/quota|limit|too many|429|403|Service invoked too many times/i.test(m)) onFatal();
  }
}
function placesLookup_(s, key) {
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName,places.location' },
    payload: JSON.stringify({ textQuery: s.name, languageCode: 'ja', regionCode: 'JP', maxResultCount: 3, locationBias: { circle: { center: { latitude: s.lat, longitude: s.lng }, radius: 50000 } } }),
  });
  const code = res.getResponseCode();
  if (code === 429 || code === 403) throw new Error('places ' + code);
  if (code !== 200) return [];
  const j = parseJson_(res.getContentText());
  return (j.places || []).map(function (p) {
    return { src: 'places', name: (p.displayName && p.displayName.text) || '', lat: p.location && p.location.latitude, lng: p.location && p.location.longitude, poi: true };
  }).filter(function (c) { return isFinite(c.lat) && isFinite(c.lng); });
}
const POI_TYPES_ = ['establishment', 'point_of_interest', 'park', 'train_station', 'transit_station', 'place_of_worship', 'museum', 'natural_feature', 'airport', 'tourist_attraction', 'premise'];
function geocoderLookup_(s) {
  const d = 0.3; // 約30kmの枠に寄せる(枠の外も返る)
  const r = Maps.newGeocoder().setLanguage('ja').setRegion('jp').setBounds(s.lat - d, s.lng - d, s.lat + d, s.lng + d).geocode(s.name);
  if (!r || r.status !== 'OK') {
    if (r && /OVER_QUERY_LIMIT|REQUEST_DENIED/.test(r.status)) throw new Error('geocoder ' + r.status);
    return [];
  }
  return (r.results || []).slice(0, 3).filter(function (x) {
    return !x.partial_match && (x.types || []).some(function (t) { return POI_TYPES_.indexOf(t) >= 0; });
  }).map(function (x) {
    const nm = ((x.address_components || [])[0] || {}).long_name || x.formatted_address || '';
    return { src: 'geocoder', name: nm, lat: x.geometry.location.lat, lng: x.geometry.location.lng, poi: true };
  });
}
function osmLookup_(s) {
  Utilities.sleep(1100); // Nominatim の利用規約: 1秒に1回まで
  const d = 0.3;
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=jp&accept-language=ja' +
    '&viewbox=' + [s.lng - d, s.lat + d, s.lng + d, s.lat - d].join(',') + '&q=' + encodeURIComponent(s.name);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'ensen-hub/1.0 (personal lifelog; Google Apps Script)' } });
  const code = res.getResponseCode();
  if (code === 429) throw new Error('osm 429');
  if (code !== 200) return [];
  let arr;
  try { arr = JSON.parse(res.getContentText()); } catch (e) { return []; }
  return (arr || []).map(function (x) {
    return { src: 'osm', name: x.name || String(x.display_name || '').split(',')[0], lat: Number(x.lat), lng: Number(x.lon), poi: x.category !== 'boundary' && x.category !== 'place' };
  }).filter(function (c) { return isFinite(c.lat) && isFinite(c.lng); });
}

// ---------- 判定 ----------
// 名前の近さ spotNameScore_ は Code.gs にある(結ぶ画面の近くの場所でも使う)
function judgeSpot_(s, cands) {
  const none = { lat: '', lng: '', src: '', found_name: '', dist: '', agree: 0, verdict: 'unknown' };
  // 名前が似ている候補だけ。照会先ごとに今の点にいちばん近いもの
  const good = cands.filter(function (c) { return c.poi && spotNameScore_(s.name, c.name) >= 0.6; });
  if (!good.length) return none;
  const rank = { places: 0, geocoder: 1, osm: 2 };
  // 同じ照会先が1km以上離れた同名の場所を複数返したら(チェーン店など)、どれか決められないので使わない
  const ambiguous = {};
  good.forEach(function (c) {
    good.forEach(function (o) { if (o.src === c.src && haversineM_(c.lat, c.lng, o.lat, o.lng) > 1000) ambiguous[c.src] = true; });
  });
  const pickOf = {};
  good.filter(function (c) { return !ambiguous[c.src]; }).forEach(function (c) {
    c.d = Math.round(haversineM_(s.lat, s.lng, c.lat, c.lng));
    const cur = pickOf[c.src];
    if (!cur || c.d < cur.d) pickOf[c.src] = c;
  });
  if (!Object.keys(pickOf).length) return none;
  const picks = Object.keys(pickOf).map(function (k) { return pickOf[k]; }).sort(function (x, y) { return rank[x.src] - rank[y.src]; });
  // 今の点の近くに見つかれば、そのままで正しい
  const near = picks.filter(function (c) { return c.d <= SPOT_MATCH_OK_M; });
  if (near.length) {
    const c = near[0];
    return { lat: c.lat, lng: c.lng, src: c.src, found_name: c.name, dist: c.d, agree: near.length, verdict: 'ok' };
  }
  // いちばん信頼できる照会先の答えに、ほかがどれだけ合うか
  let best = null;
  picks.forEach(function (c) {
    const agree = picks.filter(function (o) { return haversineM_(c.lat, c.lng, o.lat, o.lng) <= SPOT_MATCH_AGREE_M; }).length;
    if (!best || agree > best.agree) best = { c: c, agree: agree };
  });
  const c = best.c;
  const score = spotNameScore_(s.name, c.name);
  const sure = best.agree >= 2 || (score >= 0.8 && c.d <= SPOT_MATCH_ONE_SOURCE_MAX_M);
  return { lat: c.lat, lng: c.lng, src: c.src, found_name: c.name, dist: c.d, agree: best.agree, verdict: sure ? 'move' : 'unknown' };
}

// ---------- 小物 ----------
function spotFixSheet_(ss) {
  const sh = ss.getSheetByName('spot_fixes') || ss.insertSheet('spot_fixes');
  if (sh.getLastRow() === 0) sh.appendRow(SPOT_FIXES_HEADERS);
  return sh;
}
// source を指定するとその出どころの行がある台帳だけ。空ならすべて
function spotFixedAids_(ss, source) {
  const sh = ss.getSheetByName('spot_fixes');
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().forEach(function (r) {
    if (!source || String(r[7]) === source) out[String(r[2])] = true;
  });
  return out;
}
function clearSpotTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'matchSpots') ScriptApp.deleteTrigger(t); });
}
function spotMatchSummary_(sh) {
  const c = { ok: 0, move: 0, unknown: 0 };
  if (sh.getLastRow() > 1) sh.getRange(2, 12, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { c[String(r[0])] = (c[String(r[0])] || 0) + 1; });
  return 'そのままで正しい ' + c.ok + '・置き直す ' + c.move + '・わからない ' + c.unknown + '。よければ applySpotMatches を実行してください';
}
