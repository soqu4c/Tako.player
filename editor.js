// Video editor (beta): a timeline with video, audio and title tracks, in the spirit of
// Premiere. Source files are only read; the result is rendered into a new file by ffmpeg
// (editor-export in main.js). Runs after ui.js and uses its globals ($, api, toast, ...).

// ---------- project model
//
// media:  files added to the project, with what ffprobe told about them
// clips:  { id, track, media, start, in, out, volume, fadeIn, fadeOut, link, audioK }
//         text clips: { id, track: 'T1', start, in: 0, out: duration, text, size, color, pos, box, fadeIn, fadeOut }
// A video file dropped on the timeline gives a video clip and each of its sound tracks as
// linked audio clips; linked clips move, trim and split together.

// Audio tracks are added as needed (an OBS recording can bring six at once)
const BASE_TRACKS = [
  { id: 'T1', kind: 'text', name: 'Текст' },
  { id: 'V2', kind: 'video', name: 'Видео 2' },
  { id: 'V1', kind: 'video', name: 'Видео 1' },
];
let ED_TRACKS = [];
const trackOf = id => ED_TRACKS.find(t => t.id === id);
const audioIds = () => ED_TRACKS.filter(t => t.kind === 'audio').map(t => t.id);
// Label colours as in Premiere; each track has its own, a clip can be given another
const LABELS = [
  ['iris', 'Ирис', '#6f7fd8'], ['violet', 'Фиолетовый', '#a46ad6'], ['caribbean', 'Карибский', '#27b3a0'],
  ['lavender', 'Лавандовый', '#c493e8'], ['cerulean', 'Церулеан', '#2a8fd6'], ['forest', 'Лесной', '#3c9a52'],
  ['rose', 'Розовый', '#e0629a'], ['mango', 'Манго', '#e8a33a'], ['purple', 'Пурпурный', '#8a4fc7'],
  ['blue', 'Синий', '#3f6ed8'], ['teal', 'Бирюзовый', '#1f8c9a'], ['magenta', 'Пурпурно-красный', '#d14fb3'],
  ['tan', 'Песочный', '#c2a079'], ['green', 'Зелёный', '#55b04a'], ['brown', 'Коричневый', '#a0703c'], ['yellow', 'Жёлтый', '#d6c23a'],
];
const TRACK_LABELS = { T1: 'rose', V2: 'violet', V1: 'iris', A1: 'forest', A2: 'caribbean', A3: 'mango', A4: 'cerulean', A5: 'lavender', A6: 'tan', A7: 'yellow', A8: 'brown' };
const labelColor = name => (LABELS.find(l => l[0] === name) || LABELS[0])[2];
const trackColor = id => labelColor(TRACK_LABELS[id] || 'green');
const clipColor = c => (c.label ? labelColor(c.label) : trackColor(c.track));

// A sound track is not heard when it is muted, or when another one is soloed
function trackSilent(id) {
  const st = ed.p.tracks[id];
  if (st.muted) return true;
  const solo = audioIds().some(a => ed.p.tracks[a].solo);
  return solo && !st.solo;
}
const IMG_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
const IMAGE_DUR = 5;

function setAudioCount(p, n) {
  p.aCount = Math.max(3, n);
  ED_TRACKS = [...BASE_TRACKS];
  for (let k = 1; k <= p.aCount; k++) ED_TRACKS.push({ id: 'A' + k, kind: 'audio', name: 'Звук ' + k });
  for (const t of ED_TRACKS) if (!p.tracks[t.id]) p.tracks[t.id] = { muted: false, hidden: false, volume: 1 };
}

function emptyProject() {
  const p = { w: 1920, h: 1080, fps: 30, media: [], clips: [], tracks: {} };
  setAudioCount(p, 3);
  return p;
}

const ed = {
  p: recall('edProject', null) || emptyProject(),
  sel: new Set(),
  tool: 'select',
  t: 0, // playhead, seconds
  playing: false,
  pps: 40, // pixels per second
  undo: [],
  redo: [],
  nextId: 1,
};
for (const c of ed.p.clips) ed.nextId = Math.max(ed.nextId, c.id + 1);
setAudioCount(ed.p, ed.p.aCount || 3);

const edMedia = file => ed.p.media.find(m => m.path === file);
const clipDur = c => c.out - c.in;
const clipEnd = c => c.start + clipDur(c);
const edDuration = () => ed.p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
const linked = c => (c.link ? ed.p.clips.filter(x => x.link === c.link) : [c]);
const fmtEd = t => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

let saveTimer = 0;
function edChanged() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store('edProject', ed.p), 400);
  renderTimeline();
  renderInspector();
  syncPreview(true);
}

// Every edit first remembers the project as it was
function edCommit() {
  ed.undo.push(JSON.stringify(ed.p));
  if (ed.undo.length > 100) ed.undo.shift();
  ed.redo = [];
}
function edUndo(back = true) {
  const from = back ? ed.undo : ed.redo;
  const to = back ? ed.redo : ed.undo;
  if (!from.length) return;
  to.push(JSON.stringify(ed.p));
  ed.p = JSON.parse(from.pop());
  setAudioCount(ed.p, ed.p.aCount || 3);
  ed.sel = new Set([...ed.sel].filter(id => ed.p.clips.some(c => c.id === id)));
  renderHeads();
  renderBin();
  edChanged();
}

// ---------- media bin

async function edImport(paths) {
  const added = [];
  for (const file of paths) {
    if (edMedia(file)) {
      added.push(edMedia(file));
      continue;
    }
    try {
      const info = await api.probe(file);
      const streams = info.streams || [];
      const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const image = IMG_RE.test(file);
      const audio = streams.filter(s => s.codec_type === 'audio').map(s => ({
        index: s.index,
        name: (s.tags && (s.tags.title || s.tags.handler_name)) || '',
      }));
      if (!v && !audio.length) throw new Error('нет ни видео, ни звука');
      const m = {
        path: file,
        name: api.basename(file),
        dur: image ? 3600 : parseFloat(info.format.duration) || 0,
        image,
        video: v ? { index: v.index, w: v.width, h: v.height, fps: commonFps(v.avg_frame_rate || v.r_frame_rate) } : null,
        audio,
      };
      ed.p.media.push(m);
      added.push(m);
    } catch (e) {
      toast(`Не удалось добавить ${api.basename(file)}: ${cleanErr(e)}`);
    }
  }
  store('edProject', ed.p);
  renderBin();
  return added;
}

function renderBin() {
  const box = $('#ed-bin-list');
  box.innerHTML = '';
  if (!ed.p.media.length) {
    box.innerHTML = '<div class="ed-hint">Добавьте видео, музыку или картинки и перетащите их на таймлайн. Исходные файлы не изменяются.</div>';
    return;
  }
  for (const m of ed.p.media) {
    const row = document.createElement('div');
    row.className = 'ed-item ' + (m.video ? (m.image ? 'img' : 'vid') : 'aud');
    row.draggable = true;
    row.title = m.path + '\nДвойной клик — добавить в конец таймлайна';
    row.innerHTML = '<i></i><span class="n"></span><small></small><button class="icon sm" title="Убрать из проекта"><svg class="i"><use href="#i-x"/></svg></button>';
    row.querySelector('.n').textContent = m.name;
    row.querySelector('small').textContent = m.image ? 'картинка' : fmt(m.dur) + (m.audio.length > 1 ? ` · ${m.audio.length} дор.` : '');
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/tako-media', m.path);
      e.dataTransfer.effectAllowed = 'copy';
    });
    row.ondblclick = () => edPlace(m, null, edDuration());
    row.querySelector('button').onclick = async e => {
      e.stopPropagation();
      // only the project forgets the file; the file itself stays on disk
      const drop = () => {
        edCommit();
        ed.p.media = ed.p.media.filter(x => x !== m);
        ed.p.clips = ed.p.clips.filter(c => c.media !== m.path);
        ed.sel = new Set([...ed.sel].filter(id => ed.p.clips.some(c => c.id === id)));
        renderBin();
        edChanged();
      };
      const n = ed.p.clips.filter(c => c.media === m.path).length;
      if (!n || await confirmDialog('Убрать файл из проекта?', `Его клипы на таймлайне (${n}) тоже уберутся. Сам файл на диске останется.`, 'Убрать')) drop();
    };
    box.append(row);
  }
}

$('#ed-import').onclick = async () => {
  const paths = await api.openFiles();
  if (paths.length) edImport(paths);
};

// A file on the timeline: its picture on a video track and every one of its sound tracks
// on audio tracks of their own (more audio tracks appear when there are not enough)
function edPlace(m, trackId, start) {
  edCommit();
  const dur = m.image ? IMAGE_DUR : m.dur;
  const sounds = m.image ? [] : m.audio;
  const link = m.video && sounds.length ? ed.nextId : 0;
  const made = [];
  const base = { media: m.path, start: Math.max(0, start), in: 0, out: dur, volume: 1, fadeIn: 0, fadeOut: 0, link };
  // a few hundredths of overlap (rounding of file lengths) do not count
  const isFree = id => !ed.p.clips.some(c => c.track === id && c.start < base.start + dur - 0.05 && clipEnd(c) > base.start + 0.05);
  const vTrack = trackId && trackOf(trackId).kind === 'video' ? trackId : ['V1', 'V2'].find(isFree) || 'V1';
  // sound: from the lane it was dropped on (or the first free one) downwards, skipping busy ones
  let aTracks = [];
  if (sounds.length) {
    const first = trackId && trackOf(trackId).kind === 'audio' ? Number(trackId.slice(1)) : 1;
    for (let k = first; aTracks.length < sounds.length; k++) {
      if (k > ed.p.aCount) setAudioCount(ed.p, k);
      if (isFree('A' + k) || (k === first && trackId && trackId[0] === 'A')) aTracks.push('A' + k);
    }
    renderHeads();
  }
  if (m.video) made.push({ ...base, id: ed.nextId++, track: vTrack });
  sounds.forEach((_, k) => made.push({ ...base, id: ed.nextId++, track: aTracks[k], audioK: k }));
  ed.p.clips.push(...made);
  // the first video sets the frame size and rate of the project
  if (m.video && !ed.p.clips.some(c => c.track[0] === 'V' && !made.includes(c)) && m.video.w && m.video.h && !m.image) {
    ed.p.w = m.video.w;
    ed.p.h = m.video.h;
    if (m.video.fps) ed.p.fps = m.video.fps;
  }
  resolveOverlaps(made);
  ed.sel = new Set([made[0].id]);
  edChanged();
  renderProjectSettings();
}

