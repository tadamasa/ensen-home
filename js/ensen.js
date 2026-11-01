// 縁泉の語彙と、画面に依らない計算。DOMに触れないので node --test で試せる。
// 規約: 語彙は凍結。スコア・連続・達成率は作らない(形と事実だけを見せる)。

export const TYPES = ['人', '場所', '作品', 'モノ', '食'];
export const VERBS = ['出会う', '再会', '受け取る', '贈る', '交わす', '発見する', '手放す'];
export const ORIGINS = ['人', '本', '場所', 'メディア', '偶然'];
export const TYPE_KEY = { '人': 'person', '場所': 'place', '作品': 'work', 'モノ': 'thing', '食': 'food' };
export const TYPE_ICON = { '人': 'i-person', '場所': 'i-place', '作品': 'i-work', 'モノ': 'i-thing', '食': 'i-food' };
export const VERB_ICON = { '出会う': 'v-au', '再会': 'v-saikai', '受け取る': 'v-uketoru', '贈る': 'v-okuru', '交わす': 'v-kawasu', '発見する': 'v-hakken', '手放す': 'v-tebanasu' };
export const VERB_ORDER = {
  '人': { main: ['出会う', '再会', '交わす', '受け取る', '贈る', '手放す', '発見する'], rest: [] },
  '作品': { main: ['出会う', '再会', '手放す'], rest: ['受け取る', '贈る', '交わす', '発見する'] },
  'モノ': { main: ['受け取る', '贈る', '手放す'], rest: ['出会う', '再会', '交わす', '発見する'] },
  '場所': { main: ['発見する', '再会'], rest: ['出会う', '受け取る', '贈る', '交わす', '手放す'] },
  '食': { main: ['受け取る', '交わす'], rest: ['出会う', '再会', '贈る', '発見する', '手放す'] },
};
export const VERB_TIPS = {
  '出会う': '初めての人・初めて触れた作品',
  '再会': '久しぶりの人・再訪・再読',
  '受け取る': '買った・もらった・届いた',
  '贈る': 'あげた・おごった・寄付した',
  '交わす': '話した・会食した・議論した',
  '発見する': '初めての場所・新しい気づき',
  '手放す': '捨てた・解約した・読むのをやめた',
};
export const PLACE_RADIUS_M = 150;
export const NEAR_RADIUS_M = 300;

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
}

// ---------- 日付(端末の時刻。縁泉と同じ "YYYY-MM-DDTHH:mm:ss+09:00" の形) ----------
const p2 = n => String(n).padStart(2, '0');
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}
export const today = () => isoLocal().slice(0, 10);
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export const dayOf = ts => String(ts || '').slice(0, 10);
export const timeOf = ts => String(ts || '').slice(11, 16);
// <input type="datetime-local"> の値 ⇔ ISO
export const toInputValue = ts => String(ts || '').slice(0, 16);
export function fromInputValue(v) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return isoLocal();
  const [d, t] = v.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return isoLocal(new Date(y, m - 1, dd, hh, mm, 0));
}
export function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const x = new Date(y, m - 1, d + days);
  return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`;
}
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const x = new Date(y, m - 1 + n, 1);
  return `${x.getFullYear()}-${p2(x.getMonth() + 1)}`;
}
// 月のカレンダー(日曜はじまり)。空きは null
export function monthCells(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const cells = Array(first).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${p2(d)}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}年${m}月${d}日(${WD[new Date(y, m - 1, d).getDay()]})`;
}
export function gapLabel(fromTs, toTs) {
  const days = Math.round((new Date(dayOf(toTs)) - new Date(dayOf(fromTs))) / 864e5);
  if (days <= 0) return 'その日のうちに';
  if (days < 31) return `${days}日ぶり`;
  if (days < 365) return `${Math.round(days / 30.4)}か月ぶり`;
  const y = Math.floor(days / 365.25);
  return `${y}年ぶり`;
}

