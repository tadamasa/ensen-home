/**
 * 縁泉ハブ: ホーム画面の縁泉アプリ(https://tadamasa.github.io/ensen-home/)と、
 * いまの縁泉スプレッドシート(ensen)をつなぐ受け口。使い方は hub/README.md。
 *
 * ensen シートは、これまでの縁泉GAS(UI・iOSショートカットの取込口・夜間エンリッチ)もそのまま読み書きする。
 * だからこのハブは縁泉の絶対規約を守る:
 *  1. events / appraisals は追記専用。appendRow だけで書き、既存行は直さない・消さない
 *  2. 人/場所/作品/モノ/食 の5種と関係動詞7語は凍結。ここでも検査だけして増やさない
 *  3. 件数・連続・達成率のような目的関数は返さない
 *  6. intent に期限・自動クローズはない(状態を変えるのは本人がアプリで押したときだけ)
 *  7. text/plain の JSON を受ける
 * 足すのは同期の台帳シート「_sync」(kind, id, rev, mtime, deleted, hash)だけ。
 * 縁泉GASや手で表に入った分は、同期のたびに hash を比べて見つけ、新しい rev を振ってアプリへ流す。
 */

const TIMEZONE = 'Asia/Tokyo';
const ENSEN_SHEET_ID_DEFAULT = '1vKPwd3kM4RdD19PEWaCG1R6OuVJGxSjj2njlan6UBFA';
const LEDGER = '_sync';
const LEDGER_COLS = ['kind', 'id', 'rev', 'mtime', 'deleted', 'hash'];
const ITEM_LIMIT = 800;        // 1回の応答で返す最大件数
const CHAR_BUDGET = 2500000;   // 1回の応答のおおよその大きさ(写真の痕跡サムネが大きいため)

// 固定コア語彙(縁泉 Code.gs と同じ。凍結。拡張・改名禁止)
const ACTANT_TYPES = ['人', '場所', '作品', 'モノ', '食'];
const VERBS = ['出会う', '再会', '受け取る', '贈る', '交わす', '発見する', '手放す'];
const INTENT_ORIGINS = ['人', '本', '場所', 'メディア', '偶然'];
const INTENT_STATUS = ['open', 'fulfilled', 'released'];
const PLACE_MATCH_RADIUS_M = 150;
const MEDIA_FOLDER_NAME = 'ensen_media';

// 列は縁泉の SHEET_HEADERS / TRACE_HEADERS と同じ並び
const KINDS = {
  events: { sheet: 'events', cols: 16 },     // event_id, ts, recorded_ts, lat, lng, place_name, actant_type, actant_name, actant_id, verb, note, media_ref, star, source, tags, enrich
  intents: { sheet: 'intents', cols: 9 },    // intent_id, ts, what, actant_type, origin, origin_name, status, fulfilled_event_id, enrich
  appraisals: { sheet: 'appraisals', cols: 5 }, // appraisal_id, ts, target_event_id, weight, note
  actants: { sheet: 'actants', cols: 8 },    // actant_id, type, canonical_name, aliases, keys, first_seen, last_seen, count
  traces: { sheet: 'traces', cols: 8 },      // trace_id, ts, recorded_ts, lat, lng, place_name, photo_key, source (9列目 thumb_b64 は返すときだけ読む)
  place_names: { sheet: 'place_names', cols: 7 }, // fix_id, ts, trace_id, lat, lng, name, source(場所名の修正。追記専用。traces.place_name は書き換えない)
  spot_fixes: { sheet: 'spot_fixes', cols: 8 },   // fix_id, ts, actant_id, event_id, lat, lng, status, source(スポットの位置の修正。追記専用。events の lat/lng は書き換えない)
};
const PLACE_NAMES_HEADERS = ['fix_id', 'ts', 'trace_id', 'lat', 'lng', 'name', 'source'];
const SPOT_FIXES_HEADERS = ['fix_id', 'ts', 'actant_id', 'event_id', 'lat', 'lng', 'status', 'source'];
const SPOT_STATUS = ['move', 'hide', 'ok', 'undo'];
const KIND_NAMES = Object.keys(KINDS);

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  const ss = db_();
  ['events', 'intents', 'appraisals', 'actants'].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('縁泉のシート「' + n + '」が見つかりません。ENSEN_SHEET_ID を確かめてください');
  });
  ledger_(ss);
  Logger.log('合言葉: ' + props.getProperty('TOKEN'));
}

function doGet() {
  return json_({ ok: true, app: 'ensen-hub' });
}

