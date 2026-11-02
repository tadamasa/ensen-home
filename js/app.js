import { STORY, STORY_TITLE, STORY_LEAD } from './story.js';
import * as db from './db.js';
import * as sync from './sync.js';
import * as gemini from './gemini.js';
import * as places from './places.js';
import { exportData, importData } from './backup.js';
import {
  TYPES, VERBS, ORIGINS, TYPE_KEY, TYPE_ICON, VERB_ICON, VERB_ORDER, VERB_TIPS,
  esc, uuid, haversine, isoLocal, today, isDate, dayOf, timeOf, toInputValue, fromInputValue, shiftMonth, monthCells, dateLabel, gapLabel, autoSeason,
  findActant, suggestVerb, nearbyPlaces, nameChips, poiLabel, poiChoices, OVERPASS_DIRECT, overpassQuery, parseOverpass, photonUrl, parsePhoton, mergePoiList, isHomeMove, homeKind, echoOf,
  frontier, reunions, apprQueue, placeNameFor, isBooklogIntent, booklogCsv, READING_MEMO_URL, latestSpotFixes, applySpotFixes, spotSuspects, spotCandidates, yearReview, yearStory, yearsOf, SEASONS, meshBounds, latestWeight, mapPoints, distantCandidates, distantPrompt, parseDistant, parseExif,
} from './ensen.js';

// ---------- 状態 ----------
const state = { marks: {}, events: [], intents: [], appraisals: [], actants: [], traces: [], around: {}, look: 'map', appr: null, pair: null, frontierOrder: 'new', frontierShown: 150, fogOrder: 'old', map: { period: '1y', off: new Set() } };
const blankForm = () => ({ mode: 'event', ts: '', lat: null, lng: null, gps: null, place: '', placeTouched: false, type: null, name: '', verb: null, verbAuto: true, verbsOpen: false, star: false, note: '', photo: '', photoThumb: '', exif: null, trace_id: '', intent_id: '', poi: null, poiKey: '', poiBusy: false, poiFrom: null, poiRadius: 300, poiProviders: [], poiNote: '', found: null, foundKey: '', foundBusy: false, poiId: '', poiName: '', pickOpen: false, what: '', origin: null, originName: '', itype: null });
let form = blankForm();
const $view = document.getElementById('view');
const kcls = t => `t-${TYPE_KEY[t] || 'person'}`;
const glyph = (id, cls = 'glyph') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;

function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function splash() {
  const s = document.getElementById('splash');
  s.classList.remove('go'); void s.offsetWidth; s.classList.add('go');
  setTimeout(() => s.classList.remove('go'), 1400);
}
function setTitle(text, { back = false, sub = '' } = {}) {
  document.getElementById('nav-title').textContent = text;
  document.getElementById('nav-title-large').textContent = text;
  document.getElementById('nav-sub').textContent = sub;
  document.getElementById('back').hidden = !back;
  document.title = text === '泉' ? '縁泉' : `${text} - 縁泉`;
}
function setTab(tab) {
  document.querySelectorAll('.tabbar__item').forEach(a => a.classList.toggle('is-active', a.dataset.tab === tab));
}
const sortTs = (a, b) => String(a.ts).localeCompare(String(b.ts));

async function load() {
  const [events, intents, appraisals, actants, traces, placeNames, spotFixes] = await Promise.all(['events', 'intents', 'appraisals', 'actants', 'traces', 'place_names', 'spot_fixes'].map(s => db.getAll(s)));
  state.placeNames = placeNames;
  // スポットの位置の修正は読むときに当てる(元の縁は書き換えない)。怪しいものの検出には元の位置を使う
  state.spotFixes = latestSpotFixes(spotFixes);
  state.rawEvents = events.sort(sortTs);
  state.events = applySpotFixes(state.rawEvents, state.spotFixes);
  state.intents = intents.sort(sortTs);
  state.appraisals = appraisals;
  state.actants = applySpotFixes(actants, state.spotFixes, 'id');
  state.traces = traces.sort(sortTs);
}

// ---------- 泉の四季 ----------
function themePref() { try { return localStorage.getItem('ensen_theme') || 'auto'; } catch { return 'auto'; } }
function applyTheme() {
  const pref = themePref();
  const t = pref === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'winter' : autoSeason()) : pref;
  document.documentElement.setAttribute('data-theme', t);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg || '#F3EEE3');
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').setAttribute('content', t === 'winter' ? 'black-translucent' : 'default');
}
const SEASON_NAME = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

// ============================================================
// 泉(その日)
// ============================================================
function daysInfo() {
  const info = {};
  for (const e of state.events) {
    if (isHomeMove(e)) continue;
    const d = dayOf(e.ts);
    (info[d] = info[d] || { types: new Set(), trace: false }).types.add(e.type);
  }
  for (const t of state.traces) (info[dayOf(t.ts)] = info[dayOf(t.ts)] || { types: new Set(), trace: false }).trace = true;
  return info;
}

function calendarHtml(date) {
  const ym = date.slice(0, 7);
  const info = daysInfo();
  const t = today();
  const cells = monthCells(ym).map(d => {
    if (!d) return '<span class="cal__cell cal__cell--empty"></span>';
    const i = info[d];
    const mk = state.marks[ym] || {};
    const dots = (i ? TYPES.filter(x => i.types.has(x)).map(x => `<i class="${kcls(x)}"></i>`).join('') : '')
      + ((mk.books || []).includes(d) ? '<i class="m-book"></i>' : '') + ((mk.films || []).includes(d) ? '<i class="m-film"></i>' : '');
    const cls = ['cal__cell', d === t ? 'is-today' : '', d === date ? 'is-selected' : '', i && i.trace ? 'has-trace' : ''].join(' ');
    const label = `${Number(d.slice(8))}日${i && i.types.size ? '、縁あり' : ''}${i && i.trace ? '、写真の痕跡あり' : ''}${(mk.books || []).includes(d) ? '、本を読み終えた日' : ''}${(mk.films || []).includes(d) ? '、映画を観た日' : ''}`;
    return `<a class="${cls}${state.rippleDay === d ? ' is-rippling' : ''}" data-day="${d}" href="#day/${d}" aria-label="${label}"${d === date ? ' aria-current="date"' : ''}>${Number(d.slice(8))}<span class="cal__dots">${dots}</span></a>`;
  }).join('');
  const [y, m] = ym.split('-').map(Number);
  const enter = state.calEnter; state.calEnter = '';
  return `<div class="card cal${enter ? ` cal--enter-${enter}` : ''}" data-ym="${ym}">
    <div class="cal__head">
      <a class="cal__nav" href="#day/${shiftMonth(ym, -1)}-01" aria-label="前の月" style="display:flex;align-items:center;justify-content:center;text-decoration:none">‹</a>
      <span class="cal__label">${y}年${m}月</span>
      <a class="cal__nav" href="#day/${shiftMonth(ym, 1)}-01" aria-label="次の月" style="display:flex;align-items:center;justify-content:center;text-decoration:none">›</a>
    </div>
    <div class="cal__grid cal__week" aria-hidden="true"><span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span></div>
    <div class="cal__grid cal__days">${cells}</div>
  </div>`;
}

function echoHtml(e) {
  const r = echoOf(state.events, e);
  if (!r) return '';
  const x = r.e;
  const what = r.same ? '前に結んだのは' : '近くで前に結んだのは';
  return `<a class="echo" href="#day/${dayOf(x.ts)}">谺 ── ${what} <b>${esc(dayOf(x.ts).replace(/-/g, '.'))}</b>(${gapLabel(x.ts, e.ts)})${r.same ? '' : ` ${esc(x.name)}`}・${esc(x.verb)}${x.note ? `「${esc(x.note.slice(0, 40))}」` : ''}</a>`;
}

function traceById(id) { return state.traces.find(t => t.id === id); }
// 縁の出どころ(events.source)の呼び名。無いものはそのまま出す
const SOURCE_LABEL = { reading: '読書メモ', movie: '映画メモ' };
const thumbSrc = t => (t && t.thumb ? `data:image/jpeg;base64,${t.thumb}` : '');