// 暦と時刻だけで移ろう景色(記録の量や中身では変わらない)。縁泉の ensenAutoTheme と同じ
export function autoSeason(d = new Date()) {
  const m = d.getMonth() + 1, h = d.getHours();
  if (h >= 18 || h < 6) return 'winter';
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

// ---------- 名寄せ(縁泉の照合規則と同じ) ----------
export const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
export function nameSimilar(a, b, partial) {
  if (!a || !b) return false;
  if (a === b) return true;
  return !!(partial && a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)));
}
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, t = x => x * Math.PI / 180;
  const s1 = Math.sin(t(lat2 - lat1) / 2), s2 = Math.sin(t(lng2 - lng1) / 2);
  const q = s1 * s1 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * s2 * s2;
  return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}
const hasPos = (o) => o && o.lat != null && o.lng != null && o.lat !== '' && o.lng !== '';

export function findActant(actants, type, name, lat, lng) {
  const n = norm(name);
  if (!type || !n) return null;
  for (const a of actants) {
    if (a.type !== type) continue;
    const names = [a.name, ...String(a.aliases || '').split(',')].filter(Boolean);
    if (!names.some(nm => nameSimilar(n, norm(nm), type === '場所'))) continue;
    if (type === '場所' && lat != null && hasPos(a) && haversine(lat, lng, a.lat, a.lng) > PLACE_RADIUS_M) continue;
    return a;
  }
  return null;
}
export const defaultVerb = type => (VERB_ORDER[type] ? VERB_ORDER[type].main[0] : null);
export function suggestVerb(type, matched) { return matched ? '再会' : defaultVerb(type); }

// 近くの台帳の場所(300m)。近い順
export function nearbyPlaces(actants, lat, lng, radius = NEAR_RADIUS_M) {
  if (lat == null || lng == null) return [];
  return actants.filter(a => a.type === '場所' && hasPos(a))
    .map(a => ({ a, d: haversine(lat, lng, a.lat, a.lng) }))
    .filter(x => x.d <= radius).sort((x, y) => x.d - y.d).map(x => ({ ...x.a, dist: Math.round(x.d) }));
}
// 名前の候補: その種別の最近と、何度も結んだもの(重ならないように)
export function nameChips(actants, type, max = 5) {
  const mine = actants.filter(a => a.type === type);
  const recent = [...mine].sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen))).slice(0, max);
  const seen = new Set(recent.map(a => a.id));
  const often = mine.filter(a => a.count >= 2 && !seen.has(a.id)).sort((a, b) => b.count - a.count).slice(0, max);
  return { recent, often };
}

// iOSの自宅オートメーションの到着・出発(縁ではなく暮らしの拍として小さく出す)
export const isHomeMove = e => String(e.tags || '').includes('自宅');
export const homeKind = e => (String(e.tags || '').includes('出発') ? '出発' : '到着');

/**
 * 谺(こだま): ある縁の、ひとつ前の接触を1件だけ。
 * (a) 同じ actant の直前の縁 → (b) 同じ種別で500m以内の直前の縁 → (c) なし(沈黙も応答)
 */
export function echoOf(events, e) {
  const before = events.filter(x => x.id !== e.id && String(x.ts) < String(e.ts) && !isHomeMove(x));
  let best = null;
  if (e.aid) for (const x of before) if (x.aid === e.aid && (!best || x.ts > best.ts)) best = x;
  if (best) return { e: best, same: true };
  if (hasPos(e)) for (const x of before) {
    if (x.type !== e.type || !hasPos(x)) continue;
    if (haversine(e.lat, e.lng, x.lat, x.lng) <= 500 && (!best || x.ts > best.ts)) best = x;
  }
  return best ? { e: best, same: false } : null;
}