// Like Premiere's overwrite: a clip laid over others cuts away what is under it
function resolveOverlaps(moved) {
  const ids = new Set(moved.map(c => c.id));
  for (const m of moved) {
    const a = m.start, b = clipEnd(m);
    for (const c of [...ed.p.clips]) {
      if (ids.has(c.id) || c.track !== m.track) continue;
      const s = c.start, e = clipEnd(c);
      if (e <= a + 1e-6 || s >= b - 1e-6) continue;
      if (s >= a && e <= b) ed.p.clips = ed.p.clips.filter(x => x !== c);
      else if (s < a && e > b) {
        const tail = { ...c, id: ed.nextId++, start: b, in: c.in + (b - s) };
        c.out = c.in + (a - s);
        ed.p.clips.push(tail);
      } else if (s < a) c.out = c.in + (a - s);
      else {
        c.in += b - s;
        c.start = b;
      }
    }
  }
}

// ---------- timeline

const lanesBox = $('#ed-lanes');
const scroller = $('#ed-scroll');
const xOf = t => t * ed.pps;
const tOf = x => x / ed.pps;

// Track headers as in Premiere: lock, then eye for pictures, M (mute) and S (solo) for sound
function renderHeads() {
  const box = $('#ed-heads');
  box.innerHTML = '<div class="ed-ruler-pad"></div>';
  for (const tr of ED_TRACKS) {
    const st = ed.p.tracks[tr.id];
    const h = document.createElement('div');
    h.className = `ed-trhead ${tr.kind}`;
    h.title = tr.name;
    const toggle = (cls, on, title, html, flip) => {
      const b = document.createElement('button');
      b.className = `ed-tb ${cls}`;
      b.classList.toggle('on', !!on);
      b.title = title;
      b.innerHTML = html;
      b.onclick = () => { edCommit(); flip(); renderHeads(); edChanged(); };
      h.append(b);
      return b;
    };
    toggle('lock', st.locked, st.locked ? 'Дорожка заблокирована — нажмите, чтобы разблокировать' : 'Заблокировать дорожку',
      `<svg class="i"><use href="#${st.locked ? 'i-lock' : 'i-unlock'}"/></svg>`, () => { st.locked = !st.locked; });
    const name = document.createElement('b');
    name.className = 'ed-trname';
    name.textContent = tr.id;
    name.style.background = trackColor(tr.id);
    h.append(name);
    if (tr.kind === 'audio') {
      toggle('m', st.muted, 'Без звука (Mute)', 'M', () => { st.muted = !st.muted; });
      toggle('s', st.solo, 'Только эта дорожка (Solo)', 'S', () => { st.solo = !st.solo; });
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = 0;
      vol.max = 2;
      vol.step = 0.05;
      vol.value = st.volume;
      vol.title = 'Громкость дорожки: ' + Math.round(st.volume * 100) + '%';
      vol.onpointerdown = () => edCommit();
      vol.oninput = () => {
        st.volume = Number(vol.value);
        vol.title = 'Громкость дорожки: ' + Math.round(st.volume * 100) + '%';
        store('edProject', ed.p);
        syncPreview(true);
      };
      h.append(vol);
    } else {
      toggle('eye', !st.hidden, st.hidden ? 'Показать дорожку' : 'Скрыть дорожку',
        `<svg class="i"><use href="#${st.hidden ? 'i-eye-off' : 'i-eye'}"/></svg>`, () => { st.hidden = !st.hidden; });
    }
    h.classList.toggle('off', trackSilent(tr.id) || st.hidden);
    h.classList.toggle('locked', !!st.locked);
    box.append(h);
  }
}

