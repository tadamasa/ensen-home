// 縁泉ハブ(いまの ensen スプレッドシート + Apps Script)との自動同期。
// 端末内の IndexedDB で圏外でも書け、開いたとき・戻ったとき・書いて4秒後に、変わった分だけをやり取りする。
// - 縁(events)と評価(appraisals)は追記専用。送ったらハブが actant_id と動詞を決めて返し、それが正になる
// - 試す(intents)の状態は、mtime の新しい方を残す
// - 台帳(actants)と痕跡(traces)は受け取るだけ
import * as db from './db.js';

const KINDS = ['events', 'intents', 'appraisals', 'actants', 'traces'];
const PUSH_KINDS = ['events', 'intents', 'appraisals'];
const PUSH_CHARS = 3000000; // 1回に送るおおよその大きさ(写真つきの縁があるため)
let dirty = {}; // 未送信: { "kind|id": mtime }
let cfg = { url: '', token: '' };
let timer = null;
let running = null;
let saveTimer = null;
let onRemoteChange = () => {};
const listeners = new Set();
export const status = { state: 'off', lastAt: null, error: '', pending: 0, rejected: [] };

function emit() {
  status.pending = Object.keys(dirty).length;
  listeners.forEach(fn => fn(status));
}
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function saveDirty() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.setMeta('syncDirty', dirty), 300);
}

function mark(name, changes) {
  for (const c of changes) dirty[`${name}|${c.id}`] = c.mtime || Date.now();
  saveDirty();
  emit();
  schedule();
}

export async function initSync(opts = {}) {
  if (opts.onRemoteChange) onRemoteChange = opts.onRemoteChange;
  const [url, token, saved, lastAt] = await Promise.all([db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('syncDirty'), db.getMeta('syncLastAt')]);
  cfg = { url: url || '', token: token || '' };
  if (saved) dirty = saved;
  status.state = cfg.url ? 'idle' : 'off';
  status.lastAt = lastAt;
  db.onChange(mark);
  emit();
}

export function enabled() { return !!(cfg.url && cfg.token); }
export function isPending(kind, id) { return dirty[`${kind}|${id}`] !== undefined; }

export function schedule(delay = 4000) {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

async function post(body) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    // text/plain にすると事前確認(CORS preflight)が要らず、Apps Scriptで受けられる
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: cfg.token, ...body }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`縁泉ハブ HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('縁泉ハブの応答を読めませんでした(URLが正しいか、デプロイのアクセスが「全員」か確かめてください)'); }
  if (!data.ok && data.error === 'unauthorized') throw new Error('合言葉が違います');
  return data;
}

// その日のまわり(日記・本・映画)や近くの場所など、同期以外の読み取り。圏外なら投げる
export async function ask(action, params = {}) {
  if (!enabled()) throw new Error('設定で縁泉ハブにつなぐと表示されます');
  if (navigator.onLine === false) throw new Error('オフラインです');
  const r = await post({ action, ...params });
  if (!r.ok) throw new Error(r.error || '縁泉ハブでエラー');
  return r;
}

// 送る本体。写真(photo)は送るときだけ入れ、端末の表示用の小さな写真(photoThumb)や状態は送らない
function wire(kind, rec) {
  const { mtime, pending, error, photoThumb, ...data } = rec;
  return data;
}

// 受け取ったものを手元に書く
export async function apply(items) {
  let changed = 0;
  for (const it of items) {
    if (!KINDS.includes(it.kind)) continue;
    const key = `${it.kind}|${it.id}`;
    const local = await db.get(it.kind, it.id);
    if (it.kind === 'intents' && dirty[key] !== undefined && dirty[key] > it.mtime) continue; // 手元の未送信が新しい
    if (it.kind === 'intents' && local && (local.mtime || 0) > it.mtime) continue;
    if (it.deleted) { if (local) { await db.del(it.kind, it.id, { silent: true }); changed++; } continue; }
    if (!it.data) continue;
    const rec = { ...it.data, id: it.id, mtime: it.mtime };
    if (local && local.photoThumb) rec.photoThumb = local.photoThumb;
    if (it.kind === 'events' || it.kind === 'appraisals') delete dirty[key]; // ハブに届いた
    await db.put(it.kind, rec, { silent: true });
    changed++;
  }
  return changed;
}

export function syncNow() {
  if (!enabled()) return Promise.resolve(0);
  if (running) return running;
  running = (async () => {
    status.state = 'syncing'; status.error = ''; emit();
    let changed = 0;
    try {
      let cursor = Number(await db.getMeta('syncCursor', 0)) || 0;
      for (let guard = 0; guard < 200; guard++) {
        const push = {};
        const sent = [];
        let chars = 0;
        for (const [key, mtime] of Object.entries(dirty)) {
          if (chars > PUSH_CHARS) break;
          const [kind, id] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
          if (!PUSH_KINDS.includes(kind)) { delete dirty[key]; continue; }
          const rec = await db.get(kind, id);
          if (!rec) { delete dirty[key]; continue; }
          const data = wire(kind, rec);
          chars += JSON.stringify(data).length;
          (push[kind] = push[kind] || []).push({ id, mtime: rec.mtime || mtime, data });
          sent.push([key, mtime]);
        }
        const res = await post({ since: cursor, push });
        if (!res.ok) throw new Error(`縁泉ハブ: ${res.error}`);
        // 送っている間に書き直されたものは、次の回に送る
        for (const [key, mtime] of sent) if (dirty[key] !== undefined && dirty[key] <= mtime) delete dirty[key];
        // 語彙の外などで断られたものは、もう送らずに印をつける
        for (const r of res.rejected || []) {
          delete dirty[`${r.kind}|${r.id}`];
          const rec = await db.get(r.kind, r.id);
          if (rec) { rec.error = r.error; await db.put(r.kind, rec, { silent: true }); changed++; }
        }
        status.rejected = res.rejected || [];
        changed += await apply(res.items || []);
        cursor = res.rev;
        await db.setMeta('syncCursor', cursor);
        saveDirty();
        if (!res.more && !Object.keys(dirty).length) break;
      }
      status.lastAt = new Date().toISOString();
      await db.setMeta('syncLastAt', status.lastAt);
      status.state = 'idle';
    } catch (e) {
      status.state = 'error';
      status.error = navigator.onLine === false ? 'オフラインです' : e.message;
    } finally {
      running = null;
      emit();
    }
    if (changed) await onRemoteChange(changed);
    return changed;
  })();
  return running;
}

// 接続: ハブから全部を受け取り直す。手元で書いた分(まだ表にないもの)も送る
export async function connect(url, token) {
  cfg = { url: url.trim(), token: token.trim() };
  await db.setMeta('syncUrl', cfg.url);
  await db.setMeta('syncToken', cfg.token);
  await db.setMeta('syncCursor', 0);
  for (const kind of PUSH_KINDS) for (const r of await db.getAll(kind)) if (r.pending) dirty[`${kind}|${r.id}`] = r.mtime || 1;
  await db.setMeta('syncDirty', dirty);
  status.state = 'idle';
  emit();
  return syncNow();
}

export async function disconnect() {
  cfg = { url: '', token: '' };
  clearTimeout(timer);
  await Promise.all(['syncUrl', 'syncToken', 'syncCursor', 'syncLastAt'].map(k => db.setMeta(k, null)));
  status.state = 'off'; status.lastAt = null; status.error = '';
  emit();
}
