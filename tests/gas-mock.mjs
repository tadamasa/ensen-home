// Apps Script の最小限の模擬。hub/Code.gs を Node で動かして確かめるためのもの。
// 縁泉スプレッドシート(events / intents / appraisals / actants / traces)を作り、縁泉GASの書き方もまねる。
import fs from 'fs';
import vm from 'vm';

const HEADERS = {
  events: ['event_id', 'ts', 'recorded_ts', 'lat', 'lng', 'place_name', 'actant_type', 'actant_name', 'actant_id', 'verb', 'note', 'media_ref', 'star', 'source', 'tags', 'enrich'],
  intents: ['intent_id', 'ts', 'what', 'actant_type', 'origin', 'origin_name', 'status', 'fulfilled_event_id', 'enrich'],
  appraisals: ['appraisal_id', 'ts', 'target_event_id', 'weight', 'note'],
  telemetry: ['date', 'steps', 'sleep_min', 'hrv', 'resting_hr', 'active_kcal'],
  actants: ['actant_id', 'type', 'canonical_name', 'aliases', 'keys', 'first_seen', 'last_seen', 'count'],
  ingest_log: ['ts', 'source', 'kind', 'count', 'error'],
  traces: ['trace_id', 'ts', 'recorded_ts', 'lat', 'lng', 'place_name', 'photo_key', 'source', 'thumb_b64'],
};

export function makeBook() {
  const sheets = new Map();
  const ss = {
    sheets,
    log: [], // 書き込みの記録(追記専用の確認用)
    getSheetByName: n => (sheets.get(n) || {}).api || null,
    insertSheet: name => {
      const sh = { name, rows: [], maxRows: 1000 };
      const strip = x => (typeof x === 'string' && x.startsWith("'") ? x.slice(1) : x);
      const range = (r, c, nr = 1, nc = 1) => {
        if (r + nr - 1 > Math.max(sh.maxRows, sh.rows.length)) throw new Error(`範囲外 ${r + nr - 1} > ${sh.maxRows}`);
        const api = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((sh.rows[r - 1 + i] || [])[c - 1 + j] ?? ''))),
          getValue: () => api.getValues()[0][0],
          setValues: v => { ss.log.push({ sheet: name, op: 'set', row: r, col: c, rows: v.length, cols: v[0].length }); v.forEach((row, i) => { sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || []; row.forEach((x, j) => { sh.rows[r - 1 + i][c - 1 + j] = strip(x); }); }); return api; },
          setValue: x => api.setValues([[x]]),
          setNumberFormat: () => api,
          setFontWeight: () => api,
        };
        return api;
      };
      const lastRow = () => { let n = sh.rows.length; while (n > 0 && !(sh.rows[n - 1] || []).some(x => x !== '' && x != null)) n--; return n; };
      sh.api = {
        getRange: range,
        getLastRow: lastRow,
        getMaxRows: () => sh.maxRows,
        insertRowsAfter: (_, n) => { sh.maxRows += n; },
        setFrozenRows() {},
        appendRow: row => { ss.log.push({ sheet: name, op: 'append' }); const at = lastRow(); if (at + 1 > sh.maxRows) sh.maxRows = at + 1; sh.rows[at] = row.map(strip); },
        getDataRange: () => range(1, 1, Math.max(lastRow(), 1), 16),
      };
      sheets.set(name, sh);
      return sh.api;
    },
  };
  return ss;
}

const pad = n => String(n).padStart(2, '0');
function formatDate(d, _tz, f) {
  // テストは TZ=Asia/Tokyo で動かす想定。XXX は +09:00 固定
  return f.replace(/'T'/g, 'T').replace('yyyy', d.getFullYear()).replace('MM', pad(d.getMonth() + 1)).replace('dd', pad(d.getDate()))
    .replace('HH', pad(d.getHours())).replace('mm', pad(d.getMinutes())).replace('ss', pad(d.getSeconds())).replace('XXX', '+09:00');
}

export function loadHub() {
  const ensen = makeBook();
  for (const [n, h] of Object.entries(HEADERS)) ensen.insertSheet(n).appendRow(h);
  ensen.log.length = 0;
  const props = {};
  let uuid = 0;
  const books = { '1vKPwd3kM4RdD19PEWaCG1R6OuVJGxSjj2njlan6UBFA': ensen };
  const addBook = (id, sheets) => {
    const b = makeBook();
    for (const [name, rows] of Object.entries(sheets)) { const sh = b.insertSheet(name); rows.forEach(r => sh.appendRow(r)); }
    books[id] = b;
    return b;
  };
  const drive = { files: [] };
  const folder = { getId: () => 'folder1', createFile: blob => { drive.files.push(blob); return { getUrl: () => `https://drive.google.com/file/d/f${drive.files.length}/view` }; } };
  const cache = {};
  const ctx = {
    SpreadsheetApp: { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    DriveApp: { getFolderById: () => folder, getFoldersByName: () => ({ hasNext: () => true, next: () => folder }), createFolder: () => folder },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ places: [{ displayName: { text: '近くの喫茶' }, location: { latitude: 35, longitude: 139 } }] }) }) },
    Utilities: {
      getUuid: () => `0000${(++uuid).toString(16).padStart(4, '0')}-1111-2222-3333-444455556666`,
      formatDate,
      base64Decode: s => Buffer.from(s, 'base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
    Logger: { log() {} },
    Date, Math, JSON, String, Number, Array, Object, isFinite, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../hub/Code.gs', import.meta.url), 'utf8'), ctx);
  ctx.setup();
  const sheet = n => ensen.getSheetByName(n);
  // 縁泉GASの書き方(appendRow)をまねる
  const gas = {
    event: (row = {}) => {
      const id = row.id || `ev-${++uuid}`;
      sheet('events').appendRow([id, row.ts || '2026-10-01T10:00:00+09:00', row.ts || '2026-10-01T10:00:00+09:00', row.lat ?? '', row.lng ?? '', row.place || '', row.type || '人', row.name || '友人', row.aid || '', row.verb || '出会う', row.note || '', '', 0, row.source || 'app', row.tags || '', row.enrich || '']);
      return id;
    },
    actant: (row = {}) => {
      const id = row.id || `ac-${++uuid}`;
      sheet('actants').appendRow([id, row.type || '人', row.name || '友人', row.aliases || '', row.keys || '{}', row.first || '2026-01-01T00:00:00+09:00', row.last || '2026-01-01T00:00:00+09:00', row.count || 1]);
      return id;
    },
    trace: (row = {}) => {
      const id = row.id || `tr-${++uuid}`;
      sheet('traces').appendRow([id, row.ts || '2026-10-30T12:00:00+09:00', '2026-10-30T23:00:00+09:00', row.lat ?? '', row.lng ?? '', row.place || '', row.key || id, 'shortcut-photo', row.thumb ?? 'A'.repeat(200)]);
      return id;
    },
    intent: (row = {}) => {
      const id = row.id || `in-${++uuid}`;
      sheet('intents').appendRow([id, '2026-09-01T09:00:00+09:00', row.what || '読みたい本', row.type || '作品', row.origin || '本', '', row.status || 'open', '', '']);
      return id;
    },
  };
  return {
    token: props.TOKEN,
    props,
    ensen,
    drive,
    addBook,
    rows: n => ensen.sheets.get(n).rows,
    gas,
    post: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text),
  };
}
