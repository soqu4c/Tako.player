'use strict';

// The shell around the player: settings, views, library, timeline preview and auto-hiding
// controls. Runs after renderer.js and uses its globals (state, video, api, $, fmt, ...).

const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|ac3|dts|mka)$/i;
const collatorRu = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

function fmtSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1).replace('.', ',') + ' ГБ';
  return Math.max(1, Math.round(bytes / 1048576)) + ' МБ';
}

function bump(el) {
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

// ---------- settings

const ACCENTS = {
  salsa: ['#ff5a47', '#ff9a4a', 'Сальса'],
  berry: ['#ff4f8b', '#ff7a5c', 'Ягода'],
  grape: ['#9b6bff', '#d46bff', 'Виноград'],
  ocean: ['#3d8bff', '#3fd0ff', 'Океан'],
  lime: ['#2fc48d', '#9be15d', 'Лайм'],
};
const SUB_SIZES = { s: '1em', m: '1.25em', l: '1.55em', xl: '1.9em' };
const SUB_BGS = { none: 'transparent', soft: 'rgba(0, 0, 0, .45)', solid: 'rgba(0, 0, 0, .85)' };
const DEFAULTS = {
  resume: true, autoplay: true, autoNext: true, seekStep: 5,
  accent: 'salsa', preview: true, hideDelay: 2.5, motion: true, splash: true,
  subSize: 'm', subColor: '#ffffff', subBg: 'soft', obsNames: true,
};
const settings = { ...DEFAULTS, ...recall('settings', {}) };

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}`;
}

function applySettings() {
  const root = document.documentElement.style;
  const [a, b] = ACCENTS[settings.accent] || ACCENTS.salsa;
  root.setProperty('--accent', a);
  root.setProperty('--accent-2', b);
  root.setProperty('--accent-rgb', hexRgb(a));
  root.setProperty('--sub-size', SUB_SIZES[settings.subSize] || SUB_SIZES.m);
  root.setProperty('--sub-color', settings.subColor);
  root.setProperty('--sub-bg', SUB_BGS[settings.subBg] || SUB_BGS.soft);
  document.body.classList.toggle('no-motion', !settings.motion);
}

function setSetting(key, value) {
  settings[key] = value;
  store('settings', settings);
  applySettings();
  if (key === 'obsNames' && state.info) refreshTrackLabels();
}

// Marks a data action as done right on its button (toasts sit behind the modal)
function done(btn, text = 'Готово') {
  btn.textContent = text;
  btn.disabled = true;
}

const SETTING_TABS = [
  {
    id: 'play', title: 'Воспроизведение', icon: 'i-play', rows: [
      { key: 'resume', type: 'toggle', label: 'Продолжать с места остановки', hint: 'Плеер помнит, где вы остановились, в 200 последних файлах' },
      { key: 'autoplay', type: 'toggle', label: 'Сразу начинать воспроизведение', hint: 'Иначе файл откроется на паузе' },
      { key: 'autoNext', type: 'toggle', label: 'Включать следующий файл из открытой папки' },
      { key: 'seekStep', type: 'segment', label: 'Перемотка стрелками ← →', options: [[5, '5 с'], [10, '10 с'], [15, '15 с'], [30, '30 с']] },
    ],
  },
  {
    id: 'ui', title: 'Интерфейс', icon: 'i-screen', rows: [
      { key: 'accent', type: 'accent', label: 'Цвет акцента' },
      { key: 'preview', type: 'toggle', label: 'Превью кадра над шкалой времени', hint: 'Показывает кадр из видео при наведении на шкалу' },
      { key: 'hideDelay', type: 'segment', label: 'Прятать панель управления', hint: 'Во время просмотра, если мышь не двигается', options: [[1.5, '1,5 с'], [2.5, '2,5 с'], [4, '4 с'], [0, 'Никогда']] },
      { key: 'motion', type: 'toggle', label: 'Анимации интерфейса' },
      { key: 'splash', type: 'toggle', label: 'Заставка при запуске' },
    ],
  },
  {
    id: 'tracks', title: 'Дорожки', icon: 'i-audio', rows: [
      { type: 'obsinfo' },
      { key: 'obsNames', type: 'toggle', label: 'Брать названия дорожек из OBS', hint: 'Для записей, в которых названия дорожек не сохранены' },
      { type: 'action', label: 'Общие названия дорожек', hint: 'Те, что заданы с галочкой «ко всем файлам» в окне подписи (N)', button: 'Очистить', run: btn => { store('defaultNames', {}); refreshTrackLabels(); done(btn); } },
    ],
  },
  {
    id: 'subs', title: 'Субтитры', icon: 'i-cc', rows: [
      { type: 'subdemo' },
      { key: 'subSize', type: 'segment', label: 'Размер текста', options: [['s', 'Мелкий'], ['m', 'Средний'], ['l', 'Крупный'], ['xl', 'Огромный']] },
      { key: 'subColor', type: 'colors', label: 'Цвет текста', options: [['#ffffff', 'Белый'], ['#ffe45c', 'Жёлтый'], ['#7cf0c4', 'Мятный'], ['#9fd2ff', 'Голубой']] },
      { key: 'subBg', type: 'segment', label: 'Подложка', options: [['none', 'Нет'], ['soft', 'Лёгкая'], ['solid', 'Плотная']] },
    ],
  },
  {
    id: 'data', title: 'Данные', icon: 'i-trash', rows: [
      { type: 'action', label: 'История просмотра', hint: 'Места остановки во всех файлах', button: 'Очистить', run: btn => { store('positions', {}); renderRecent(); done(btn); } },
      { type: 'action', label: 'Кэш превью библиотеки', hint: 'Миниатюры создадутся заново', button: 'Очистить', run: async btn => { await api.clearThumbs(); thumbCache.clear(); if (lib.loaded) renderLibrary(); done(btn); } },
      { type: 'action', label: 'Подписи дорожек', hint: 'Названия, которые вы дали дорожкам', button: 'Очистить', run: btn => { store('trackNames', {}); state.names = {}; refreshTrackLabels(); done(btn); } },
      { type: 'action', label: 'Настройки', hint: 'Вернуть всё как было после установки', button: 'Сбросить', run: () => { Object.assign(settings, DEFAULTS); store('settings', settings); applySettings(); renderSettings('data'); } },
    ],
  },
  { id: 'about', title: 'О программе', icon: 'i-info', about: true },
];

let settingsTab = 'play';

function settingControl(row) {
  if (row.type === 'toggle') {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!settings[row.key];
    input.onchange = () => setSetting(row.key, input.checked);
    wrap.append(input, document.createElement('span'));
    return wrap;
  }
  if (row.type === 'segment') {
    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const [value, text] of row.options) {
      const b = document.createElement('button');
      b.textContent = text;
      b.classList.toggle('on', settings[row.key] === value);
      b.onclick = () => {
        setSetting(row.key, value);
        for (const x of seg.children) x.classList.toggle('on', x === b);
      };
      seg.append(b);
    }
    return seg;
  }
  if (row.type === 'accent' || row.type === 'colors') {
    const box = document.createElement('div');
    box.className = 'swatches';
    const opts = row.type === 'accent' ? Object.entries(ACCENTS).map(([k, [a, b, name]]) => [k, name, `linear-gradient(135deg, ${a}, ${b})`])
      : row.options.map(([c, name]) => [c, name, c]);
    for (const [value, name, bg] of opts) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.title = name;
      b.style.background = bg;
      b.classList.toggle('on', settings[row.key] === value);
      b.onclick = () => {
        setSetting(row.key, value);
        for (const x of box.children) x.classList.toggle('on', x === b);
      };
      box.append(b);
    }
    return box;
  }
  const b = document.createElement('button');
  b.className = 'btn small';
  b.textContent = row.button;
  b.onclick = () => row.run(b);
  return b;
}

async function renderSettings(tabId = settingsTab) {
  settingsTab = tabId;
  const tabs = $('#set-tabs');
  tabs.innerHTML = '<div class="set-title">Настройки</div>';
  for (const t of SETTING_TABS) {
    const b = document.createElement('button');
    b.innerHTML = `<svg class="i"><use href="#${t.icon}"/></svg>`;
    b.append(t.title);
    b.classList.toggle('on', t.id === tabId);
    b.onclick = () => renderSettings(t.id);
    tabs.append(b);
  }
  const tab = SETTING_TABS.find(t => t.id === tabId);
  const panel = $('#set-panel');
  panel.innerHTML = '';
  panel.style.animation = 'none';
  void panel.offsetWidth;
  panel.style.animation = '';
  if (tab.about) {
    const { version } = await api.appInfo();
    panel.innerHTML = `<div class="about"><img src="assets/logo.png" alt=""><span class="app-name">Tako<span class="app-suffix">.player</span></span>
      <div>Версия ${version}</div><div>Видео, музыка, обрезка и дорожки — без лишнего.</div><small>Работает на Electron и FFmpeg</small>
      <div class="about-update"><span id="about-update-text"></span>
        <div class="about-links"><button id="about-check" class="btn small"></button><button id="about-project" class="btn small ghost">Страница проекта на GitHub</button></div></div>
      <div class="donate"><div>Нравится плеер? Можно поддержать автора — это помогает делать Tako лучше.</div>
        <button id="about-donate" class="btn accent"><svg class="i"><use href="#i-heart"/></svg>Поддержать автора</button></div></div>`;
    $('#about-project').onclick = () => api.openProject();
    $('#about-donate').onclick = () => api.openDonate();
    $('#about-check').onclick = () => (upd.status === 'ready' ? api.updateInstall() : api.updateCheck());
    renderUpdate(upd);
    return;
  }
  const h = document.createElement('h3');
  h.textContent = tab.title;
  panel.append(h);
  for (const row of tab.rows) {
    if (row.type === 'obsinfo') {
      panel.append(obsInfo());
      continue;
    }
    if (row.type === 'subdemo') {
      const demo = document.createElement('div');
      demo.className = 'sub-demo';
      demo.innerHTML = '<span>Так будут выглядеть субтитры</span>';
      panel.append(demo);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'set-row';
    const txt = document.createElement('div');
    txt.className = 'txt';
    const label = document.createElement('div');
    label.textContent = row.label;
    txt.append(label);
    if (row.hint) {
      const hint = document.createElement('small');
      hint.textContent = row.hint;
      txt.append(hint);
    }
    el.append(txt, settingControl(row));
    panel.append(el);
  }
}

// What the player found in OBS, so it is clear where track names come from
function obsInfo() {
  const box = document.createElement('div');
  box.className = 'obs-info';
  if (!obsTracks) {
    box.textContent = 'OBS на этом компьютере не найден. Названия можно задать в окне подписи дорожек (N).';
    return box;
  }
  const head = document.createElement('div');
  head.innerHTML = 'Профиль OBS: <b></b>';
  head.querySelector('b').textContent = obsTracks.profile;
  box.append(head);
  const recorded = [1, 2, 3, 4, 5, 6].filter(n => obsTracks.recTracks & (1 << (n - 1)));
  if (!recorded.some(n => obsTracks.names[n - 1])) {
    const hint = document.createElement('small');
    hint.textContent = `Записываются дорожки ${recorded.join(', ')}, но названия им не заданы. Задайте их в OBS: Настройки → Вывод → Аудио → «Название» у каждой дорожки — и плеер подхватит их сам.`;
    box.append(hint);
    return box;
  }
  const list = document.createElement('ol');
  for (const n of recorded) {
    const li = document.createElement('li');
    li.value = n;
    li.textContent = obsTracks.names[n - 1] || 'без названия';
    list.append(li);
  }
  box.append(list);
  return box;
}

function openSettings() {
  renderSettings();
  $('#settings-dlg').showModal();
  document.activeElement.blur();
}

// ---------- views

let currentView = 'player';

function moveIndicator() {
  const btn = $(currentView === 'library' ? '#nav-library' : '#nav-player');
  $('.rail-indicator').style.transform = `translateY(${btn.offsetTop}px)`;
}

function showView(v) {
  currentView = v;
  document.body.dataset.view = v;
  for (const name of ['player', 'library']) {
    $('#view-' + name).classList.toggle('active', v === name);
    $('#nav-' + name).classList.toggle('active', v === name);
  }
  moveIndicator();
  if (v === 'library' && !lib.loaded) loadLibrary();
  updateMini();
  poke();
}

// Opening media from anywhere brings the player forward
const addFilesBase = addFiles;
addFiles = paths => {
  addFilesBase(paths);
  if (paths.some(p => !SUB_RE.test(p))) showView('player');
};

$('#nav-player').onclick = () => showView('player');
$('#nav-library').onclick = () => showView('library');
$('#btn-go-library').onclick = () => showView('library');
$('#nav-settings').onclick = openSettings;

// ---------- player chrome: auto-hide, play state, trim panel

let idleTimer;
let overControls = false;

function poke() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (!settings.hideDelay) return;
  idleTimer = setTimeout(() => {
    const keep = overControls || video.paused || !state.info || !state.videoStream || currentView !== 'player'
      || document.body.classList.contains('trim-open') || document.querySelector('dialog[open]');
    if (!keep) document.body.classList.add('idle');
  }, settings.hideDelay * 1000);
}
document.addEventListener('mousemove', poke);
document.addEventListener('keydown', poke);
$('#controls').addEventListener('mouseenter', () => { overControls = true; poke(); });
$('#controls').addEventListener('mouseleave', () => { overControls = false; poke(); });

// ---------- trimming: panel with a film strip
//
// Opening the panel selects the whole file so only the edges need dragging; closing it
// (or switching files) drops the selection.

const strip = $('#strip');
let stripKey = null;

function trimOpen() {
  return document.body.classList.contains('trim-open');
}

function selectAll() {
  if (!state.info) return;
  state.inPt = 0;
  state.outPt = duration();
  renderSelection();
}

function setTrimOpen(open) {
  if (open === trimOpen()) return;
  if (open && !state.info) return;
  document.body.classList.toggle('trim-open', open);
  if (open) {
    if (!selRange()) selectAll();
    loadStrip();
  } else {
    resetTrim();
  }
  poke();
}

function toggleTrim() {
  setTrimOpen(!trimOpen());
}

// A new file starts with the panel closed
const loadIndexBase = loadIndex;
loadIndex = (...args) => {
  setTrimOpen(false);
  return loadIndexBase(...args);
};

function renderStrip() {
  const d = duration();
  const r = selRange() || [0, d];
  const a = d ? r[0] / d * 100 : 0;
  const b = d ? r[1] / d * 100 : 100;
  $('#strip-sel').style.left = a + '%';
  $('#strip-sel').style.width = (b - a) + '%';
  $('#shade-l').style.width = a + '%';
  $('#shade-r').style.width = (100 - b) + '%';
}

async function loadStrip() {
  const item = currentItem();
  if (!item || !state.info || !trimOpen()) return;
  const n = clamp(Math.round(strip.clientWidth / 92), 4, 24);
  const key = `${item.path}|${n}`;
  if (stripKey === key) return;
  stripKey = key;
  const box = $('#strip-frames');
  box.innerHTML = '';
  box.classList.toggle('audio', !state.videoStream);
  if (!state.videoStream) return;
  const d = duration();
  const imgs = Array.from({ length: n }, () => {
    const cell = document.createElement('div');
    cell.className = 'sf';
    const img = new Image();
    cell.append(img);
    box.append(cell);
    return img;
  });
  for (let i = 0; i < n; i++) {
    const url = await api.frameThumb({ file: item.path, time: (i + 0.5) * d / n }).catch(() => null);
    if (stripKey !== key) return;
    if (url) {
      imgs[i].onload = () => imgs[i].classList.add('show');
      imgs[i].src = url;
    }
  }
}
new ResizeObserver(() => loadStrip()).observe(strip);

function seekTo(t) {
  video.currentTime = clamp(t, 0, duration());
  updateProgress();
}

function stripTime(e) {
  const r = strip.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * duration();
}

strip.addEventListener('pointerdown', e => {
  if (!state.info || e.button !== 0) return;
  const handle = e.target.closest('.strip-handle');
  const which = handle && handle.dataset.h;
  const onSel = !handle && e.target.closest('#strip-sel');
  const start = selRange() || [0, duration()];
  const t0 = stripTime(e);
  const minLen = Math.max(0.1, 1 / state.fps);
  let moved = false;
  strip.setPointerCapture(e.pointerId);
  const move = ev => {
    moved = true;
    const t = stripTime(ev);
    const d = duration();
    if (which === 'in') {
      state.inPt = clamp(t, 0, (state.outPt ?? d) - minLen);
      seekTo(state.inPt);
    } else if (which === 'out') {
      state.outPt = clamp(t, (state.inPt ?? 0) + minLen, d);
      seekTo(state.outPt);
    } else if (onSel) {
      const len = start[1] - start[0];
      state.inPt = clamp(start[0] + t - t0, 0, d - len);
      state.outPt = state.inPt + len;
      seekTo(state.inPt);
    } else {
      seekTo(t);
      return;
    }
    renderSelection();
  };
  const up = () => {
    strip.removeEventListener('pointermove', move);
    strip.removeEventListener('pointerup', up);
    strip.removeEventListener('pointercancel', up);
    // A plain click inside the selection just moves the playhead there
    if (onSel && !moved) seekTo(t0);
  };
  if (!which && !onSel) move(e);
  strip.addEventListener('pointermove', move);
  strip.addEventListener('pointerup', up);
  strip.addEventListener('pointercancel', up);
});

// ‹ › next to the times: one frame, or one second with Shift
for (const b of document.querySelectorAll('.nudge')) {
  b.addEventListener('click', e => {
    if (!state.info) return;
    const step = (e.shiftKey ? 1 : 1 / state.fps) * Number(b.dataset.d);
    const r = selRange() || [0, duration()];
    if (b.dataset.p === 'in') setIn(clamp(r[0] + step, 0, r[1] - 1 / state.fps));
    else setOut(clamp(r[1] + step, r[0] + 1 / state.fps, duration()));
    video.pause();
    seekTo(b.dataset.p === 'in' ? state.inPt : state.outPt);
  });
}

$('#btn-trim').onclick = toggleTrim;
$('#btn-trim-close').onclick = () => setTrimOpen(false);
$('#btn-clear').onclick = selectAll;

video.addEventListener('play', () => {
  miniClosed = false;
  document.body.classList.add('playing');
  bump($('#btn-play'));
  updateMini();
  poke();
});
video.addEventListener('pause', () => {
  document.body.classList.remove('playing');
  bump($('#btn-play'));
  updateMini();
});
video.addEventListener('emptied', () => document.body.classList.remove('playing'));
video.addEventListener('timeupdate', updateMini);

// Body classes drive a few dependent bits: the trim button and the start screen
let wasLoaded = false;
new MutationObserver(() => {
  const b = document.body.classList;
  $('#btn-trim').classList.toggle('active', b.contains('trim-open'));
  if (wasLoaded && !b.contains('loaded')) renderRecent();
  wasLoaded = b.contains('loaded');
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---------- mini player (library view)

let miniClosed = false; // closed with ×; comes back once something plays again

function updateMini() {
  const show = currentView === 'library' && !!state.info && !miniClosed;
  $('#mini').hidden = !show;
  if (!show) return;
  const item = currentItem();
  const d = duration();
  $('#mini-name').textContent = item ? item.name : '';
  $('#mini-time').textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
  $('#mini-fill').style.width = (d ? video.currentTime / d * 100 : 0) + '%';
  $('#mini-icon').setAttribute('href', video.paused ? '#i-play' : '#i-pause');
}
$('#mini-play').onclick = togglePlay;
$('#mini-open').onclick = () => showView('player');
$('#mini-close').onclick = () => {
  miniClosed = true;
  video.pause();
  updateMini();
};

// ---------- timeline frame preview
//
// Frames come from ffmpeg (key frames only, so it stays quick on huge files). One request runs
// at a time and the newest hover position wins; between hovers a storyboard of the whole file
// is fetched so most positions already have a nearby frame to show instantly.

const pv = { file: null, bucket: 1, cache: new Map(), queue: [], want: null, busy: false, hoverKey: null, shownKey: null };
const tip = $('#tip');
const tipImg = $('#tip-img');
const tipFrame = $('#tip-frame');
const STORYBOARD = 48;

function pvSetup() {
  const item = currentItem();
  const file = item ? item.path : null;
  if (pv.file === file) return;
  pv.file = file;
  pv.cache = new Map();
  pv.want = null;
  pv.shownKey = null;
  pv.bucket = Math.max(1, duration() / 600);
  const last = Math.floor(duration() / pv.bucket);
  // Spread the storyboard so early frames already cover the whole file
  pv.queue = Array.from({ length: STORYBOARD }, (_, i) => Math.round(((i * 7) % STORYBOARD + 0.5) * last / STORYBOARD));
}

function pvNearest(key) {
  let best = null;
  let dist = Infinity;
  for (const [k, url] of pv.cache) {
    if (url && Math.abs(k - key) < dist) {
      dist = Math.abs(k - key);
      best = k;
    }
  }
  return best;
}

function pvShow() {
  const k = pvNearest(pv.hoverKey);
  if (k == null) {
    tipImg.classList.remove('show');
    tipFrame.classList.remove('ready');
    return;
  }
  if (k !== pv.shownKey) {
    pv.shownKey = k;
    tipImg.src = pv.cache.get(k);
  }
  tipImg.classList.add('show');
  tipFrame.classList.add('ready');
}

async function pvPump() {
  if (pv.busy || !pv.file) return;
  let key = pv.want;
  pv.want = null;
  if (key != null && pv.cache.has(key)) key = null;
  while (key == null && pv.queue.length) {
    const k = pv.queue.shift();
    if (!pv.cache.has(k)) key = k;
  }
  if (key == null) return;
  pv.busy = true;
  const file = pv.file;
  let url = null;
  try {
    url = await api.frameThumb({ file, time: key * pv.bucket });
  } catch {}
  pv.busy = false;
  if (file === pv.file) {
    pv.cache.set(key, url);
    if (pv.hoverKey != null) pvShow();
  }
  pvPump();
}

bar.addEventListener('mousemove', e => {
  if (!state.info) return;
  const r = bar.getBoundingClientRect();
  const x = clamp(e.clientX - r.left, 0, r.width);
  const t = timeAt(e);
  const withFrame = settings.preview && !!state.videoStream;
  tip.hidden = false;
  tip.classList.toggle('no-frame', !withFrame);
  $('#tip-time').textContent = fmt(t);
  const half = withFrame ? 116 : 26;
  tip.style.left = clamp(x, half, r.width - half) + 'px';
  $('#hover-fill').style.width = x / r.width * 100 + '%';
  if (!withFrame) return;
  pvSetup();
  pv.hoverKey = Math.round(t / pv.bucket);
  pvShow();
  if (!pv.cache.has(pv.hoverKey)) {
    pv.want = pv.hoverKey;
    pvPump();
  }
});
bar.addEventListener('mouseleave', () => {
  tip.hidden = true;
  pv.hoverKey = null;
});

// ---------- cards (library and the start screen)

const thumbCache = new Map(); // file -> { thumb, duration }

async function fillCard(card) {
  const file = card.dataset.path;
  let meta = thumbCache.get(file);
  if (!meta) {
    try {
      meta = await api.libraryThumb(file);
    } catch {
      meta = { thumb: null, duration: 0 };
    }
    thumbCache.set(file, meta);
  }
  const box = card.querySelector('.thumb');
  box.classList.add('ready');
  if (meta.thumb) {
    const img = box.querySelector('img');
    img.onload = () => img.classList.add('show');
    img.src = api.toUrl(meta.thumb);
  } else {
    box.querySelector('.placeholder').hidden = false;
  }
  if (meta.duration) {
    const dur = box.querySelector('.dur');
    dur.textContent = fmt(meta.duration);
    dur.hidden = false;
    const pos = recall('positions', {})[file];
    if (pos) {
      const prog = box.querySelector('.prog');
      prog.firstChild.style.width = clamp(pos / meta.duration * 100, 2, 100) + '%';
      prog.hidden = false;
    }
  }
}

const cardObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    cardObserver.unobserve(e.target);
    fillCard(e.target);
  }
}, { rootMargin: '300px' });

function makeCard(f, meta, onClick, i) {
  const card = document.createElement('div');
  card.className = 'card';
  card.title = f.path;
  card.dataset.path = f.path;
  card.style.animationDelay = Math.min(i, 24) * 22 + 'ms';
  card.innerHTML = `<div class="thumb"><img alt=""><div class="placeholder" hidden><svg class="i"><use href="#i-${f.audio ? 'music' : 'screen'}"/></svg></div>`
    + '<span class="dur" hidden></span><div class="prog" hidden><i></i></div>'
    + '<div class="play-ov"><span><svg class="i"><use href="#i-play"/></svg></span></div></div><div class="card-name"></div><div class="card-meta"></div>';
  card.querySelector('.card-name').textContent = f.name;
  card.querySelector('.card-meta').textContent = meta;
  card.onclick = onClick;
  cardObserver.observe(card);
  return card;
}

async function renderRecent() {
  const pos = recall('positions', {});
  const paths = Object.keys(pos).reverse().slice(0, 12);
  const existing = new Set(paths.length ? await api.expandPaths(paths) : []);
  const items = paths.filter(p => existing.has(p)).slice(0, 4);
  const box = $('#recent');
  box.innerHTML = '';
  items.forEach((p, i) => {
    const f = { path: p, name: api.basename(p), audio: AUDIO_RE.test(p) };
    const card = makeCard(f, `Остановились на ${fmt(pos[p])}`, () => addFiles([p]), i);
    const rm = document.createElement('button');
    rm.className = 'card-rm';
    rm.title = 'Убрать из «Продолжить просмотр»';
    rm.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
    rm.onclick = e => {
      e.stopPropagation();
      forgetPosition(p);
      card.classList.add('leaving');
      setTimeout(renderRecent, 220);
    };
    card.querySelector('.thumb').append(rm);
    box.append(card);
  });
  $('#recent-wrap').hidden = !items.length;
}

function forgetPosition(file) {
  const all = recall('positions', {});
  delete all[file];
  store('positions', all);
}

$('#recent-clear').onclick = () => {
  store('positions', {});
  renderRecent();
};

// ---------- library

const lib = {
  folders: recall('libraryFolders', []),
  data: [],
  filter: recall('libFilter', 'all'),
  sort: recall('libSort', 'name'),
  query: '',
  loaded: false,
};

async function loadLibrary() {
  lib.loaded = true;
  $('#lib-refresh').classList.add('spin');
  lib.data = lib.folders.length ? await api.libraryScan(lib.folders) : [];
  $('#lib-refresh').classList.remove('spin');
  renderLibrary();
}

const SORTS = {
  name: (a, b) => collatorRu.compare(a.name, b.name),
  new: (a, b) => b.mtime - a.mtime,
  size: (a, b) => b.size - a.size,
};

function playFrom(files, i) {
  state.playlist = files.map(f => ({ path: f.path, name: f.name }));
  state.current = -1;
  renderPlaylist();
  showView('player');
  loadIndex(i);
}

function renderLibrary() {
  const body = $('#lib-body');
  body.innerHTML = '';
  const q = lib.query.trim().toLowerCase();
  let total = 0;
  let shown = 0;
  for (const sec of lib.data) {
    total += sec.files.length;
    const files = sec.files
      .filter(f => (lib.filter === 'all' || (lib.filter === 'audio') === f.audio) && (!q || f.name.toLowerCase().includes(q)))
      .sort(SORTS[lib.sort] || SORTS.name);
    if (!files.length && (q || lib.filter !== 'all')) continue;
    shown += files.length;

    const section = document.createElement('section');
    section.className = 'lib-section';
    const head = document.createElement('div');
    head.className = 'lib-section-head';
    const h = document.createElement('h2');
    h.textContent = sec.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = files.length;
    const where = document.createElement('span');
    where.className = sec.exists ? 'path' : 'path lib-missing';
    where.textContent = sec.exists ? sec.dir : 'Папка не найдена — ' + sec.dir;
    const rm = document.createElement('button');
    rm.className = 'icon sm';
    rm.title = 'Убрать из библиотеки (файлы на диске не удаляются)';
    rm.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
    rm.onclick = () => {
      lib.folders = lib.folders.filter(d => d !== sec.dir);
      store('libraryFolders', lib.folders);
      lib.data = lib.data.filter(s => s !== sec);
      renderLibrary();
    };
    const all = document.createElement('button');
    all.className = 'btn small';
    all.title = 'Смотреть все файлы этой папки подряд';
    all.innerHTML = '<svg class="i"><use href="#i-play"/></svg>Играть всё';
    all.onclick = () => playFrom(files, 0);
    all.hidden = !files.length;
    head.append(h, count, where, all, rm);

    const grid = document.createElement('div');
    grid.className = 'cards';
    files.forEach((f, i) => {
      // Files from subfolders show which one they are in
      const rel = f.path.slice(sec.dir.length).replace(/^[\\/]+/, '');
      const sub = rel.includes('\\') ? rel.slice(0, rel.lastIndexOf('\\')) + ' · ' : '';
      const meta = `${sub}${fmtSize(f.size)} · ${new Date(f.mtime).toLocaleDateString('ru-RU')}`;
      grid.append(makeCard(f, meta, () => addFiles([f.path]), i));
    });
    if (!files.length) {
      const none = document.createElement('div');
      none.className = 'lib-none';
      none.textContent = 'В этой папке нет видео и музыки';
      grid.append(none);
    }
    section.append(head, grid);
    body.append(section);
  }
  if (lib.folders.length && !shown && (q || lib.filter !== 'all')) {
    const none = document.createElement('div');
    none.className = 'lib-none';
    none.textContent = 'Ничего не найдено';
    body.append(none);
  }
  const n = lib.folders.length;
  $('#lib-empty').hidden = n > 0;
  body.hidden = !n;
  $('#lib-count').textContent = n
    ? `${total} ${plural(total, 'файл', 'файла', 'файлов')} в ${n} ${plural(n, 'папке', 'папках', 'папках')}`
    : 'Все ваши видео и музыка в одном месте';
}

async function addLibraryFolder() {
  const dir = await api.pickFolder();
  if (!dir) return;
  if (!lib.folders.some(d => d.toLowerCase() === dir.toLowerCase())) {
    lib.folders.push(dir);
    store('libraryFolders', lib.folders);
  }
  await loadLibrary();
}

$('#lib-add').onclick = addLibraryFolder;
$('#lib-add-big').onclick = addLibraryFolder;
$('#lib-refresh').onclick = loadLibrary;

let searchTimer;
$('#lib-search').addEventListener('input', e => {
  lib.query = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderLibrary, 120);
});
$('#lib-search').addEventListener('keydown', e => { if (e.key === 'Escape') e.target.blur(); });

for (const b of $('#lib-filter').children) {
  b.classList.toggle('on', b.dataset.v === lib.filter);
  b.onclick = () => {
    lib.filter = b.dataset.v;
    store('libFilter', lib.filter);
    for (const x of $('#lib-filter').children) x.classList.toggle('on', x === b);
    renderLibrary();
  };
}
$('#lib-sort').value = lib.sort;
$('#lib-sort').addEventListener('change', e => {
  lib.sort = e.target.value;
  store('libSort', lib.sort);
  renderLibrary();
  e.target.blur();
});

// ---------- updates

let upd = { status: 'idle' };

function updateText(s) {
  switch (s.status) {
    case 'checking': return 'Проверяю обновления…';
    case 'latest': return 'У вас последняя версия';
    case 'downloading': return `Скачиваю версию ${s.version}… ${s.percent || 0}%`;
    case 'ready': return `Версия ${s.version} скачана — установится при перезапуске`;
    case 'error': return 'Не удалось проверить обновления: ' + s.message;
    default: return s.enabled === false ? 'Обновления работают в установленной версии плеера' : '';
  }
}

function renderUpdate(s) {
  upd = { ...upd, ...s };
  const btn = $('#update-btn');
  btn.hidden = upd.status !== 'ready';
  btn.querySelector('span').textContent = `Обновить до ${upd.version}`;
  const text = document.querySelector('#about-update-text');
  if (!text) return;
  text.textContent = updateText(upd);
  const check = $('#about-check');
  check.textContent = upd.status === 'ready' ? 'Перезапустить и обновить' : 'Проверить обновления';
  check.disabled = upd.enabled === false || upd.status === 'checking' || upd.status === 'downloading';
}

api.onUpdate(renderUpdate);
api.updateState().then(renderUpdate).catch(() => {});
$('#update-btn').onclick = () => api.updateInstall();

// ---------- init

applySettings();
api.obsTracks().then(d => {
  obsTracks = d;
  if (state.info) refreshTrackLabels();
}).catch(() => {});
renderRecent();
requestAnimationFrame(moveIndicator);

const splash = $('#splash');
if (!settings.splash || !settings.motion) splash.remove();
else splash.addEventListener('animationend', e => { if (e.animationName === 'splash-out') splash.remove(); });