// Timecode as in Premiere: hours:minutes:seconds:frames
const fpsOf = () => ed.p.fps || 30;
function tc(t) {
  const fps = Math.round(fpsOf());
  let f = Math.round(Math.max(0, t) * fpsOf());
  const ff = f % fps;
  f = Math.floor(f / fps);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(f / 3600))}:${p(Math.floor(f / 60) % 60)}:${p(f % 60)}:${p(ff)}`;
}
// "1:30" "01:30:00" "00:01:30:12" or plain seconds "90"
function parseTc(s) {
  const parts = String(s).trim().replace(',', '.').split(/[:;]/).map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fpsOf();
  return parts.reduce((a, n) => a * 60 + n, 0);
}

const timelineLength = () => Math.max(edDuration() + 30, tOf(scroller.clientWidth) + 5);

function renderRuler() {
  const ruler = $('#ed-ruler');
  ruler.innerHTML = '';
  const total = timelineLength();
  $('#ed-canvas').style.width = xOf(total) + 'px';
  // labels at least 90 px apart on a round time; small ticks in between
  const steps = [1 / fpsOf(), 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find(s => xOf(s) >= 90) || 3600;
  const minor = step / 5;
  const from = Math.max(0, Math.floor(tOf(scroller.scrollLeft) / step) * step);
  const to = Math.min(total, tOf(scroller.scrollLeft + scroller.clientWidth) + step);
  for (let t = from; t <= to; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const tick = document.createElement('span');
    tick.className = major ? 'major' : 'minor';
    tick.style.left = xOf(t) + 'px';
    if (major) tick.textContent = tc(t);
    ruler.append(tick);
  }
  // the yellow bar shows how far the edit goes, like Premiere's work area
  const work = document.createElement('div');
  work.className = 'ed-work';
  work.style.width = xOf(edDuration()) + 'px';
  ruler.append(work);
  for (const t of ed.p.markers || []) {
    const mk = document.createElement('i');
    mk.className = 'ed-mark';
    mk.style.left = xOf(markDrag && markDrag.from === t ? markDrag.to : t) + 'px';
    mk.title = `Метка ${tc(t)} — тяните, чтобы сдвинуть; клик: перейти; двойной клик: удалить`;
    mk.onpointerdown = e => dragMarker(e, t);
    mk.ondblclick = e => {
      e.stopPropagation();
      edCommit();
      ed.p.markers = ed.p.markers.filter(x => x !== t);
      edChanged();
    };
    ruler.append(mk);
  }
  renderZoombar();
}

// A mark can be dragged along the ruler (it snaps to clip edges and the playhead). The
// ruler may be redrawn meanwhile, so the drag follows the mouse on the whole page and the
// mark being dragged is drawn where it is going.
let markDrag = null; // { from, to }
function dragMarker(e, t) {
  e.stopPropagation();
  e.preventDefault();
  const x0 = e.clientX;
  let moved = false;
  const move = ev => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) { edCommit(); moved = true; }
    const s = snap(Math.max(0, t + tOf(ev.clientX - x0)), snapPoints(new Set()).filter(p => p !== t));
    markDrag = { from: t, to: s.t };
    renderRuler();
    showSnap(s.hit);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    showSnap(null);
    const to = markDrag ? markDrag.to : t;
    markDrag = null;
    if (!moved) return seekEd(t);
    ed.p.markers = [...new Set(ed.p.markers.map(x => (x === t ? Math.round(to * 1000) / 1000 : x)))].sort((a, b) => a - b);
    edChanged();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function addMarker() {
  edCommit();
  ed.p.markers = [...new Set([...(ed.p.markers || []), Math.round(ed.t * 1000) / 1000])].sort((a, b) => a - b);
  edChanged();
}
$('#ed-marker').onclick = addMarker;

function renderTimeline() {
  // frames asked for by the previous drawing but not taken yet may be off screen now
  for (const q of thumbQueue) edThumbs.delete(q.key);
  thumbQueue.length = 0;
  renderRuler();
  // The lanes are built aside and swapped in at once: emptying them first would shrink the
  // timeline for a moment and throw the view back to the top tracks
  const top = scroller.scrollTop;
  const lanes = ED_TRACKS.map(tr => {
    const lane = document.createElement('div');
    lane.className = `ed-lane ${tr.kind}`;
    lane.dataset.track = tr.id;
    lane.style.setProperty('--tc', trackColor(tr.id));
    lane.classList.toggle('off', (tr.kind === 'audio' && trackSilent(tr.id)) || ed.p.tracks[tr.id].hidden);
    lane.classList.toggle('locked', !!ed.p.tracks[tr.id].locked);
    for (const c of ed.p.clips.filter(x => x.track === tr.id)) lane.append(clipEl(c, tr));
    return lane;
  });
  lanesBox.replaceChildren(...lanes);
  if (scroller.scrollTop !== top) scroller.scrollTop = top;
  placePlayhead();
}

function clipEl(c, tr) {
  const el = document.createElement('div');
  el.className = `ed-clip ${tr.kind}`;
  el.style.setProperty('--cc', clipColor(c));
  el.classList.toggle('disabled', !!c.off);
  el.classList.toggle('sel', ed.sel.has(c.id));
  el.classList.toggle('linked', !!c.link);
  el.dataset.id = c.id;
  el.style.left = xOf(c.start) + 'px';
  el.style.width = Math.max(4, xOf(clipDur(c))) + 'px';
  const m = edMedia(c.media);
  const label = tr.kind === 'text' ? c.text.split('\n')[0] || 'Текст' : (m ? m.name : '?');
  el.innerHTML = '<span class="ed-name"></span><i class="ed-edge l"></i><i class="ed-edge r"></i>'
    + '<i class="ed-fh l" title="Тяните вправо — плавное появление"></i><i class="ed-fh r" title="Тяните влево — плавное затухание"></i>';
  el.querySelector('.ed-name').textContent = label + (c.volume !== 1 && tr.kind === 'audio' ? `  ${Math.round(c.volume * 100)}%` : '');
  const fi = xOf(c.fadeIn || 0), fo = xOf(c.fadeOut || 0);
  el.querySelector('.ed-fh.l').style.left = fi + 'px';
  el.querySelector('.ed-fh.r').style.right = fo + 'px';
  if (tr.kind === 'audio') {
    // waveform, and over it the loudness line that bends down into the fades
    const w = Math.max(4, xOf(clipDur(c)));
    const cv = document.createElement('canvas');
    cv.className = 'ed-wave';
    el.prepend(cv);
    drawClipWave(cv, c, el);
    const y = (1 - c.volume / 2) * 100;
    el.insertAdjacentHTML('beforeend', `<svg class="ed-env" viewBox="0 0 ${w} 100" preserveAspectRatio="none"><polyline points="0,${c.fadeIn ? 100 : y} ${fi},${y} ${w - fo},${y} ${w},${c.fadeOut ? 100 : y}"/></svg>`
      + `<i class="ed-vol" style="top: calc(${y}% - 4px); left: ${fi}px; right: ${fo}px" title="Тяните вверх или вниз — громкость (${Math.round(c.volume * 100)}%)"></i>`);
  } else {
    if (tr.kind === 'video' && m) el.prepend(filmStrip(c, m));
    if (c.fadeIn > 0) el.style.setProperty('--fi', fi + 'px');
    if (c.fadeOut > 0) el.style.setProperty('--fo', fo + 'px');
    el.classList.toggle('fi', c.fadeIn > 0);
    el.classList.toggle('fo', c.fadeOut > 0);
  }
  return el;
}

// ---------- waveforms of audio clips
//
// The whole file's peaks come from main.js (all its sound tracks are read in one pass and
// cached); a clip draws the part between its in and out points.

const edWaves = new Map(); // "path|index" -> peaks, or { partial, done } while being read
const waveIds = new Map(); // request id -> "path|index"
const wavePoints = m => clamp(Math.round(m.dur * 20), 200, 40000);
let waveRedraw = 0;

// Redraws that come from work in the background (waveforms being read) wait while a mouse
// button is down: swapping the timeline under a drag would drop whatever is being dragged
let pointerDown = false, renderPending = false;
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
for (const n of ['pointerup', 'pointercancel']) {
  document.addEventListener(n, () => {
    pointerDown = false;
    if (renderPending) setTimeout(() => { renderPending = false; if (currentView === 'editor') renderTimeline(); });
  }, true);
}
function bgRender() {
  if (pointerDown) renderPending = true;
  else if (currentView === 'editor') renderTimeline();
}

// A long recording takes a while: what is read so far is drawn, with how far it got
api.onWaveformProgress(({ id, peaks, done }) => {
  const key = waveIds.get(id);
  if (!key || Array.isArray(edWaves.get(key))) return;
  edWaves.set(key, { partial: peaks, done });
  if (!waveRedraw) waveRedraw = setTimeout(() => { waveRedraw = 0; bgRender(); }, 800);
});

// The part of a clip that is on screen, in px from the clip's left edge
function visiblePart(c) {
  const left = xOf(c.start);
  const a = Math.max(0, scroller.scrollLeft - 100 - left);
  const b = Math.min(xOf(clipDur(c)), scroller.scrollLeft + scroller.clientWidth + 100 - left);
  return b > a ? [a, b] : null;
}

function drawClipWave(cv, c, el) {
  const m = edMedia(c.media);
  const a = m && m.audio[c.audioK || 0];
  if (!a) return;
  const key = `${m.path}|${a.index}`;
  let peaks = edWaves.get(key);
  if (!peaks) {
    const id = newJob();
    waveIds.set(id, key);
    edWaves.set(key, { partial: null, done: 0 });
    api.waveform({ id, file: m.path, index: a.index, points: wavePoints(m) })
      .then(p => { edWaves.set(key, p); bgRender(); })
      .catch(() => edWaves.delete(key))
      .finally(() => waveIds.delete(id));
    peaks = edWaves.get(key);
  }
  if (!Array.isArray(peaks)) {
    const note = document.createElement('span');
    note.className = 'ed-wave-note';
    note.textContent = `звуковая волна строится… ${Math.round(peaks.done * 100)}%`;
    el.append(note);
    if (!peaks.partial) return;
    peaks = peaks.partial;
  }
  // only the visible stretch is drawn, so a long recording stays sharp at any zoom
  const part = visiblePart(c);
  if (!part) return;
  const [x0, x1] = part;
  const width = Math.round(x1 - x0);
  const h = 40;
  cv.width = width;
  cv.height = h;
  cv.style.left = x0 + 'px';
  cv.style.width = width + 'px';
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(0, 0, 0, .32)';
  const per = peaks.length / m.dur; // points per second of the file
  // quiet recordings are drawn taller, so their shape is still visible
  if (peaks.max == null) peaks.max = peaks.reduce((p, v) => Math.max(p, v), 0);
  const gain = Math.min(8, 0.95 / Math.max(0.01, peaks.max));
  for (let x = 0; x < width; x++) {
    const t0 = c.in + tOf(x0 + x);
    const t1 = c.in + tOf(x0 + x + 1);
    let v = 0;
    for (let i = Math.floor(t0 * per), e = Math.max(i + 1, Math.ceil(t1 * per)); i < e && i < peaks.length; i++) v = Math.max(v, peaks[i]);
    const bar = Math.max(1, Math.min(1, v * gain) * h);
    g.fillRect(x, (h - bar) / 2, 1, bar);
  }
}

// ---------- film strip on video clips
//
// Frames are taken by ffmpeg (frame-thumb in main.js), two at a time, newest wishes first,
// and kept for the session. Only the slots on screen are asked for.

const edThumbs = new Map(); // "path|time" -> data URL, or '' while loading
const thumbQueue = [];
let thumbBusy = 0;
const THUMB_W = 56;

function pumpThumbs() {
  while (thumbBusy < 2 && thumbQueue.length) {
    const { file, time, key } = thumbQueue.pop();
    thumbBusy++;
    const done = url => {
      thumbBusy--;
      edThumbs.set(key, url || 'none');
      for (const img of document.querySelectorAll('img.ed-thumb')) if (img.dataset.key === key && url) img.src = url;
      pumpThumbs();
    };
    (IMG_RE.test(file) ? Promise.resolve(api.toUrl(file)) : api.frameThumb({ file, time })).then(done, () => done(null));
  }
}

function filmStrip(c, m) {
  const strip = document.createElement('div');
  strip.className = 'ed-strip';
  const part = visiblePart(c);
  if (!part) return strip;
  const step = tOf(THUMB_W);
  for (let k = Math.floor(part[0] / THUMB_W); k * THUMB_W < part[1]; k++) {
    // times on a grid, so the same frames are reused while scrolling
    const time = m.image ? 0 : Math.min(m.dur - 0.05, Math.round((c.in + k * step) * 10) / 10);
    const key = `${m.path}|${time}`;
    const img = document.createElement('img');
    img.className = 'ed-thumb';
    img.dataset.key = key;
    img.style.left = k * THUMB_W + 'px';
    const have = edThumbs.get(key);
    if (have && have !== 'none') img.src = have;
    else if (have === undefined) {
      edThumbs.set(key, '');
      thumbQueue.push({ file: m.path, time, key });
    }
    strip.append(img);
  }
  setTimeout(pumpThumbs);
  return strip;
}

function placePlayhead() {
  $('#ed-playhead').style.left = xOf(ed.t) + 'px';
  $('#ed-time').textContent = tc(edDuration());
  $('#ed-tc-left').textContent = tc(ed.t);
  if (document.activeElement !== $('#ed-tc')) $('#ed-tc').value = tc(ed.t);
}

// The big timecode can be typed into
$('#ed-tc').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const t = parseTc(e.target.value);
    if (t !== null) seekEd(t);
    e.target.blur();
  } else if (e.key === 'Escape') e.target.blur();
});
$('#ed-tc').addEventListener('blur', () => { $('#ed-tc').value = tc(ed.t); });
$('#ed-tc').addEventListener('focus', e => e.target.select());

// Zoom: 0.02…400 px per second (a whole long recording fits, or single frames)
function setZoom(pps, anchorT = ed.t) {
  const before = xOf(anchorT) - scroller.scrollLeft;
  ed.pps = clamp(pps, 0.02, 400);
  renderTimeline();
  scroller.scrollLeft = xOf(anchorT) - before;
}
scroller.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.altKey) return;
  e.preventDefault();
  const r = scroller.getBoundingClientRect();
  setZoom(ed.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2), tOf(e.clientX - r.left + scroller.scrollLeft));
}, { passive: false });
// Backslash fits the whole edit, as in Premiere
const zoomToFit = () => { setZoom((scroller.clientWidth - 40) / Math.max(1, edDuration()), 0); scroller.scrollLeft = 0; };

// The bar under the timeline: its thumb is the visible part; drag it to scroll, drag its
// ends to zoom in or out
function renderZoombar() {
  const bar = $('.ed-zoombar');
  const total = Math.max(1, xOf(timelineLength()));
  const w = bar.clientWidth;
  const thumb = $('#ed-zoomthumb');
  thumb.style.left = (scroller.scrollLeft / total) * w + 'px';
  thumb.style.width = Math.max(24, Math.min(1, scroller.clientWidth / total) * w) + 'px';
}
$('#ed-zoomthumb').addEventListener('pointerdown', e => {
  e.preventDefault();
  const thumb = $('#ed-zoomthumb');
  thumb.setPointerCapture(e.pointerId);
  const bar = $('.ed-zoombar').getBoundingClientRect();
  const end = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : null;
  const r0 = thumb.getBoundingClientRect();
  const x0 = e.clientX;
  const len = timelineLength();
  const sl0 = scroller.scrollLeft;
  thumb.onpointermove = ev => {
    const dx = ev.clientX - x0;
    if (!end) {
      scroller.scrollLeft = sl0 + dx / bar.width * xOf(len);
      return;
    }
    // new visible span from the thumb's new edges
    let a = r0.left - bar.left, b = r0.right - bar.left;
    if (end === 'l') a = clamp(a + dx, 0, b - 12);
    else b = clamp(b + dx, a + 12, bar.width);
    const t0 = (a / bar.width) * len, t1 = (b / bar.width) * len;
    ed.pps = clamp(scroller.clientWidth / Math.max(0.05, t1 - t0), 0.02, 400);
    renderTimeline();
    scroller.scrollLeft = xOf(t0);
  };
  thumb.onpointerup = () => { thumb.onpointermove = thumb.onpointerup = null; };
});

// Snap points: clip edges, marks and the playhead, within 8 px
function snapPoints(exclude) {
  const pts = [0, ed.t, ...(ed.p.markers || [])];
  for (const c of ed.p.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
  return pts;
}
ed.snap = recall('edSnap', true);
ed.linkMove = recall('edLinked', true);
function renderToggles() {
  $('#ed-snap').classList.toggle('on', ed.snap);
  $('#ed-linked').classList.toggle('on', ed.linkMove);
}
$('#ed-snap').onclick = () => { ed.snap = !ed.snap; store('edSnap', ed.snap); renderToggles(); };
$('#ed-linked').onclick = () => { ed.linkMove = !ed.linkMove; store('edLinked', ed.linkMove); renderToggles(); };
function snap(t, pts) {
  if (!ed.snap) return { t, hit: null };
  let best = null;
  for (const p of pts) if (Math.abs(xOf(p - t)) <= 8 && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
  return best === null ? { t, hit: null } : { t: best, hit: best };
}
function showSnap(t) {
  const line = $('#ed-snapline');
  line.hidden = t === null;
  if (t !== null) line.style.left = xOf(t) + 'px';
}

const canvasX = e => e.clientX - $('#ed-canvas').getBoundingClientRect().left;

const isLocked = c => !!ed.p.tracks[c.track].locked;
// linked halves go along unless linked moving is switched off
const partners = c => (ed.linkMove ? linked(c) : [c]).filter(x => !isLocked(x));

lanesBox.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  if (ed.tool === 'hand') return panTimeline(e);
  if (ed.tool === 'track') return trackSelect(e);
  let el = e.target.closest('.ed-clip');
  // clips on a locked track cannot be picked or changed
  if (el && isLocked(ed.p.clips.find(x => x.id === Number(el.dataset.id)))) el = null;
  if (!el) {
    if (!e.shiftKey) ed.sel.clear();
    seekEd(tOf(canvasX(e)));
    renderTimeline();
    renderInspector();
    return;
  }
  const c = ed.p.clips.find(x => x.id === Number(el.dataset.id));
  if (ed.tool === 'razor') {
    // only the clicked track is cut; with Shift every unlocked track at that point
    const at = snap(tOf(canvasX(e)), snapPoints(new Set([c.id]))).t;
    splitClips(e.shiftKey ? ed.p.clips.filter(x => !isLocked(x)) : [c], at);
    return;
  }
  // a click picks just this clip; its linked halves still move with it
  if (e.shiftKey || e.ctrlKey) ed.sel.has(c.id) ? ed.sel.delete(c.id) : ed.sel.add(c.id);
  else ed.sel = new Set([c.id]);
  renderTimeline();
  renderInspector();
  if (e.target.classList.contains('ed-vol')) return dragLevel(e, c);
  if (e.target.classList.contains('ed-fh')) return dragFade(e, c, e.target.classList.contains('l') ? 'fadeIn' : 'fadeOut');
  const edge = e.target.classList.contains('ed-edge') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  dragClips(e, c, edge);
});

// Hand: drag the timeline sideways (and up and down)
function panTimeline(e) {
  lanesBox.setPointerCapture(e.pointerId);
  const x0 = e.clientX, y0 = e.clientY, sl = scroller.scrollLeft, st = scroller.scrollTop;
  lanesBox.classList.add('panning');
  lanesBox.onpointermove = ev => {
    scroller.scrollLeft = sl - (ev.clientX - x0);
    scroller.scrollTop = st - (ev.clientY - y0);
  };
  lanesBox.onpointerup = () => {
    lanesBox.onpointermove = lanesBox.onpointerup = null;
    lanesBox.classList.remove('panning');
  };
}

// Track select forward: everything from the click onwards (Shift: only on this track),
// then it can be dragged as one piece to open or close a gap
function trackSelect(e) {
  const t = tOf(canvasX(e));
  const lane = e.target.closest('.ed-lane');
  const list = ed.p.clips.filter(c => !isLocked(c) && clipEnd(c) > t + 1e-6 && (!e.shiftKey || (lane && c.track === lane.dataset.track)));
  ed.sel = new Set(list.map(c => c.id));
  renderTimeline();
  renderInspector();
  if (!list.length) return;
  const first = list.reduce((a, b) => (b.start < a.start ? b : a));
  dragClips(e, first, null);
}

// The volume line on a clip: up is louder (top = 200%, middle = 100%)
function dragLevel(e, c) {
  edCommit();
  lanesBox.setPointerCapture(e.pointerId);
  const move = ev => {
    // the clip is redrawn on every step, so its box is looked up each time
    const r = lanesBox.querySelector(`.ed-clip[data-id="${c.id}"]`).getBoundingClientRect();
    c.volume = Math.round(clamp(2 * (1 - (ev.clientY - r.top) / r.height), 0, 2) * 100) / 100;
    renderTimeline();
    renderInspector();
    syncPreview(false);
  };
  const up = () => {
    lanesBox.removeEventListener('pointermove', move);
    lanesBox.removeEventListener('pointerup', up);
    edChanged();
  };
  lanesBox.addEventListener('pointermove', move);
  lanesBox.addEventListener('pointerup', up);
}

// The round handles in the top corners: pull inwards for a fade in or out
function dragFade(e, c, key) {
  edCommit();
  lanesBox.setPointerCapture(e.pointerId);
  const move = ev => {
    const x = tOf(canvasX(ev));
    const v = key === 'fadeIn' ? x - c.start : clipEnd(c) - x;
    c[key] = Math.round(clamp(v, 0, clipDur(c) / 2) * 10) / 10;
    renderTimeline();
    renderInspector();
  };
  const up = () => {
    lanesBox.removeEventListener('pointermove', move);
    lanesBox.removeEventListener('pointerup', up);
    edChanged();
  };
  lanesBox.addEventListener('pointermove', move);
  lanesBox.addEventListener('pointerup', up);
}

function dragClips(e, c, edge) {
  const picked = ed.p.clips.filter(x => ed.sel.has(x.id));
  const group = edge ? partners(c) : [...new Set(picked.flatMap(partners))];
  const orig = new Map(group.map(x => [x.id, { ...x }]));
  const ids = new Set(group.map(x => x.id));
  const pts = snapPoints(ids);
  const x0 = canvasX(e);
  const y0 = e.clientY;
  const lane0 = c.track;
  let committed = false;
  lanesBox.setPointerCapture(e.pointerId);
  const move = ev => {
    const dt = tOf(canvasX(ev) - x0);
    if (!committed) {
      if (Math.abs(canvasX(ev) - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      edCommit();
      committed = true;
    }
    let hit = null;
    if (edge) {
      for (const x of group) {
        const o = orig.get(x.id);
        const m = edMedia(x.media);
        const maxOut = x.track === 'T1' || (m && m.image) ? Infinity : m ? m.dur : o.out;
        if (edge === 'l') {
          let s = snap(o.start + dt, pts);
          let d = clamp(s.t - o.start, -o.in, clipDur(o) - 0.05);
          d = Math.max(d, -o.start);
          x.start = o.start + d;
          x.in = o.in + d;
          hit = s.hit;
        } else {
          let s = snap(clipEnd(o) + dt, pts);
          x.out = clamp(o.out + (s.t - clipEnd(o)), o.in + 0.05, maxOut);
          hit = s.hit;
        }
      }
    } else {
      // whole selection moves; the grabbed clip snaps by its start or end
      let d = dt;
      const a = snap(orig.get(c.id).start + dt, pts);
      const b = snap(clipEnd(orig.get(c.id)) + dt, pts);
      if (a.hit !== null) { d = a.t - orig.get(c.id).start; hit = a.hit; }
      else if (b.hit !== null) { d = b.t - clipEnd(orig.get(c.id)); hit = b.hit; }
      d = Math.max(d, -Math.min(...group.map(x => orig.get(x.id).start)));
      for (const x of group) x.start = orig.get(x.id).start + d;
      // the grabbed clip may go to another track of the same kind
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const lane = over && over.closest('.ed-lane');
      if (lane && trackOf(lane.dataset.track).kind === trackOf(lane0).kind) c.track = lane.dataset.track;
    }
    showSnap(hit);
    renderTimeline();
  };
  const up = () => {
    lanesBox.removeEventListener('pointermove', move);
    lanesBox.removeEventListener('pointerup', up);
    showSnap(null);
    if (!committed) return;
    resolveOverlaps(group);
    edChanged();
  };
  lanesBox.addEventListener('pointermove', move);
  lanesBox.addEventListener('pointerup', up);
}

function splitClips(list, t) {
  const cut = [];
  for (const x of list) if (!cut.includes(x) && x.start + 0.02 < t && clipEnd(x) - 0.02 > t) cut.push(x);
  if (!cut.length) return;
  edCommit();
  const newLink = new Map();
  for (const c of cut) {
    const tail = { ...c, id: ed.nextId++, start: t, in: c.in + (t - c.start), fadeIn: 0 };
    if (c.link) {
      if (!newLink.has(c.link)) newLink.set(c.link, ed.nextId++);
      tail.link = newLink.get(c.link);
    }
    c.out = c.in + (t - c.start);
    c.fadeOut = 0;
    ed.p.clips.push(tail);
  }
  edChanged();
}

function splitAtPlayhead(shiftAll = false) {
  // only what is selected is cut (Shift+S cuts every unlocked track)
  const sel = ed.p.clips.filter(c => ed.sel.has(c.id) && !isLocked(c));
  if (shiftAll) return splitClips(ed.p.clips.filter(c => !isLocked(c)), ed.t);
  if (!sel.length) return toast('Выберите клип, который резать (или Shift+S — разрезать все дорожки).');
  splitClips(sel, ed.t);
}

function deleteSelected() {
  if (!ed.sel.size) return;
  edCommit();
  ed.p.clips = ed.p.clips.filter(c => !ed.sel.has(c.id) || isLocked(c));
  ed.sel.clear();
  edChanged();
}

// ---------- copy, paste, and the clip menu (right click)

let edClipboard = [];
function copySelected() {
  const sel = ed.p.clips.filter(c => ed.sel.has(c.id));
  if (!sel.length) return;
  const from = Math.min(...sel.map(c => c.start));
  edClipboard = sel.map(c => ({ ...c, start: c.start - from }));
  toast(`Скопировано клипов: ${sel.length}. Ctrl+V вставит их у линии времени.`);
}
// Pasted at the playhead on the same tracks, over what is there (like Premiere)
function pasteClips() {
  if (!edClipboard.length) return;
  edCommit();
  const links = new Map();
  const made = edClipboard.map(c => {
    const x = { ...c, id: ed.nextId++, start: ed.t + c.start };
    if (c.link) {
      if (!links.has(c.link)) links.set(c.link, ed.nextId++);
      x.link = links.get(c.link);
    }
    return x;
  });
  ed.p.clips.push(...made);
  resolveOverlaps(made);
  ed.sel = new Set(made.map(c => c.id));
  seekEd(Math.max(...made.map(clipEnd)));
  edChanged();
}

function clipMenu(e, c) {
  e.preventDefault();
  if (!ed.sel.has(c.id)) {
    ed.sel = new Set([c.id]);
    renderTimeline();
    renderInspector();
  }
  const sel = ed.p.clips.filter(x => ed.sel.has(x.id));
  const change = fn => () => { edCommit(); sel.forEach(fn); edChanged(); };
  const items = [
    { icon: c.off ? 'i-eye' : 'i-eye-off', label: c.off ? 'Включить клип' : 'Выключить клип (не виден и не слышен)', run: change(x => { x.off = !c.off; }) },
  ];
  if (sel.some(x => x.link)) items.push({ icon: 'i-link', label: 'Отвязать картинку от звука', run: change(x => { x.link = 0; }) });
  const media = new Set(sel.map(x => x.media));
  if (sel.length > 1 && media.size === 1 && sel.some(x => trackOf(x.track).kind === 'video') && sel.some(x => trackOf(x.track).kind === 'audio')) {
    const id = ed.nextId++;
    items.push({ icon: 'i-link', label: 'Связать выбранное', run: change(x => { x.link = id; }) });
  }
  items.push('-',
    { icon: 'i-scissors', label: 'Разрезать по линии времени', run: () => splitClips(sel, ed.t) },
    { icon: 'i-file-plus', label: 'Копировать (Ctrl+C)', run: copySelected },
    '-',
    { icon: 'i-x', label: 'Удалить', danger: true, run: deleteSelected });
  openCtxMenu(e.clientX, e.clientY, items);
  // label colours, as Premiere's "Label" submenu
  const row = document.createElement('div');
  row.className = 'ed-labels';
  for (const [name, title, color] of LABELS) {
    const b = document.createElement('button');
    b.style.background = color;
    b.title = title;
    b.classList.toggle('on', (c.label || TRACK_LABELS[c.track]) === name);
    b.onclick = () => { closeCtxMenu(); change(x => { x.label = name; })(); };
    row.append(b);
  }
  const cap = document.createElement('div');
  cap.className = 'ed-labels-cap';
  cap.textContent = 'Цвет метки';
  $('#ctx-menu').prepend(cap, row);
}
lanesBox.addEventListener('contextmenu', e => {
  const el = e.target.closest('.ed-clip');
  const c = el && ed.p.clips.find(x => x.id === Number(el.dataset.id));
  if (c && !isLocked(c)) clipMenu(e, c);
});

// Ruler: click or drag to move the playhead
$('#ed-ruler').addEventListener('pointerdown', e => {
  const r = $('#ed-ruler');
  r.setPointerCapture(e.pointerId);
  const go = ev => seekEd(tOf(canvasX(ev)));
  go(e);
  r.onpointermove = go;
  r.onpointerup = () => { r.onpointermove = null; };
});

// Files dropped from the bin or from Explorer onto a lane
lanesBox.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
lanesBox.addEventListener('drop', async e => {
  e.preventDefault();
  const lane = e.target.closest('.ed-lane');
  const t = Math.max(0, tOf(canvasX(e)));
  const path = e.dataTransfer.getData('text/tako-media');
  let media = path ? [edMedia(path)] : await edImport([...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean));
  let at = snap(t, snapPoints(new Set())).t;
  for (const m of media.filter(Boolean)) {
    edPlace(m, lane && lane.dataset.track, at);
    at += m.image ? IMAGE_DUR : m.dur;
  }
});
$('.ed-bin').addEventListener('dragover', e => e.preventDefault());
$('.ed-bin').addEventListener('drop', e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
  if (files.length) edImport(files);
});

// ---------- titles

function addText() {
  edCommit();
  const c = { id: ed.nextId++, track: 'T1', start: ed.t, in: 0, out: 4, text: 'Новый текст', size: 72, color: 'white', x: 0.5, y: 0.85, box: false, fadeIn: 0, fadeOut: 0, volume: 1 };
  ed.p.clips.push(c);
  resolveOverlaps([c]);
  ed.sel = new Set([c.id]);
  edChanged();
  const ta = $('#ed-insp-body textarea');
  if (ta) { ta.focus(); ta.select(); }
}

// Where a title's centre is, as parts of the frame (older titles only had top/centre/bottom)
const titleXY = c => (c.x != null ? [c.x, c.y] : [0.5, { top: 0.12, center: 0.5 }[c.pos] || 0.85]);

function dragTitle(e, c, d) {
  e.stopPropagation();
  if (!ed.sel.has(c.id)) {
    ed.sel = new Set([c.id]);
    renderTimeline();
    renderInspector();
  }
  const r = $('#ed-screen').getBoundingClientRect();
  const [x0, y0] = titleXY(c);
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  d.setPointerCapture(e.pointerId);
  d.onpointermove = ev => {
    if (!moved) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
      edCommit();
      moved = true;
    }
    // centre lines pull the text in, like guides
    let x = clamp(x0 + (ev.clientX - sx) / r.width, 0, 1);
    let y = clamp(y0 + (ev.clientY - sy) / r.height, 0, 1);
    if (Math.abs(x - 0.5) * r.width < 6) x = 0.5;
    if (Math.abs(y - 0.5) * r.height < 6) y = 0.5;
    c.x = x;
    c.y = y;
    d.style.left = x * 100 + '%';
    d.style.top = y * 100 + '%';
  };
  d.onpointerup = () => {
    d.onpointermove = d.onpointerup = null;
    if (moved) edChanged();
  };
}

// ---------- inspector

// Effect Controls, as in Premiere: the selected clip's effects in folding sections, each
// value a blue number that is dragged left/right (Shift: faster, Alt: finer) or clicked to
// type, with a reset arrow. Several selected clips change together.
const fxOpen = recall('edFxOpen', { motion: true, opacity: true, volume: true, text: true, source: true });

function renderInspector() {
  const body = $('#ed-insp-body');
  body.innerHTML = '';
  const sel = ed.p.clips.filter(c => ed.sel.has(c.id));
  if (!sel.length) {
    body.innerHTML = '<div class="fx-empty">(клип не выбран)</div>'
      + '<div class="ed-hint"><b>Пробел</b> — смотреть · <b>S</b> — разрезать выделенное · <b>Shift+S</b> — все дорожки<br>'
      + '<b>V</b> выделение · <b>A</b> всё дальше · <b>C</b> бритва · <b>H</b> рука · <b>T</b> текст · <b>M</b> метка<br>'
      + '<b>Ctrl+C / Ctrl+V</b> — копировать и вставить · <b>\\</b> — весь монтаж на экран</div>';
    return;
  }
  const c = sel.length === 1 ? sel[0] : sel.find(x => trackOf(x.track).kind === 'video') || sel[0];
  const kind = trackOf(c.track).kind;
  const m = edMedia(c.media);
  const pics = sel.filter(x => trackOf(x.track).kind === 'video');
  const sounds = sel.filter(x => trackOf(x.track).kind === 'audio');

  // header: clip name over a small bar of where it sits
  const head = document.createElement('div');
  head.className = 'fx-head';
  head.innerHTML = '<div class="fx-name"></div><div class="fx-tc"></div>';
  head.querySelector('.fx-name').textContent = (sel.length > 1 ? `${sel.length} клипа · ` : '') + (kind === 'text' ? 'Надпись' : m ? m.name : '');
  head.querySelector('.fx-name').style.setProperty('--cc', clipColor(c));
  head.querySelector('.fx-tc').textContent = `${trackOf(c.track).name} · ${tc(c.start)} – ${tc(clipEnd(c))} · длина ${tc(clipDur(c))}`;
  body.append(head);

  const section = (key, title, fill, reset) => {
    const s = document.createElement('div');
    s.className = 'fx-sec';
    s.classList.toggle('open', fxOpen[key] !== false);
    s.innerHTML = '<div class="fx-title"><svg class="i chev"><use href="#i-chevron"/></svg><i class="fx-badge">fx</i><span></span></div><div class="fx-rows"></div>';
    s.querySelector('span').textContent = title;
    s.querySelector('.fx-title').onclick = e => {
      if (e.target.closest('.fx-reset')) return;
      fxOpen[key] = !s.classList.contains('open');
      store('edFxOpen', fxOpen);
      s.classList.toggle('open', fxOpen[key]);
    };
    if (reset) {
      const r = document.createElement('button');
      r.className = 'fx-reset';
      r.title = 'Сбросить';
      r.innerHTML = '↺';
      r.onclick = () => { edCommit(); reset(); edChanged(); };
      s.querySelector('.fx-title').append(r);
    }
    fill(s.querySelector('.fx-rows'));
    body.append(s);
  };

  // one value: label, scrubbable number, optional unit and reset
  const value = (rows, label, get, set, { min = -Infinity, max = Infinity, step = 1, unit = '', show, def, list = sel }) => {
    const row = document.createElement('div');
    row.className = 'fx-row';
    row.innerHTML = '<span class="fx-label"></span><span class="fx-num" tabindex="0"></span><span class="fx-unit"></span>';
    row.querySelector('.fx-label').textContent = label;
    row.querySelector('.fx-unit').textContent = unit;
    const num = row.querySelector('.fx-num');
    const paint = () => { num.textContent = show ? show(get(c)) : String(Math.round(get(c) / step) * step).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); };
    paint();
    const apply = v => {
      v = clamp(v, min, max);
      for (const x of list) set(x, v);
      paint();
      store('edProject', ed.p);
      syncPreview(true);
    };
    num.onpointerdown = e => {
      e.preventDefault();
      num.setPointerCapture(e.pointerId);
      const x0 = e.clientX, v0 = get(c);
      let moved = false;
      num.onpointermove = ev => {
        const dx = ev.clientX - x0;
        if (!moved && Math.abs(dx) < 2) return;
        if (!moved) { edCommit(); moved = true; document.body.classList.add('fx-scrub'); }
        const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        apply(v0 + Math.round(dx * k) * step);
      };
      num.onpointerup = () => {
        num.onpointermove = num.onpointerup = null;
        document.body.classList.remove('fx-scrub');
        if (moved) { renderTimeline(); return; }
        // a click types a value
        const inp = document.createElement('input');
        inp.className = 'fx-input';
        inp.value = num.textContent.replace('−∞', '-100').replace(',', '.');
        num.replaceWith(inp);
        inp.focus();
        inp.select();
        let closed = false;
        const done = ok => {
          if (closed) return; // Enter closes it, and the blur that follows must not again
          closed = true;
          if (ok) {
            const v = parseFloat(inp.value.replace(',', '.'));
            if (Number.isFinite(v)) { edCommit(); apply(v); renderTimeline(); }
          }
          inp.replaceWith(num);
        };
        inp.onkeydown = ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); ev.stopPropagation(); };
        inp.onblur = () => done(true);
      };
    };
    if (def !== undefined) {
      const r = document.createElement('button');
      r.className = 'fx-reset';
      r.title = 'Сбросить';
      r.innerHTML = '↺';
      r.onclick = () => { edCommit(); apply(def); renderTimeline(); };
      row.append(r);
    }
    rows.append(row);
  };

  if (kind === 'video' || pics.length) {
    const p = pics.length ? pics : [c];
    const v = p[0];
    section('motion', 'Движение', rows => {
      value(rows, 'Положение X', x => motion(x).x, (x, n) => { x.posX = n; }, { step: 1, def: ed.p.w / 2, list: p });
      value(rows, 'Положение Y', x => motion(x).y, (x, n) => { x.posY = n; }, { step: 1, def: ed.p.h / 2, list: p });
      value(rows, 'Масштаб', x => motion(x).scale, (x, n) => { x.scale = n; }, { min: 1, max: 1000, step: 1, unit: '%', def: 100, list: p });
      value(rows, 'Поворот', x => motion(x).rot, (x, n) => { x.rot = n; }, { min: -3600, max: 3600, step: 1, unit: '°', def: 0, list: p });
    }, () => p.forEach(x => { x.posX = x.posY = x.scale = null; x.rot = 0; }));
    section('opacity', 'Непрозрачность', rows => {
      value(rows, 'Непрозрачность', x => motion(x).opacity, (x, n) => { x.opacity = n; }, { min: 0, max: 100, step: 1, unit: '%', def: 100, list: p });
      value(rows, 'Появление', x => x.fadeIn || 0, (x, n) => { x.fadeIn = Math.min(n, clipDur(x) / 2); }, { min: 0, step: 0.1, unit: 'с', def: 0, list: p });
      value(rows, 'Исчезание', x => x.fadeOut || 0, (x, n) => { x.fadeOut = Math.min(n, clipDur(x) / 2); }, { min: 0, step: 0.1, unit: 'с', def: 0, list: p });
      if (m && m.image) value(rows, 'Длительность', x => clipDur(x), (x, n) => { x.out = x.in + n; }, { min: 0.2, step: 0.1, unit: 'с', list: [v] });
    }, () => p.forEach(x => { x.opacity = null; x.fadeIn = x.fadeOut = 0; }));
  }

  if (kind === 'text') {
    section('text', 'Текст', rows => {
      const ta = document.createElement('textarea');
      ta.className = 'fx-text';
      ta.value = c.text;
      ta.rows = 3;
      ta.onfocus = () => edCommit();
      ta.oninput = () => { c.text = ta.value; store('edProject', ed.p); syncPreview(true); };
      ta.onchange = () => renderTimeline();
      rows.append(ta);
      value(rows, 'Размер', x => x.size, (x, n) => { x.size = n; }, { min: 8, max: 400, step: 1, unit: 'px', def: 72 });
      value(rows, 'Положение X', x => titleXY(x)[0] * ed.p.w, (x, n) => { x.x = n / ed.p.w; x.y = titleXY(x)[1]; }, { step: 1, def: ed.p.w / 2 });
      value(rows, 'Положение Y', x => titleXY(x)[1] * ed.p.h, (x, n) => { x.y = n / ed.p.h; x.x = titleXY(x)[0]; }, { step: 1, def: ed.p.h * 0.85 });
      value(rows, 'Появление', x => x.fadeIn || 0, (x, n) => { x.fadeIn = Math.min(n, clipDur(x) / 2); }, { min: 0, step: 0.1, unit: 'с', def: 0 });
      value(rows, 'Исчезание', x => x.fadeOut || 0, (x, n) => { x.fadeOut = Math.min(n, clipDur(x) / 2); }, { min: 0, step: 0.1, unit: 'с', def: 0 });
      const colors = document.createElement('div');
      colors.className = 'fx-row fx-colors';
      colors.innerHTML = '<span class="fx-label">Цвет</span>';
      for (const col of ['white', 'yellow', '#ff5d3a', '#3ad1ff', '#7bff6b', 'black']) {
        const b = document.createElement('button');
        b.style.background = col;
        b.classList.toggle('on', c.color === col);
        b.onclick = () => { edCommit(); for (const x of sel) x.color = col; edChanged(); };
        colors.append(b);
      }
      rows.append(colors);
      const box = document.createElement('label');
      box.className = 'fx-row fx-check';
      box.innerHTML = '<span class="fx-label">Подложка</span><input type="checkbox">';
      box.querySelector('input').checked = !!c.box;
      box.querySelector('input').onchange = ev => { edCommit(); for (const x of sel) x.box = ev.target.checked; edChanged(); };
      rows.append(box);
      const where = document.createElement('div');
      where.className = 'fx-row fx-where';
      for (const [label, x, y] of [['Сверху', 0.5, 0.12], ['Центр', 0.5, 0.5], ['Снизу', 0.5, 0.85]]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => { edCommit(); for (const t of sel) Object.assign(t, { x, y }); edChanged(); };
        where.append(b);
      }
      rows.append(where);
    });
  }

  if (sounds.length) {
    section('volume', 'Громкость', rows => {
      for (const a of sounds) {
        if (sounds.length > 1) {
          const n = document.createElement('div');
          n.className = 'fx-sub';
          n.textContent = a.track;
          rows.append(n);
        }
        // the level in decibels like Premiere; 0 dB = as recorded, up to +6 dB (200%)
        value(rows, 'Уровень', x => (x.volume > 0 ? 20 * Math.log10(x.volume) : -60), (x, n) => { x.volume = n <= -60 ? 0 : Math.pow(10, n / 20); },
          { min: -60, max: 6, step: 0.1, unit: 'дБ', def: 0, list: [a], show: v => (v <= -60 ? '−∞' : (v >= 0 ? '+' : '') + v.toFixed(1)) });
        value(rows, 'Нарастание', x => x.fadeIn || 0, (x, n) => { x.fadeIn = Math.min(n, clipDur(x) / 2); }, { min: 0, step: 0.1, unit: 'с', def: 0, list: [a] });
        value(rows, 'Затухание', x => x.fadeOut || 0, (x, n) => { x.fadeOut = Math.min(n, clipDur(x) / 2); }, { min: 0, step: 0.1, unit: 'с', def: 0, list: [a] });
        const am = edMedia(a.media);
        if (am && am.audio.length > 1) {
          const row = document.createElement('label');
          row.className = 'fx-row';
          row.innerHTML = '<span class="fx-label">Дорожка файла</span>';
          const s = document.createElement('select');
          am.audio.forEach((t, k) => s.add(new Option(`${k + 1}${t.name ? ' — ' + t.name : ''}`, k)));
          s.value = a.audioK || 0;
          s.onchange = () => { edCommit(); a.audioK = Number(s.value); edChanged(); };
          row.append(s);
          rows.append(row);
        }
      }
    }, () => sounds.forEach(x => { x.volume = 1; x.fadeIn = x.fadeOut = 0; }));
  }
}

// ---------- preview
//
// One <video> per video track shows the clip under the playhead; audio clips play through
// their own <audio> elements. While playing, a clock drives the playhead and the elements
// are nudged back when they drift.

const edV = { V1: $('#ed-v1'), V2: $('#ed-v2') };
const edAudio = new Map(); // clip id -> <audio>
let clock = null; // { t0, n0 }

function fadeAt(c, t) {
  const local = t - c.start;
  let a = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) a = Math.min(a, local / c.fadeIn);
  if (c.fadeOut > 0 && clipDur(c) - local < c.fadeOut) a = Math.min(a, (clipDur(c) - local) / c.fadeOut);
  return clamp(a, 0, 1);
}
// Motion and opacity of a picture clip, as in Premiere's Effect Controls; the position is
// the centre of the picture in frame pixels
const motion = c => ({
  x: c.posX != null ? c.posX : ed.p.w / 2,
  y: c.posY != null ? c.posY : ed.p.h / 2,
  scale: c.scale != null ? c.scale : 100,
  rot: c.rot || 0,
  opacity: c.opacity != null ? c.opacity : 100,
});
// The same on screen: the preview is the frame shrunk to fit
function motionCss(c, el) {
  const mo = motion(c);
  const k = $('#ed-screen').clientHeight / ed.p.h;
  el.style.transform = `translate(${(mo.x - ed.p.w / 2) * k}px, ${(mo.y - ed.p.h / 2) * k}px) scale(${mo.scale / 100}) rotate(${mo.rot}deg)`;
  return mo.opacity / 100;
}

const clipAt = (track, t) => ed.p.clips.find(c => !c.off && c.track === track && c.start <= t && clipEnd(c) > t);

function syncEl(el, file, local, force) {
  const url = api.toUrl(file);
  if (el.dataset.src !== url) {
    // a seek before the file is open gets lost, so it waits for the metadata
    el.dataset.src = url;
    el.src = url;
    el.addEventListener('loadedmetadata', () => { el.currentTime = Number(el.dataset.want); }, { once: true });
  }
  el.dataset.want = local;
  if (el.readyState < 1) {
    // still opening: the seek above takes the newest wanted time
  } else if (el.seeking) {
    // A big recording can take a while to seek. Asking again every frame would restart the
    // seek forever, so the newest wanted time is applied once this seek is done.
    if (!el.seekQueued) {
      el.seekQueued = true;
      el.addEventListener('seeked', () => {
        el.seekQueued = false;
        const want = Number(el.dataset.want) + (ed.playing ? 0.15 : 0);
        if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      }, { once: true });
    }
  } else if (force || Math.abs(el.currentTime - local) > 0.3) {
    el.currentTime = local;
  }
  const run = ed.playing && !ed.holding;
  if (run && el.paused) el.play().catch(() => {});
  if (!run && !el.paused) el.pause();
}

// Something on screen or in the speakers is still seeking or loading
const edWaiting = () => [...Object.values(edV), ...edAudio.values()]
  .some(el => el.dataset.src && !el.hidden && el.src && (el.seeking || el.readyState < 3));

function syncPreview(force) {
  const t = ed.t;
  const screen = $('#ed-screen');
  for (const [track, el] of Object.entries(edV)) {
    const c = !ed.p.tracks[track].hidden && clipAt(track, t);
    const m = c && edMedia(c.media);
    if (!c || !m) {
      el.hidden = true;
      if (!el.paused) el.pause();
      screen.querySelector(`img[data-track="${track}"]`)?.remove();
      continue;
    }
    if (m.image) {
      el.hidden = true;
      let img = screen.querySelector(`img[data-track="${track}"]`);
      if (!img) {
        img = document.createElement('img');
        img.dataset.track = track;
        img.className = 'ed-layer ' + track;
        screen.insertBefore(img, $('#ed-titles'));
      }
      if (img.dataset.src !== m.path) { img.dataset.src = m.path; img.src = api.toUrl(m.path); }
      img.style.opacity = fadeAt(c, t) * motionCss(c, img);
      continue;
    }
    screen.querySelector(`img[data-track="${track}"]`)?.remove();
    el.hidden = false;
    el.style.opacity = fadeAt(c, t) * motionCss(c, el);
    syncEl(el, m.path, c.in + (t - c.start), force && !ed.playing);
  }
  // sound
  const live = new Set();
  for (const c of ed.p.clips) {
    const tr = trackOf(c.track);
    if (tr.kind !== 'audio' || c.off || c.start > t || clipEnd(c) <= t) continue;
    const st = ed.p.tracks[c.track];
    live.add(c.id);
    let el = edAudio.get(c.id);
    if (!el) {
      el = new Audio();
      el.preload = 'auto';
      edAudio.set(c.id, el);
    }
    const m = edMedia(c.media);
    if (!m) continue;
    // a file with several sound tracks plays the chosen one
    if (el.audioTracks && el.audioTracks.length > 1) {
      for (let k = 0; k < el.audioTracks.length; k++) el.audioTracks[k].enabled = k === (c.audioK || 0);
    } else if (!el.audioTracks) el.addEventListener('loadedmetadata', () => syncPreview(), { once: true });
    el.volume = clamp(c.volume * st.volume * fadeAt(c, t), 0, 1);
    el.muted = trackSilent(c.track);
    syncEl(el, m.path, c.in + (t - c.start), force && !ed.playing);
  }
  for (const [id, el] of edAudio) {
    if (live.has(id)) continue;
    el.pause();
    el.removeAttribute('src');
    edAudio.delete(id);
  }
  // titles
  const titles = $('#ed-titles');
  titles.innerHTML = '';
  if (!ed.p.tracks.T1.hidden) {
    for (const c of ed.p.clips.filter(x => !x.off && x.track === 'T1' && x.start <= t && clipEnd(x) > t)) {
      const d = document.createElement('div');
      d.className = 'ed-title';
      d.classList.toggle('box', c.box);
      d.classList.toggle('sel', ed.sel.has(c.id));
      d.textContent = c.text;
      const [x, y] = titleXY(c);
      d.style.left = x * 100 + '%';
      d.style.top = y * 100 + '%';
      d.onpointerdown = e => dragTitle(e, c, d);
      d.onclick = e => e.stopPropagation();
      // sizes are given for a 1080 px high frame
      d.style.fontSize = `calc(${c.size / 1080} * var(--ed-h))`;
      d.style.color = c.color;
      d.style.opacity = fadeAt(c, t);
      titles.append(d);
    }
  }
  placePlayhead();
}

function seekEd(t) {
  ed.t = clamp(t, 0, Math.max(edDuration(), 0));
  if (ed.playing) clock = { t0: ed.t, n0: performance.now() };
  syncPreview(true);
  // a jump out of sight brings the timeline along
  const x = xOf(ed.t);
  if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 20) scroller.scrollLeft = x - scroller.clientWidth / 3;
}

function edTick() {
  if (!ed.playing) return;
  // while the picture or sound catches up after a jump the playhead waits for it, so
  // time does not run on without them
  ed.holding = false;
  if (edWaiting()) {
    if (!clock.wait) clock.wait = performance.now();
    if (performance.now() - clock.wait < 4000) {
      ed.holding = true; // the ready ones wait too, so sound and picture start together
      syncPreview(false);
      requestAnimationFrame(edTick);
      return;
    }
  }
  if (clock.wait) {
    clock = { t0: ed.t, n0: performance.now() };
  }
  ed.t = clock.t0 + (performance.now() - clock.n0) / 1000;
  if (ed.t >= edDuration()) {
    ed.t = edDuration();
    edPause();
    return;
  }
  syncPreview(false);
  // keep the playhead in view
  const x = xOf(ed.t);
  if (x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = x - 80;
  requestAnimationFrame(edTick);
}

function edPlay() {
  if (!edDuration()) return;
  if (ed.t >= edDuration() - 0.05) ed.t = 0;
  ed.playing = true;
  clock = { t0: ed.t, n0: performance.now() };
  $('#ed-play-icon').setAttribute('href', '#i-pause');
  syncPreview(true);
  requestAnimationFrame(edTick);
}
function edPause() {
  ed.playing = false;
  $('#ed-play-icon').setAttribute('href', '#i-play');
  for (const el of [...Object.values(edV), ...edAudio.values()]) el.pause();
  syncPreview(true);
}
const edToggle = () => (ed.playing ? edPause() : edPlay());

$('#ed-play').onclick = edToggle;
$('#ed-fback').onclick = () => seekEd(ed.t - 1 / fpsOf());
$('#ed-ffwd').onclick = () => seekEd(ed.t + 1 / fpsOf());
$('#ed-mark-btn').onclick = () => addMarker();
$('#ed-home').onclick = () => seekEd(0);
$('#ed-end').onclick = () => seekEd(edDuration());
$('#ed-screen').onclick = edToggle;

// The preview keeps the project's frame shape
function fitScreen() {
  const wrap = $('#ed-screen-wrap');
  // the picture floats inside the monitor (it never makes the monitor taller), with a margin
  const k = Math.max(0.01, Math.min((wrap.clientWidth - 16) / ed.p.w, (wrap.clientHeight - 16) / ed.p.h));
  const s = $('#ed-screen');
  s.style.width = Math.floor(ed.p.w * k) + 'px';
  s.style.height = Math.floor(ed.p.h * k) + 'px';
  s.style.setProperty('--ed-h', Math.floor(ed.p.h * k) + 'px');
}
new ResizeObserver(fitScreen).observe($('#ed-screen-wrap'));

// The border between the monitor and the timeline can be dragged; its place is remembered
const edBox = $('.ed');
const setTopH = px => edBox.style.setProperty('--top-h', Math.round(clamp(px, 160, edBox.clientHeight - 220)) + 'px');
{
  const saved = recall('edTopH', 0);
  if (saved) setTopH(saved);
}
$('.ed-split').ondblclick = () => { edBox.style.removeProperty('--top-h'); store('edTopH', 0); };
// Side borders: effects | monitor and project | timeline
for (const bar of document.querySelectorAll('.ed-vsplit')) {
  const v = bar.dataset.var, key = bar.dataset.key;
  const panel = bar.previousElementSibling;
  const setW = px => edBox.style.setProperty(v, Math.round(clamp(px, 180, bar.parentNode.clientWidth - 320)) + 'px');
  const saved = recall(key, 0);
  if (saved) setW(saved);
  bar.ondblclick = () => { edBox.style.removeProperty(v); store(key, 0); };
  bar.addEventListener('pointerdown', e => {
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('drag');
    document.body.classList.add('ed-resizing');
    const left = panel.getBoundingClientRect().left;
    bar.onpointermove = ev => setW(ev.clientX - left - 3);
    bar.onpointerup = () => {
      bar.onpointermove = bar.onpointerup = null;
      bar.classList.remove('drag');
      document.body.classList.remove('ed-resizing');
      store(key, panel.getBoundingClientRect().width);
      renderTimeline();
    };
  });
}
$('.ed-split').addEventListener('pointerdown', e => {
  const bar = e.currentTarget;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add('drag');
  const top = edBox.getBoundingClientRect().top + 4;
  bar.onpointermove = ev => setTopH(ev.clientY - top - 3);
  bar.onpointerup = () => {
    bar.onpointermove = bar.onpointerup = null;
    bar.classList.remove('drag');
    store('edTopH', $('.ed-top').getBoundingClientRect().height);
  };
});
new ResizeObserver(() => renderRuler()).observe(scroller);
// track names follow the lanes when the timeline scrolls up and down
scroller.addEventListener('scroll', () => {
  $('#ed-heads').scrollTop = scroller.scrollTop;
  renderRuler();
  // film strips are drawn only where they can be seen
  clearTimeout(ed.stripTimer);
  ed.stripTimer = setTimeout(renderTimeline, 120);
});

// ---------- project settings

// "30000/1001" -> 29.97, rounded to the usual rates
function commonFps(rate) {
  const [a, b] = String(rate || '').split('/').map(Number);
  const f = b ? a / b : a;
  if (!(f > 0)) return 0;
  return [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].find(x => Math.abs(x - f) < 0.02) || Math.round(f);
}

// A size or rate that is not in the toolbar lists gets its own entry there
function ensureOption(sel, value, text) {
  if (![...sel.options].some(o => o.value === value)) sel.add(new Option(text, value));
  sel.value = value;
}
function renderProjectSettings() {
  ensureOption($('#ed-res'), `${ed.p.w}x${ed.p.h}`, `${ed.p.w}×${ed.p.h}`);
  ensureOption($('#ed-fps'), String(ed.p.fps), `${fpsText(ed.p.fps)} к/с`);
  fitScreen();
}
$('#ed-res').onchange = e => {
  edCommit();
  [ed.p.w, ed.p.h] = e.target.value.split('x').map(Number);
  store('edProject', ed.p);
  fitScreen();
};
$('#ed-fps').onchange = e => {
  edCommit();
  ed.p.fps = Number(e.target.value);
  store('edProject', ed.p);
};
$('#ed-new').onclick = async () => {
  if (!(await confirmDialog('Новый проект?', 'Таймлайн и список медиа очистятся. Исходные файлы не пострадают.', 'Начать новый'))) return;
  edPause();
  edCommit();
  ed.p = emptyProject();
  ed.sel.clear();
  ed.t = 0;
  renderBin();
  renderHeads();
  renderProjectSettings();
  edChanged();
};

// ---------- toolbar and keys

function setTool(tool) {
  ed.tool = tool;
  for (const b of document.querySelectorAll('[data-edtool]')) b.classList.toggle('on', b.dataset.edtool === tool);
  for (const t of ['razor', 'hand', 'track']) lanesBox.classList.toggle(t, tool === t);
}
for (const b of document.querySelectorAll('[data-edtool]')) b.onclick = () => setTool(b.dataset.edtool);
$('#ed-split').onclick = e => splitAtPlayhead(e.shiftKey);
$('#ed-del').onclick = deleteSelected;
$('#ed-text').onclick = addText;
$('#ed-undo').onclick = () => edUndo(true);
$('#ed-redo').onclick = () => edUndo(false);

document.addEventListener('keydown', e => {
  if (currentView !== 'editor' || document.querySelector('dialog[open]')) return;
  const el = e.target;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const frame = 1 / ed.p.fps;
  const keys = {
    Space: edToggle,
    KeyS: () => splitAtPlayhead(e.shiftKey),
    KeyC: () => setTool('razor'),
    KeyV: () => setTool('select'),
    KeyA: () => setTool('track'),
    KeyH: () => setTool('hand'),
    KeyM: addMarker,
    Backslash: zoomToFit,
    KeyT: addText,
    Delete: deleteSelected,
    Backspace: deleteSelected,
    Home: () => seekEd(0),
    End: () => seekEd(edDuration()),
    ArrowLeft: () => seekEd(ed.t - (e.shiftKey ? 1 : frame)),
    ArrowRight: () => seekEd(ed.t + (e.shiftKey ? 1 : frame)),
    Equal: () => setZoom(ed.pps * 1.3),
    Minus: () => setZoom(ed.pps / 1.3),
    Escape: () => { ed.sel.clear(); renderTimeline(); renderInspector(); },
  };
  let fn = keys[e.code];
  if (ctrl) {
    fn = { KeyZ: () => edUndo(!e.shiftKey), KeyY: () => edUndo(false), KeyA: () => { ed.sel = new Set(ed.p.clips.map(c => c.id)); renderTimeline(); renderInspector(); }, KeyC: copySelected, KeyV: pasteClips, KeyM: () => $('#ed-export').click(), KeyI: () => $('#ed-import').click(), KeyX: () => { copySelected(); deleteSelected(); } }[e.code];
  }
  if (!fn) return;
  e.preventDefault();
  fn();
});

// ---------- export

// What ffmpeg needs: every visible clip with its place, cut and levels
function exportSpec() {
  const spec = { w: ed.p.w, h: ed.p.h, fps: ed.p.fps, duration: edDuration(), video: [], audio: [], texts: [] };
  for (const tr of ['V1', 'V2']) {
    if (ed.p.tracks[tr].hidden) continue;
    for (const c of ed.p.clips.filter(x => x.track === tr && !x.off).sort((a, b) => a.start - b.start)) {
      const m = edMedia(c.media);
      if (!m || !m.video) continue;
      const mo = motion(c);
      spec.video.push({ file: m.path, vIndex: m.video.index, image: m.image, in: c.in, dur: clipDur(c), start: c.start, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
        x: mo.x, y: mo.y, scale: mo.scale / 100, rot: mo.rot, opacity: mo.opacity / 100 });
    }
  }
  for (const c of ed.p.clips) {
    const st = ed.p.tracks[c.track];
    if (trackOf(c.track).kind !== 'audio' || c.off || trackSilent(c.track)) continue;
    const m = edMedia(c.media);
    if (!m || !m.audio.length) continue;
    const vol = c.volume * st.volume;
    if (vol <= 0) continue;
    spec.audio.push({ file: m.path, aIndex: m.audio[c.audioK || 0].index, in: c.in, dur: clipDur(c), start: c.start, volume: vol, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
  }
  if (!ed.p.tracks.T1.hidden) {
    for (const c of ed.p.clips.filter(x => x.track === 'T1' && !x.off && x.text.trim())) {
      const [x, y] = titleXY(c);
      spec.texts.push({ text: c.text, start: c.start, dur: clipDur(c), size: c.size, color: c.color, x, y, box: c.box, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
    }
  }
  return spec;
}

// Export settings, remembered between projects
const edEnc = Object.assign({ format: 'mp4', codec: 'h264', profile: 'high', mode: 'crf', crf: 20, vbitrate: 12, vmax: 18, preset: 'veryfast', abitrate: 192, lock: true }, recall('edExport', {}));
if (edEnc.mode === 'bitrate') edEnc.mode = 'vbr1';
const crfWord = v => (v <= 17 ? 'почти без потерь' : v <= 20 ? 'высокое' : v <= 24 ? 'хорошее' : v <= 28 ? 'среднее' : 'низкое, файл маленький');
const fpsText = f => String(f).replace('.', ',');

function renderExportForm() {
  $('#ed-ex-format').value = edEnc.format;
  $('#ed-ex-codec').value = edEnc.codec;
  $('#ed-ex-w').value = ed.p.w;
  $('#ed-ex-h').value = ed.p.h;
  $('#ed-ex-lock').classList.toggle('on', edEnc.lock);
  $('#ed-ex-fps').value = String(ed.p.fps);
  $('#ed-ex-profile').value = edEnc.profile;
  $('#ed-ex-profile-row').hidden = edEnc.codec !== 'h264';
  $('#ed-ex-mode').value = edEnc.mode;
  $('#ed-ex-crf').value = edEnc.crf;
  $('#ed-ex-crf-text').textContent = `${crfWord(edEnc.crf)} (CRF ${edEnc.crf})`;
  $('#ed-ex-br').value = $('#ed-ex-br-range').value = edEnc.vbitrate;
  $('#ed-ex-max').value = $('#ed-ex-max-range').value = edEnc.vmax;
  $('#ed-ex-preset').value = edEnc.preset;
  $('#ed-ex-abr').value = String(edEnc.abitrate);
  $('#ed-ex-crf-row').hidden = edEnc.mode !== 'crf';
  $('#ed-ex-br-row').hidden = edEnc.mode === 'crf';
  $('#ed-ex-max-row').hidden = edEnc.mode !== 'vbr1' && edEnc.mode !== 'vbr2';
  const T = edDuration();
  let text = `${ed.p.w}×${ed.p.h}, ${fpsText(ed.p.fps)} к/с, длина ${fmt(T)}.`;
  if (edEnc.mode !== 'crf') text += ` Примерный размер: ${fmtSize((edEnc.vbitrate * 1000 + edEnc.abitrate) * 125 * T)}.`;
  $('#ed-ex-summary').textContent = text;
}

function readExportForm(changed) {
  edEnc.format = $('#ed-ex-format').value;
  edEnc.codec = $('#ed-ex-codec').value;
  edEnc.profile = $('#ed-ex-profile').value;
  edEnc.mode = $('#ed-ex-mode').value;
  edEnc.crf = Number($('#ed-ex-crf').value);
  // slider and number box of a bitrate follow each other
  const br = changed === 'ed-ex-br-range' ? $('#ed-ex-br-range').value : $('#ed-ex-br').value;
  const mx = changed === 'ed-ex-max-range' ? $('#ed-ex-max-range').value : $('#ed-ex-max').value;
  edEnc.vbitrate = clamp(Number(br) || 12, 1, 150);
  edEnc.vmax = clamp(Number(mx) || 18, 1, 200);
  if (changed && changed.startsWith('ed-ex-br') && edEnc.vmax < edEnc.vbitrate) edEnc.vmax = edEnc.vbitrate;
  if (changed && changed.startsWith('ed-ex-max') && edEnc.vmax < edEnc.vbitrate) edEnc.vbitrate = edEnc.vmax;
  edEnc.preset = $('#ed-ex-preset').value;
  edEnc.abitrate = Number($('#ed-ex-abr').value);
  // frame size: even numbers (the encoders need them), proportions kept when the link is on
  const even = v => Math.max(16, Math.round(v / 2) * 2);
  let w = even(Number($('#ed-ex-w').value) || ed.p.w);
  let h = even(Number($('#ed-ex-h').value) || ed.p.h);
  if (edEnc.lock && changed === 'ed-ex-w') h = even(w * ed.p.h / ed.p.w);
  if (edEnc.lock && changed === 'ed-ex-h') w = even(h * ed.p.w / ed.p.h);
  const fps = Number($('#ed-ex-fps').value);
  if (w !== ed.p.w || h !== ed.p.h || fps !== ed.p.fps) {
    edCommit();
    Object.assign(ed.p, { w, h, fps });
    store('edProject', ed.p);
    renderProjectSettings();
  }
  store('edExport', edEnc);
  renderExportForm();
}
for (const id of ['ed-ex-format', 'ed-ex-codec', 'ed-ex-profile', 'ed-ex-mode', 'ed-ex-crf', 'ed-ex-br', 'ed-ex-br-range', 'ed-ex-max', 'ed-ex-max-range', 'ed-ex-preset', 'ed-ex-abr', 'ed-ex-fps']) {
  $('#' + id).addEventListener('input', () => readExportForm(id));
}
for (const id of ['ed-ex-w', 'ed-ex-h']) $('#' + id).addEventListener('change', () => readExportForm(id));
$('#ed-ex-lock').onclick = () => {
  edEnc.lock = !edEnc.lock;
  store('edExport', edEnc);
  renderExportForm();
};
// Size and frame rate of the first video on the timeline
$('#ed-ex-match').onclick = () => {
  const c = ed.p.clips.filter(x => x.track[0] === 'V').sort((a, b) => a.start - b.start).find(x => { const m = edMedia(x.media); return m && m.video && !m.image; });
  const m = c && edMedia(c.media);
  if (!m) {
    toast('На таймлайне нет видео.');
    return;
  }
  edCommit();
  ed.p.w = m.video.w;
  ed.p.h = m.video.h;
  if (m.video.fps) ed.p.fps = m.video.fps;
  store('edProject', ed.p);
  renderProjectSettings();
  renderExportForm();
};
$('#ed-ex-cancel').onclick = () => $('#ed-ex-dlg').close();

let edJob = null;
$('#ed-export').onclick = () => {
  if (!edDuration()) {
    toast('Таймлайн пуст — перетащите на него файлы из «Медиа».');
    return;
  }
  edPause();
  renderExportForm();
  $('#ed-ex-dlg').showModal();
};

$('#ed-ex-go').onclick = async () => {
  $('#ed-ex-dlg').close();
  const first = ed.p.clips.find(c => c.media) || {};
  const out = await api.saveDialog({ source: first.media || 'C:\\video.mp4', ext: edEnc.format, name: 'Проект Tako' });
  if (!out) return;
  const spec = { ...exportSpec(), out, enc: { ...edEnc } };
  edJob = newJob();
  spec.jobId = edJob;
  $('#ed-progress').hidden = false;
  $('#ed-progress-bar').style.width = '0%';
  $('#ed-progress-text').textContent = 'Экспорт… 0%';
  try {
    await api.editorExport(spec);
    toast('Готово: ' + api.basename(out), 'Показать в папке', () => api.reveal(out));
    if (typeof offerDrag === 'function') offerDrag([out]);
  } catch (e) {
    if (!/Отменено/.test(e.message)) toast('Не удалось сохранить: ' + cleanErr(e));
  } finally {
    edJob = null;
    $('#ed-progress').hidden = true;
  }
};
$('#ed-progress-cancel').onclick = () => { if (edJob) api.cancel(edJob); };
api.onProgress(({ jobId, value }) => {
  if (jobId !== edJob) return;
  const pct = Math.round(value * 100) + '%';
  $('#ed-progress-bar').style.width = pct;
  $('#ed-progress-text').textContent = 'Экспорт… ' + pct;
});

// ---------- entering and leaving the editor

const showViewBeforeEditor = showView;
showView = v => {
  if (v === 'editor' && !video.paused) video.pause();
  if (v !== 'editor' && ed.playing) edPause();
  showViewBeforeEditor(v);
  if (v === 'editor') {
    fitScreen();
    renderTimeline();
  }
};
$('#nav-editor').onclick = () => showView('editor');

renderBin();
renderHeads();
renderToggles();
renderProjectSettings();
setZoom(ed.pps);
renderInspector();
syncPreview(true);
