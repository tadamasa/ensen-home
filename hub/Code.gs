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
};
const PLACE_NAMES_HEADERS = ['fix_id', 'ts', 'trace_id', 'lat', 'lng', 'name', 'source'];
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
      bumpIfChanged_(st, kind, id, hashRow_(kind, r));
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
  const reg = upsertActant_(st, p.type, name, lat, lng, ts);
  const verb = p.verb || (reg.existed ? '再会' : defaultNewVerb_(p.type));
  let media = String(p.media || '');
  if (p.photo) media = storeMedia_(p.photo, ts);
  const enrich = p.trace_id ? JSON.stringify({ trace_id: String(p.trace_id) }) : '';
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
function upsertActant_(st, type, name, lat, lng, ts) {
  const sh = st.sheets.actants;
  const rows = st.rows.actants;
  const norm = normalizeName_(name);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[1] !== type) continue;
    const names = [String(r[2])].concat(String(r[3] || '').split(',')).filter(String);
    if (!names.some(function (nm) { return nameSimilar_(norm, normalizeName_(nm), type === '場所'); })) continue;
    if (type === '場所' && lat !== '' && lng !== '') {
      const k = parseJson_(r[4]);
      if (k.lat != null && k.lng != null && haversineM_(lat, lng, Number(k.lat), Number(k.lng)) > PLACE_MATCH_RADIUS_M) continue;
    }
    const count = (Number(r[7]) || 0) + 1;
    const lastSeen = isoString_(r[6]) > ts ? r[6] : ts; // 過去の日時で書いたときは last_seen を戻さない
    sh.getRange(i + 2, 7, 1, 2).setValues([[lastSeen, count]]);
    r[6] = lastSeen; r[7] = count;
    bumpIfChanged_(st, 'actants', String(r[0]), hashRow_('actants', r));
    return { actant_id: String(r[0]), existed: true };
  }
  const id = Utilities.getUuid();
  const keys = (type === '場所' && lat !== '' && lng !== '') ? JSON.stringify({ lat: lat, lng: lng }) : '{}';
  const row = [id, type, safe_(name), '', keys, ts, ts, 1];
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
  if (kind === 'intents') return { id: s(r[0]), ts: isoString_(r[1]), what: s(r[2]), type: s(r[3]), origin: s(r[4]), origin_name: s(r[5]), status: s(r[6]) || 'open', fulfilled_event_id: s(r[7]), isbn: (parseJson_(r[8]).keys || {}).isbn || '' };
  if (kind === 'appraisals') return { id: s(r[0]), ts: isoString_(r[1]), target: s(r[2]), weight: Number(r[3]) || 0, note: s(r[4]) };
  if (kind === 'actants') {
    const k = parseJson_(r[4]);
    return { id: s(r[0]), type: s(r[1]), name: s(r[2]), aliases: s(r[3]), lat: k.lat != null ? Number(k.lat) : null, lng: k.lng != null ? Number(k.lng) : null, first_seen: isoString_(r[5]), last_seen: isoString_(r[6]), count: Number(r[7]) || 0 };
  }
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

// FNV-1a(32bit)。「変わったか」を見るだけなので軽いもので足りる
function hashRow_(kind, r) {
  const parts = [];
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

// ========== その日のまわり(読み取りのみ): 日記・読み終えた本・観た映画 ==========
const DIARY_SHEET_ID_DEFAULT = '1yVC3q2dm4-LxrAg_lRDk8G3qqU-WNQnI5LznFPgxKp8';
const DIARY_APP_URL_DEFAULT = 'https://tadamasa.github.io/diary-home/';
const BOOKS_SHEET_ID_DEFAULT = '1WEsS95CKH7JPFuGf7BYzlTV-d6FyTVg0OCOymKHqsZg';
const READING_APP_URL_DEFAULT = 'https://tadamasa.github.io/reading-memo/';
const MOVIES_SHEET_ID_DEFAULT = '156oktIUuxKOcFZn0QYrx6ncY3AFiY-7DjgAIYbiRCm4';
const MOVIE_APP_URL_DEFAULT = 'https://tadamasa.github.io/movie-memo/';

function getDay_(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false, error: 'bad date' };
  return { ok: true, date: dateStr, diary: diaryFor_(dateStr), books: booksFor_(dateStr), films: filmsFor_(dateStr) };
}

function prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d; }
function toDateStr_(v) { return v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd') : String(v || '').trim().substring(0, 10); }

// 「日記の記録」CoreData: Date, Time, Text, Feelings, Thinkings
function diaryFor_(dateStr) {
  try {
    const sh = SpreadsheetApp.openById(prop_('DIARY_SHEET_ID', DIARY_SHEET_ID_DEFAULT)).getSheetByName('CoreData');
    const last = sh.getLastRow();
    const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, 5).getValues();
    const out = [];
    rows.forEach(function (r) {
      if (toDateStr_(r[0]) !== dateStr || !String(r[2] || '').trim()) return;
      const t = r[1] instanceof Date ? Utilities.formatDate(r[1], TIMEZONE, 'HH:mm') : String(r[1] || '').trim().slice(0, 5);
      out.push({ time: t, text: String(r[2]), feelings: String(r[3] || '') });
    });
    out.sort(function (a, b) { return a.time < b.time ? -1 : 1; });
    return { ok: true, url: prop_('DIARY_APP_URL', DIARY_APP_URL_DEFAULT) + '#day/' + dateStr, entries: out };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// 読書ハブ books: id, rev, mtime, deleted, title, author, status, category, score, finishedAt, json
function booksFor_(dateStr) {
  try {
    const sh = SpreadsheetApp.openById(prop_('BOOKS_SHEET_ID', BOOKS_SHEET_ID_DEFAULT)).getSheetByName('books');
    const last = sh.getLastRow();
    const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, 11).getValues();
    const app = prop_('READING_APP_URL', READING_APP_URL_DEFAULT);
    const out = [];
    rows.forEach(function (r) {
      if (String(r[3]).toLowerCase() === 'true' || String(r[6]) !== '読了' || toDateStr_(r[9]) !== dateStr) return;
      out.push({ title: String(r[4] || ''), author: String(r[5] || ''), cover: parseJson_(r[10]).cover || '', url: app + '#book/' + encodeURIComponent(String(r[0])) });
    });
    return { ok: true, books: out };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// 映画ハブ views: id, rev, mtime, deleted, date, filmId, filmTitle, place, venue, score, text, json
function filmsFor_(dateStr) {
  try {
    const ss = SpreadsheetApp.openById(prop_('MOVIES_SHEET_ID', MOVIES_SHEET_ID_DEFAULT));
    const vs = ss.getSheetByName('views');
    const last = vs.getLastRow();
    const rows = last < 2 ? [] : vs.getRange(2, 1, last - 1, 11).getValues();
    const app = prop_('MOVIE_APP_URL', MOVIE_APP_URL_DEFAULT);
    const out = [];
    rows.forEach(function (r) {
      if (String(r[3]).toLowerCase() === 'true' || toDateStr_(r[4]) !== dateStr) return;
      out.push({ title: String(r[6] || ''), venue: String(r[8] || ''), url: app + '#film/' + encodeURIComponent(String(r[5])) });
    });
    return { ok: true, films: out };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ========== 近くの場所の候補(任意。GOOGLE_PLACES_API_KEY があるときだけ) ==========
function nearbyPoi_(req) {
  const lat = Number(req.lat), lng = Number(req.lng);
  const key = PropertiesService.getScriptProperties().getProperty('GOOGLE_PLACES_API_KEY');
  if (!key || !isFinite(lat) || !isFinite(lng)) return { ok: true, provider: 'none', poi: [] };
  const cache = CacheService.getScriptCache();
  const ck = 'poi_' + lat.toFixed(3) + '_' + lng.toFixed(3);
  const hit = cache.get(ck);
  if (hit) return { ok: true, provider: 'google', poi: JSON.parse(hit), cached: true };
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName,places.location' },
    payload: JSON.stringify({ locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 300 } }, maxResultCount: 10, languageCode: 'ja' }),
  });
  if (res.getResponseCode() >= 400) return { ok: true, provider: 'google', poi: [], error: 'places ' + res.getResponseCode() };
  const poi = (JSON.parse(res.getContentText()).places || []).map(function (p) {
    return { name: p.displayName && p.displayName.text, lat: p.location && p.location.latitude, lng: p.location && p.location.longitude };
  }).filter(function (p) { return p.name; });
  try { cache.put(ck, JSON.stringify(poi), 1800); } catch (e) {}
  return { ok: true, provider: 'google', poi: poi };
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