function eventNode(e) {
  const tr = e.trace_id ? traceById(e.trace_id) : null;
  const img = e.photoThumb || thumbSrc(tr);
  const meta = [
    e.star ? '<span class="star" aria-label="後で効く印">★</span>' : '',
    e.media ? `<a href="${esc(e.media)}" target="_blank" rel="noopener">写真(Drive)</a>` : '',
    e.error ? `<span class="badge badge--warn">ハブに断られました: ${esc(e.error)}</span>` : (e.pending ? '<span class="badge">未送信</span>' : ''),
    e.source && e.source !== 'home' && e.source !== 'app' ? `<span class="badge">${esc(SOURCE_LABEL[e.source] || e.source)}</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="node ${kcls(e.type)}">
    <span class="node__dot">${glyph(TYPE_ICON[e.type] || 'i-place', '')}</span>
    <div class="node__time">${esc(timeOf(e.ts))}・${esc(e.type)}</div>
    <div class="node__body">
      <div class="node__title">${esc(e.name)}<span class="node__verb">${glyph(VERB_ICON[e.verb] || 'v-au', '')}${esc(e.verb)}</span></div>
      ${e.place && e.place !== e.name ? `<div class="node__place">${esc(e.place)}</div>` : ''}
      ${e.note ? `<p class="node__note">${esc(e.note)}</p>` : ''}
      ${img ? `<img class="node__photo" src="${img}" alt="">` : ''}
      ${meta ? `<div class="node__meta">${meta}</div>` : ''}
      ${echoHtml(e)}
    </div>
  </div>`;
}

// 痕跡の場所名(直した名前があればそれ)。押すと直せる
const tPlace = t => placeNameFor(t, state.placeNames);
function placeBtn(t) {
  const p = tPlace(t);
  return `<button class="place-fix" data-fix-trace="${esc(t.id)}" aria-label="場所名を直す">${esc(p.name || '場所の名前なし')}<small>直す</small></button>${p.fixed ? '<span class="muted small">(直した名前)</span>' : ''}`;
}
async function fixPlace(id) {
  const t = traceById(id);
  if (!t) return false;
  const cur = tPlace(t);
  const v = prompt(`この写真の場所名を直します。\n150m以内で撮った、ほかの写真の名前も変わります。\n空にすると元の名前「${t.place || '名前なし'}」に戻ります。`, cur.name);
  if (v === null) return false;
  const nv = v.trim();
  if (nv === cur.name || (!nv && !cur.fixed)) return false; // 変わっていない・戻す修正もない
  await db.put('place_names', { id: uuid(), ts: isoLocal(), trace_id: t.id, lat: t.lat ?? null, lng: t.lng ?? null, name: nv.slice(0, 80), source: 'home', mtime: Date.now(), pending: true });
  await load();
  toast(nv ? `「${nv}」にしました` : '元の名前に戻しました');
  return true;
}

function traceNode(t, promoted) {
  return `<div class="node node--trace">
    <span class="node__dot">${glyph('i-pin', '')}</span>
    <div class="node__time">${esc(timeOf(t.ts))}・写真の痕跡</div>
    <div class="trace-card${promoted ? ' is-promoted' : ''}">
      ${t.thumb ? `<img src="${thumbSrc(t)}" alt="この時刻に撮った写真">` : '<span class="ph"></span>'}
      <div class="trace-card__text">${placeBtn(t)}<br><span class="muted small">${promoted ? '縁にしました' : 'まだ痕跡のまま'}</span></div>
      ${promoted ? '' : `<a class="btn btn--tinted btn--small" href="#record/trace/${encodeURIComponent(t.id)}">縁にする</a>`}
    </div>
  </div>`;
}

// 同じ場所で続けて撮った写真の痕跡(1時間以内)を一つにまとめる。過去の写真を一括で取り込んだ日が長くならないように
function traceGroups(ts) {
  const out = [];
  for (const t of ts) {
    const g = out[out.length - 1];
    const prev = g && g[g.length - 1];
    if (prev && tPlace(prev).name === tPlace(t).name && (new Date(t.ts) - new Date(prev.ts)) <= 3600e3) g.push(t);
    else out.push([t]);
  }
  return out;
}
function traceGroupNode(g) {
  const withThumb = g.filter(t => t.thumb).slice(0, 4);
  return `<div class="node node--trace">
    <span class="node__dot">${glyph('i-pin', '')}</span>
    <div class="node__time">${esc(timeOf(g[0].ts))}〜${esc(timeOf(g[g.length - 1].ts))}・写真の痕跡 ${g.length}枚</div>
    <div class="trace-card">
      ${withThumb.length ? `<span class="trace-stack">${withThumb.map(t => `<img src="${thumbSrc(t)}" alt="">`).join('')}</span>` : '<span class="ph"></span>'}
      <div class="trace-card__text">${placeBtn(g[0])}<br><span class="muted small">まだ痕跡のまま</span></div>
      <a class="btn btn--tinted btn--small" href="#record/trace/${encodeURIComponent(g[0].id)}">縁にする</a>
    </div>
  </div>`;
}

async function renderDay(arg) {
  const date = isDate(arg) ? arg : today();
  setTab('day');
  const theme = document.documentElement.getAttribute('data-theme');
  const pending = state.events.filter(e => e.pending && !e.error).length;
  setTitle('泉', { sub: `${SEASON_NAME[theme] || ''}の泉${pending ? `・未送信の縁 ${pending}` : ''}` });
  const evs = state.events.filter(e => dayOf(e.ts) === date);
  const promoted = new Set(state.events.map(e => e.trace_id).filter(Boolean));
  const items = [
    ...evs.map(e => ({ ts: e.ts, html: isHomeMove(e)
      ? `<div class="node node--home"><span class="node__dot"></span><div class="node__time">${esc(timeOf(e.ts))} ${homeKind(e) === '出発' ? '自宅から行ってきます' : '自宅にただいま'}</div></div>`
      : eventNode(e) })),
    ...traceGroups(state.traces.filter(t => dayOf(t.ts) === date && !promoted.has(t.id)).sort(sortTs)).map(g => ({ ts: g[0].ts, html: g.length > 1 ? traceGroupNode(g) : traceNode(g[0], false) })),
  ].sort(sortTs);
  const quiet = !items.length;
  $view.innerHTML = `
    ${calendarHtml(date)}
    <div class="day-head"><h2>${dateLabel(date)}</h2><a class="btn btn--tinted btn--small" href="#record/date/${date}">この日に結ぶ</a></div>
    ${quiet ? '<p class="empty-line">静かな水面。</p>' : `<div class="flow${state.lastDay !== date ? ' flow--enter' : ''}">${items.map((i, n) => i.html.replace('<div class="node', `<div style="--i:${Math.min(n, 12)}" class="node`)).join('')}</div>`}
    <div class="around" id="around"></div>`;
  state.lastDay = date;
  bindCalendar(date);
  loadMarks(date.slice(0, 7), date);
  $view.querySelectorAll('[data-fix-trace]').forEach(b => b.addEventListener('click', async () => { if (await fixPlace(b.dataset.fixTrace)) { const y = scrollY; await renderDay(date); scrollTo(0, y); } }));
  renderAround(date);
}

// カレンダーは左右にフリックで月を送る。指に追従し、離すと次の月が反対側から流れ込む。日はなるべく同じ日に
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function goMonth(date, dir) {
  const ym = shiftMonth(date.slice(0, 7), dir);
  const [y, m] = ym.split('-').map(Number);
  const dd = Math.min(Number(date.slice(8)), new Date(y, m, 0).getDate());
  state.calEnter = dir > 0 ? 'next' : 'prev';
  location.hash = `#day/${ym}-${String(dd).padStart(2, '0')}`;
}
function bindCalendar(date) {
  const cal = $view.querySelector('.cal');
  if (!cal) return;
  const moving = [cal.querySelector('.cal__days'), cal.querySelector('.cal__label')];
  const setX = (x, op, tr) => moving.forEach(el => { el.style.transition = tr || 'none'; el.style.transform = x ? `translateX(${x}px)` : ''; el.style.opacity = op == null ? '' : op; });
  const leave = dir => {
    if (reduceMotion()) return goMonth(date, dir);
    setX(-dir * cal.clientWidth * 0.6, 0, 'transform .18s cubic-bezier(.4,0,1,1), opacity .18s');
    setTimeout(() => goMonth(date, dir), 150);
  };
  let x0 = null, y0 = null, t0 = 0, lock = '';
  cal.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); lock = ''; }, { passive: true });
  cal.addEventListener('touchmove', e => {
    if (x0 == null) return;
    const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (!lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (lock !== 'x' || reduceMotion()) return;
    // 端に近づくほど重くなる(ゴムのような抵抗)
    const w = cal.clientWidth, x = dx / (1 + Math.abs(dx) / w);
    setX(x, 1 - Math.min(Math.abs(x) / w, 0.6));
  }, { passive: true });
  cal.addEventListener('touchend', e => {
    if (x0 == null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    const fast = Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.5;
    x0 = null;
    if (lock === 'x' && (Math.abs(dx) > 60 || (fast && Math.abs(dx) > 24)) && Math.abs(dx) > Math.abs(dy)) return leave(dx < 0 ? 1 : -1);
    setX(0, null, 'transform .42s cubic-bezier(.2,1.4,.4,1), opacity .25s'); // ばねで戻る
  }, { passive: true });
  cal.querySelectorAll('.cal__nav').forEach((a, i) => a.addEventListener('click', e => { e.preventDefault(); leave(i === 0 ? -1 : 1); }));
  // 日を押すと、そこに波紋が広がる
  cal.querySelectorAll('[data-day]').forEach(a => a.addEventListener('click', () => { state.rippleDay = a.dataset.day; }));
  setTimeout(() => { state.rippleDay = ''; }, 0);
}
// 本を読み終えた日・映画を観た日の印(月ごと、ハブで読む)
async function loadMarks(ym, date) {
  if (state.marks[ym] || !sync.enabled()) return;
  try { state.marks[ym] = await sync.ask('month', { month: ym }); } catch { state.marks[ym] = {}; return; }
  const cal = $view.querySelector(`.cal[data-ym="${ym}"]`);
  if (!cal) return;
  cal.outerHTML = calendarHtml(date);
  bindCalendar(date);
}

// その日のまわり: 日記・読み終えた本・観た映画(縁泉ハブが読むだけ)。押したときではなく開いたときに一度だけ読む
async function renderAround(date) {
  const el = document.getElementById('around');
  if (!el || !sync.enabled()) return;
  let d = state.around[date];
  if (!d) {
    el.innerHTML = '<p class="hint">その日の日記を読んでいます…</p>';
    try { d = state.around[date] = await sync.ask('day', { date }); } catch (e) { el.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  }
  if (!location.hash.includes(date) && date !== today()) return;
  const parts = [];
  const fold = (text, cls) => `<div class="fold-text ${cls}"><p class="fold-text__body">${esc(text)}</p><button class="fold-text__more" hidden>続きを読む</button></div>`;
  const diary = (d.diary && d.diary.entries) || [];
  if (d.diary && d.diary.ok === false) parts.push(`<p class="hint">日記を読めませんでした: ${esc(d.diary.error || '')}</p>`);
  if (diary.length) parts.push(`<div class="sect">この日の日記<small><a href="${esc(d.diary.url)}" target="_blank" rel="noopener">日記で開く</a></small></div>
    <div class="card">${diary.map(x => `<div class="diary-line"><div class="diary-line__time">${esc(x.time)}${x.feelings ? `・${esc(x.feelings)}` : ''}</div>${fold(x.text, 'diary-line__text')}</div>`).join('')}</div>`);
  const books = (d.books && d.books.books) || [];
  if (books.length) parts.push(`<div class="sect">この日に読み終えた本</div><div class="card">
    ${books.map(b => `<a class="mini" href="${esc(b.url)}" target="_blank" rel="noopener">${b.cover ? `<img src="${esc(b.cover)}" alt="">` : '<img alt="">'}<span><span class="list-row__title">${esc(b.title)}</span><br><span class="muted small">${esc(b.author)}</span></span></a>`).join('')}
  </div>`);
  const films = (d.films && d.films.films) || [];
  if (d.films && d.films.ok === false) parts.push(`<p class="hint">映画ハブを読めませんでした: ${esc(d.films.error || '')}</p>`);
  if (films.length) parts.push(`<div class="sect">この日に観た映画</div><div class="card">
    ${films.map(f => `<div class="film"><a class="mini" href="${esc(f.url)}" target="_blank" rel="noopener">${f.poster ? `<img src="${esc(f.poster)}" alt="">` : '<img alt="">'}<span><span class="list-row__title">${esc(f.title)}</span>${f.year ? `<span class="muted small">(${esc(f.year)})</span>` : ''}<br><span class="muted small">${esc([f.place, f.venue, f.directors].filter(Boolean).join('・') || '映画')}${f.score !== '' && f.score != null ? `・${'★'.repeat(Math.max(0, Math.min(5, Math.round(Number(f.score) || 0))))}` : ''}</span></span></a>${f.text ? fold(f.text, 'film__text') : ''}</div>`).join('')}
  </div>`);
  el.innerHTML = parts.join('');
  // 折りたたみ: はみ出すときだけ「続きを読む」を出す。押すと全文、もう一度でたたむ
  el.querySelectorAll('.fold-text').forEach(w => {
    const body = w.querySelector('.fold-text__body'), btn = w.querySelector('.fold-text__more');
    if (body.scrollHeight > body.clientHeight + 2) btn.hidden = false;
    const toggle = () => {
      const opening = !w.classList.contains('is-open');
      btn.textContent = opening ? 'たたむ' : '続きを読む';
      if (reduceMotion()) { w.classList.toggle('is-open', opening); return; }
      const from = body.clientHeight;
      w.classList.add('is-open');
      const full = body.scrollHeight;
      const to = opening ? full : parseFloat(getComputedStyle(body).lineHeight) * 4;
      body.style.maxHeight = `${from}px`; body.style.overflow = 'hidden';
      void body.offsetHeight;
      body.style.transition = 'max-height .34s cubic-bezier(.25,.8,.25,1)';
      body.style.maxHeight = `${to}px`;
      setTimeout(() => { body.style.transition = ''; body.style.maxHeight = ''; body.style.overflow = ''; if (!opening) w.classList.remove('is-open'); }, 360);
    };
    btn.addEventListener('click', toggle);
    body.addEventListener('click', () => { if (!btn.hidden) toggle(); });
  });
}

// ============================================================
// 結ぶ
// ============================================================
function curPos() {
  if (form.lat != null) return { lat: form.lat, lng: form.lng };
  return form.gps || { lat: null, lng: null };
}
function matched() { const p = curPos(); return findActant(state.actants, form.type, form.name, p.lat, p.lng); }

function locate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    form.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (form.lat == null && !form.placeTouched) revGeocode(form.gps.lat, form.gps.lng);
    loadPoi();
    if (location.hash.startsWith('#record')) paintRecordParts();
  }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}
