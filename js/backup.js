// バックアップ: 手元のデータをJSONにして、iPhoneの共有シート(「ファイル」に保存→iCloud Drive等)へ渡す。
// 痕跡の写真サムネは大きいので入れない(縁泉シートの traces に残っている)。
import * as db from './db.js';

const STORES = ['events', 'intents', 'appraisals', 'actants', 'place_names'];
// キーと、端末ごとの同期の状態は書き出さない
const SECRET_KEYS = new Set(['geminiKey', 'syncUrl', 'syncToken', 'syncCursor', 'syncDirty', 'syncLastAt']);

export async function exportData() {
  const payload = { app: 'ensen-home', version: 1, exportedAt: new Date().toISOString() };
  for (const s of STORES) payload[s] = (await db.getAll(s)).map(({ photo, ...r }) => r);
  payload.meta = (await db.getAll('meta')).filter(m => !SECRET_KEYS.has(m.key));
  const name = `ensen-home-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e.name === 'AbortError') return false;
      throw e;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  await db.setMeta('lastBackupAt', new Date().toISOString());
  return true;
}

// 取り込み: id が同じものは mtime が新しい方を残す。まだハブに届いていない縁は、取り込むと送られる
export async function importData(text) {
  const data = JSON.parse(text);
  if (data.app !== 'ensen-home') throw new Error('このアプリのバックアップファイルではありません');
  let n = 0;
  for (const s of STORES) {
    const cur = new Map((await db.getAll(s)).map(x => [x.id, x]));
    const put = (data[s] || []).filter(x => { const c = cur.get(x.id); return !c || (x.mtime || 0) > (c.mtime || 0); });
    const pending = put.filter(x => x.pending);
    await db.putMany(s, put.filter(x => !x.pending), { silent: true });
    if (pending.length) await db.putMany(s, pending); // 未送信だったものは送り直す
    n += put.length;
  }
  return n;
}