// 受け取る: { token, action?, since, push: { events:[{id,mtime,data}], intents:[...], appraisals:[...] } }
// 返す:     { ok, rev, more, items:[{kind,id,mtime,deleted,data}], rejected:[{kind,id,error}] }
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || req.token !== token) return json_({ ok: false, error: 'unauthorized' });
  try {
    if (req.action === 'ping') return json_({ ok: true, pong: true });
    if (req.action === 'day') return json_(getDay_(String(req.date || '')));
    if (req.action === 'poi') return json_(nearbyPoi_(req));
    if (req.action === 'month') return json_(monthMarks_(String(req.month || '')));
    if (req.action) return json_({ ok: false, error: 'unknown action' });
    const lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      return json_(sync_(req));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ========== 同期 ==========
function sync_(req) {
  const props = PropertiesService.getScriptProperties();
  const ss = db_();
  const since = Number(req.since || 0);
  const st = reconcile_(ss, Number(props.getProperty('REV') || 0));
  const push = req.push || {};
  const rejected = [];
  const each = function (kind, fn) {
    (push[kind] || []).forEach(function (item) {
      if (!item || !item.id) return;
      try { fn(item, String(item.id)); } catch (err) { rejected.push({ kind: kind, id: String(item.id), error: String(err && err.message || err) }); }
    });
  };
  each('events', function (item, id) { pushEvent_(st, item, id); });
  each('intents', function (item, id) { pushIntent_(st, item, id); });
  each('appraisals', function (item, id) { pushAppraisal_(st, item, id); });
  each('place_names', function (item, id) { pushPlaceName_(st, item, id); });
  each('spot_fixes', function (item, id) { pushSpotFix_(st, item, id); });

  if (st.dirty) writeLedger_(st.lsh, st.ledger);
  props.setProperty('REV', String(st.rev));

  // since より新しいものを古い順に返す。多いときは more を立て、返した最後の rev を次の起点にする
  const fresh = st.ledger.filter(function (r) { return Number(r[2]) > since; })
    .sort(function (x, y) { return Number(x[2]) - Number(y[2]); });
  const page = [];
  let chars = 0;
  for (let i = 0; i < fresh.length && page.length < ITEM_LIMIT && chars < CHAR_BUDGET; i++) {
    const it = itemOf_(st, fresh[i]);
    chars += it.size;
    page.push({ row: fresh[i], item: it.item });
  }
  fillThumbs_(st, page.map(function (p) { return p.item; }));
  const more = page.length < fresh.length;
  return {
    ok: true,
    more: more,
    rev: more ? Number(page[page.length - 1].row[2]) : st.rev,
    items: page.map(function (p) { return p.item; }),
    rejected: rejected,
  };
}

/**
 * 表と台帳を突き合わせる。縁泉GAS・iOSショートカット・夜間エンリッチ・手での修正で
 * 中身が変わった行(hash が違う行)と新しい行に新しい rev を振る。表から消えた行は削除として流す。
 */
function reconcile_(ss, rev) {
  const lsh = ledger_(ss);
  const ledger = lsh.getLastRow() > 1 ? lsh.getRange(2, 1, lsh.getLastRow() - 1, LEDGER_COLS.length).getValues().map(function (r) { return r.map(String); }) : [];
  const lidx = {};
  ledger.forEach(function (r, i) { if (r[1]) lidx[r[0] + '|' + r[1]] = i; });
  const st = { ss: ss, lsh: lsh, ledger: ledger, lidx: lidx, rev: rev, dirty: false, rows: {}, byId: {}, sheets: {}, now: String(Date.now()) };
  KIND_NAMES.forEach(function (kind) {
    const k = KINDS[kind];
    const sh = ss.getSheetByName(k.sheet);
    st.sheets[kind] = sh;
    const last = sh ? sh.getLastRow() : 0;
    const rows = last > 1 ? sh.getRange(2, 1, last - 1, k.cols).getValues() : [];
    const byId = {};
    rows.forEach(function (r, i) {
      const id = String(r[0] || '').trim();
      if (!id || byId[id] !== undefined) return; // 同じidの2行目以降は無視(追記専用なので直さない)
      byId[id] = i;
      const h = hashRow_(kind, r);
      // 返す形を変えただけ(中身は前のまま)の送り直しでは mtime を進めない。手元の未送信の操作が「古い」と退けられないように
      const li = lidx[kind + '|' + id];
      const keep = li !== undefined && DATA_SHAPE[kind] && ledger[li][4] !== 'true' && ledger[li][5] !== h && ledger[li][5] === hashRow_(kind, r, true);
      bumpIfChanged_(st, kind, id, h, keep ? ledger[li][3] : undefined);
    });
    st.rows[kind] = rows;
    st.byId[kind] = byId;
  });
  ledger.forEach(function (r) {
    if (r[1] && r[4] !== 'true' && st.byId[r[0]] && st.byId[r[0]][r[1]] === undefined) bump_(st, r[0], r[1], true, '', st.now);
  });
  return st;
}

function bumpIfChanged_(st, kind, id, h, mtime) {
  const li = st.lidx[kind + '|' + id];
  if (li !== undefined && st.ledger[li][5] === h && st.ledger[li][4] !== 'true') return false;
  bump_(st, kind, id, false, h, mtime || st.now);
  return true;
}

function bump_(st, kind, id, deleted, hash, mtime) {
  st.rev += 1;
  const row = [kind, id, String(st.rev), String(mtime), String(deleted), hash];
  const key = kind + '|' + id;
  if (st.lidx[key] === undefined) { st.lidx[key] = st.ledger.length; st.ledger.push(row); } else st.ledger[st.lidx[key]] = row;
  st.dirty = true;
}

// ---------- アプリからの書き込み ----------
function pushEvent_(st, item, id) {
  if (st.byId.events[id] !== undefined) return; // もう表にある(送り直し)。追記専用なので直さない
  const p = item.data || {};
  if (ACTANT_TYPES.indexOf(p.type) < 0) throw new Error('actant_type は ' + ACTANT_TYPES.join('/') + ' のいずれか');
  const name = String(p.name || '').trim();
  if (!name) throw new Error('actant_name が空です');
  if (p.verb && VERBS.indexOf(p.verb) < 0) throw new Error('verb は固定7語のいずれか');
  const recorded = isoOr_(p.recorded_ts, isoNow_());
  const ts = isoOr_(p.ts, recorded);
  const lat = numOrBlank_(p.lat), lng = numOrBlank_(p.lng);
  const poiId = p.type === '場所' && /^(osm|google):[\w\/\-]+$/.test(String(p.poi_id || '')) ? String(p.poi_id) : '';
  const reg = upsertActant_(st, p.type, name, lat, lng, ts, poiId);
  const verb = p.verb || (reg.existed ? '再会' : defaultNewVerb_(p.type));
  let media = String(p.media || '');
  if (p.photo) media = storeMedia_(p.photo, ts);
  const en = {};
  if (p.trace_id) en.trace_id = String(p.trace_id);
  if (poiId) en.poi = poiId; // 結ぶときに地図の候補から選んだ場所
  const enrich = Object.keys(en).length ? JSON.stringify(en) : '';
  const row = [id, ts, recorded, lat, lng, safe_(p.place || ''), p.type, safe_(name), reg.actant_id, verb,
    safe_(p.note || ''), media, p.star ? 1 : 0, 'home', safe_(p.tags || ''), enrich];
  st.sheets.events.appendRow(row);
  addRow_(st, 'events', id, row.map(unsafe_), item.mtime);
}

function pushIntent_(st, item, id) {
  const p = item.data || {};
  const ri = st.byId.intents[id];
  if (ri === undefined) {
    const what = String(p.what || '').trim();
    if (!what) throw new Error('what が空です');
    if (p.type && ACTANT_TYPES.indexOf(p.type) < 0) throw new Error('actant_type が語彙にありません');
    if (p.origin && INTENT_ORIGINS.indexOf(p.origin) < 0) throw new Error('origin は ' + INTENT_ORIGINS.join('/') + ' のいずれか');
    const status = INTENT_STATUS.indexOf(p.status) >= 0 ? p.status : 'open';
    const row = [id, isoOr_(p.ts, isoNow_()), safe_(what), p.type || '', p.origin || '', safe_(p.origin_name || ''), status, String(p.fulfilled_event_id || ''), ''];
    st.sheets.intents.appendRow(row);
    addRow_(st, 'intents', id, row.map(unsafe_), item.mtime);
    return;
  }
  // 既にある intent は、状態(open/fulfilled/released)と結んだ縁のidだけを本人の操作として書く
  const li = st.lidx['intents|' + id];
  if (li !== undefined && Number(st.ledger[li][3]) > Number(item.mtime || 0)) return; // 表のほうが新しい
  if (INTENT_STATUS.indexOf(p.status) < 0) throw new Error('status は open/fulfilled/released');
  const r = st.rows.intents[ri];
  const fe = p.status === 'fulfilled' ? String(p.fulfilled_event_id || r[7] || '') : String(r[7] || '');
  if (String(r[6]) === p.status && String(r[7] || '') === fe) return;
  st.sheets.intents.getRange(ri + 2, 7, 1, 2).setValues([[p.status, fe]]);
  r[6] = p.status; r[7] = fe;
  bump_(st, 'intents', id, false, hashRow_('intents', r), Number(item.mtime || Date.now()));
}

function pushAppraisal_(st, item, id) {
  if (st.byId.appraisals[id] !== undefined) return; // 追記専用
  const p = item.data || {};
  const w = Number(p.weight);
  if (w !== 0 && w !== 1 && w !== 2) throw new Error('weight は 0/1/2');
  if (!p.target) throw new Error('target_event_id が空です');
  const row = [id, isoOr_(p.ts, isoNow_()), String(p.target), w, safe_(p.note || '')];
  st.sheets.appraisals.appendRow(row);
  addRow_(st, 'appraisals', id, row.map(unsafe_), item.mtime);
}

// 場所名の修正: 1行の追記で表す。空の名前は「修正を取り消して元に戻す」
function pushPlaceName_(st, item, id) {
  if (st.byId.place_names[id] !== undefined) return; // 追記専用
  const p = item.data || {};
  const lat = Number(p.lat), lng = Number(p.lng);
  const hasPos = p.lat !== '' && p.lat != null && p.lng !== '' && p.lng != null && isFinite(lat) && isFinite(lng);
  if (!p.trace_id && !hasPos) throw new Error('trace_id か位置が要ります');
  const name = String(p.name == null ? '' : p.name).trim();
  if (name.length > 80) throw new Error('場所名が長すぎます');
  if (!st.sheets.place_names) {
    const sh = st.ss.getSheetByName('place_names') || st.ss.insertSheet('place_names');
    if (sh.getLastRow() === 0) sh.appendRow(PLACE_NAMES_HEADERS);
    st.sheets.place_names = sh;
  }
  const row = [id, isoOr_(p.ts, isoNow_()), String(p.trace_id || ''), hasPos ? lat : '', hasPos ? lng : '', safe_(name), 'home'];
  st.sheets.place_names.appendRow(row);
  addRow_(st, 'place_names', id, row.map(unsafe_), item.mtime);
}

// spot_fixes の ts の約束(読む相手=縁泉アプリ・旅先との約束。hub/README.md):
//   yyyy-MM-dd'T'HH:mm:ss+09:00(東京時間・秒まで・ミリ秒なし・オフセットは必ず +09:00)。読む側は文字列のまま大小を比べる。
//   いったん Date にしてから書き直す。Z・ミリ秒付き・ほかのオフセットも東京時間に直す。オフセットのない文字列は東京時間とみなす。
//   読めない値・空は受け取った時刻にする。spot_fixes に書く経路(ここと SpotMatch.gs)はすべてこの関数を通す。
function spotTs_(v) {
  let d = null;
  if (v instanceof Date) d = v;
  else {
    const s = String(v == null ? '' : v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
      const off = !m[7] ? '+09:00' : m[7] === 'Z' ? 'Z' : m[7].length === 5 ? m[7].slice(0, 3) + ':' + m[7].slice(3) : m[7];
      d = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + off);
    }
  }
  if (!d || isNaN(d.getTime())) d = new Date();
  return Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// スポットの位置の修正: 台帳(actant_id)ごとに、いちばん新しい行が効く。ts が同じ秒なら、後に追記された行(下の行)が勝つ。
// move=lat/lngへ置き直す / hide=位置不明 / ok=確かめた / undo=元に戻す
function pushSpotFix_(st, item, id) {
  if (st.byId.spot_fixes[id] !== undefined) return; // 追記専用
  const p = item.data || {};
  const status = String(p.status || '');
  if (SPOT_STATUS.indexOf(status) < 0) throw new Error('status は ' + SPOT_STATUS.join('/'));
  if (!p.aid) throw new Error('actant_id が空です');
  const lat = Number(p.lat), lng = Number(p.lng);
  const hasPos = p.lat !== '' && p.lat != null && p.lng !== '' && p.lng != null && isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (status === 'move' && !hasPos) throw new Error('置き直す位置が要ります');
  if (!st.sheets.spot_fixes) {
    const sh = st.ss.getSheetByName('spot_fixes') || st.ss.insertSheet('spot_fixes');
    if (sh.getLastRow() === 0) sh.appendRow(SPOT_FIXES_HEADERS);
    st.sheets.spot_fixes = sh;
  }
  const row = [id, spotTs_(p.ts), safe_(String(p.aid)), safe_(String(p.event_id || '')), status === 'move' ? lat : '', status === 'move' ? lng : '', status, 'home'];
  st.sheets.spot_fixes.appendRow(row);
  addRow_(st, 'spot_fixes', id, row.map(unsafe_), item.mtime);
}

function addRow_(st, kind, id, row, mtime) {
  const r = row.slice(0, KINDS[kind].cols);
  st.byId[kind][id] = st.rows[kind].length;
  st.rows[kind].push(r);
  bump_(st, kind, id, false, hashRow_(kind, r), Number(mtime || Date.now()));
}

/**
 * actants 台帳の照合と更新(縁泉 Code.gs の upsertActant_ と同じ規則):
 * 場所=名称類似(部分一致可)かつ 150m 以内 / ほか=正規化した名前・別名の一致。
 * 台帳は追記専用の対象外なので last_seen と count を更新してよい。
 */
function upsertActant_(st, type, name, lat, lng, ts, poiId) {
  const sh = st.sheets.actants;
  const rows = st.rows.actants;
  const norm = normalizeName_(name);
  // 地図の候補のIDが同じ台帳があれば、名前の表記が違っても同じ場所
  let hit = -1;
  if (poiId) {
    for (let i = 0; i < rows.length; i++) if (rows[i][1] === type && parseJson_(rows[i][4]).poi === poiId) { hit = i; break; }
  }
  for (let i = 0; hit < 0 && i < rows.length; i++) {
    const r = rows[i];
    if (r[1] !== type) continue;
    const names = [String(r[2])].concat(String(r[3] || '').split(',')).filter(String);
    if (!names.some(function (nm) { return nameSimilar_(norm, normalizeName_(nm), type === '場所'); })) continue;
    if (type === '場所' && lat !== '' && lng !== '') {
      const k = parseJson_(r[4]);
      if (k.lat != null && k.lng != null && haversineM_(lat, lng, Number(k.lat), Number(k.lng)) > PLACE_MATCH_RADIUS_M) continue;
      if (poiId && k.poi && k.poi !== poiId) continue; // 別の店だとわかっている
    }
    hit = i;
  }
  if (hit >= 0) {
    const r = rows[hit];
    const count = (Number(r[7]) || 0) + 1;
    const lastSeen = isoString_(r[6]) > ts ? r[6] : ts; // 過去の日時で書いたときは last_seen を戻さない
    sh.getRange(hit + 2, 7, 1, 2).setValues([[lastSeen, count]]);
    r[6] = lastSeen; r[7] = count;
    const k = parseJson_(r[4]);
    if (poiId && !k.poi) { // 台帳に地図のIDを覚えさせる(位置は台帳のまま)
      k.poi = poiId;
      r[4] = JSON.stringify(k);
      sh.getRange(hit + 2, 5).setValue(r[4]);
    }
    bumpIfChanged_(st, 'actants', String(r[0]), hashRow_('actants', r));
    return { actant_id: String(r[0]), existed: true };
  }
  const id = Utilities.getUuid();
  const k = {};
  if (type === '場所' && lat !== '' && lng !== '') { k.lat = lat; k.lng = lng; }
  if (poiId) k.poi = poiId;
  const row = [id, type, safe_(name), '', JSON.stringify(k), ts, ts, 1];
  sh.appendRow(row);
  addRow_(st, 'actants', id, row.map(unsafe_), Date.now());
  return { actant_id: id, existed: false };
}

function defaultNewVerb_(t) {
  const d = { '人': '出会う', '場所': '発見する', '作品': '出会う', 'モノ': '受け取る', '食': '受け取る' };
  return d[t] || '出会う';
}

// 写真は縁泉と同じ Drive の ensen_media フォルダへ。events には URL だけ入れる
function storeMedia_(b64, ts) {
  const props = PropertiesService.getScriptProperties();
  let folder = null;
  const fid = props.getProperty('ENSEN_MEDIA_FOLDER_ID');
  if (fid) { try { folder = DriveApp.getFolderById(fid); } catch (e) { folder = null; } }
  if (!folder) {
    const it = DriveApp.getFoldersByName(MEDIA_FOLDER_NAME);
    folder = it.hasNext() ? it.next() : DriveApp.createFolder(MEDIA_FOLDER_NAME);
    props.setProperty('ENSEN_MEDIA_FOLDER_ID', folder.getId());
  }
  const data = String(b64).replace(/^data:[^,]*,/, '');
  const name = 'ensen_' + String(ts).slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1_$2') + '.jpg';
  return folder.createFile(Utilities.newBlob(Utilities.base64Decode(data), 'image/jpeg', name)).getUrl();
}

// ---------- 表の行 → アプリのデータ ----------
function itemOf_(st, lrow) {
  const kind = lrow[0], id = lrow[1];
  const ri = st.byId[kind] ? st.byId[kind][id] : undefined;
  if (lrow[4] === 'true' || ri === undefined) return { item: { kind: kind, id: id, mtime: Number(lrow[3]), deleted: true }, size: 60 };
  const data = dataOf_(kind, st.rows[kind][ri]);
  if (kind === 'spot_fixes') data.seq = ri + 2;
  const item = { kind: kind, id: id, mtime: Number(lrow[3]), deleted: false, data: data };
  return { item: item, size: JSON.stringify(data).length + (kind === 'traces' ? 40000 : 0) };
}

function dataOf_(kind, r) {
  const s = function (v) { return String(v == null ? '' : v); };
  const n = function (v) { return v === '' || v == null || isNaN(Number(v)) ? null : Number(v); };
  if (kind === 'events') {
    const en = s(r[15]);
    const m = en.match(/"trace_id"\s*:\s*"([^"]+)"/);
    return { id: s(r[0]), ts: isoString_(r[1]), recorded_ts: isoString_(r[2]), lat: n(r[3]), lng: n(r[4]), place: s(r[5]), type: s(r[6]), name: s(r[7]), aid: s(r[8]), verb: s(r[9]), note: s(r[10]), media: s(r[11]), star: r[12] === 1 || s(r[12]) === '1' || r[12] === true, source: s(r[13]), tags: s(r[14]), trace_id: m ? m[1] : '', enrich: en.length > 4000 ? '' : en };
  }
  if (kind === 'intents') {
    const en = parseJson_(r[8]);
    // src: 取込元の印(ブクログ取込は booklog:<itemId>:読みたい)。アプリは booklog: のものを「読書メモで管理している読みたい」に分ける
    return { id: s(r[0]), ts: isoString_(r[1]), what: s(r[2]), type: s(r[3]), origin: s(r[4]), origin_name: s(r[5]), status: s(r[6]) || 'open', fulfilled_event_id: s(r[7]), isbn: (en.keys || {}).isbn || '', src: typeof en.src_id === 'string' ? en.src_id : '' };
  }
  if (kind === 'appraisals') return { id: s(r[0]), ts: isoString_(r[1]), target: s(r[2]), weight: Number(r[3]) || 0, note: s(r[4]) };
  if (kind === 'actants') {
    const k = parseJson_(r[4]);
    return { id: s(r[0]), type: s(r[1]), name: s(r[2]), aliases: s(r[3]), lat: k.lat != null ? Number(k.lat) : null, lng: k.lng != null ? Number(k.lng) : null, poi: k.poi ? String(k.poi) : '', first_seen: isoString_(r[5]), last_seen: isoString_(r[6]), count: Number(r[7]) || 0 };
  }
  if (kind === 'spot_fixes') return { id: s(r[0]), ts: isoString_(r[1]), aid: s(r[2]), event_id: s(r[3]), lat: n(r[4]), lng: n(r[5]), status: s(r[6]), source: s(r[7]) };
  if (kind === 'place_names') return { id: s(r[0]), ts: isoString_(r[1]), trace_id: s(r[2]), lat: n(r[3]), lng: n(r[4]), name: s(r[5]), source: s(r[6]) };
  return { id: s(r[0]), ts: isoString_(r[1]), lat: n(r[3]), lng: n(r[4]), place: s(r[5]), source: s(r[7]), thumb: '' };
}