// 国土地理院の逆ジオコーダ(無料・認証不要)
let muniLoaded = null;
async function revGeocode(lat, lng) {
  try {
    const j = await (await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`)).json();
    if (!j.results) return;
    muniLoaded = muniLoaded || new Promise(res => { window.GSI = window.GSI || {}; const s = document.createElement('script'); s.src = 'https://maps.gsi.go.jp/js/muni.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
    await muniLoaded;
    let muni = '';
    try { const e = window.GSI.MUNI_ARRAY[String(Number(j.results.muniCd))]; muni = e ? e.split(',')[3] : ''; } catch { muni = ''; }
    if (form.placeTouched) return;
    form.place = (muni || '') + (j.results.lv01Nm || '');
    const el = document.getElementById('f-place');
    if (el && !el.value) el.value = form.place;
  } catch { /* 手入力で */ }
}
// 外の地図(OSM・Google)の近くの候補。位置か半径が変わったら引き直す。待たせない(届いたら描き直す)
// 候補を選ぶと記録の位置はその店に移るが、候補は「選ぶ前の位置」のまわりのまま(poiFrom)
function poiCenter() { return form.poiFrom || curPos(); }
async function loadPoi(q = '') {
  const p = poiCenter();
  if (p.lat == null) return;
  const slot = q ? 'found' : 'poi';
  const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)},${q ? `q:${q}` : form.poiRadius}`;
  if (form[slot + 'Key'] === key) return;
  Object.assign(form, { [slot + 'Key']: key, [slot]: null, [slot + 'Busy']: true });
  if (q) paintRecordParts();
  // OSM は端末から直接引く。Photon と Overpass 2か所を同時に投げ、届いた順に重ねる。
  // ハブには Google の分だけを同時に尋ねる(キーが無ければすぐ空で返る)。同じ場所の OSM の結果は端末に1週間覚えておく
  const rad = q ? 5000 : form.poiRadius;
  const stale = () => form[slot + 'Key'] !== key;
  const memo = `ensen-poi:${key}`;
  let cached = null;
  try { const m = JSON.parse(localStorage.getItem(memo) || 'null'); if (m && Date.now() - m.at < 7 * 864e5) cached = m.list; } catch { /* 覚えていなくてもよい */ }
  let list = cached || [], notes = [];
  const jobs = [];
  const show = done => {
    if (stale()) return;
    form[slot] = list;
    form[slot + 'Busy'] = !done && !list.length;
    form.poiNote = !list.length && done ? notes.join('・') : '';
    form.poiProviders = ['osm', 'google'].filter(x => list.some(y => y.src === x));
    if (location.hash.startsWith('#record') && form.type === '場所') { paintRecordParts(); drawPick(); }
  };
  const add = got => { list = mergePoiList(list.concat(got)); show(false); };
  const timed = (url, opts, ms = 20000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, { ...opts, signal: ac.signal }).then(res => { if (!res.ok) throw new Error(String(res.status)); return res.json(); }).finally(() => clearTimeout(t));
  };
  const why = (host, e) => notes.push(`${host} ${e.name === 'AbortError' ? '時間切れ' : e.message}`);
  if (!cached) {
    const osmGot = [];
    jobs.push(timed(photonUrl(p.lat, p.lng, rad, q)).then(j => { const g = parsePhoton(j, p.lat, p.lng, rad); osmGot.push(...g); add(g); }).catch(e => why('photon', e)));
    for (const ep of OVERPASS_DIRECT) {
      jobs.push(timed(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(overpassQuery(p.lat, p.lng, rad, q)) })
        .then(j => { const g = parseOverpass(j, p.lat, p.lng, rad); osmGot.push(...g); add(g); }).catch(e => why(new URL(ep).host, e)));
    }
    Promise.allSettled(jobs.slice()).then(() => {
      if (osmGot.length) { try { localStorage.setItem(memo, JSON.stringify({ at: Date.now(), list: mergePoiList(osmGot) })); } catch { /* 満杯なら覚えない */ } }
    });
  }
  // Google: 端末にキーがあれば端末から直接(速い・理由がそのまま見える)。なければハブに尋ねる
  const placesKey = await db.getMeta('placesKey', '');
  if (stale()) return;
  if (placesKey) {
    jobs.push(places.searchPlaces({ apiKey: placesKey, lat: p.lat, lng: p.lng, radius: form.poiRadius, q })
      .then(g => add(g.map(x => ({ ...x, dist: Math.round(haversine(p.lat, p.lng, x.lat, x.lng)) })).filter(x => x.dist <= rad)))
      .catch(e => notes.push(`google ${e.message}`)));
  } else if (sync.enabled()) jobs.push(sync.ask('poi', { lat: p.lat, lng: p.lng, radius: form.poiRadius, q, osm: false })
    .then(r => { add(((r && r.poi) || []).filter(x => x.src !== 'osm' || !cached)); if (r && r.error) notes.push(r.error); })
    .catch(e => { notes.push(`縁泉ハブ: ${e.message}`); }));
  show(false);
  await Promise.allSettled(jobs);
  show(true);
}
// 候補を採る: 名前と位置をその場所に。外の地図の候補ならIDも持って行く(台帳が同じ場所だと覚える)
function choosePlace(c) {
  if (!form.poiFrom && curPos().lat != null) form.poiFrom = { ...curPos() };
  form.name = c.name;
  if (c.lat != null && isFinite(c.lat)) { form.lat = Number(c.lat); form.lng = Number(c.lng); }
  form.poiId = c.src ? (c.id || '') : (c.poi || ''); // 台帳の場所は、覚えている地図のIDがあればそれ
  form.poiName = c.name;
  if (!form.placeTouched) { form.place = c.name; const el = document.getElementById('f-place'); if (el) el.value = form.place; }
  const el = document.getElementById('f-name'); if (el) el.value = form.name;
  paintRecordParts(); drawPick();
}
function unchoosePlace() { // 選ぶ前の位置に戻す
  const f = form.poiFrom;
  if (f && form.gps && f.lat === form.gps.lat && f.lng === form.gps.lng) form.lat = form.lng = null;
  else if (f) { form.lat = f.lat; form.lng = f.lng; }
  Object.assign(form, { poiId: '', poiName: '', poiFrom: null });
  paintRecordParts(); drawPick();
}

// ---- 地図で選ぶ(結ぶ画面の小さな地図。台帳の場所と OSM の候補を置く。押した点を採る) ----
// Google の候補は規約で Google 以外の地図に重ねられないので、地図には出さず一覧だけに出す
let pick = null;
function drawPick() {
  const el = document.getElementById('f-pickmap');
  if (!el || !form.pickOpen) { if (pick) { pick.map.remove(); pick = null; } return; }
  loadLeaflet().then(L => {
    if (!document.getElementById('f-pickmap')) return;
    const c = poiCenter();
    if (c.lat == null) return;
    if (!pick || pick.el !== el) {
      if (pick) pick.map.remove();
      const map = L.map(el, { zoomControl: false, attributionControl: false }).setView([c.lat, c.lng], 17);
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
      pick = { el, map, layer: L.layerGroup().addTo(map) };
      map.on('click', e => { // 何もないところを押したら、その点を記録の位置に(名前はそのまま)
        if (!form.poiFrom) form.poiFrom = { ...poiCenter() };
        form.lat = Math.round(e.latlng.lat * 1e6) / 1e6; form.lng = Math.round(e.latlng.lng * 1e6) / 1e6; form.poiId = ''; form.poiName = '';
        paintRecordParts(); drawPick();
      });
    }
    const { map, layer } = pick;
    layer.clearLayers();
    L.marker([c.lat, c.lng], { icon: meIcon(L), interactive: false }).addTo(layer);
    const sel = curPos();
    const near = nearbyPlaces(state.actants, c.lat, c.lng).slice(0, 12);
    const add = (x, cls, label) => {
      const on = form.poiId ? form.poiId === (x.id || x.poi) : (form.name === x.name && sel.lat === x.lat);
      L.marker([x.lat, x.lng], { icon: L.divIcon({ html: `<div class="pk ${cls}${on ? ' is-on' : ''}"><i></i><span>${esc(x.name)}</span></div>`, className: '', iconSize: [0, 0], iconAnchor: [7, 7] }), title: x.name, keyboard: true, alt: label })
        .addTo(layer).on('click', ev => { L.DomEvent.stopPropagation(ev); choosePlace(x); });
    };
    near.forEach(a => add(a, 'pk--mine', '前に結んだ場所'));
    poiChoices(near, form.poi, 30).concat(form.found || []).filter(x => x.src !== 'google').forEach(x => add(x, '', poiLabel(x.category)));
    if (sel.lat != null && !(form.poiId) && (sel.lat !== c.lat || sel.lng !== c.lng)) L.marker([sel.lat, sel.lng], { icon: L.divIcon({ html: '<div class="pk pk--drop is-on"><i></i><span>ここ</span></div>', className: '', iconSize: [0, 0], iconAnchor: [7, 7] }), interactive: false }).addTo(layer);
    setTimeout(() => { map.invalidateSize(); if (sel.lat != null) map.panInside([sel.lat, sel.lng], { padding: [40, 40] }); }, 0);
  }).catch(() => {});
}

function typeButtons(selected, attr) {
  return `<div class="types" role="radiogroup" aria-label="なにと">${TYPES.map(t => `<button class="type ${kcls(t)}${selected === t ? ' is-active' : ''}" ${attr}="${t}" role="radio" aria-checked="${selected === t}">${glyph(TYPE_ICON[t], '')}<span>${t}</span></button>`).join('')}</div>`;
}

function renderRecord(arg, arg2) {
  setTab('record');
  // 入口: #record / #record/trace/ID(写真の痕跡から) / #record/intent/ID(試すを結ぶ) / #record/date/YYYY-MM-DD / #record/try
  if (arg === 'trace' && arg2) {
    const t = traceById(arg2);
    form = blankForm();
    if (t) {
      const pn = tPlace(t).name;
      Object.assign(form, { ts: t.ts, lat: t.lat, lng: t.lng, place: pn, placeTouched: !!pn, photoThumb: thumbSrc(t), trace_id: t.id });
      if (!pn && t.lat != null) revGeocode(t.lat, t.lng);
    }
    history.replaceState(null, '', '#record');
  } else if (arg === 'intent' && arg2) {
    const it = state.intents.find(x => x.id === arg2);
    form = blankForm();
    if (it) Object.assign(form, { name: it.what, type: TYPES.includes(it.type) ? it.type : null, intent_id: it.id });
    history.replaceState(null, '', '#record');
  } else if (arg === 'date' && isDate(arg2)) {
    form = blankForm();
    if (arg2 !== today()) form.ts = `${arg2}T${isoLocal().slice(11)}`;
    history.replaceState(null, '', '#record');
  } else if (arg === 'try') {
    form.mode = 'intent';
    history.replaceState(null, '', '#record');
  }
  setTitle(form.mode === 'intent' ? '試す' : '結ぶ');
  if (!form.gps && form.lat == null) locate();
  $view.innerHTML = `
    <div class="seg" role="tablist">
      <button class="chip${form.mode === 'event' ? ' is-active' : ''}" data-mode="event" role="tab" aria-selected="${form.mode === 'event'}">縁を結ぶ</button>
      <button class="chip${form.mode === 'intent' ? ' is-active' : ''}" data-mode="intent" role="tab" aria-selected="${form.mode === 'intent'}">試すことに</button>
    </div>
    <div id="rec"></div>`;
  $view.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { form.mode = b.dataset.mode; renderRecord(); }));
  if (form.mode === 'intent') return paintIntentForm();
  paintEventForm();
}

function paintEventForm() {
  const rec = document.getElementById('rec');
  const fromTrace = form.trace_id ? `<div class="card from-trace">${form.photoThumb ? `<img src="${form.photoThumb}" alt="">` : ''}<div class="small" style="flex:1">写真の痕跡から結びます。<br><span class="muted">${esc(dayOf(form.ts))} ${esc(timeOf(form.ts))}</span></div><button class="btn btn--plain btn--small" id="f-clear">やめる</button></div>` : '';
  const fromIntent = form.intent_id ? `<div class="card from-trace"><div class="small" style="flex:1">「${esc(form.name)}」を試した縁として結びます。結ぶと霧が晴れます。</div><button class="btn btn--plain btn--small" id="f-clear">やめる</button></div>` : '';
  rec.innerHTML = `
    ${fromTrace}${fromIntent}
    <div class="sect">いつ・どこで</div>
    <div class="card">
      <div class="row"><label for="f-ts">日時</label><input id="f-ts" type="datetime-local" value="${esc(toInputValue(form.ts || isoLocal()))}"></div>
      <div class="row"><label for="f-place">場所</label><input id="f-place" type="text" placeholder="${form.gps ? '場所の名前' : '現在地を取得中…'}" value="${esc(form.place)}" autocomplete="off"></div>
      <div id="f-photoloc"></div>
    </div>
    <div class="sect">なにと</div>
    ${typeButtons(form.type, 'data-type')}
    <div class="card" style="margin-top:var(--space-3)">
      <input id="f-name" class="field field--name" type="text" placeholder="なにと出会った？" value="${esc(form.name)}" autocomplete="off" aria-label="名前">
      <div class="match" id="f-match" aria-live="polite"></div>
      <div class="find" id="f-find"></div>
      <div class="chips" id="f-names"></div>
    </div>
    <div class="sect">どんなご縁</div>
    <div class="card"><div class="chips verbs" id="f-verbs"></div><div class="verb-tip" id="f-tip"></div></div>
    <div class="sect">ひとこと</div>
    <div class="card">
      <div class="row" style="align-items:flex-start">
        <textarea id="f-note" class="field field--note" rows="2" placeholder="一言そえる(なくてもいい)" aria-label="ひとこと">${esc(form.note)}</textarea>
        <button class="star-btn${form.star ? ' is-on' : ''}" id="f-star" aria-pressed="${form.star}" aria-label="後で効く印">★</button>
      </div>
      ${form.trace_id ? '' : `<div class="row photo-row"><span id="f-photo-prev">${form.photoThumb ? `<img src="${form.photoThumb}" alt="">` : ''}</span>
        <label class="btn btn--plain btn--small" for="f-file" style="color:var(--color-accent)">${form.photoThumb ? '写真を替える' : '＋写真'}</label>
        ${form.photoThumb ? '<button class="btn btn--plain btn--small" id="f-photo-del">外す</button>' : ''}
        <input id="f-file" type="file" accept="image/*" hidden></div>`}
    </div>
    <button class="send" id="f-send">結ぶ</button>
    <div id="f-echo" style="margin-top:var(--space-3)"></div>`;
  const $ = id => document.getElementById(id);
  $('f-ts').addEventListener('change', e => { form.ts = fromInputValue(e.target.value); });
  $('f-place').addEventListener('input', e => { form.place = e.target.value; form.placeTouched = true; });
  rec.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    form.type = b.dataset.type; form.verbsOpen = false;
    rec.querySelectorAll('[data-type]').forEach(x => { x.classList.toggle('is-active', x === b); x.setAttribute('aria-checked', String(x === b)); });
    if (form.type === '場所') loadPoi();
    paintRecordParts();
  }));
  $('f-name').addEventListener('input', e => { form.name = e.target.value; paintRecordParts(true); });
  $('f-note').addEventListener('input', e => { form.note = e.target.value; });
  $('f-star').addEventListener('click', e => { form.star = !form.star; e.currentTarget.classList.toggle('is-on', form.star); e.currentTarget.setAttribute('aria-pressed', String(form.star)); });
  if ($('f-file')) $('f-file').addEventListener('change', e => attachPhoto(e.target.files[0]));
  if ($('f-photo-del')) $('f-photo-del').addEventListener('click', () => { Object.assign(form, { photo: '', photoThumb: '', exif: null }); if (form.lat != null && !form.trace_id) { form.lat = form.lng = null; } paintEventForm(); });
  $('f-send').addEventListener('click', saveEvent);
  if ($('f-clear')) $('f-clear').addEventListener('click', () => { const gps = form.gps; form = blankForm(); form.gps = gps; if (gps) revGeocode(gps.lat, gps.lng); paintEventForm(); });
  paintRecordParts();
}