// ---------- 眺める ----------
// 初出の川: actant が最初に現れた日と、そのときの一言
export function frontier(actants, events, order = 'new') {
  const firstNote = {};
  for (const e of events) {
    if (!e.aid) continue;
    const c = firstNote[e.aid];
    if (!c || e.ts < c.ts) firstNote[e.aid] = { ts: e.ts, note: e.note || '' };
  }
  const items = actants.filter(a => a.name && a.first_seen).map(a => ({ id: a.id, type: a.type, name: a.name, first: dayOf(a.first_seen), note: (firstNote[a.id] || {}).note || '' }));
  items.sort((a, b) => (order === 'old' ? a.first.localeCompare(b.first) : b.first.localeCompare(a.first)));
  return items;
}

// 再会の川: 2回以上結んだ actant の接触の並び。いちばん長く離れていた間隔の長い順
export function reunions(events) {
  const by = {};
  for (const e of events) {
    if (!e.aid || isHomeMove(e)) continue;
    const a = by[e.aid] = by[e.aid] || { aid: e.aid, name: e.name, type: e.type, days: [] };
    a.days.push(dayOf(e.ts));
  }
  return Object.values(by).map(a => {
    a.days.sort();
    let gap = 0;
    for (let i = 1; i < a.days.length; i++) gap = Math.max(gap, (new Date(a.days[i]) - new Date(a.days[i - 1])) / 864e5);
    return { ...a, first: a.days[0], last: a.days[a.days.length - 1], gap: Math.round(gap) };
  }).filter(a => a.days.length >= 2).sort((x, y) => y.gap - x.gap);
}

/**
 * 評価の間: 新奇性に寄せた抽選(一様ではない)。基礎1、未評価・一言なし・初出のまま再訪なし で各+2。
 * 「見逃していたもの」を優先して掘り起こす。重み付きの非復元抽出。
 */
export function apprQueue(events, appraisals, n = 12, rand = Math.random) {
  const evaluated = new Set(appraisals.map(a => a.target));
  const count = {};
  for (const e of events) if (e.aid) count[e.aid] = (count[e.aid] || 0) + 1;
  const pool = events.filter(e => e.name && !isHomeMove(e)).map(e => ({
    e, w: 1 + (evaluated.has(e.id) ? 0 : 2) + (e.note ? 0 : 2) + (e.aid && count[e.aid] === 1 ? 2 : 0),
  }));
  const out = [];
  let total = pool.reduce((s, x) => s + x.w, 0);
  while (out.length < n && pool.length) {
    let r = rand() * total, i = 0;
    for (; i < pool.length - 1; i++) { r -= pool[i].w; if (r <= 0) break; }
    const [c] = pool.splice(i, 1);
    total -= c.w;
    out.push({ ...c.e, evaluated: evaluated.has(c.e.id) });
  }
  return out;
}
// その縁への最新の重み(過去の評価は消さないので、いちばん新しいもの)
export function latestWeight(appraisals, eventId) {
  let best = null;
  for (const a of appraisals) if (a.target === eventId && (!best || a.ts > best.ts)) best = a;
  return best ? best.weight : null;
}

// 地図: 位置のある縁を actant ごとにまとめ、最新の1点に寄せる。接触の履歴を添える
export function mapPoints(events, { from = '', to = '9999', types = TYPES } = {}) {
  const groups = {};
  for (const e of events) {
    if (!hasPos(e) || isHomeMove(e) || !types.includes(e.type)) continue;
    const d = dayOf(e.ts);
    if (d < from || d > to) continue;
    const k = e.aid || `@${e.lat},${e.lng}`;
    const g = groups[k] = groups[k] || { key: k, visits: [] };
    g.visits.push(e);
  }
  return Object.values(groups).map(g => {
    g.visits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const top = g.visits[0];
    return { key: g.key, lat: top.lat, lng: top.lng, type: top.type, name: top.name || top.place, visits: g.visits };
  });
}