// 痕跡のサムネ(9列目)は返す分だけ読む。毎回の突き合わせで数MBを読まないため
function fillThumbs_(st, items) {
  const want = items.filter(function (it) { return it.kind === 'traces' && !it.deleted; });
  if (!want.length) return;
  const sh = st.sheets.traces;
  const col = sh.getRange(2, 9, sh.getLastRow() - 1, 1).getValues();
  want.forEach(function (it) {
    const ri = st.byId.traces[it.id];
    const v = String((col[ri] || [''])[0] || '').replace(/\s+/g, '');
    it.data.thumb = v.length > 100 && v.length < 60000 ? v : '';
  });
}

// アプリへ返す形を変えた種類と、その印。印を変えると hash が変わり、次の同期で全件を送り直す
//  intents: src(2026-11-02)/ spot_fixes: seq(2026-11-02)
const DATA_SHAPE = { intents: '2', spot_fixes: '2' };

// FNV-1a(32bit)。「変わったか」を見るだけなので軽いもので足りる
function hashRow_(kind, r, noShape) {
  const parts = DATA_SHAPE[kind] && !noShape ? ['shape' + DATA_SHAPE[kind]] : [];
  for (let i = 0; i < KINDS[kind].cols; i++) parts.push(r[i] instanceof Date ? isoString_(r[i]) : String(r[i] == null ? '' : r[i]));
  const str = parts.join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

function ledger_(ss) {
  let sh = ss.getSheetByName(LEDGER);
  if (!sh) {
    sh = ss.insertSheet(LEDGER);
    sh.getRange(1, 1, sh.getMaxRows(), LEDGER_COLS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, LEDGER_COLS.length).setValues([LEDGER_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeLedger_(sh, ledger) {
  if (!ledger.length) return;
  const need = ledger.length + 1 - sh.getMaxRows();
  if (need > 0) { sh.insertRowsAfter(sh.getMaxRows(), need); sh.getRange(1, 1, sh.getMaxRows(), LEDGER_COLS.length).setNumberFormat('@'); }
  sh.getRange(2, 1, ledger.length, LEDGER_COLS.length).setValues(ledger);
}

// ========== その日のまわり(読み取りのみ): 日記・読み終えた本・観た映画・月の印 ==========
// 読み方は共通ライブラリ DayReaders(tadamasa/diary-home の lib/day-readers)にまとめた。日記ハブ・日記v2 も同じものを使う。
// ここではスクリプト プロパティからシートIDとアプリURLを決めて渡すだけ。列は各シートの1行目の見出しから引く。
// ライブラリは「ライブラリ +」で版を固定して追加する(識別子 DayReaders、版は appsscript.json と README の「他アプリとの約束」)。
const DIARY_SHEET_ID_DEFAULT = '1yVC3q2dm4-LxrAg_lRDk8G3qqU-WNQnI5LznFPgxKp8';
const DIARY_APP_URL_DEFAULT = 'https://tadamasa.github.io/diary-home/';
const BOOKS_SHEET_ID_DEFAULT = '1WEsS95CKH7JPFuGf7BYzlTV-d6FyTVg0OCOymKHqsZg';
const READING_APP_URL_DEFAULT = 'https://tadamasa.github.io/reading-memo/';
const MOVIES_SHEET_ID_DEFAULT = '156oktIUuxKOcFZn0QYrx6ncY3AFiY-7DjgAIYbiRCm4';
const MOVIE_APP_URL_DEFAULT = 'https://tadamasa.github.io/movie-memo/';

function prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d; }

// ライブラリが追加されていなくても同期は動く。「その日」と月の印だけが理由つきで空になる
function readers_() {
  if (typeof DayReaders === 'undefined') throw new Error('ライブラリ DayReaders が追加されていません(hub/README.md)');
  return DayReaders;
}
function readSafe_(fn) {
  try { return fn(readers_()); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function getDay_(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false, error: 'bad date' };
  return {
    ok: true,
    date: dateStr,
    diary: readSafe_(function (R) { return R.diaryForDate(prop_('DIARY_SHEET_ID', DIARY_SHEET_ID_DEFAULT), dateStr, prop_('DIARY_APP_URL', DIARY_APP_URL_DEFAULT)); }),
    books: readSafe_(function (R) { return R.booksForDate(prop_('BOOKS_SHEET_ID', BOOKS_SHEET_ID_DEFAULT), dateStr, prop_('READING_APP_URL', READING_APP_URL_DEFAULT)); }),
    films: readSafe_(function (R) { return R.filmsForDate(prop_('MOVIES_SHEET_ID', MOVIES_SHEET_ID_DEFAULT), dateStr, prop_('MOVIE_APP_URL', MOVIE_APP_URL_DEFAULT)); }),
  };
}

// カレンダーの印: その月に本を読み終えた日・映画を観た日
function monthMarks_(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad month' };
  return readSafe_(function (R) { return R.monthMarks(prop_('BOOKS_SHEET_ID', BOOKS_SHEET_ID_DEFAULT), prop_('MOVIES_SHEET_ID', MOVIES_SHEET_ID_DEFAULT), ym); });
}

// ========== 近くの場所の候補(結ぶ画面の「近くの場所」) ==========
// 元の縁泉(Phase 1.7)と同じ考え方: 第一層=自分の台帳はアプリが手元で出す。ここは第二層=外の地図の候補だけ。
// 失敗・遅延は静かに諦める(空で返す)。ingest_log にも書かない。
//
// 照会先(スクリプトプロパティで決まる。コードは変えない):
//   - OpenStreetMap(Overpass) … 既定で使う。キー不要・無料。座標を保存してよい(ODbL、表記「© OpenStreetMap contributors」)
//       OVERPASS_ENDPOINT で照会先を変えられる。'off' で止める。
//       本家 overpass-api.de は GAS からの照会を 406 で断る(2026-07 実測)ので、既定は GAS から通った maps.mail.ru
//   - Google Places(New) … GOOGLE_PLACES_API_KEY があるときだけ足す。小さな店に強い。
//       Google の規約では座標の保存は30日まで・place_id は無期限。OSM と同じ店が重なったら OSM を残す
// req: { lat, lng, radius?(m, 100〜1000、既定300), q?(名前で探す。そのときは 5km 以内) }
// 返す: { ok, providers:[...], poi:[{ id:'osm:node/123'|'google:ChIJ…', src, name, lat, lng, category, dist }] }
const POI_RADIUS_M = 300;
const POI_SEARCH_RADIUS_M = 5000;
const POI_CACHE_SEC = 1800;
const POI_CACHE_VER = 'poi3';
const POI_DUP_M = 60;
// 既定は上から順に試す(一つが落ちていても次へ)。OVERPASS_ENDPOINT を入れるとそれだけを使う
const OVERPASS_DEFAULTS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function nearbyPoi_(req) {
  const lat = Number(req.lat), lng = Number(req.lng);
  if (!isFinite(lat) || !isFinite(lng) || req.lat === '' || req.lat == null) return { ok: true, providers: [], provider: 'none', poi: [] };
  const q = String(req.q || '').trim().slice(0, 40);
  const radius = q ? POI_SEARCH_RADIUS_M : Math.max(100, Math.min(1000, Number(req.radius) || POI_RADIUS_M));
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GOOGLE_PLACES_API_KEY');
  const ep = String(props.getProperty('OVERPASS_ENDPOINT') || '').trim();
  const providers = [];
  if (ep !== 'off' && req.osm !== false) providers.push(overpassProvider_(ep ? [ep] : OVERPASS_DEFAULTS)); // アプリが端末から OSM を引くときは osm:false で来る(Google だけ)
  if (key) providers.push(googleProvider_(key));
  if (!providers.length) return { ok: true, providers: [], provider: 'none', poi: [] };
  const names = providers.map(function (x) { return x.name; });
  const cache = CacheService.getScriptCache();
  const ck = [POI_CACHE_VER, names.join('+'), lat.toFixed(3), lng.toFixed(3), radius, q ? Utilities.base64EncodeWebSafe(q) : ''].join('_').slice(0, 240);
  const hit = cache.get(ck);
  if (hit && !req.nocache) { try { const j = JSON.parse(hit); j.cached = true; return j; } catch (e) {} }
  // 照会先は並べて同時に投げる(遅い方に引きずられない)。投げられなかったもの・断られたものは一つずつ控えに回す
  const reqs = providers.map(function (x) { return x.request(lat, lng, radius, q, 0); });
  let resps = [];
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { resps = []; }
  const errors = [];
  let all = [];
  providers.forEach(function (x, i) {
    for (let k = 0; k < x.tries; k++) {
      let res = k === 0 ? resps[i] : null;
      try { if (!res) res = UrlFetchApp.fetch(x.request(lat, lng, radius, q, k).url, x.request(lat, lng, radius, q, k)); }
      catch (e) { errors.push(x.label(k) + ' ' + String(e && e.message || e).slice(0, 80)); continue; }
      const code = res.getResponseCode();
      if (code >= 400) { errors.push(x.label(k) + ' ' + code); continue; }
      try { all = all.concat(x.parse(res.getContentText())); return; } catch (e) { errors.push(x.label(k) + ' parse'); }
    }
  });
  const poi = mergePoi_(all.filter(function (p) { return p && p.name && isFinite(p.lat) && isFinite(p.lng); }).map(function (p) {
    p.dist = Math.round(haversineM_(lat, lng, p.lat, p.lng));
    return p;
  }).filter(function (p) { return p.dist <= radius; }), q);
  const out = { ok: true, providers: names, provider: names[0], poi: poi };
  if (errors.length) out.error = errors.join(', ').slice(0, 400);
  if (poi.length || !errors.length) { try { cache.put(ck, JSON.stringify(out), POI_CACHE_SEC); } catch (e) {} } // 何も引けなかった失敗は覚えない
  return out;
}

// スクリプトエディタで実行して、近くの場所が引けるか確かめる(実行ログに結果が出る)。緯度経度は自宅あたり
function testPoi() {
  const r = nearbyPoi_({ lat: 34.7638, lng: 135.5135, radius: 300, nocache: true });
  Logger.log('照会先: ' + r.providers.join(', ') + ' / 候補 ' + r.poi.length + ' 件' + (r.error ? ' / うまくいかなかった照会: ' + r.error : ''));
  r.poi.slice(0, 10).forEach(function (p) { Logger.log(p.dist + 'm ' + p.name + ' (' + p.category + ', ' + p.id + ')'); });
  return r;
  return out;
}

// 名前の近さ(SpotMatch.gs と共用): 記号・空白・かっこの中を除いて、最長の共通部分 / 長い方の長さ(包含は1)
function spotNameScore_(a, b) {
  const clean = function (x) { return String(x || '').normalize('NFKC').toLowerCase().replace(/[(\[（【].*?[)\]）】]/g, '').replace(/[\s・\-‐ー―〜~'’".,、。!！?？&＆/／]/g, ''); };
  a = clean(a); b = clean(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
  if (short.length >= 3 && long.indexOf(short) >= 0) return Math.max(0.8, short.length / long.length);
  let best = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0;
    while (i + k < a.length && j + k < b.length && a.charAt(i + k) === b.charAt(j + k)) k++;
    if (k > best) best = k;
  }
  return best / long.length;
}
// 同じ店が OSM と Google の両方にあれば OSM を残す(座標を持ち続けてよい方)。名前で探すときは名前の近い順
function mergePoi_(list, q) {
  const rank = { osm: 0, google: 1 };
  list.sort(function (a, b) { return (rank[a.src] - rank[b.src]) || (a.dist - b.dist); });
  const out = [];
  list.forEach(function (p) {
    const dup = out.some(function (o) {
      return haversineM_(o.lat, o.lng, p.lat, p.lng) <= POI_DUP_M && spotNameScore_(o.name, p.name) >= 0.8;
    });
    if (!dup) out.push(p);
  });
  if (q) {
    out.forEach(function (p) { p.score = spotNameScore_(q, p.name); });
    out.sort(function (a, b) { return (b.score - a.score) || (a.dist - b.dist); });
    out.forEach(function (p) { delete p.score; });
  } else {
    out.sort(function (a, b) { return a.dist - b.dist; });
  }
  return out.slice(0, q ? 10 : 20);
}

// Overpass: 名前のある店・施設・観光・公園・史跡・駅。relation は重いので外す(元の縁泉の実測: 密集地で 504)
function overpassProvider_(endpoints) {
  return {
    name: 'osm',
    tries: endpoints.length,
    label: function (k) { return 'osm(' + String(endpoints[k]).replace(/^https?:\/\//, '').split('/')[0] + ')'; },
    request: function (lat, lng, radius, q, k) {
      const around = 'around:' + radius + ',' + lat + ',' + lng;
      let body;
      if (q) {
        const re = q.replace(/[\\"]/g, '').replace(/[.^$|?*+()\[\]{}]/g, '.'); // 正規表現の記号は「何か1文字」に
        body = 'nw(' + around + ')["name"~"' + re + '",i];nw(' + around + ')["name:ja"~"' + re + '",i];';
      } else {
        body = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'craft', 'office'].map(function (k) { return 'nw(' + around + ')[name][' + k + '];'; }).join('') +
          'nw(' + around + ')[name][railway=station];nw(' + around + ')[name][building=temple];nw(' + around + ')[name][building=shrine];';
      }
      return { url: endpoints[k || 0], method: 'post', payload: { data: '[out:json][timeout:20];(' + body + ');out center 60;' }, muteHttpExceptions: true };
    },
    parse: function (text) {
      const j = JSON.parse(text); // HTML の断り文などはここで投げて次の照会先へ
      if (!(j.elements || []).length && /error|timed out|rate_limited/i.test(String(j.remark || ''))) throw new Error('remark');
      return (j.elements || []).map(function (e) {
        const c = e.center || e, t = e.tags || {};
        const k = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'railway', 'craft', 'office', 'building'].filter(function (x) { return t[x]; })[0];
        return { id: 'osm:' + e.type + '/' + e.id, src: 'osm', name: t['name:ja'] || t.name, lat: Number(c.lat), lng: Number(c.lon), category: k ? k + '=' + t[k] : '' };
      });
    },
  };
}

// Google Places(New)。FieldMask は最小(料金はフィールドで決まる。displayName が入るので Pro 枠、月5,000回まで無料)
function googleProvider_(key) {
  return {
    name: 'google',
    tries: 1,
    label: function () { return 'google'; },
    request: function (lat, lng, radius, q) {
      const circle = { circle: { center: { latitude: lat, longitude: lng }, radius: radius } };
      const payload = q
        ? { textQuery: q, languageCode: 'ja', regionCode: 'JP', maxResultCount: 10, locationBias: circle }
        : { locationRestriction: circle, maxResultCount: 20, languageCode: 'ja', rankPreference: 'DISTANCE' };
      return {
        url: 'https://places.googleapis.com/v1/places:' + (q ? 'searchText' : 'searchNearby'),
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType' },
        payload: JSON.stringify(payload),
      };
    },
    parse: function (text) {
      return (JSON.parse(text).places || []).map(function (p) {
        return { id: 'google:' + p.id, src: 'google', name: p.displayName && p.displayName.text, lat: p.location && Number(p.location.latitude), lng: p.location && Number(p.location.longitude), category: p.primaryType ? 'google=' + p.primaryType : '' };
      });
    },
  };
}

// ========== 小さな道具 ==========
function db_() { return SpreadsheetApp.openById(prop_('ENSEN_SHEET_ID', ENSEN_SHEET_ID_DEFAULT)); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function isoNow_() { return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function isoString_(v) { return v instanceof Date ? Utilities.formatDate(v, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX") : String(v == null ? '' : v); }
function isoOr_(v, d) { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s : d; }
function numOrBlank_(v) { return v === '' || v == null || !isFinite(Number(v)) ? '' : Number(v); }
function parseJson_(v) { try { const o = JSON.parse(String(v || '{}')); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
// = + - @ で始まる文字が式にならないように ' を付ける(表では ' は見えない)
function safe_(s) { s = String(s); return /^[=+\-@]/.test(s) ? "'" + s : s; }
function unsafe_(v) { return typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v; }
function normalizeName_(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }
function nameSimilar_(a, b, partial) {
  if (!a || !b) return false;
  if (a === b) return true;
  return !!(partial && a.length >= 2 && b.length >= 2 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0));
}
function haversineM_(lat1, lng1, lat2, lng2) {
  const R = 6371000, t = function (d) { return d * Math.PI / 180; };
  const a = Math.pow(Math.sin(t(lat2 - lat1) / 2), 2) + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.pow(Math.sin(t(lng2 - lng1) / 2), 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