// 種別・名前・位置で変わる部分(名前の候補・再会の判定・動詞)
function paintRecordParts(fromTyping = false) {
  const $ = id => document.getElementById(id);
  if (!$('f-names')) return;
  const m = matched();
  if (m && m.last_seen) $('f-match').textContent = `再会(前回 ${dayOf(m.last_seen).replace(/-/g, '.')}、${gapLabel(m.last_seen, form.ts || isoLocal())})`;
  else $('f-match').textContent = form.type && form.name.trim() ? 'はじめての縁' : '';
  if (form.verbAuto && form.type) form.verb = suggestVerb(form.type, m);
  // 名前の候補
  let chips = '';
  if (form.type === '場所') {
    const c = poiCenter();
    const near = nearbyPlaces(state.actants, c.lat, c.lng).slice(0, 6);
    const poi = poiChoices(near, form.poi);
    const kind = x => { const k = poiLabel(x.category); return k ? `<small>${esc(k)}・${x.dist}m</small>` : `<small>${x.dist}m</small>`; };
    const on = x => (form.poiId && form.poiId === (x.id || x.poi)) || (!form.poiId && form.name === x.name && form.lat === x.lat) ? ' is-active' : '';
    const chip = (x, i, list) => `<button class="chip${on(x)}" data-pick="${list}:${i}">${esc(x.name)} ${list === 'near' ? `<small>${x.dist}m</small>` : kind(x)}</button>`;
    if (form.poiFrom) chips += `<div class="picked" role="status">${glyph('i-pin', '')}<span><b>${esc(form.poiName || '地図で選んだところ')}</b> の位置で結びます</span><button class="btn btn--plain btn--small" id="f-unpick" aria-label="選んだ場所を外す">外す</button></div>`;
    if (near.length) chips += `<span class="chips-label">近くの、前に結んだ場所</span>${near.map((x, i) => chip(x, i, 'near')).join('')}`;
    if (c.lat == null) chips += '<span class="small muted" style="width:100%">現在地がまだわかりません。位置情報の許可を確かめてください(写真を付けると撮影地で探します)</span>';
    if (c.lat != null) {
      chips += `<span class="chips-label">近くの場所${form.poiBusy ? '<span class="poi-wait">さがしています…</span>' : ''}</span>`;
      chips += poi.map((x, i) => chip(x, i, 'poi')).join('');
      if (!form.poiBusy && form.poi && !poi.length) chips += `<span class="small muted">${form.poiNote ? `近くの場所を引けませんでした(${esc(form.poiNote)})` : `${form.poiRadius}m 以内に見つかりませんでした`}</span>`;
      if (form.found || form.foundBusy) {
        chips += `<span class="chips-label">「${esc(form.foundKey.split(',q:')[1] || '')}」で探した場所${form.foundBusy ? '<span class="poi-wait">さがしています…</span>' : ''}</span>`;
        chips += (form.found || []).map((x, i) => chip(x, i, 'found')).join('') || (form.foundBusy ? '' : '<span class="small muted">5km 以内に見つかりませんでした</span>');
      }
      chips += `<div class="poi-tools">${form.poiRadius < 1000 ? '<button class="chip chip--ghost" id="f-wider">もっと広く</button>' : ''}<button class="chip chip--ghost" id="f-pick" aria-expanded="${form.pickOpen}">${form.pickOpen ? '地図をとじる' : '地図で選ぶ'}</button></div>`;
      if (form.pickOpen) chips += '<div class="pick-wrap"><div id="f-pickmap" role="application" aria-label="結ぶ場所を地図で選ぶ"></div><p class="hint" style="margin:var(--space-1) 0 0">点を押すとその場所に。何もないところを押すと、その位置で結びます。</p></div>';
      const by = (form.poiProviders || []).map(x => ({ osm: '© OpenStreetMap contributors', google: 'Google Maps' })[x]).filter(Boolean);
      if (by.length && ((form.poi || []).length || (form.found || []).length)) chips += `<p class="credit" style="margin:var(--space-1) 0 0;width:100%">候補: ${by.join('・')}</p>`;
    }
  } else if (form.type) {
    const { recent, often } = nameChips(state.actants, form.type);
    if (recent.length) chips += `<span class="chips-label">最近</span>${recent.map(a => `<button class="chip" data-name="${esc(a.name)}">${esc(a.name)}</button>`).join('')}`;
    if (often.length) chips += `<span class="chips-label">くり返し</span>${often.map(a => `<button class="chip" data-name="${esc(a.name)}">${esc(a.name)}</button>`).join('')}`;
  }
  if (!fromTyping) {
    $('f-names').innerHTML = chips;
    $('f-names').querySelectorAll('[data-name]').forEach(b => b.addEventListener('click', () => {
      form.name = b.dataset.name; $('f-name').value = form.name;
      paintRecordParts();
    }));
    if (form.type === '場所') {
      const c = poiCenter();
      const near = nearbyPlaces(state.actants, c.lat, c.lng).slice(0, 6);
      const lists = { near, poi: poiChoices(near, form.poi), found: form.found || [] };
      $('f-names').querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
        const [l, i] = b.dataset.pick.split(':');
        const x = lists[l] && lists[l][Number(i)];
        if (x) choosePlace(x);
      }));
      if ($('f-unpick')) $('f-unpick').addEventListener('click', unchoosePlace);
      if ($('f-wider')) $('f-wider').addEventListener('click', () => { form.poiRadius = form.poiRadius < 600 ? 600 : 1000; loadPoi(); paintRecordParts(); });
      if ($('f-pick')) $('f-pick').addEventListener('click', () => { form.pickOpen = !form.pickOpen; paintRecordParts(); });
      drawPick();
    }
  }
  // 名前で探す(店を出てから結ぶとき。近くの候補に無い名前を打ったら出す)
  const fb = $('f-find');
  if (fb) {
    const q = form.name.trim();
    const listed = form.type === '場所' && q.length >= 2 && poiCenter().lat != null && !form.poiId;
    fb.innerHTML = listed && !String(form.foundKey).endsWith(`q:${q}`) ? `<button class="btn btn--plain btn--small" id="f-find-go" style="color:var(--color-accent)">「${esc(q)}」を近くで探す</button>` : '';
    if ($('f-find-go')) $('f-find-go').addEventListener('click', () => loadPoi(q));
  }
  // 位置の出どころ
  const pl = $('f-photoloc');
  if (pl) pl.innerHTML = form.exif && form.exif.lat != null && form.lat === form.exif.lat
    ? '<div class="row small"><span class="muted">写真の撮影地を使っています</span><button class="btn btn--plain btn--small" id="f-here" style="margin-left:auto;color:var(--color-accent)">現在地に戻す</button></div>' : '';
  if ($('f-here')) $('f-here').addEventListener('click', () => { form.lat = form.lng = null; Object.assign(form, { poiId: '', poiName: '', poiFrom: null }); form.placeTouched = false; form.place = ''; $('f-place').value = ''; if (form.gps) revGeocode(form.gps.lat, form.gps.lng); paintRecordParts(); });
  // 動詞(種別ごとに並べ替えるだけ。語彙は7語のまま)
  const order = form.type ? VERB_ORDER[form.type] : { main: VERBS, rest: [] };
  const list = form.verbsOpen ? order.main.concat(order.rest) : order.main;
  $('f-verbs').innerHTML = (form.type ? list : VERBS).map(v => `<button class="chip${form.verb === v ? ' is-active' : ''}" data-verb="${v}" aria-pressed="${form.verb === v}">${glyph(VERB_ICON[v], '')}${v}</button>`).join('')
    + (form.type && !form.verbsOpen && order.rest.length ? '<button class="chip" id="f-more" style="color:var(--color-accent)">ほかの動詞</button>' : '');
  $('f-tip').textContent = form.verb ? `${form.verb}: ${VERB_TIPS[form.verb]}${form.verbAuto ? '(おすすめ。押して変えられます)' : ''}` : '';
  $('f-verbs').querySelectorAll('[data-verb]').forEach(b => b.addEventListener('click', () => { form.verb = b.dataset.verb; form.verbAuto = false; paintRecordParts(); }));
  if ($('f-more')) $('f-more').addEventListener('click', () => { form.verbsOpen = true; paintRecordParts(); });
  $('f-send').disabled = !(form.type && form.name.trim());
}

// 写真: 撮影日時と撮影地を EXIF から読み、送る用(長辺1280px)と表示用(240px)に縮める
async function attachPhoto(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const ex = parseExif(buf);
    const bmp = await createImageBitmap(file).catch(() => null);
    const img = bmp || await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    const shrink = (max, q) => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    };
    form.photo = shrink(1280, 0.82);
    form.photoThumb = shrink(360, 0.7);
    form.exif = ex;
    if (ex && ex.date && !form.ts) form.ts = isoLocal(ex.date);
    if (ex && ex.lat != null) { form.lat = ex.lat; form.lng = ex.lng; Object.assign(form, { poiId: '', poiName: '', poiFrom: null }); form.placeTouched = false; form.place = ''; revGeocode(ex.lat, ex.lng); if (form.type === '場所') loadPoi(); }
    paintEventForm();
    if (ex && (ex.date || ex.lat != null)) toast('写真の撮影日時・撮影地を使います');
  } catch (e) { toast(`写真を読めませんでした: ${e.message}`); }
}

async function saveEvent() {
  if (!(form.type && form.name.trim())) return;
  const p = curPos();
  const m = matched();
  const now = isoLocal();
  const rec = {
    id: uuid(), ts: form.ts || now, recorded_ts: now,
    lat: p.lat, lng: p.lng, place: form.place.trim(),
    type: form.type, name: form.name.trim(), aid: m ? m.id : '', verb: form.verb || suggestVerb(form.type, m),
    note: form.note.trim(), star: form.star, tags: '', source: 'home', trace_id: form.trace_id || '', poi_id: form.type === '場所' ? form.poiId : '',
    media: '', photo: form.photo || '', photoThumb: form.trace_id ? '' : (form.photoThumb || ''), pending: true,
  };
  await db.put('events', rec);
  if (form.intent_id) {
    const it = state.intents.find(x => x.id === form.intent_id);
    if (it) await db.put('intents', { ...it, status: 'fulfilled', fulfilled_event_id: rec.id, pending: true });
  }
  await load();
  splash();
  const echo = echoHtml(rec);
  const keepMode = form.mode;
  form = blankForm(); form.mode = keepMode; form.gps = null;
  paintEventForm();
  locate();
  const el = document.getElementById('f-echo');
  if (el) el.innerHTML = `<div class="card ${kcls(rec.type)}"><div class="small muted">結びました: ${esc(rec.name)}・${esc(rec.verb)}</div>${echo}</div>`;
  toast(sync.enabled() ? '結びました。数秒後に縁泉へ届けます' : '結びました(この端末の中に)');
}

function paintIntentForm() {
  const rec = document.getElementById('rec');
  rec.innerHTML = `
    <p class="hint">期限も督促もありません。霧の中に置いておくだけです。</p>
    <div class="card"><input id="i-what" class="field field--name" type="text" placeholder="何を試す？(題名・URL・一言)" value="${esc(form.what)}" autocomplete="off" aria-label="何を試す"></div>
    <div class="sect">なにと(なくてもいい)</div>
    ${typeButtons(form.itype, 'data-itype')}
    <div class="sect">きっかけ</div>
    <div class="card"><div class="chips">${ORIGINS.map(o => `<button class="chip${form.origin === o ? ' is-active' : ''}" data-origin="${o}" aria-pressed="${form.origin === o}">${o}</button>`).join('')}</div>
      <div class="row" style="margin-top:var(--space-2)"><input id="i-oname" type="text" placeholder="きっかけの具体名(なくてもいい)" value="${esc(form.originName)}" style="text-align:left"></div></div>
    <button class="send" id="i-send" ${form.what.trim() ? '' : 'disabled'}>霧の中に置く</button>`;
  const $ = id => document.getElementById(id);
  $('i-what').addEventListener('input', e => { form.what = e.target.value; $('i-send').disabled = !form.what.trim(); });
  $('i-oname').addEventListener('input', e => { form.originName = e.target.value; });
  rec.querySelectorAll('[data-itype]').forEach(b => b.addEventListener('click', () => { form.itype = form.itype === b.dataset.itype ? null : b.dataset.itype; paintIntentForm(); }));
  rec.querySelectorAll('[data-origin]').forEach(b => b.addEventListener('click', () => { form.origin = form.origin === b.dataset.origin ? null : b.dataset.origin; paintIntentForm(); }));
  $('i-send').addEventListener('click', async () => {
    if (!form.what.trim()) return;
    await db.put('intents', { id: uuid(), ts: isoLocal(), what: form.what.trim(), type: form.itype || '', origin: form.origin || '', origin_name: form.originName.trim(), status: 'open', fulfilled_event_id: '', pending: true });
    await load();
    splash();
    Object.assign(form, { what: '', itype: null, origin: null, originName: '' });
    paintIntentForm();
    toast('霧の中に置きました(眺める → 霧の中へ)');
  });
}