// ---------- 遠い対(Gemini) ----------
// 送るのは、ランダムに選んだ20件の「名前・種別・一言」だけ(日時・場所・座標は送らない)
export function distantCandidates(events, rand = Math.random, n = 20) {
  const pool = events.filter(e => e.name && !isHomeMove(e));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}
export function distantPrompt(cands) {
  const list = cands.map((e, i) => ({ i, title: e.name, type: e.type, note: String(e.note || '').slice(0, 80) }));
  return '次の候補リストから、意味的に最も遠い2件を選び、その2件のあいだに張れる問いを日本語で1つ作ってください。' +
    '問いは答えを決めつけず、短く。JSONだけを返してください: {"a":番号,"b":番号,"question":"問い"}\n\n' + JSON.stringify(list);
}
export function parseDistant(text, cands) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[0]);
    const a = cands[r.a], b = cands[r.b];
    if (!a || !b || a === b) return null;
    return { a, b, question: String(r.question || '') };
  } catch { return null; }
}

// ---------- 写真 ----------
// JPEG の EXIF から撮影日時と位置を読む(なければ null)。縁泉の parseExif と同じ考え方
export function parseExif(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
  let off = 2;
  while (off + 4 < dv.byteLength) {
    const marker = dv.getUint16(off);
    const len = dv.getUint16(off + 2);
    if (marker === 0xFFE1 && dv.getUint32(off + 4) === 0x45786966) return parseTiff(dv, off + 10);
    if ((marker & 0xFF00) !== 0xFF00) break;
    off += 2 + len;
  }
  return null;
}
function parseTiff(dv, tiff) {
  const le = dv.getUint16(tiff) === 0x4949;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const out = {};
  const readIfd = ifdOff => {
    const map = {};
    const start = tiff + ifdOff;
    if (start + 2 > dv.byteLength) return map;
    const n = u16(start);
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      map[u16(e)] = { type: u16(e + 2), count: u32(e + 4), off: e + 8 };
    }
    return map;
  };
  const ascii = en => { const o = en.count > 4 ? tiff + u32(en.off) : en.off; let s = ''; for (let i = 0; i < en.count - 1; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
  const rationals = (en, cnt) => { const o = tiff + u32(en.off); const r = []; for (let i = 0; i < cnt; i++) r.push(u32(o + i * 8) / (u32(o + i * 8 + 4) || 1)); return r; };
  const ifd0 = readIfd(u32(tiff + 4));
  if (ifd0[0x8769]) {
    const ex = readIfd(u32(ifd0[0x8769].off));
    const dt = ex[0x9003] || ex[0x9004];
    if (dt) {
      const m = ascii(dt).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (m) out.date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
  }
  if (ifd0[0x8825]) {
    const g = readIfd(u32(ifd0[0x8825].off));
    if (g[2] && g[4]) {
      const la = rationals(g[2], 3), lo = rationals(g[4], 3);
      let lat = la[0] + la[1] / 60 + la[2] / 3600, lng = lo[0] + lo[1] / 60 + lo[2] / 3600;
      if (g[1] && String.fromCharCode(dv.getUint8(g[1].off)) === 'S') lat = -lat;
      if (g[3] && String.fromCharCode(dv.getUint8(g[3].off)) === 'W') lng = -lng;
      if (isFinite(lat) && isFinite(lng) && (lat || lng)) { out.lat = lat; out.lng = lng; }
    }
  }
  return out;
}

// ---------- 一年をめぐる ----------
// 点数は出さない。その年と前の年を、層・土地・弧の「形」で並べ、語りにする。
export const SEASONS = ['春', '夏', '秋', '冬'];
export const seasonOf = d => { const m = Number(String(d).slice(5, 7)); return m >= 3 && m <= 5 ? '春' : m >= 6 && m <= 8 ? '夏' : m >= 9 && m <= 11 ? '秋' : '冬'; };
// 約1km四方の区画(標準地域メッシュ3次と同じ刻み: 緯度30秒・経度45秒)
export const meshOf = (lat, lng) => `${Math.floor(Number(lat) * 120)}_${Math.floor(Number(lng) * 80)}`;
export const meshBounds = key => { const [a, b] = key.split('_').map(Number); return [[a / 120, b / 80], [(a + 1) / 120, (b + 1) / 80]]; };

export function yearsOf(events) {
  return [...new Set(events.map(e => dayOf(e.ts).slice(0, 4)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
}

export function yearReview({ events = [], intents = [], actants = [] }, year) {
  const Y = String(year), P = String(Number(year) - 1);
  const yr = d => String(d).slice(0, 4);
  const evs = events.filter(e => !isHomeMove(e));
  // 広がり(種類): 初めて出会ったものの層
  const blank = () => Object.fromEntries(SEASONS.map(s => [s, Object.fromEntries(TYPES.map(t => [t, 0]))]));
  const strata = { [Y]: blank(), [P]: blank() };
  const typeTotal = { [Y]: Object.fromEntries(TYPES.map(t => [t, 0])), [P]: Object.fromEntries(TYPES.map(t => [t, 0])) };
  const firstsY = [];
  for (const a of frontier(actants, evs, 'old')) {
    const y = yr(a.first);
    if (!strata[y] || !TYPES.includes(a.type)) continue;
    strata[y][seasonOf(a.first)][a.type]++;
    typeTotal[y][a.type]++;
    if (y === Y) firstsY.push(a);
  }
  // 広がり(土地): 区画ごとの初めての日
  const cells = {};
  for (const e of evs) {
    if (!hasPos(e)) continue;
    const k = meshOf(e.lat, e.lng), d = dayOf(e.ts);
    if (!cells[k] || d < cells[k].first) cells[k] = { key: k, first: d, lat: Number(e.lat), lng: Number(e.lng), label: e.place || e.name || '' };
  }
  const all = Object.values(cells);
  const before = all.filter(c => c.first < `${Y}-01-01`);
  const newY = all.filter(c => yr(c.first) === Y);
  const newP = all.filter(c => yr(c.first) === P);
  const base = before.length ? before : all;
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const center = { lat: med(base.map(c => c.lat)), lng: med(base.map(c => c.lng)) };
  let farthest = null;
  for (const c of newY) { const dist = haversine(center.lat, center.lng, c.lat, c.lng); if (!farthest || dist > farthest.dist) farthest = { ...c, dist: Math.round(dist) }; }
  // 挑戦: 霧の中へ置いた試みと、晴れた試み
  const evById = Object.fromEntries(events.map(e => [e.id, e]));
  const placed = intents.filter(i => yr(dayOf(i.ts)) === Y);
  const cleared = intents.filter(i => i.status === 'fulfilled').map(i => ({ ...i, clearedOn: dayOf((evById[i.fulfilled_event_id] || {}).ts || i.ts) })).filter(i => yr(i.clearedOn) === Y).sort((a, b) => a.clearedOn.localeCompare(b.clearedOn));
  const placedP = intents.filter(i => yr(dayOf(i.ts)) === P).length;
  // 深まり: その年に架かった再会の弧(前に結んだことのある相手と、その年にもう一度)
  const byAid = {};
  for (const e of evs) if (e.aid) (byAid[e.aid] = byAid[e.aid] || { aid: e.aid, name: e.name, type: e.type, days: [] }).days.push(dayOf(e.ts));
  const deepen = y => Object.values(byAid).map(a => {
    const days = [...new Set(a.days)].sort();
    let times = 0, gap = 0, from = '', to = '';
    for (let i = 1; i < days.length; i++) {
      if (yr(days[i]) !== y) continue;
      times++;
      const g = (new Date(days[i]) - new Date(days[i - 1])) / 864e5;
      if (g > gap) { gap = g; from = days[i - 1]; to = days[i]; }
    }
    return { ...a, days, times, gap: Math.round(gap), from, to };
  }).filter(a => a.times > 0).sort((a, b) => b.gap - a.gap || b.times - a.times);
  const reY = deepen(Y);
  return {
    year: Y, prev: P, strata, typeTotal, firstsY,
    land: { cells: all, before, newY, newPCount: newP.length, center, farthest },
    challenge: { placed, cleared, open: placed.filter(i => (i.status || 'open') === 'open'), placedP },
    deepen: reY, deepenPCount: deepen(P).length,
    hasPrev: TYPES.some(t => typeTotal[P][t] > 0) || newP.length > 0,
  };
}

// 一年の語り。数を競わせず、去年との違いを言葉の傾きで伝える
export function yearStory(r) {
  const out = [];
  const { placed, cleared } = r.challenge;
  if (placed.length) {
    out.push(`この一年、霧の中へ${placed.length}つの試みを置き、${cleared.length ? `${cleared.length}つが晴れました。` : 'まだどれも霧の中にあります。'}`);
    if (cleared.length) out.push(`最初に晴れたのは「${cleared[0].what}」、${Number(cleared[0].clearedOn.slice(5, 7))}月のことでした。`);
  } else if (cleared.length) out.push(`この一年、前から霧の中にあった試みが${cleared.length}つ晴れました。`);
  else out.push('この一年、霧の中に置いた試みはありませんでした。');

  const tY = r.typeTotal[r.year], tP = r.typeTotal[r.prev];
  const sumY = TYPES.reduce((s, t) => s + tY[t], 0), sumP = TYPES.reduce((s, t) => s + tP[t], 0);
  if (sumY) {
    const rank = TYPES.filter(t => tY[t] > 0).sort((a, b) => tY[b] - tY[a]);
    const thin = TYPES.filter(t => tY[t] <= sumY * 0.08);
    out.push(`初めて出会ったものは、${rank.slice(0, 2).join('と')}の層が厚い一年でした。${thin.length ? `${thin.join('・')}の層は薄めです。` : ''}`);
    if (sumP >= 5) {
      const grew = TYPES.filter(t => tY[t] >= tP[t] * 1.5 && tY[t] - tP[t] >= 3);
      const shrank = TYPES.filter(t => tY[t] * 1.5 <= tP[t] && tP[t] - tY[t] >= 3);
      if (grew.length || shrank.length) out.push(`去年と比べると、${[grew.length ? `${grew.join('・')}の層が厚くなり` : '', shrank.length ? `${shrank.join('・')}の層が細くなりました` : ''].filter(Boolean).join('、')}${shrank.length ? '' : 'ました'}。`);
      else out.push('去年と比べて、層の厚みの配分はあまり変わっていません。');
    } else out.push('去年の層はまだ薄く、比べられるのはこれからです。');
  } else out.push('この一年、初めて出会ったものはありませんでした。戻っていく縁の多い年だったのかもしれません。');

  const ny = r.land.newY.length, np = r.land.newPCount;
  if (ny) {
    const cmp = !r.hasPrev || !np ? '' : ny >= np * 1.3 ? '去年より広がりました' : ny * 1.3 <= np ? '去年より少し落ち着きました' : '去年と同じくらいの広がりでした';
    out.push(`初めて足を踏み入れた土地は${cmp ? `、${cmp}` : 'が地図に滲んでいます'}。${r.land.farthest && r.land.farthest.dist >= 5000 && r.land.farthest.label ? `いちばん遠くへ伸びた線の先は、${r.land.farthest.label}。` : ''}`);
  } else out.push('この一年、地図の上では、なじみの土地の内側で過ごしました。');

  if (r.deepen.length) {
    const d = r.deepen[0];
    out.push(`再会の弧は${r.deepen.length}の名前に架かりました。${d.gap >= 30 ? `いちばん間を置いた再会は${d.name}、${gapLabel(d.from, d.to)}でした。` : ''}`);
  } else out.push('この一年、再会の弧はまだ架かっていません。');
  return out;
}
