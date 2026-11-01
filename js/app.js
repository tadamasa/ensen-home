import { STORY, STORY_TITLE, STORY_LEAD } from './story.js';
import * as db from './db.js';
import * as sync from './sync.js';
import * as gemini from './gemini.js';
import { exportData, importData } from './backup.js';
import {
  TYPES, VERBS, ORIGINS, TYPE_KEY, TYPE_ICON, VERB_ICON, VERB_ORDER, VERB_TIPS,
  esc, uuid, isoLocal, today, isDate, dayOf, timeOf, toInputValue, fromInputValue, shiftMonth, monthCells, dateLabel, gapLabel, autoSeason,
  findActant, suggestVerb, nearbyPlaces, nameChips, isHomeMove, homeKind, echoOf,
  frontier, reunions, apprQueue, yearReview, yearStory, yearsOf, SEASONS, meshBounds, latestWeight, mapPoints, distantCandidates, distantPrompt, parseDistant, parseExif,
} from './ensen.js';

// ---------- 状態 ----------
const state = { events: [], intents: [], appraisals: [], actants: [], traces: [], around: {}, look: 'map', appr: null, pair: null, frontierOrder: 'new', frontierShown: 150, fogOrder: 'old', map: { period: '1y', off: new Set() } };
const blankForm = () => ({ mode: 'event', ts: '', lat: null, lng: null, gps: null, place: '', placeTouched: false, type: null, name: '', verb: null, verbAuto: true, verbsOpen: false, star: false, note: '', photo: '', photoThumb: '', exif: null, trace_id: '', intent_id: '', poi: null, what: '', origin: null, originName: '', itype: null });
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
  const [events, intents, appraisals, actants, traces] = await Promise.all(['events', 'intents', 'appraisals', 'actants', 'traces'].map(s => db.getAll(s)));
  state.events = events.sort(sortTs);
  state.intents = intents.sort(sortTs);
  state.appraisals = appraisals;
  state.actants = actants;
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
    const dots = i ? TYPES.filter(x => i.types.has(x)).map(x => `<i class="${kcls(x)}"></i>`).join('') : '';
    const cls = ['cal__cell', d === t ? 'is-today' : '', d === date ? 'is-selected' : '', i && i.trace ? 'has-trace' : ''].join(' ');
    const label = `${Number(d.slice(8))}日${i && i.types.size ? '、縁あり' : ''}${i && i.trace ? '、写真の痕跡あり' : ''}`;
    return `<a class="${cls}" href="#day/${d}" aria-label="${label}"${d === date ? ' aria-current="date"' : ''}>${Number(d.slice(8))}<span class="cal__dots">${dots}</span></a>`;
  }).join('');
  const [y, m] = ym.split('-').map(Number);
  return `<div class="card cal">
    <div class="cal__head">
      <a class="cal__nav" href="#day/${shiftMonth(ym, -1)}-01" aria-label="前の月" style="display:flex;align-items:center;justify-content:center;text-decoration:none">‹</a>
      <span class="cal__label">${y}年${m}月</span>
      <a class="cal__nav" href="#day/${shiftMonth(ym, 1)}-01" aria-label="次の月" style="display:flex;align-items:center;justify-content:center;text-decoration:none">›</a>
    </div>
    <div class="cal__grid cal__week" aria-hidden="true"><span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span></div>
    <div class="cal__grid">${cells}</div>
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
const thumbSrc = t => (t && t.thumb ? `data:image/jpeg;base64,${t.thumb}` : '');

function eventNode(e) {
  const tr = e.trace_id ? traceById(e.trace_id) : null;
  const img = e.photoThumb || thumbSrc(tr);
  const meta = [
    e.star ? '<span class="star" aria-label="後で効く印">★</span>' : '',
    e.media ? `<a href="${esc(e.media)}" target="_blank" rel="noopener">写真(Drive)</a>` : '',
    e.error ? `<span class="badge badge--warn">ハブに断られました: ${esc(e.error)}</span>` : (e.pending ? '<span class="badge">未送信</span>' : ''),
    e.source && e.source !== 'home' && e.source !== 'app' ? `<span class="badge">${esc(e.source)}</span>` : '',
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

function traceNode(t, promoted) {
  return `<div class="node node--trace">
    <span class="node__dot">${glyph('i-pin', '')}</span>
    <div class="node__time">${esc(timeOf(t.ts))}・写真の痕跡</div>
    <div class="trace-card${promoted ? ' is-promoted' : ''}">
      ${t.thumb ? `<img src="${thumbSrc(t)}" alt="この時刻に撮った写真">` : '<span class="ph"></span>'}
      <div class="trace-card__text">${esc(t.place || '場所の名前なし')}<br><span class="muted small">${promoted ? '縁にしました' : 'まだ痕跡のまま'}</span></div>
      ${promoted ? '' : `<a class="btn btn--tinted btn--small" href="#record/trace/${encodeURIComponent(t.id)}">縁にする</a>`}
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
      ? `<div class="node node--home"><span class="node__dot"></span><div class="node__time">${esc(timeOf(e.ts))} 家に${homeKind(e) === '出発' ? 'いってきます' : 'ただいま'}</div></div>`
      : eventNode(e) })),
    ...state.traces.filter(t => dayOf(t.ts) === date && !promoted.has(t.id)).map(t => ({ ts: t.ts, html: traceNode(t, false) })),
  ].sort(sortTs);
  const quiet = !items.length;
  $view.innerHTML = `
    ${calendarHtml(date)}
    <div class="day-head"><h2>${dateLabel(date)}</h2><a class="btn btn--tinted btn--small" href="#record/date/${date}">この日に結ぶ</a></div>
    ${quiet ? '<p class="empty-line">静かな水面。</p>' : `<div class="flow">${items.map(i => i.html).join('')}</div>`}
    <div class="around" id="around"></div>`;
  renderAround(date);
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
  const diary = (d.diary && d.diary.entries) || [];
  if (diary.length) parts.push(`<div class="sect">この日の日記<small><a href="${esc(d.diary.url)}" target="_blank" rel="noopener">日記で開く</a></small></div>
    <div class="card">${diary.map(x => `<div class="diary-line"><div class="diary-line__time">${esc(x.time)}${x.feelings ? `・${esc(x.feelings)}` : ''}</div><p class="diary-line__text">${esc(x.text)}</p></div>`).join('')}</div>`);
  const books = (d.books && d.books.books) || [];
  const films = (d.films && d.films.films) || [];
  if (books.length || films.length) parts.push(`<div class="sect">この日に読み終えた本・観た映画</div><div class="card">
    ${books.map(b => `<a class="mini" href="${esc(b.url)}" target="_blank" rel="noopener">${b.cover ? `<img src="${esc(b.cover)}" alt="">` : '<img alt="">'}<span><span class="list-row__title">${esc(b.title)}</span><br><span class="muted small">${esc(b.author)}</span></span></a>`).join('')}
    ${films.map(f => `<a class="mini" href="${esc(f.url)}" target="_blank" rel="noopener"><img alt=""><span><span class="list-row__title">${esc(f.title)}</span><br><span class="muted small">${esc(f.venue || '映画')}</span></span></a>`).join('')}
  </div>`);
  el.innerHTML = parts.join('');
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
async function loadPoi() {
  const p = form.gps;
  if (!p || !sync.enabled() || form.poi) return;
  form.poi = [];
  const timeout = new Promise(r => setTimeout(() => r(null), 2500)); // 間に合わなければ静かに諦める
  const r = await Promise.race([sync.ask('poi', { lat: p.lat, lng: p.lng }).catch(() => null), timeout]);
  if (r && r.poi) { form.poi = r.poi; if (location.hash.startsWith('#record') && form.type === '場所') paintRecordParts(); }
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
      Object.assign(form, { ts: t.ts, lat: t.lat, lng: t.lng, place: t.place, placeTouched: !!t.place, photoThumb: thumbSrc(t), trace_id: t.id });
      if (!t.place && t.lat != null) revGeocode(t.lat, t.lng);
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
    const p = curPos();
    const near = nearbyPlaces(state.actants, p.lat, p.lng).slice(0, 6);
    const seen = new Set(near.map(a => a.name));
    const poi = (form.poi || []).filter(x => !seen.has(x.name)).slice(0, 6);
    if (near.length) chips += `<span class="chips-label">近くの、前に結んだ場所</span>${near.map(a => `<button class="chip" data-name="${esc(a.name)}" data-lat="${a.lat}" data-lng="${a.lng}">${esc(a.name)} <small>${a.dist}m</small></button>`).join('')}`;
    if (poi.length) chips += `<span class="chips-label">近くの場所</span>${poi.map(x => `<button class="chip" data-name="${esc(x.name)}" data-lat="${x.lat}" data-lng="${x.lng}">${esc(x.name)}</button>`).join('')}`;
  } else if (form.type) {
    const { recent, often } = nameChips(state.actants, form.type);
    if (recent.length) chips += `<span class="chips-label">最近</span>${recent.map(a => `<button class="chip" data-name="${esc(a.name)}">${esc(a.name)}</button>`).join('')}`;
    if (often.length) chips += `<span class="chips-label">くり返し</span>${often.map(a => `<button class="chip" data-name="${esc(a.name)}">${esc(a.name)}</button>`).join('')}`;
  }
  if (!fromTyping) {
    $('f-names').innerHTML = chips;
    $('f-names').querySelectorAll('[data-name]').forEach(b => b.addEventListener('click', () => {
      form.name = b.dataset.name; $('f-name').value = form.name;
      if (b.dataset.lat && b.dataset.lat !== 'null' && b.dataset.lat !== 'undefined') {
        // 候補の地点を採る(GPSの誤差を吸収)。場所の名前も合わせる
        form.lat = Number(b.dataset.lat); form.lng = Number(b.dataset.lng);
        if (!form.placeTouched) { form.place = form.name; $('f-place').value = form.place; }
      }
      paintRecordParts();
    }));
  }
  // 位置の出どころ
  const pl = $('f-photoloc');
  if (pl) pl.innerHTML = form.exif && form.exif.lat != null && form.lat === form.exif.lat
    ? '<div class="row small"><span class="muted">写真の撮影地を使っています</span><button class="btn btn--plain btn--small" id="f-here" style="margin-left:auto;color:var(--color-accent)">現在地に戻す</button></div>' : '';
  if ($('f-here')) $('f-here').addEventListener('click', () => { form.lat = form.lng = null; form.placeTouched = false; form.place = ''; $('f-place').value = ''; if (form.gps) revGeocode(form.gps.lat, form.gps.lng); paintRecordParts(); });
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
    if (ex && ex.lat != null) { form.lat = ex.lat; form.lng = ex.lng; form.placeTouched = false; form.place = ''; revGeocode(ex.lat, ex.lng); }
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
    note: form.note.trim(), star: form.star, tags: '', source: 'home', trace_id: form.trace_id || '',
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
function lookMap(el) {
  const per = state.map.period;
  el.innerHTML = `<div class="seg">${[['3m', '3か月'], ['1y', '1年'], ['all', 'すべて']].map(([k, l]) => `<button class="chip${per === k ? ' is-active' : ''}" data-per="${k}">${l}</button>`).join('')}</div>
    <div class="map-wrap"><div id="map" role="application" aria-label="縁の地図"></div><button class="map-me" id="map-me" aria-label="現在地へ">${glyph('i-pin', '')}</button></div>
    <div class="legend">${TYPES.map(t => `<button class="chip ${kcls(t)}${state.map.off.has(t) ? ' is-off' : ''}" data-lg="${t}" aria-pressed="${!state.map.off.has(t)}"><i></i>${t}</button>`).join('')}</div>
    <p class="hint">再訪した場所は、いちばん新しい1点にまとめています。点を押すと、これまでの縁が出ます。</p>
    <p class="credit">地図: 国土地理院 淡色地図(https://maps.gsi.go.jp/development/ichiran.html)</p>`;
  el.querySelectorAll('[data-per]').forEach(b => b.addEventListener('click', () => { state.map.period = b.dataset.per; lookMap(el); }));
  el.querySelectorAll('[data-lg]').forEach(b => b.addEventListener('click', () => { const t = b.dataset.lg; state.map.off.has(t) ? state.map.off.delete(t) : state.map.off.add(t); lookMap(el); }));
  const from = per === 'all' ? '' : new Date(Date.now() - (per === '3m' ? 92 : 366) * 864e5).toISOString().slice(0, 10);
  const pts = mapPoints(state.events, { from, types: TYPES.filter(t => !state.map.off.has(t)) });
  loadLeaflet().then(L => {
    if (!document.getElementById('map')) return;
    if (mapObj) { mapObj.remove(); mapObj = null; }
    const map = mapObj = L.map('map', { zoomControl: false, attributionControl: false });
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
    const bounds = [];
    for (const p of pts) {
      const many = p.visits.length > 1;
      const icon = L.divIcon({ html: `<div class="tm ${kcls(p.type)}${many ? ' tm--many' : ''}">${glyph(TYPE_ICON[p.type] || 'i-place', '')}</div>`, className: kcls(p.type), iconSize: [26, 26], iconAnchor: [13, 13] });
      const visits = p.visits.slice(0, 30).map(v => `<div class="visit"><a href="#day/${dayOf(v.ts)}">${esc(dayOf(v.ts).replace(/-/g, '.'))}</a> ${esc(v.verb)}${v.note ? `<br>${esc(v.note.slice(0, 60))}` : ''}</div>`).join('');
      L.marker([p.lat, p.lng], { icon }).addTo(map).bindPopup(`<b>${esc(p.name)}</b><br><span style="color:#888">${esc(p.type)}${many ? `・${p.visits.length}たび` : ''}</span>${visits}${p.visits.length > 30 ? '<div class="visit">…</div>' : ''}`, { maxWidth: 260 });
      bounds.push([p.lat, p.lng]);
    }
    const gps = form.gps;
    if (gps) L.marker([gps.lat, gps.lng], { icon: L.divIcon({ html: '<div class="me-dot"></div>', className: '', iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: 1000 }).addTo(map);
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    else if (bounds.length === 1) map.setView(bounds[0], 13);
    else map.setView([36.2, 138.2], 5);
    document.getElementById('map-me').addEventListener('click', () => {
      if (!navigator.geolocation) return toast('現在地に対応していません');
      navigator.geolocation.getCurrentPosition(pos => {
        form.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        L.marker([form.gps.lat, form.gps.lng], { icon: L.divIcon({ html: '<div class="me-dot"></div>', className: '', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(map);
        map.setView([form.gps.lat, form.gps.lng], 14);
      }, () => toast('現在地を取得できませんでした'), { enableHighAccuracy: true, timeout: 8000 });
    });
  }).catch(e => { const m = document.getElementById('map'); if (m) m.innerHTML = `<p class="empty-line">${esc(e.message)}</p>`; });
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
function lookFog(el) {
  const open = state.intents.filter(i => (i.status || 'open') === 'open');
  open.sort((a, b) => (state.fogOrder === 'old' ? sortTs(a, b) : sortTs(b, a)));
  const done = state.intents.filter(i => i.status && i.status !== 'open').sort((a, b) => sortTs(b, a)).slice(0, 30);
  const row = i => `<div class="list-row ${kcls(i.type)}">${i.type ? glyph(TYPE_ICON[i.type]) : '<span class="glyph"></span>'}<div class="list-row__main">
    <div class="list-row__title">${esc(i.what)}</div>
    <div class="list-row__sub">${esc(dayOf(i.ts).replace(/-/g, '.'))}${i.origin ? `・きっかけ ${esc(i.origin)}${i.origin_name ? `(${esc(i.origin_name)})` : ''}` : ''}${i.pending ? ' <span class="badge">未送信</span>' : ''}</div>
    ${i.status === 'open' || !i.status ? `<div class="chips" style="margin-top:var(--space-2)"><a class="chip" href="#record/intent/${encodeURIComponent(i.id)}" style="color:var(--color-accent);text-decoration:none">試した → 縁を結ぶ</a><button class="chip" data-release="${esc(i.id)}">手放す</button></div>` : ''}
    </div></div>`;
  el.innerHTML = `<div class="seg">${[['old', '古い順'], ['new', '新しい順']].map(([k, l]) => `<button class="chip${state.fogOrder === k ? ' is-active' : ''}" data-ord="${k}">${l}</button>`).join('')}<a class="chip" href="#record/try" style="text-decoration:none;margin-left:auto">＋試すことに</a></div>
    <p class="hint">まだ試していない縁。急かすものは何もありません。</p>
    <div class="card">${open.map(row).join('') || '<p class="empty-line">霧はいま晴れています。</p>'}</div>
    ${done.length ? `<details class="fold"><summary>晴れた霧</summary><div class="fold__body"><div class="card">${done.map(i => `<div class="list-row"><div class="list-row__main"><div class="list-row__title">${esc(i.what)}</div><div class="list-row__sub">${i.status === 'fulfilled' ? '試した' : '手放した'}</div></div></div>`).join('')}</div></div></details>` : ''}`;
  el.querySelectorAll('[data-ord]').forEach(b => b.addEventListener('click', () => { state.fogOrder = b.dataset.ord; lookFog(el); }));
  el.querySelectorAll('[data-release]').forEach(b => b.addEventListener('click', async () => {
    const it = state.intents.find(x => x.id === b.dataset.release);
    if (!it || !confirm(`「${it.what}」を手放しますか？(縁泉の intents に「手放した」と残ります)`)) return;
    await db.put('intents', { ...it, status: 'released', pending: true });
    await load();
    lookFog(el);
  }));
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
  const [url, token, key, model, lastBackupAt] = await Promise.all([db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('geminiKey', ''), db.getMeta('geminiModel', ''), db.getMeta('lastBackupAt', '')]);
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