// ============================================================
// 眺める
// ============================================================
const LOOKS = [['map', '縁の地図'], ['first', '初出の川'], ['reunion', '再会の川'], ['fog', '霧の中へ'], ['appr', '評価の間'], ['pair', '遠い対'], ['year', '一年をめぐる']];
function renderLook(arg) {
  if (LOOKS.some(l => l[0] === arg)) state.look = arg;
  setTab('look');
  const label = LOOKS.find(l => l[0] === state.look)[1];
  setTitle('眺める', { sub: label });
  $view.innerHTML = `<div class="seg" role="tablist">${LOOKS.map(([k, l]) => `<a class="chip${k === state.look ? ' is-active' : ''}" href="#look/${k}" role="tab" aria-selected="${k === state.look}" style="text-decoration:none">${l}</a>`).join('')}</div><div id="look"></div>`;
  const el = document.getElementById('look');
  if (!state.events.length && state.look !== 'fog') {
    el.innerHTML = `<p class="empty-line">${sync.enabled() ? '縁泉から受け取っています…' : '設定で縁泉ハブにつなぐと、これまでの縁がここに現れます。'}</p>`;
    return;
  }
  ({ map: lookMap, first: lookFirst, reunion: lookReunion, fog: lookFog, appr: lookAppr, pair: lookPair, year: lookYear })[state.look](el);
}

// ---- 縁の地図(国土地理院の淡色地図。Leaflet は使うときだけ読む) ----
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletP = leafletP || new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'vendor/leaflet/leaflet.js'; s.onload = () => res(window.L); s.onerror = () => rej(new Error('地図の部品を読めませんでした')); document.head.appendChild(s);
  });
  return leafletP;
}
let mapObj = null;
const byId = id => document.getElementById(id);
const tmIcon = (L, type, cls = '') => L.divIcon({ html: `<div class="tm ${kcls(type)} ${cls}">${glyph(TYPE_ICON[type] || 'i-place', '')}</div>`, className: kcls(type), iconSize: [26, 26], iconAnchor: [13, 13] });
const meIcon = L => L.divIcon({ html: '<div class="me-dot"></div>', className: '', iconSize: [14, 14], iconAnchor: [7, 7] });
function lookMap(el) {
  const per = state.map.period;
  const groups = spotSuspects(state.rawEvents, state.spotFixes);
  const doubt = new Set(groups.flatMap(g => g.items.map(i => i.aid)));
  const nDoubt = doubt.size;
  const nFixed = [...state.spotFixes.values()].filter(f => f.status === 'move' || f.status === 'hide').length;
  const fix = state.map.fix ? spotTarget(state.map.fix, groups) : null;
  if (state.map.fix && !fix) state.map.fix = null;
  const fixPanel = fix ? spotFixPanel(fix) : '';
  el.innerHTML = `<div class="seg">${[['3m', '3か月'], ['1y', '1年'], ['all', 'すべて']].map(([k, l]) => `<button class="chip${per === k ? ' is-active' : ''}" data-per="${k}"${fix ? ' disabled' : ''}>${l}</button>`).join('')}</div>
    ${!fix && (nDoubt || nFixed) ? `<button class="spot-note" id="spot-check" aria-expanded="${!!state.map.check}"><span>${nDoubt ? `位置の怪しいスポットが <b>${nDoubt}</b> か所あります` : `位置を直したスポット <b>${nFixed}</b> か所`}</span><small>${state.map.check ? 'とじる' : '確かめる'}</small></button>` : ''}
    <div class="map-wrap${fix ? ' map-wrap--fix' : ''}"><div id="map" role="application" aria-label="${fix ? '置き直す場所を押してください' : '縁の地図'}"></div><button class="map-me" id="map-me" aria-label="現在地へ">${glyph('i-pin', '')}</button></div>
    ${fixPanel}
    ${fix ? '' : `<div class="legend">${TYPES.map(t => `<button class="chip ${kcls(t)}${state.map.off.has(t) ? ' is-off' : ''}" data-lg="${t}" aria-pressed="${!state.map.off.has(t)}"><i></i>${t}</button>`).join('')}</div>
    <p class="hint">再訪した場所は、いちばん新しい1点にまとめています。点を押すと、これまでの縁が出ます。</p>`}
    ${!fix && state.map.check ? spotList(groups) : ''}
    <p class="credit">地図: 国土地理院 淡色地図(https://maps.gsi.go.jp/development/ichiran.html)</p>`;
  el.querySelectorAll('[data-per]').forEach(b => b.addEventListener('click', () => { state.map.period = b.dataset.per; lookMap(el); }));
  el.querySelectorAll('[data-lg]').forEach(b => b.addEventListener('click', () => { const t = b.dataset.lg; state.map.off.has(t) ? state.map.off.delete(t) : state.map.off.add(t); lookMap(el); }));
  if (byId('spot-check')) byId('spot-check').addEventListener('click', () => { state.map.check = !state.map.check; lookMap(el); if (state.map.check) setTimeout(() => document.querySelector('.spot-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); });
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openSpotFix(el, b.dataset.open)));
  if (byId('spot-fixed-all')) byId('spot-fixed-all').addEventListener('click', () => { state.map.fixedAll = true; lookMap(el); });
  el.querySelectorAll('[data-allok]').forEach(b => b.addEventListener('click', async () => {
    const g = groups.find(x => x.key === b.dataset.allok);
    if (!g || !confirm(`${g.items.map(i => `「${i.name}」`).join('')}の${g.items.length}か所を、今の位置で正しいことにします。`)) return;
    for (const it of g.items) await putSpotFix(it, 'ok');
    await load(); toast(`${g.items.length}か所を確かめました`); lookMap(el);
  }));
  const from = per === 'all' ? '' : new Date(Date.now() - (per === '3m' ? 92 : 366) * 864e5).toISOString().slice(0, 10);
  const pts = fix ? [] : mapPoints(state.events, { from, types: TYPES.filter(t => !state.map.off.has(t)) });
  loadLeaflet().then(L => {
    if (!document.getElementById('map')) return;
    if (mapObj) { mapObj.remove(); mapObj = null; }
    const map = mapObj = L.map('map', { zoomControl: false, attributionControl: false });
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
    if (fix) { spotFixMap(L, map, el, fix); return; }
    const bounds = [];
    for (const p of pts) {
      const many = p.visits.length > 1;
      const aid = p.visits[0].aid;
      const doubtful = aid && doubt.has(aid);
      const icon = tmIcon(L, p.type, `${many ? 'tm--many' : ''}${doubtful ? ' tm--doubt' : ''}`);
      const visits = p.visits.slice(0, 30).map(v => `<div class="visit"><a href="#day/${dayOf(v.ts)}">${esc(dayOf(v.ts).replace(/-/g, '.'))}</a> ${esc(v.verb)}${v.note ? `<br>${esc(v.note.slice(0, 60))}` : ''}</div>`).join('');
      const tools = aid && p.type === '場所' ? `<div class="pop-tools">${doubtful ? '<span class="pop-doubt">位置が怪しいかもしれません</span>' : p.visits[0].posFix === 'move' ? '<span class="muted">位置を直した場所</span>' : ''}<button class="pop-fix" data-spot="${esc(aid)}">位置を直す</button></div>` : '';
      L.marker([p.lat, p.lng], { icon }).addTo(map).bindPopup(`<b>${esc(p.name)}</b><br><span style="color:#888">${esc(p.type)}${many ? `・${p.visits.length}たび` : ''}</span>${tools}${visits}${p.visits.length > 30 ? '<div class="visit">…</div>' : ''}`, { maxWidth: 260 });
      bounds.push([p.lat, p.lng]);
    }
    map.on('popupopen', e => { const b = e.popup.getElement().querySelector('[data-spot]'); if (b) b.addEventListener('click', () => openSpotFix(el, b.dataset.spot)); });
    const gps = form.gps;
    if (gps) L.marker([gps.lat, gps.lng], { icon: meIcon(L), zIndexOffset: 1000 }).addTo(map);
    if (state.map.view) { map.setView(state.map.view.c, state.map.view.z); state.map.view = null; }
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    else if (bounds.length === 1) map.setView(bounds[0], 13);
    else map.setView([36.2, 138.2], 5);
    bindMapMe(L, map);
  }).catch(e => { const m = document.getElementById('map'); if (m) m.innerHTML = `<p class="empty-line">${esc(e.message)}</p>`; });
}
function bindMapMe(L, map) {
  document.getElementById('map-me').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('現在地に対応していません');
    navigator.geolocation.getCurrentPosition(pos => {
      form.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      L.marker([form.gps.lat, form.gps.lng], { icon: meIcon(L) }).addTo(map);
      map.setView([form.gps.lat, form.gps.lng], 14);
    }, () => toast('現在地を取得できませんでした'), { enableHighAccuracy: true, timeout: 8000 });
  });
}

// ---- スポットの位置を直す ----
// 地図を押す/候補を押す → 「ここにする」。今の位置のまま「正しい」、どこか分からなければ「位置不明」。
// 書くのは spot_fixes への1行の追記だけ(縁泉の events は書き換えない)
const SPOT_REASON = {
  anchor: g => `よく来る「${g.anchor}」の記録点のすぐそばに乗っています。そこから後でチェックインした跡かもしれません。`,
  cluster: g => `別々の${g.items.length}か所が40m以内に重なっています。どこか一か所から、まとめてチェックインした跡かもしれません。`,
  spread: g => `同じ場所の記録どうしが${g.far >= 1000 ? `${(g.far / 1000).toFixed(1)}km` : `${g.far}m`}離れています。`,
};
function spotTarget(aid, groups) {
  const g = groups.find(x => x.items.some(i => i.aid === aid));
  if (g) return { ...g.items.find(i => i.aid === aid), group: g };
  const evs = state.rawEvents.filter(e => e.aid === aid && e.type === '場所' && e.lat != null && e.lat !== '');
  if (!evs.length) return null;
  const top = evs[evs.length - 1];
  return { aid, name: top.name || top.place, events: evs, lat: Number(top.lat), lng: Number(top.lng), group: null };
}
function spotFixPanel(fix) {
  const cur = state.spotFixes.get(fix.aid);
  const cands = state.map.cands = spotCandidates(fix, state.traces, state.placeNames);
  const first = dayOf(fix.events[0].ts), last = dayOf(fix.events[fix.events.length - 1].ts);
  const when = (first === last ? first : `${first}〜${last}`).replace(/-/g, '.');
  const pick = state.map.pick;
  const away = pick ? haversine(fix.lat, fix.lng, pick.lat, pick.lng) : 0;
  return `<div class="card spot-fix" role="region" aria-label="位置を直す">
    <div class="spot-fix__head"><b>${esc(fix.name)}</b><span class="muted small">${esc(when)}${fix.events.length > 1 ? `・${fix.events.length}回` : ''}</span></div>
    <p class="small">${fix.group ? esc(SPOT_REASON[fix.group.reason](fix.group)) + '<br>' : ''}${cur ? `<span class="muted">${cur.status === 'move' ? (cur.source === 'auto' ? '店の名前で地図を引いて、自動で置き直した位置を表示しています。' : '直した位置を表示しています。') : cur.status === 'hide' ? '今は位置不明にしています。' : '確かめ済みです。'}</span><br>` : ''}地図を押すと、そこに置き直せます。</p>
    ${cands.length ? `<div class="spot-cands"><span class="chips-label">置き直す先の候補(その日に写真を撮った場所・ほかの回の位置)</span>${cands.map((c, i) => `<button class="chip${pick && pick.cand === i ? ' is-active' : ''}" data-cand="${i}"><span class="cand-no">${i + 1}</span>${esc(c.label)}</button>`).join('')}</div>` : `<p class="small muted">この日の写真の撮影地は見つかりませんでした。</p>`}
    <p class="small spot-fix__pick" aria-live="polite">${pick ? `今の点から <b>${away >= 1000 ? `${(away / 1000).toFixed(1)}km` : `${Math.round(away)}m`}</b> 離れた所を選んでいます。` : ''}</p>
    <div class="spot-fix__acts">
      <button class="btn btn--prominent btn--small" id="sf-move"${pick ? '' : ' disabled'}>ここにする</button>
      ${cur && cur.status === 'ok' ? '' : '<button class="btn btn--tinted btn--small" id="sf-ok">今の位置で正しい</button>'}
      ${cur && cur.status === 'hide' ? '' : '<button class="btn btn--plain btn--small" id="sf-hide">位置不明にする</button>'}
      ${cur ? '<button class="btn btn--plain btn--small" id="sf-undo">元の位置に戻す</button>' : ''}
      <button class="btn btn--plain btn--small" id="sf-cancel">やめる</button>
    </div>
  </div>`;
}
function spotFixMap(L, map, el, fix) {
  const cur = state.spotFixes.get(fix.aid);
  const bounds = [];
  // 記録されている位置(怪しい点)
  for (const e of fix.events) {
    if (e.lat == null || e.lat === '') continue;
    L.marker([Number(e.lat), Number(e.lng)], { icon: tmIcon(L, '場所', 'tm--doubt'), interactive: false }).addTo(map);
    bounds.push([Number(e.lat), Number(e.lng)]);
  }
  if (cur && cur.status === 'move') { L.marker([cur.lat, cur.lng], { icon: tmIcon(L, '場所', 'tm--fixed'), interactive: false }).addTo(map); bounds.push([cur.lat, cur.lng]); }
  (state.map.cands || []).forEach((c, i) => {
    L.marker([c.lat, c.lng], { icon: L.divIcon({ html: `<div class="cand-dot">${i + 1}</div>`, className: '', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map).on('click', () => setPick(el, { lat: c.lat, lng: c.lng, cand: i }));
    bounds.push([c.lat, c.lng]);
  });
  const pick = state.map.pick;
  if (pick) {
    const m = L.marker([pick.lat, pick.lng], { icon: L.divIcon({ html: '<div class="pick-pin"></div>', className: '', iconSize: [30, 30], iconAnchor: [15, 28] }), draggable: true, zIndexOffset: 1000 }).addTo(map);
    m.on('dragend', () => { const ll = m.getLatLng(); setPick(el, { lat: ll.lat, lng: ll.lng }); });
    bounds.push([pick.lat, pick.lng]);
  }
  if (state.map.view) { map.setView(state.map.view.c, state.map.view.z); state.map.view = null; }
  else if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  else if (bounds.length === 1) map.setView(bounds[0], 15);
  map.on('click', e => setPick(el, { lat: e.latlng.lat, lng: e.latlng.lng }));
  bindMapMe(L, map);
  el.querySelectorAll('[data-cand]').forEach(b => b.addEventListener('click', () => { const c = state.map.cands[Number(b.dataset.cand)]; setPick(el, { lat: c.lat, lng: c.lng, cand: Number(b.dataset.cand) }, true); }));
  const done = async (status, msg) => {
    await putSpotFix(fix, status, state.map.pick);
    await load();
    toast(msg);
    state.map.pick = null;
    // 確かめている途中なら、次の怪しいスポットへ
    const next = state.map.check ? sortSpotGroups(spotSuspects(state.rawEvents, state.spotFixes))[0] : null;
    state.map.fix = next ? next.items[0].aid : null;
    lookMap(el);
  };
  byId('sf-move').addEventListener('click', () => state.map.pick && done('move', `「${fix.name}」を置き直しました`));
  if (byId('sf-ok')) byId('sf-ok').addEventListener('click', () => done('ok', `「${fix.name}」は今の位置のままにします`));
  if (byId('sf-hide')) byId('sf-hide').addEventListener('click', () => done('hide', `「${fix.name}」を位置不明にしました(地図には出ません)`));
  if (byId('sf-undo')) byId('sf-undo').addEventListener('click', () => done('undo', `「${fix.name}」を元の位置に戻しました`));
  byId('sf-cancel').addEventListener('click', () => { state.map.fix = null; state.map.pick = null; lookMap(el); });
}
function setPick(el, pick, pan) {
  // 地図の見え方を保ったまま描き直す
  if (mapObj && !pan) state.map.view = { c: mapObj.getCenter(), z: mapObj.getZoom() };
  else if (pan) state.map.view = { c: [pick.lat, pick.lng], z: Math.max(15, mapObj ? mapObj.getZoom() : 15) };
  state.map.pick = pick;
  lookMap(el);
}
function openSpotFix(el, aid) {
  state.map.fix = aid; state.map.pick = null; state.map.view = null;
  lookMap(el);
  setTimeout(() => document.querySelector('.map-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
async function putSpotFix(item, status, pick) {
  const last = item.events[item.events.length - 1];
  await db.put('spot_fixes', {
    id: uuid(), ts: isoLocal(), aid: item.aid, event_id: last ? last.id : '',
    lat: status === 'move' ? Number(pick.lat.toFixed(6)) : null, lng: status === 'move' ? Number(pick.lng.toFixed(6)) : null,
    status, source: 'home', mtime: Date.now(), pending: true,
  });
}
const SPOT_ORDER = { anchor: 0, cluster: 1, spread: 2 };
const sortSpotGroups = groups => groups.slice().sort((a, b) => SPOT_ORDER[a.reason] - SPOT_ORDER[b.reason] || b.items.length - a.items.length);
// 直したもの(位置不明にしたものは地図に出ないので、ここから元に戻せるように)
function spotFixedList() {
  const name = aid => { const e = state.rawEvents.find(x => x.aid === aid); return e ? (e.name || e.place) : aid; };
  const rows = [...state.spotFixes.values()].filter(f => f.status === 'move' || f.status === 'hide').sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (!rows.length) return '';
  const shown = state.map.fixedAll ? rows : rows.slice(0, 40);
  const auto = rows.filter(f => f.source === 'auto').length;
  return `<div class="card spot-group"><h3>直したスポット ${rows.length}か所${auto ? `(うち店の名前で自動 ${auto})` : ''}</h3>
    ${shown.map(f => `<button class="spot-row" data-open="${esc(f.aid)}"><span><b>${esc(name(f.aid))}</b><small>${f.status === 'hide' ? '位置不明' : f.source === 'auto' ? '店の名前で自動で置き直した' : '置き直した'}・${esc(dayOf(f.ts).replace(/-/g, '.'))}</small></span><span class="spot-row__go">見る</span></button>`).join('')}
    ${rows.length > shown.length ? `<button class="btn btn--plain btn--small" id="spot-fixed-all">ほか${rows.length - shown.length}か所も見る</button>` : ''}
  </div>`;
}
function spotList(groups) {
  const title = { anchor: g => `よく来る「${g.anchor}」のそばに重なっている`, cluster: g => `40m以内に${g.items.length}か所が重なっている`, spread: () => '同じ場所の記録が離れている' };
  const gs = sortSpotGroups(groups);
  return `<section class="spot-list" aria-label="位置の怪しいスポット">
    <p class="hint">Swarmから取り込んだ記録の位置は、チェックインした時のiPhoneの位置です。家などから後でチェックインした場所は、そこに重なって見えます。押して確かめてください。</p>
    ${gs.map(g => `<div class="card spot-group">
      <h3>${esc(title[g.reason](g))}</h3>
      ${g.items.map(i => `<button class="spot-row" data-open="${esc(i.aid)}"><span><b>${esc(i.name)}</b><small>${esc(dayOf(i.events[0].ts).replace(/-/g, '.'))}${i.events.length > 1 ? ` ほか${i.events.length - 1}回` : ''}</small></span><span class="spot-row__go">直す</span></button>`).join('')}
      ${g.items.length > 1 ? `<button class="btn btn--plain btn--small" data-allok="${esc(g.key)}">この${g.items.length}か所はどれも正しい</button>` : ''}
    </div>`).join('')}
    ${spotFixedList()}
  </section>`;
}

// ---- 初出の川 ----
function lookFirst(el) {
  const items = frontier(state.actants, state.events, state.frontierOrder);
  const shown = items.slice(0, state.frontierShown);
  let lastMonth = '';
  const rows = shown.map(a => {
    const mo = a.first.slice(0, 7);
    const head = mo !== lastMonth ? `<div class="month-head">${mo.replace('-', '年')}月</div>` : '';
    lastMonth = mo;
    return `${head}<div class="list-row ${kcls(a.type)}">${glyph(TYPE_ICON[a.type] || 'i-place')}<div class="list-row__main"><div class="list-row__title">${esc(a.name)}</div><div class="list-row__sub"><a href="#day/${a.first}">${esc(a.first.replace(/-/g, '.'))}</a>・${esc(a.type)}</div>${a.note ? `<div class="list-row__note">${esc(a.note.slice(0, 60))}</div>` : ''}</div></div>`;
  }).join('');
  el.innerHTML = `<div class="seg">${[['new', '新しい順'], ['old', '古い順']].map(([k, l]) => `<button class="chip${state.frontierOrder === k ? ' is-active' : ''}" data-ord="${k}">${l}</button>`).join('')}</div>
    <p class="hint">はじめて縁を結んだ順。古い順にすると、最初の地層が現れます。</p>
    <div class="card">${rows || '<p class="empty-line">まだありません。</p>'}</div>
    ${items.length > shown.length ? '<div class="actions"><button class="btn btn--tinted" id="fr-more">さらに辿る</button></div>' : ''}`;
  el.querySelectorAll('[data-ord]').forEach(b => b.addEventListener('click', () => { state.frontierOrder = b.dataset.ord; state.frontierShown = 150; lookFirst(el); }));
  const more = document.getElementById('fr-more');
  if (more) more.addEventListener('click', () => { const y = scrollY; state.frontierShown += 150; lookFirst(el); scrollTo(0, y); });
}

const spanLabel = d => (d < 31 ? `${d}日` : d < 365 ? `${Math.round(d / 30.4)}か月` : `${(d / 365.25).toFixed(1)}年`);
// ---- 再会の川: 共通の時間軸の上に、接触と接触のあいだを弧で結ぶ。間が空くほど高い弧 ----
function lookReunion(el) {
  const arcs = reunions(state.events).slice(0, 60);
  if (!arcs.length) { el.innerHTML = '<p class="empty-line">まだくり返しの縁はありません。</p>'; return; }
  const t0 = new Date(arcs.reduce((m, a) => (a.first < m ? a.first : m), today())).getTime();
  const t1 = Date.now();
  const W = 300, H = 42;
  const x = d => 6 + (W - 12) * (new Date(d).getTime() - t0) / Math.max(1, t1 - t0);
  const maxGap = Math.max(...arcs.map(a => a.gap), 1);
  const row = a => {
    let paths = '';
    for (let i = 1; i < a.days.length; i++) {
      const x0 = x(a.days[i - 1]), x1 = x(a.days[i]);
      if (x1 - x0 < 1) continue;
      const gap = (new Date(a.days[i]) - new Date(a.days[i - 1])) / 864e5;
      const h = 4 + (H - 10) * Math.sqrt(gap / maxGap);
      paths += `<path d="M${x0.toFixed(1)},${H - 4} Q${((x0 + x1) / 2).toFixed(1)},${(H - 4 - 2 * h).toFixed(1)} ${x1.toFixed(1)},${H - 4}"/>`;
    }
    const dots = [...new Set(a.days)].map(d => `<circle cx="${x(d).toFixed(1)}" cy="${H - 4}" r="2.2"/>`).join('');
    return `<div class="list-row arc ${kcls(a.type)}">${glyph(TYPE_ICON[a.type] || 'i-place')}<div class="list-row__main"><div class="list-row__title">${esc(a.name)}</div>
      <div class="list-row__sub">${esc(a.first.replace(/-/g, '.'))} 〜 <a href="#day/${a.last}">${esc(a.last.replace(/-/g, '.'))}</a>${a.gap >= 30 ? `・いちばん長く離れていたのは ${spanLabel(a.gap)}` : ''}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="${H - 4}" x2="${W}" y2="${H - 4}"/>${paths}${dots}</svg></div></div>`;
  };
  el.innerHTML = `<p class="hint">くり返し結ばれた縁。間が空くほど、再会は高く弧を描きます(横軸は最初の縁から今日まで)。</p><div class="card">${arcs.map(row).join('')}</div>`;
}

// ---- 霧の中へ(まだ試していないこと。咎めない) ----
// ブクログ取込の「読みたい」は読書メモで管理している。消さず・状態も変えず、ふだんの一覧から外して折りたたみに入れる
const FOG_STATUS = { fulfilled: '試した', released: '手放した' };
function lookFog(el) {
  const order = (a, b) => (state.fogOrder === 'old' ? sortTs(a, b) : sortTs(b, a));
  const isOpen = i => (i.status || 'open') === 'open';
  const mine = state.intents.filter(i => !isBooklogIntent(i));
  const booklog = state.intents.filter(isBooklogIntent);
  const open = mine.filter(isOpen).sort(order);
  const done = mine.filter(i => !isOpen(i)).sort((a, b) => sortTs(b, a)).slice(0, 30);
  const blOpen = booklog.filter(isOpen).sort(order);
  const blDone = booklog.filter(i => !isOpen(i)).sort((a, b) => sortTs(b, a));
  const row = i => `<div class="list-row ${kcls(i.type)}">${i.type ? glyph(TYPE_ICON[i.type]) : '<span class="glyph"></span>'}<div class="list-row__main">
    <div class="list-row__title">${esc(i.what)}</div>
    <div class="list-row__sub">${esc(dayOf(i.ts).replace(/-/g, '.'))}${i.origin ? `・きっかけ ${esc(i.origin)}${i.origin_name ? `(${esc(i.origin_name)})` : ''}` : ''}${!isOpen(i) ? `・${FOG_STATUS[i.status] || esc(i.status)}` : ''}${i.pending ? ' <span class="badge">未送信</span>' : ''}</div>
    ${isOpen(i) ? `<div class="chips" style="margin-top:var(--space-2)"><a class="chip" href="#record/intent/${encodeURIComponent(i.id)}" style="color:var(--color-accent);text-decoration:none">試した → 縁を結ぶ</a><button class="chip" data-release="${esc(i.id)}">手放す</button></div>` : ''}
    </div></div>`;
  const reading = booklog.length ? `<details class="fold" id="fog-booklog"${state.fogBooklogOpen ? ' open' : ''}><summary>読書メモで管理している読みたい(${booklog.length}件)</summary><div class="fold__body">
      <p class="hint">7月にブクログから取り込んだ「読みたい」です。いまは読書メモで管理しています。ここでも「試した」「手放す」を押せます。</p>
      <div class="chips" style="margin:0 var(--space-4) var(--space-2)"><a class="chip" href="${esc(READING_MEMO_URL)}" target="_blank" rel="noopener" style="color:var(--color-accent);text-decoration:none">読書メモで開く</a><button class="chip" id="fog-csv">一覧を書き出す</button></div>
      <div class="card">${blOpen.concat(blDone).map(row).join('')}</div></div></details>` : '';
  el.innerHTML = `<div class="seg">${[['old', '古い順'], ['new', '新しい順']].map(([k, l]) => `<button class="chip${state.fogOrder === k ? ' is-active' : ''}" data-ord="${k}">${l}</button>`).join('')}<a class="chip" href="#record/try" style="text-decoration:none;margin-left:auto">＋試すことに</a></div>
    <p class="hint">まだ試していない縁。急かすものは何もありません。</p>
    <div class="card">${open.map(row).join('') || '<p class="empty-line">霧はいま晴れています。</p>'}</div>
    ${reading}
    ${done.length ? `<details class="fold"><summary>晴れた霧</summary><div class="fold__body"><div class="card">${done.map(i => `<div class="list-row"><div class="list-row__main"><div class="list-row__title">${esc(i.what)}</div><div class="list-row__sub">${FOG_STATUS[i.status] || esc(i.status)}</div></div></div>`).join('')}</div></div></details>` : ''}`;
  el.querySelectorAll('[data-ord]').forEach(b => b.addEventListener('click', () => { state.fogOrder = b.dataset.ord; lookFog(el); }));
  const fold = el.querySelector('#fog-booklog');
  if (fold) fold.addEventListener('toggle', () => { state.fogBooklogOpen = fold.open; });
  const csv = el.querySelector('#fog-csv');
  if (csv) csv.addEventListener('click', () => shareText(booklogCsv(state.intents), `ensen-booklog-yomitai-${today()}.csv`, 'text/csv').catch(e => alert(`書き出せませんでした: ${e.message || e}`)));
  el.querySelectorAll('[data-release]').forEach(b => b.addEventListener('click', async () => {
    const it = state.intents.find(x => x.id === b.dataset.release);
    if (!it || !confirm(`「${it.what}」を手放しますか？(縁泉の intents に「手放した」と残ります)`)) return;
    await db.put('intents', { ...it, status: 'released', pending: true });
    await load();
    lookFog(el);
  }));
}

// 文字の書類を、iPhone の共有シート(なければダウンロード)へ渡す。UTF-8
async function shareText(text, name, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- 評価の間(見逃していた縁を、ふり返る。褒めない・数えない) ----
function lookAppr(el) {
  const a = state.appr = state.appr && state.appr.i < state.appr.cards.length ? state.appr : { cards: apprQueue(state.events, state.appraisals, 12), i: 0 };
  const c = a.cards[a.i];
  if (!c) { el.innerHTML = '<p class="empty-line">まだ縁がありません。</p>'; return; }
  const prev = latestWeight(state.appraisals, c.id);
  el.innerHTML = `<p class="hint">見逃していた縁を、ふり返る。★を付けても、流してもいい。</p>
    <div class="card appr ${kcls(c.type)}">
      <div class="appr__meta">${glyph(TYPE_ICON[c.type] || 'i-place')}${esc(c.type)}・${esc(c.verb)}・<a href="#day/${dayOf(c.ts)}">${esc(dayOf(c.ts).replace(/-/g, '.'))}</a></div>
      <div class="appr__name">${esc(c.name)}</div>
      <div class="appr__note">${c.note ? esc(c.note) : '<span class="muted">(ことばはまだ無い)</span>'}</div>
      ${prev != null ? `<div class="small muted" style="margin-top:var(--space-2)">前にふり返ったときは ★${prev}</div>` : ''}
      <div class="appr__btns">${[0, 1, 2].map(w => `<button class="btn btn--tinted" data-w="${w}">★${w}</button>`).join('')}<button class="btn btn--plain" data-w="flow">流す</button></div>
    </div>`;
  el.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.w !== 'flow') {
      await db.put('appraisals', { id: uuid(), ts: isoLocal(), target: c.id, weight: Number(b.dataset.w), note: '', pending: true });
      state.appraisals = await db.getAll('appraisals');
    }
    a.i++;
    splash();
    lookAppr(el);
  }));
}

// ---- 遠い対(Gemini を自分のキーで。押したときだけ) ----
async function lookPair(el) {
  const p = state.pair;
  el.innerHTML = `<p class="hint">遠く離れたふたつの縁の間に、問いが架かる。押すと、ランダムに選んだ20件の「名前・種別・ひとこと」だけを Gemini に送ります(日時・場所・座標は送りません)。</p>
    ${p ? `<div class="pair">${[p.a, p.b].map(x => `<div class="pair__card ${kcls(x.type)}">${glyph(TYPE_ICON[x.type] || 'i-place')}<div class="list-row__title">${esc(x.name)}</div><div class="list-row__sub"><a href="#day/${dayOf(x.ts)}">${esc(dayOf(x.ts).replace(/-/g, '.'))}</a>・${esc(x.verb)}</div>${x.note ? `<div class="list-row__note">${esc(x.note.slice(0, 60))}</div>` : ''}</div>`).join('<div class="pair__vs">遠い</div>')}</div><div class="question">${esc(p.question)}</div>` : ''}
    <div class="actions"><button class="btn btn--prominent" id="pair-go">${p ? '別の対を見る' : '遠い対を見る'}</button></div>`;
  document.getElementById('pair-go').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const apiKey = await db.getMeta('geminiKey', '');
    if (!apiKey) { toast('設定で Gemini APIキーを入れてください'); return; }
    btn.disabled = true; btn.textContent = '遠い対を探しています…';
    try {
      const cands = distantCandidates(state.events);
      const text = await gemini.generateJson({ apiKey, model: await db.getMeta('geminiModel', ''), prompt: distantPrompt(cands) });
      state.pair = parseDistant(text, cands);
      if (!state.pair) toast('対をうまく作れませんでした。もう一度どうぞ');
    } catch (err) { toast(err.message, 5000); }
    lookPair(el);
  });
}

// ---- 一年をめぐる(点数ではなく、層・土地・弧の形で去年と並べる) ----
function strataSvg(r) {
  const W = 300, rowH = 34, left = 26;
  const tot = (y, s) => TYPES.reduce((n, t) => n + r.strata[y][s][t], 0);
  const max = Math.max(1, ...SEASONS.flatMap(s => [tot(r.year, s), tot(r.prev, s)]));
  const band = (y, s, top, h, cls) => {
    let x = left;
    return TYPES.map(t => { const w = (r.strata[y][s][t] / max) * (W - left); const out = w > 0 ? `<rect class="${kcls(t)} ${cls}" x="${x.toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${h}" rx="2"/>` : ''; x += w; return out; }).join('');
  };
  const rows = SEASONS.map((s, i) => { const y0 = i * rowH + 4; return `<text x="0" y="${y0 + 12}" class="strata__label">${s}</text>${band(r.year, s, y0, 14, 'strata__now')}${band(r.prev, s, y0 + 17, 7, 'strata__prev')}`; }).join('');
  return `<svg class="strata" viewBox="0 0 ${W} ${SEASONS.length * rowH + 4}" role="img" aria-label="季節ごとの初出の層。太い帯が${r.year}年、細い帯が${r.prev}年">${rows}</svg>`;
}
function lookYear(el) {
  const years = yearsOf(state.events);
  if (!state.year || !years.includes(state.year)) state.year = years[0];
  const r = yearReview(state, state.year);
  const story = yearStory(r);
  const { cleared, open } = r.challenge;
  const iRow = (i, sub) => `<div class="list-row ${kcls(i.type)}">${i.type ? glyph(TYPE_ICON[i.type]) : '<span class="glyph"></span>'}<div class="list-row__main"><div class="list-row__title">${esc(i.what)}</div><div class="list-row__sub">${sub}</div></div></div>`;
  el.innerHTML = `<div class="seg">${years.slice(0, 6).map(y => `<button class="chip${y === state.year ? ' is-active' : ''}" data-year="${y}">${y}年</button>`).join('')}</div>
    <div class="card year-story">${story.map(t => `<p>${esc(t)}</p>`).join('')}</div>
    <h3 class="sec">挑戦 ─ 霧の中へ置き、晴れたもの</h3>
    <div class="card">${cleared.map(i => iRow(i, `<a href="#day/${i.clearedOn}">${esc(i.clearedOn.replace(/-/g, '.'))}</a> に晴れた`)).join('')}${open.map(i => iRow(i, `${esc(dayOf(i.ts).replace(/-/g, '.'))} に置いた・まだ霧の中`)).join('') || (cleared.length ? '' : '<p class="empty-line">この年に置いた試みはありません。</p>')}</div>
    <h3 class="sec">広がり ─ 初めて出会ったものの層</h3>
    <div class="card">${strataSvg(r)}<div class="legend legend--static">${TYPES.map(t => `<span class="chip ${kcls(t)}"><i></i>${t}</span>`).join('')}</div><p class="hint" style="margin:0">太い帯が${r.year}年、細い帯が${r.prev}年。帯の長さは、その季節に初めて出会ったものの多さです。</p></div>
    <h3 class="sec">広がり ─ 初めて足を踏み入れた土地</h3>
    <div class="map-wrap map-wrap--year"><div id="map" role="application" aria-label="${r.year}年に初めて踏んだ土地"></div></div>
    <p class="hint">濃い四角が${r.year}年に初めて縁を結んだ土地(約1km四方)、薄い四角はそれより前から知っていた土地です。</p>
    <h3 class="sec">深まり ─ この年に架かった再会の弧</h3>
    ${(() => { const dRow = a => `<div class="list-row ${kcls(a.type)}">${glyph(TYPE_ICON[a.type] || 'i-place')}<div class="list-row__main"><div class="list-row__title">${esc(a.name)}</div><div class="list-row__sub">${a.gap >= 2 ? `${esc(gapLabel(a.from, a.to))}の再会` : '続けて結んだ'}${a.times > 1 ? `・この年に${a.times}たび` : ''}</div></div></div>`; return `<div class="card">${r.deepen.slice(0, 8).map(dRow).join('') || '<p class="empty-line">この年はまだ弧が架かっていません。</p>'}</div>${r.deepen.length > 8 ? `<details class="fold"><summary>ほかの再会</summary><div class="fold__body"><div class="card">${r.deepen.slice(8, 60).map(dRow).join('')}</div></div></details>` : ''}`; })()}
    <p class="credit">地図: 国土地理院 淡色地図(https://maps.gsi.go.jp/development/ichiran.html)</p>`;
  el.querySelectorAll('[data-year]').forEach(b => b.addEventListener('click', () => { state.year = b.dataset.year; lookYear(el); }));
  loadLeaflet().then(L => {
    if (!document.getElementById('map')) return;
    if (mapObj) { mapObj.remove(); mapObj = null; }
    const map = mapObj = L.map('map', { zoomControl: false, attributionControl: false });
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#3E8E7E';
    for (const c of r.land.before) L.rectangle(meshBounds(c.key), { stroke: false, fillColor: '#8a8f8c', fillOpacity: 0.28 }).addTo(map);
    for (const c of r.land.newY) L.rectangle(meshBounds(c.key), { color: accent, weight: 1, fillColor: accent, fillOpacity: 0.6 }).addTo(map).bindPopup(`<b>${esc(c.label || '')}</b><br><a href="#day/${c.first}">${esc(c.first.replace(/-/g, '.'))}</a> に初めて`);
    const pts = (r.land.newY.length ? r.land.newY.concat(r.land.before) : r.land.cells).map(c => [c.lat, c.lng]);
    if (pts.length > 1) map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
    else if (pts.length === 1) map.setView(pts[0], 13);
    else map.setView([36.2, 138.2], 5);
  }).catch(e => { const m = document.getElementById('map'); if (m) m.innerHTML = `<p class="empty-line">${esc(e.message)}</p>`; });
}

// ============================================================
// 設定
// ============================================================
function syncLine(st) {
  if (st.state === 'off') return '未接続(この端末の中だけに保存)';
  if (st.state === 'syncing') return '同期中…';
  if (st.state === 'error') return `うまく同期できませんでした: ${st.error}`;
  const at = st.lastAt ? new Date(st.lastAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return `同期済み${at ? `(${at})` : ''}${st.pending ? `・未送信 ${st.pending}` : ''}`;
}
let unwatch = null;
function watchSync(el) {
  if (unwatch) { unwatch(); unwatch = null; }
  if (!el) return;
  const paint = st => { el.textContent = syncLine(st); };
  paint(sync.status);
  unwatch = sync.onStatus(paint);
}

const THEME_CARDS = [
  ['auto', 'おまかせ(暦と時刻)', '#F3EEE3', '#A9D2B4'], ['spring', '春', '#F3EEE3', '#A9D2B4'], ['summer', '夏', '#EEF5F3', '#93CAD6'], ['autumn', '秋', '#F4EEE3', '#D9B383'], ['winter', '冬(夜・ダーク)', '#12201F', '#3A5A62'],
];
// 物語「泉のほとりの一年」
function renderStory() {
  setTab('settings');
  setTitle(STORY_TITLE, { back: true, sub: '縁泉の物語' });
  const para = t => `<p>${esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
  $view.innerHTML = `<article class="story">
    <p class="story__lead">${esc(STORY_LEAD)}</p>
    ${STORY.map(([h, ps]) => `<section><h2>${esc(h)}</h2>${ps.map(para).join('')}</section>`).join('')}
    <div class="actions"><a class="btn btn--tinted" href="#settings" style="text-decoration:none">設定へ戻る</a></div>
  </article>`;
}

async function renderSettings(arg) {
  if (arg === 'story') return renderStory();
  setTab('settings');
  setTitle('設定');
  const [url, token, key, model, lastBackupAt, placesKey] = await Promise.all([db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('geminiKey', ''), db.getMeta('geminiModel', ''), db.getMeta('lastBackupAt', ''), db.getMeta('placesKey', '')]);
  const pref = themePref();
  const errors = state.events.filter(e => e.error);
  $view.innerHTML = `
    <a class="card story-link" href="#settings/story"><span class="story-link__title">縁泉の物語 ─ ${esc(STORY_TITLE)}</span><span class="story-link__sub">縁泉を使う一人の一年。何を考え、何をして、何ができるかを場面で語ります</span></a>

    <details class="fold" ${url ? '' : 'open'}><summary>縁泉ハブ(同期)<small id="sync-short">${url ? 'つないでいます' : '未接続'}</small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="s-url">URL</label><input id="s-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(url)}" autocomplete="off"></div>
        <div class="row"><label for="s-token">合言葉</label><input id="s-token" type="password" value="${esc(token)}" autocomplete="off"></div>
      </div>
      <p class="hint" id="sync-line" aria-live="polite"></p>
      <div class="actions"><button class="btn btn--prominent" id="s-connect">${url ? 'つなぎ直して同期' : '接続して同期する'}</button>${url ? '<button class="btn btn--tinted" id="s-now">いま同期</button>' : ''}</div>
      ${errors.length ? `<div class="card small">ハブに断られた縁(語彙の外など)が ${errors.length} 件あります。<br>${errors.slice(0, 5).map(e => `${esc(dayOf(e.ts))} ${esc(e.name)}: ${esc(e.error)}`).join('<br>')}</div>` : ''}
      <p class="hint">いまの縁泉スプレッドシート(ensen)がそのままハブです。縁泉のGASアプリ・iOSショートカット・夜間エンリッチで入った縁も、ここに届きます。準備の手順は <a href="https://github.com/tadamasa/ensen-home/blob/main/hub/README.md" target="_blank" rel="noopener">hub/README.md</a>。</p>
      ${url ? '<div class="actions"><button class="btn btn--plain" id="s-disconnect" style="color:var(--color-destructive)">接続をやめる</button></div>' : ''}
    </div></details>

    <details class="fold"><summary>泉の四季</summary><div class="fold__body">
      <div class="card"><div class="themes">${THEME_CARDS.map(([k, l, bg, w]) => `<button class="tcard${pref === k ? ' is-active' : ''}" data-theme-pref="${k}" aria-pressed="${pref === k}"><svg viewBox="0 0 100 56" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="56" fill="${bg}"/><path d="M-4,30 C16,26 36,34 56,30 C76,26 96,34 106,30" fill="none" stroke="${w}" stroke-width="2.4"/><path d="M-4,42 C20,38 44,46 68,42 C84,39 98,44 106,42" fill="none" stroke="${w}" stroke-width="2.4" opacity=".6"/></svg><span>${l}</span></button>`).join('')}</div></div>
      <p class="hint">景色は暦と時刻だけで移ろいます。記録の中身や量では変わりません。おまかせでは、iPhoneがダークモードのときは冬になります。</p>
    </div></details>

    <details class="fold"><summary>Gemini(遠い対)<small>${key ? 'キーあり' : 'キーなし'}</small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="s-key">APIキー</label><input id="s-key" type="password" value="${esc(key)}" autocomplete="off" placeholder="AIza…"></div>
        <div class="row"><label for="s-model">モデル</label><input id="s-model" type="text" value="${esc(model)}" placeholder="${gemini.DEFAULT_MODEL}" autocomplete="off"></div>
      </div>
      <p class="hint">キーはこの端末の中だけに置き、バックアップにも入れません。無料枠では送った内容がGoogleの製品改善に使われることがあります。送るのは「遠い対を見る」を押したときの20件の名前・種別・ひとことだけです。</p>
      <div class="actions"><button class="btn btn--tinted" id="s-save-ai">保存</button></div>
    </div></details>

    <details class="fold"><summary>Google Places(近くの場所)<small>${placesKey ? 'キーあり' : 'キーなし'}</small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="s-pkey">APIキー</label><input id="s-pkey" type="password" value="${esc(placesKey)}" autocomplete="off" placeholder="AIza…"></div>
      </div>
      <p class="hint">入れると、結ぶで「場所」を選んだとき、OpenStreetMap の候補に Google の候補を足します(この端末から直接)。キーはこの端末の中だけに置き、バックアップにも入れません。Google Cloud でキーを「API: Places API (New)」に絞り、できれば「HTTP リファラー: https://tadamasa.github.io/*」も付けてください(ブラウザが送るリファラーで確かめられます。「試す」で断られたら、リファラーの制限だけ外してください)。近くの検索は月5,000回まで無料です。</p>
      <div class="actions"><button class="btn btn--tinted" id="s-save-places">保存</button><button class="btn btn--plain" id="s-test-places">試す</button></div>
      <p class="hint" id="s-places-result" aria-live="polite"></p>
    </div></details>

    <details class="fold"><summary>バックアップ<small>${lastBackupAt ? new Date(lastBackupAt).toLocaleDateString('ja-JP') : ''}</small></summary><div class="fold__body">
      <p class="hint">縁・試す・評価・台帳をJSONにして、共有シートから「ファイル」(iCloud Drive)に保存します。写真の痕跡は縁泉シートに残っているので入れません。</p>
      <div class="actions"><button class="btn btn--tinted" id="s-export">書き出す</button><label class="btn btn--plain" for="s-import" style="color:var(--color-accent)">読み込む</label><input id="s-import" type="file" accept="application/json,.json" hidden></div>
    </div></details>

    <details class="fold"><summary>このアプリについて</summary><div class="fold__body"><div class="card small" style="line-height:20px">
      縁泉は「縁の生起」(人・場所・作品・モノ・食 × 関係動詞7語)を記録します。語彙は凍結、スコア・連続記録・通知はありません。<br><br>
      データは端末の中(IndexedDB)が正本で、圏外でも開けて書けます。縁と評価は追記だけ、試すの状態は本人が押したときだけ変わります。<br><br>
      手元にある縁 ${state.events.length}・台帳 ${state.actants.length}・写真の痕跡 ${state.traces.length}
    </div></div></details>`;
  watchSync(document.getElementById('sync-line'));
  const $ = id => document.getElementById(id);
  $('s-connect').addEventListener('click', async () => {
    const u = $('s-url').value.trim(), t = $('s-token').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) { toast('Apps Script のウェブアプリURL(…/exec)を入れてください'); return; }
    if (!t) { toast('合言葉を入れてください'); return; }
    toast('はじめての同期は、これまでの縁を全部受け取るので少しかかります', 4000);
    await sync.connect(u, t);
    if (sync.status.state === 'idle') toast('つながりました');
    renderSettings();
  });
  if ($('s-now')) $('s-now').addEventListener('click', () => sync.syncNow());
  if ($('s-disconnect')) $('s-disconnect').addEventListener('click', async () => { if (!confirm('この端末と縁泉ハブの接続をやめますか？(端末の中のデータは消えません)')) return; await sync.disconnect(); renderSettings(); });
  $view.querySelectorAll('[data-theme-pref]').forEach(b => b.addEventListener('click', () => { try { localStorage.setItem('ensen_theme', b.dataset.themePref); } catch { /* 保存できなくても今回だけは効く */ } applyTheme(); renderSettings().then(() => { document.querySelectorAll('.fold')[1].open = true; }); }));
  $('s-save-places').addEventListener('click', async () => { await db.setMeta('placesKey', $('s-pkey').value.trim()); toast('保存しました'); });
  $('s-test-places').addEventListener('click', () => {
    const out = $('s-places-result');
    const apiKey = $('s-pkey').value.trim();
    if (!apiKey) { out.textContent = 'キーを入れてください'; return; }
    out.textContent = '現在地のまわりを引いています…';
    navigator.geolocation.getCurrentPosition(pos => {
      places.searchPlaces({ apiKey, lat: pos.coords.latitude, lng: pos.coords.longitude, radius: 300 })
        .then(g => { out.textContent = g.length ? `通りました。${g.length}件: ${g.slice(0, 5).map(x => x.name).join('、')}…` : '通りましたが、300m以内に見つかりませんでした'; })
        .catch(e => { out.textContent = `うまくいきませんでした: ${e.message}`; });
    }, () => { out.textContent = '現在地がわかりませんでした'; }, { timeout: 8000, maximumAge: 60000 });
  });
  $('s-save-ai').addEventListener('click', async () => { await db.setMeta('geminiKey', $('s-key').value.trim()); await db.setMeta('geminiModel', $('s-model').value.trim()); toast('保存しました'); });
  $('s-export').addEventListener('click', async () => { try { if (await exportData()) toast('書き出しました'); } catch (e) { toast(e.message); } });
  $('s-import').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { const n = await importData(await f.text()); await load(); toast(`${n}件を取り込みました`); } catch (err) { toast(err.message, 4000); }
  });
}

// ============================================================
// ルーティング
// ============================================================
async function route() {
  const [name, arg, arg2] = location.hash.replace(/^#/, '').split('/').map(x => (x ? decodeURIComponent(x) : ''));
  if (name !== 'day') window.scrollTo(0, 0);
  watchSync(null);
  if (mapObj && !(name === 'look' && ['map', 'year'].includes(arg || state.look))) { mapObj.remove(); mapObj = null; }
  const tab = name || 'day';
  if (state.lastTab && state.lastTab !== tab && !reduceMotion()) { $view.classList.remove('view-enter'); void $view.offsetWidth; $view.classList.add('view-enter'); }
  state.lastTab = tab;
  switch (name) {
    case 'record': return renderRecord(arg, arg2);
    case 'look': return renderLook(arg);
    case 'settings': return renderSettings(arg);
    default: return renderDay(arg);
  }
}

document.getElementById('back').addEventListener('click', () => history.back());
addEventListener('hashchange', () => {
  const keep = location.hash.startsWith('#day/');
  const y = scrollY;
  route().then(() => { if (keep) scrollTo(0, Math.min(y, 240)); });
});

const nav = document.getElementById('nav');
const sentinel = document.createElement('div');
sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
document.body.prepend(sentinel);
new IntersectionObserver(([e]) => nav.classList.toggle('is-collapsed', !e.isIntersecting), { threshold: 0 }).observe(sentinel);

// ハブから受け取ったら読み直す。入力中・地図を見ているときは画面を作り直さない
async function onRemoteChange() {
  await load();
  const a = document.activeElement;
  const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  const h = location.hash;
  if (typing || h.startsWith('#record') || h.startsWith('#look/map') || (h.startsWith('#look') && state.look === 'map')) return;
  if (h.startsWith('#look/appr') || h.startsWith('#look/pair')) return;
  const y = scrollY; await route(); scrollTo(0, y);
}

(async function start() {
  applyTheme();
  setInterval(applyTheme, 5 * 60 * 1000);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  // 縁泉のGASや日記から ?trace=ID で開かれたら、その痕跡を縁にする画面へ
  const q = new URLSearchParams(location.search);
  if (q.get('trace')) { history.replaceState(null, '', `${location.pathname}#record/trace/${encodeURIComponent(q.get('trace'))}`); }
  await load();
  db.requestPersist();
  // Safariのタブはホーム画面のアプリと保存場所が別で、使わないと7日で消える
  if (!(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) document.getElementById('tab-warning').hidden = false;
  await sync.initSync({ onRemoteChange });
  route();
  sync.schedule(300);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { applyTheme(); sync.schedule(300); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

window.__app = { state, get form() { return form; } };
