// Video editor (beta): a timeline with video, audio and title tracks, in the spirit of
// Premiere. Source files are only read; the result is rendered into a new file by ffmpeg
// (editor-export in main.js). Runs after ui.js and uses its globals ($, api, toast, ...).

// ---------- project model
//
// media:  files added to the project, with what ffprobe told about them
// clips:  { id, track, media, start, in, out, volume, fadeIn, fadeOut, link, audioK, speed, trans }
//         speed: 2 plays twice as fast (the clip is half as long on the timeline)
//         trans: { kind: 'cross' | 'black', dur } — a transition from the clip just before it
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
const sp = c => c.speed || 1;
// length on the timeline; the part of the file it plays is (out - in), sped up or slowed down
const clipDur = c => (c.out - c.in) / sp(c);
const clipEnd = c => c.start + clipDur(c);
// the time in the file that plays at timeline time t
const srcAt = (c, t) => c.in + (t - c.start) * sp(c);

// ---------- transitions
//
// A transition sits on the second clip of a cut on one track. Cross dissolve: the first clip
// goes on under the second for the transition's length (its last frame stays if the file
// ends) while the second one shows through; its sound fades out under the new one.
// Dip to black: the first clip fades out, the second fades in, half the length each.
const TRANS = [['cross', 'Наплыв'], ['black', 'Затемнение']];
const atCut = (a, b) => a !== b && a.track === b.track && !a.off && !b.off && Math.abs(clipEnd(a) - b.start) < 0.02;
const prevAtCut = c => ed.p.clips.find(x => atCut(x, c));
const nextAtCut = c => ed.p.clips.find(x => atCut(c, x));
function transOf(c) {
  if (!c || !c.trans || c.off) return null;
  const prev = prevAtCut(c);
  if (!prev) return null;
  return { kind: c.trans.kind, dur: Math.min(c.trans.dur, clipDur(c), clipDur(prev)), prev };
}
// how long a clip goes on past its end, under a cross dissolve into the next one
const tailOf = c => {
  const tr = transOf(nextAtCut(c));
  return tr && tr.kind === 'cross' ? tr.dur : 0;
};
const fadeInOf = c => {
  const tr = transOf(c);
  return Math.max(c.fadeIn || 0, tr ? (tr.kind === 'cross' ? tr.dur : tr.dur / 2) : 0);
};
// The speed of clips with what is linked to them. What came right after each one on its track
// moves along, so the clip neither covers the next one nor leaves a gap.
function setSpeed(clips, speed) {
  const group = [...new Set(clips.flatMap(linked))].filter(x => x.track !== 'T1' && !(edMedia(x.media) || {}).image);
  for (const x of group) {
    const oldEnd = clipEnd(x);
    x.speed = speed;
    const d = clipEnd(x) - oldEnd;
    for (const y of ed.p.clips) if (y.track === x.track && !group.includes(y) && y.start >= oldEnd - 0.02) y.start = Math.max(0, y.start + d);
    x.fadeIn = Math.min(x.fadeIn || 0, clipDur(x) / 2);
    x.fadeOut = Math.min(x.fadeOut || 0, clipDur(x) / 2);
  }
}
// A transition at the start of these clips (and the ones linked to them); null takes it off
function setTrans(clips, trans) {
  for (const x of new Set(clips.flatMap(linked))) x.trans = trans && prevAtCut(x) ? { ...trans } : null;
}
const fadeOutOf = c => {
  const tr = transOf(nextAtCut(c));
  return Math.max(c.fadeOut || 0, tr && tr.kind === 'black' ? tr.dur / 2 : 0);
};
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
  edGoto(back ? -1 : 1);
}
// Several steps back (negative) or forward at once, drawn once at the end
function edGoto(steps) {
  const from = steps < 0 ? ed.undo : ed.redo;
  const to = steps < 0 ? ed.redo : ed.undo;
  if (!from.length || !steps) return;
  for (let i = 0; i < Math.abs(steps) && from.length; i++) {
    to.push(JSON.stringify(ed.p));
    ed.p = JSON.parse(from.pop());
  }
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

// A picture of the file in the bin: the image itself, or a frame from early in the video
function binThumb(m) {
  const img = document.createElement('img');
  img.alt = '';
  const key = `${m.path}|bin`;
  const have = edThumbs.get(key);
  if (have && have !== 'none') img.src = have;
  else if (have === undefined) {
    edThumbs.set(key, '');
    (m.image ? Promise.resolve(api.toUrl(m.path)) : api.frameThumb({ file: m.path, time: Math.min(1, m.dur / 10) }))
      .then(url => {
        edThumbs.set(key, url || 'none');
        for (const el of document.querySelectorAll('#ed-bin-list .ed-item > i > img')) if (el.dataset.key === key && url) el.src = url;
      }, () => edThumbs.set(key, 'none'));
  }
  img.dataset.key = key;
  return img;
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
    if (m.video) row.querySelector('i').append(binThumb(m));
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
        const tail = { ...c, id: ed.nextId++, start: b, in: c.in + (b - s) * sp(c) };
        c.out = c.in + (a - s) * sp(c);
        ed.p.clips.push(tail);
      } else if (s < a) c.out = c.in + (a - s) * sp(c);
      else {
        c.in += (b - s) * sp(c);
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
    // what is on the track: the sound track's name from the file, the player or OBS
    if (tr.kind === 'audio') {
      const first = ed.p.clips.filter(c => c.track === tr.id).sort((a, b) => Math.abs(a.start - ed.t) - Math.abs(b.start - ed.t))[0];
      const label = first ? clipSoundName(first) : '';
      name.title = label ? `${tr.id} — ${label}` : tr.id;
      if (label) {
        const l = document.createElement('span');
        l.className = 'ed-trlabel';
        l.textContent = label;
        l.title = label;
        h.append(l);
      }
    }
    if (tr.kind === 'audio') {
      toggle('m', st.muted, 'Без звука (Mute)', 'M', () => { st.muted = !st.muted; });
      toggle('s', st.solo, 'Только эта дорожка (Solo)', 'S', () => { st.solo = !st.solo; });
      // track volume: a slider with the level next to it; double click on the number = 100%
      const wrap = document.createElement('span');
      wrap.className = 'ed-tvol';
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = 0;
      vol.max = 2;
      vol.step = 0.01;
      vol.value = st.volume;
      const pct = document.createElement('b');
      const paint = () => {
        pct.textContent = Math.round(st.volume * 100) + '%';
        vol.style.setProperty('--p', (st.volume / 2 * 100) + '%');
        wrap.title = 'Громкость дорожки ' + tr.id + ': ' + Math.round(st.volume * 100) + '% (двойной клик по числу — 100%)';
      };
      paint();
      vol.onpointerdown = () => edCommit();
      vol.oninput = () => {
        st.volume = Math.abs(Number(vol.value) - 1) < 0.03 ? 1 : Number(vol.value); // sticks at 100%
        paint();
        store('edProject', ed.p);
        syncPreview(true);
      };
      pct.ondblclick = () => { edCommit(); st.volume = 1; vol.value = 1; paint(); store('edProject', ed.p); syncPreview(true); };
      wrap.append(vol, pct);
      h.append(wrap);
    } else {
      toggle('eye', !st.hidden, st.hidden ? 'Показать дорожку' : 'Скрыть дорожку',
        `<svg class="i"><use href="#${st.hidden ? 'i-eye-off' : 'i-eye'}"/></svg>`, () => { st.hidden = !st.hidden; });
    }
    h.classList.toggle('off', trackSilent(tr.id) || st.hidden);
    h.classList.toggle('locked', !!st.locked);
    h.dataset.track = tr.id;
    if (trackH[tr.id]) h.style.setProperty('--th', trackH[tr.id] + 'px');
    const grip = document.createElement('i');
    grip.className = 'ed-trsize';
    grip.title = 'Тяните вверх или вниз — высота дорожки; двойной клик — как было';
    grip.onpointerdown = e => resizeTrack(e, tr.id);
    grip.ondblclick = () => setTrackH(tr.id, 0);
    h.append(grip);
    box.append(h);
  }
}

// Each track can be made taller or lower by dragging the bottom edge of its header, as in
// Premiere; the heights are remembered for the app, not for the project
const trackH = recall('edTrackH', {});
const TRACK_H_MIN = 26, TRACK_H_MAX = 240;
function setTrackH(id, px) {
  if (px) trackH[id] = Math.round(clamp(px, TRACK_H_MIN, TRACK_H_MAX));
  else delete trackH[id];
  store('edTrackH', trackH);
  for (const el of document.querySelectorAll(`.ed-trhead[data-track="${id}"], .ed-lane[data-track="${id}"]`)) {
    if (px) el.style.setProperty('--th', trackH[id] + 'px');
    else el.style.removeProperty('--th');
  }
}
function resizeTrack(e, id) {
  e.preventDefault();
  e.stopPropagation();
  if (ed.miniTracks) setMiniTracks(false);
  const grip = e.currentTarget;
  const h0 = grip.parentElement.getBoundingClientRect().height, y0 = e.clientY;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('ed-resizing');
  grip.onpointermove = ev => setTrackH(id, h0 + ev.clientY - y0);
  grip.onpointerup = () => {
    grip.onpointermove = grip.onpointerup = null;
    document.body.classList.remove('ed-resizing');
    renderTimeline(); // waveforms and film strips are drawn again for the new height
  };
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
  renderHeadButtons();
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
    mk.classList.toggle('sel', ed.markSel === t);
    mk.onpointerdown = e => { if (e.button === 0) dragMarker(e, t); else e.stopPropagation(); };
    mk.oncontextmenu = e => {
      e.preventDefault();
      e.stopPropagation();
      ed.markSel = t;
      renderRuler();
      openCtxMenu(e.clientX, e.clientY, [
        { icon: 'i-x', label: 'Удалить метку', danger: true, run: () => removeMarker(t) },
        { icon: 'i-x', label: 'Удалить все метки (Ctrl+Alt+M)', danger: true, run: clearMarkers },
      ]);
    };
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
    if (!moved) {
      // a click picks the mark (Delete removes it) and moves the playhead to it
      ed.markSel = t;
      seekEd(t);
      renderRuler();
      return;
    }
    ed.p.markers = [...new Set(ed.p.markers.map(x => (x === t ? Math.round(to * 1000) / 1000 : x)))].sort((a, b) => a - b);
    edChanged();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function removeMarker(t) {
  edCommit();
  ed.p.markers = (ed.p.markers || []).filter(x => x !== t);
  if (ed.markSel === t) ed.markSel = null;
  edChanged();
}
function clearMarkers() {
  if (!(ed.p.markers || []).length) return;
  edCommit();
  ed.p.markers = [];
  ed.markSel = null;
  edChanged();
}

function addMarker() {
  edCommit();
  ed.p.markers = [...new Set([...(ed.p.markers || []), Math.round(ed.t * 1000) / 1000])].sort((a, b) => a - b);
  edChanged();
}
$('#ed-marker').onclick = addMarker;

// ---------- history
//
// The undo stack holds the project as it was before each step. A step's name comes from
// what differs between two neighbouring states, so edits need not name themselves.

const CLIP_WORDS = [
  [['start', 'track'], 'Перемещение'], [['in', 'out'], 'Обрезка'], [['speed'], 'Скорость'], [['trans'], 'Переход'],
  [['volume'], 'Громкость'], [['fadeIn', 'fadeOut'], 'Появление и затухание'], [['off'], 'Клип включён или выключен'],
  [['label'], 'Цвет метки'], [['link'], 'Связь картинки и звука'], [['audioK'], 'Дорожка файла'],
  [['text', 'size', 'color', 'font', 'bold', 'box', 'x', 'y'], 'Текст'],
  [['posX', 'posY', 'scale', 'scaleX', 'scaleY', 'rot', 'opacity', 'anchorX', 'anchorY'], 'Преобразование'],
];
const histParsed = new Map(); // JSON -> project, so the list is not parsed again on every draw
const histGet = j => {
  if (!histParsed.has(j)) {
    if (histParsed.size > 300) histParsed.clear();
    histParsed.set(j, JSON.parse(j));
  }
  return histParsed.get(j);
};
function stepName(a, b) {
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  if (b.clips.length > a.clips.length) {
    const n = b.clips.length - a.clips.length;
    return b.clips.filter(c => !a.clips.some(x => x.id === c.id)).every(c => c.track === 'T1') ? 'Новая надпись' : n > 2 ? `Добавлено клипов: ${n}` : 'Добавлен клип';
  }
  if (b.clips.length < a.clips.length) return a.clips.length - b.clips.length > 2 ? `Удалено клипов: ${a.clips.length - b.clips.length}` : 'Удаление';
  for (const c of b.clips) {
    const o = a.clips.find(x => x.id === c.id);
    if (!o) return 'Разрез';
    if (same(o, c)) continue;
    const keys = [...new Set([...Object.keys(o), ...Object.keys(c)])].filter(k => !same(o[k], c[k]));
    const hit = CLIP_WORDS.find(([ks]) => keys.some(k => ks.includes(k)));
    return hit ? hit[1] : 'Изменение клипа';
  }
  if (!same(a.media, b.media)) return 'Файлы проекта';
  if (!same(a.markers, b.markers)) return 'Метки';
  if (!same(a.tracks, b.tracks) || a.aCount !== b.aCount) return 'Дорожки';
  if (a.w !== b.w || a.h !== b.h || a.fps !== b.fps) return 'Размер кадра';
  return 'Изменение';
}
function renderHistory() {
  const box = $('#ed-hist');
  if (box.hidden) return;
  const states = [...ed.undo, JSON.stringify(ed.p), ...[...ed.redo].reverse()];
  const now = ed.undo.length;
  box.innerHTML = '';
  states.forEach((j, k) => {
    const b = document.createElement('button');
    b.className = 'ed-hstep';
    b.classList.toggle('now', k === now);
    b.classList.toggle('undone', k > now);
    b.textContent = k === 0 ? 'Начало' : stepName(histGet(states[k - 1]), k === now ? ed.p : histGet(j));
    b.onclick = () => edGoto(k - now);
    box.append(b);
  });
  box.querySelector('.now')?.scrollIntoView({ block: 'nearest' });
}
for (const tab of document.querySelectorAll('[data-bintab]')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('[data-bintab]')) t.classList.toggle('on', t === tab);
    const hist = tab.dataset.bintab === 'hist';
    $('#ed-bin-list').hidden = hist;
    $('#ed-hist').hidden = !hist;
    $('#ed-import').hidden = hist;
    renderHistory();
  };
}

// Buttons above the tracks show whether they can do something now
function renderHeadButtons() {
  const sel = ed.p.clips.some(c => ed.sel.has(c.id));
  $('#ed-undo').classList.toggle('dis', !ed.undo.length);
  $('#ed-redo').classList.toggle('dis', !ed.redo.length);
  $('#ed-split').classList.toggle('dis', !sel);
  $('#ed-del').classList.toggle('dis', !sel && ed.markSel == null);
}

function renderTimeline() {
  renderHeadButtons();
  renderHistory();
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
    if (trackH[tr.id]) lane.style.setProperty('--th', trackH[tr.id] + 'px');
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
  const label = tr.kind === 'text' ? c.text.split('\n')[0] || 'Текст' : !m ? '?' : tr.kind === 'audio' && clipSoundName(c) ? `${clipSoundName(c)} · ${m.name}` : m.name;
  el.innerHTML = '<span class="ed-name"></span><i class="ed-edge l"></i><i class="ed-edge r"></i>'
    + '<i class="ed-fh l" title="Тяните вправо — плавное появление"></i><i class="ed-fh r" title="Тяните влево — плавное затухание"></i>';
  el.querySelector('.ed-name').textContent = label + (c.volume !== 1 && tr.kind === 'audio' ? `  ${Math.round(c.volume * 100)}%` : '')
    + (sp(c) !== 1 ? `  · скорость ${Math.round(sp(c) * 100)}%` : '');
  // the transition from the clip before, as a striped block at the start
  const trn = transOf(c);
  if (trn) {
    const name = TRANS.find(k => k[0] === trn.kind)[1];
    el.insertAdjacentHTML('beforeend', `<i class="ed-trans ${trn.kind}" style="width: ${Math.max(6, xOf(trn.kind === 'cross' ? trn.dur : trn.dur / 2))}px" title="${name}, ${trn.dur.toFixed(1)} с"></i>`);
  }
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
    const t0 = c.in + tOf(x0 + x) * sp(c);
    const t1 = c.in + tOf(x0 + x + 1) * sp(c);
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
    const time = m.image ? 0 : Math.min(m.dur - 0.05, Math.round((c.in + k * step * sp(c)) * 10) / 10);
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
// The browser keeps scrollLeft in whole pixels; zooming step after step from the rounded
// value made the point under the mouse creep away, so the exact value is kept between steps
function setZoom(pps, anchorT = ed.t) {
  const sl = ed.slExact != null && Math.abs(ed.slExact - scroller.scrollLeft) < 1 ? ed.slExact : scroller.scrollLeft;
  const before = xOf(anchorT) - sl;
  ed.pps = clamp(pps, 0.02, 400);
  renderTimeline();
  ed.slExact = Math.max(0, xOf(anchorT) - before);
  scroller.scrollLeft = ed.slExact;
}
scroller.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.altKey) return;
  e.preventDefault();
  const r = scroller.getBoundingClientRect();
  const sl = ed.slExact != null && Math.abs(ed.slExact - scroller.scrollLeft) < 1 ? ed.slExact : scroller.scrollLeft;
  setZoom(ed.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2), tOf(e.clientX - r.left + sl));
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
  if (ed.markSel != null) { ed.markSel = null; renderRuler(); }
  if (ed.tool === 'hand') return panTimeline(e);
  if (ed.tool === 'track') return trackSelect(e);
  let el = e.target.closest('.ed-clip');
  // clips on a locked track cannot be picked or changed
  if (el && isLocked(ed.p.clips.find(x => x.id === Number(el.dataset.id)))) el = null;
  if (!el) return marquee(e);
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
          let d = clamp(s.t - o.start, -o.in / sp(o), clipDur(o) - 0.05);
          d = Math.max(d, -o.start);
          x.start = o.start + d;
          x.in = o.in + d * sp(o);
          hit = s.hit;
        } else {
          let s = snap(clipEnd(o) + dt, pts);
          x.out = clamp(o.out + (s.t - clipEnd(o)) * sp(o), o.in + 0.05, maxOut);
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
    const tail = { ...c, id: ed.nextId++, start: t, in: srcAt(c, t), fadeIn: 0, trans: null };
    if (c.link) {
      if (!newLink.has(c.link)) newLink.set(c.link, ed.nextId++);
      tail.link = newLink.get(c.link);
    }
    c.out = srcAt(c, t);
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
  // transitions from the clip just before, on the same track
  if (prevAtCut(c)) {
    const put = trans => () => { edCommit(); setTrans(sel, trans); edChanged(); };
    items.push('-');
    for (const [k, name] of TRANS) items.push({ icon: 'i-film', label: `${name} с предыдущим клипом (1 с)`, run: put({ kind: k, dur: 1 }) });
    if (c.trans) items.push({ icon: 'i-x', label: 'Убрать переход', run: put(null) });
  }
  if (sp(c) !== 1) items.push({ icon: 'i-film', label: 'Обычная скорость (100%)', run: () => { edCommit(); setSpeed(sel, 1); edChanged(); } });
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

// Ruler: click or drag to move the playhead. Held at an edge of the timeline, it scrolls on
// at a steady pace that grows with how far past the edge the mouse is, never a screen at once.
const SCRUB_EDGE = 24; // px
const SCRUB_MAX = 8; // px per frame
$('#ed-ruler').addEventListener('pointerdown', e => {
  const r = $('#ed-ruler');
  r.setPointerCapture(e.pointerId);
  let cx = e.clientX;
  let raf = 0;
  const go = () => {
    const v = scroller.getBoundingClientRect();
    seekEd(tOf(clamp(cx, v.left, v.right - 1) - $('#ed-canvas').getBoundingClientRect().left), true);
  };
  const tick = () => {
    raf = 0;
    const v = scroller.getBoundingClientRect();
    const past = cx < v.left + SCRUB_EDGE ? cx - v.left - SCRUB_EDGE : cx > v.right - SCRUB_EDGE ? cx - v.right + SCRUB_EDGE : 0;
    if (!past) return;
    scroller.scrollLeft += clamp(past / 4, -SCRUB_MAX, SCRUB_MAX);
    go();
    raf = requestAnimationFrame(tick);
  };
  const move = ev => {
    cx = ev.clientX;
    go();
    if (!raf) raf = requestAnimationFrame(tick);
  };
  move(e);
  r.onpointermove = move;
  r.onpointerup = () => {
    r.onpointermove = null;
    cancelAnimationFrame(raf);
    raf = 0;
  };
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

// Uniform scale: the chain between the width and height of Scale (as in After Effects)
ed.scaleLink = recall('edScaleLink', true);

// Rotation as After Effects shows it: whole turns and degrees, "1x+30°"
const showRot = r => {
  const turns = Math.trunc(r / 360);
  const deg = Math.round((r - turns * 360) * 10) / 10;
  return `${turns}x${deg < 0 ? '−' : '+'}${Math.abs(deg)}`;
};
const parseRot = s => {
  const m = /^\s*(-?\d+)\s*x\s*([+\-−]?\s*[\d.,]+)/i.exec(s);
  if (m) return Number(m[1]) * 360 + parseFloat(m[2].replace('−', '-').replace(/\s/g, '').replace(',', '.'));
  return parseFloat(String(s).replace('−', '-').replace(',', '.'));
};

// Fonts for titles: [name, CSS family, regular file, bold file] from Windows\Fonts
const FONTS = [
  ['Arial', 'Arial', 'arial.ttf', 'arialbd.ttf'],
  ['Arial Black', '"Arial Black"', 'ariblk.ttf', ''],
  ['Impact', 'Impact', 'impact.ttf', ''],
  ['Segoe UI', '"Segoe UI"', 'segoeui.ttf', 'segoeuib.ttf'],
  ['Segoe UI Black', '"Segoe UI Black"', 'seguibl.ttf', ''],
  ['Bahnschrift', 'Bahnschrift', 'bahnschrift.ttf', ''],
  ['Calibri', 'Calibri', 'calibri.ttf', 'calibrib.ttf'],
  ['Verdana', 'Verdana', 'verdana.ttf', 'verdanab.ttf'],
  ['Tahoma', 'Tahoma', 'tahoma.ttf', 'tahomabd.ttf'],
  ['Trebuchet MS', '"Trebuchet MS"', 'trebuc.ttf', 'trebucbd.ttf'],
  ['Georgia', 'Georgia', 'georgia.ttf', 'georgiab.ttf'],
  ['Times New Roman', '"Times New Roman"', 'times.ttf', 'timesbd.ttf'],
  ['Comic Sans MS', '"Comic Sans MS"', 'comic.ttf', 'comicbd.ttf'],
  ['Consolas', 'Consolas', 'consola.ttf', 'consolab.ttf'],
  ['Courier New', '"Courier New"', 'cour.ttf', 'courbd.ttf'],
  ['Segoe Print', '"Segoe Print"', 'segoepr.ttf', 'segoeprb.ttf'],
  ['Gabriola', 'Gabriola', 'Gabriola.ttf', ''],
];
const fontOf = c => FONTS.find(f => f[0] === c.font) || FONTS[0];

// Name of sound track k of a file, the same as the player shows: the name given in the
// player for this file, the file's own title, the name set for all files, else OBS's
function soundName(m, k) {
  const a = m && m.audio[k];
  if (!a) return '';
  const saved = (recall('trackNames', {})[m.path] || {})[a.index];
  if (saved) return saved;
  if (a.name && !STOCK_HANDLER.test(a.name.trim())) return a.name.trim();
  const own = recall('defaultNames', {})[k];
  if (own) return own;
  if (obsTracks && settings.obsNames) {
    const enabled = [1, 2, 3, 4, 5, 6].filter(n => obsTracks.recTracks & (1 << (n - 1)));
    const n = enabled.length === m.audio.length ? enabled[k] : k + 1;
    if (obsTracks.names[n - 1]) return obsTracks.names[n - 1];
  }
  return '';
}
const clipSoundName = c => soundName(edMedia(c.media), c.audioK || 0);

function renderInspector() {
  placeXform();
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

  const head = document.createElement('div');
  head.className = 'fx-head';
  head.innerHTML = '<div class="fx-name"></div><div class="fx-tc"></div>';
  head.querySelector('.fx-name').textContent = (sel.length > 1 ? `${sel.length} клипа · ` : '') + (kind === 'text' ? 'Надпись' : m ? m.name : '');
  head.querySelector('.fx-name').style.setProperty('--cc', clipColor(c));
  head.querySelector('.fx-tc').textContent = `${trackOf(c.track).name} · ${tc(c.start)} – ${tc(clipEnd(c))} · длина ${tc(clipDur(c))}`;
  body.append(head);

  const repaint = () => body.querySelectorAll('.fx-num').forEach(n => n.paint && n.paint());

  // A folding section; "Сброс" on the right puts its values back
  const section = (key, title, fill, reset) => {
    const s = document.createElement('div');
    s.className = 'fx-sec';
    s.classList.toggle('open', fxOpen[key] !== false);
    s.innerHTML = '<div class="fx-title"><svg class="i chev"><use href="#i-chevron"/></svg><span></span></div><div class="fx-rows"></div>';
    s.querySelector('span').textContent = title;
    s.querySelector('.fx-title').onclick = e => {
      if (e.target.closest('.fx-sreset')) return;
      fxOpen[key] = !s.classList.contains('open');
      store('edFxOpen', fxOpen);
      s.classList.toggle('open', fxOpen[key]);
    };
    if (reset) {
      const r = document.createElement('button');
      r.className = 'fx-sreset';
      r.textContent = 'Сброс';
      r.onclick = () => { edCommit(); reset(); edChanged(); };
      s.querySelector('.fx-title').append(r);
    }
    fill(s.querySelector('.fx-rows'));
    body.append(s);
  };

  // One blue number: drag it left or right (Shift faster, Alt finer) or click to type
  const numEl = ({ get, set, min = -Infinity, max = Infinity, step = 1, unit = '', show, parse, list = sel }) => {
    const wrap = document.createElement('span');
    wrap.className = 'fx-val';
    const num = document.createElement('span');
    num.className = 'fx-num';
    num.tabIndex = 0;
    const paint = () => { num.textContent = show ? show(get(c)) : String(+(Math.round(get(c) / step) * step).toFixed(6)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); };
    paint();
    num.paint = paint;
    const apply = v => {
      v = clamp(v, min, max);
      for (const x of list) set(x, v);
      repaint();
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
        const inp = document.createElement('input');
        inp.className = 'fx-input';
        inp.value = num.textContent.replace('−∞', '-100').replace(/−/g, '-');
        num.replaceWith(inp);
        inp.focus();
        inp.select();
        let closed = false;
        const done = ok => {
          if (closed) return; // Enter closes it, and the blur that follows must not again
          closed = true;
          inp.replaceWith(num); // back first, so the new value is painted on it
          if (ok) {
            const v = parse ? parse(inp.value) : parseFloat(inp.value.replace(',', '.'));
            if (Number.isFinite(v)) { edCommit(); apply(v); renderTimeline(); }
          }
        };
        inp.onkeydown = ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); ev.stopPropagation(); };
        inp.onblur = () => done(true);
      };
    };
    wrap.append(num);
    if (unit) wrap.append(Object.assign(document.createElement('span'), { className: 'fx-unit', textContent: unit }));
    return wrap;
  };

  // A row: name, then one or two numbers (two with an optional chain between them)
  const row = (rows, label, parts, { link } = {}) => {
    const r = document.createElement('div');
    r.className = 'fx-row' + (parts.length > 1 ? ' two' : '');
    const l = document.createElement('span');
    l.className = 'fx-label';
    l.textContent = label;
    const chain = document.createElement('span');
    chain.className = 'fx-chain';
    if (link) {
      const b = document.createElement('button');
      b.className = 'fx-link';
      b.classList.toggle('on', link.on());
      b.title = link.on() ? 'Пропорционально: ширина и высота меняются вместе. Нажмите, чтобы разделить' : 'Связать ширину и высоту';
      b.innerHTML = '<svg class="i"><use href="#i-link"/></svg>';
      b.onclick = () => { link.toggle(); renderInspector(); };
      chain.append(b);
    }
    r.append(chain, l, ...parts.map(numEl));
    rows.append(r);
  };

  if (kind === 'video' || pics.length) {
    const p = pics.length ? pics : [c];
    const v = p[0];
    section('motion', 'Преобразование', rows => {
      row(rows, 'Опорная точка', [
        { get: x => motion(x).ax, set: (x, n) => { x.anchorX = n; }, list: p },
        { get: x => motion(x).ay, set: (x, n) => { x.anchorY = n; }, list: p },
      ]);
      row(rows, 'Положение', [
        { get: x => motion(x).x, set: (x, n) => { x.posX = n; }, list: p },
        { get: x => motion(x).y, set: (x, n) => { x.posY = n; }, list: p },
      ]);
      // with the chain on, width and height of Scale stay equal
      row(rows, 'Масштаб', [
        { get: x => motion(x).sx, set: (x, n) => { x.scaleX = n; if (ed.scaleLink) x.scaleY = n; }, min: 1, max: 2000, unit: '%', list: p },
        { get: x => motion(x).sy, set: (x, n) => { x.scaleY = n; if (ed.scaleLink) x.scaleX = n; }, min: 1, max: 2000, unit: '%', list: p },
      ], { link: { on: () => ed.scaleLink, toggle: () => { ed.scaleLink = !ed.scaleLink; store('edScaleLink', ed.scaleLink); } } });
      const fits = document.createElement('div');
      fits.className = 'fx-fits';
      for (const [label, how, title] of [['Вписать', 'fit', 'Весь кадр видео виден, по краям могут остаться полосы'], ['Заполнить', 'fill', 'Видео закрывает весь кадр, лишнее обрезается (для 9:16 из горизонтального)']]) {
        const b = document.createElement('button');
        b.className = 'btn small ghost';
        b.textContent = label;
        b.title = title;
        b.onclick = () => { edCommit(); p.forEach(x => fitClip(x, how)); edChanged(); };
        fits.append(b);
      }
      rows.append(fits);
      row(rows, 'Поворот', [{ get: x => motion(x).rot, set: (x, n) => { x.rot = n; }, min: -36000, max: 36000, unit: '°', show: showRot, parse: parseRot, list: p }]);
      row(rows, 'Непрозрачность', [{ get: x => motion(x).opacity, set: (x, n) => { x.opacity = n; }, min: 0, max: 100, unit: '%', list: p }]);
    }, () => p.forEach(x => { x.posX = x.posY = x.scale = x.scaleX = x.scaleY = x.anchorX = x.anchorY = x.opacity = null; x.rot = 0; }));
    section('fade', 'Появление и исчезание', rows => {
      row(rows, 'Появление', [{ get: x => x.fadeIn || 0, set: (x, n) => { x.fadeIn = Math.min(n, clipDur(x) / 2); }, min: 0, step: 0.1, unit: 'с', list: p }]);
      row(rows, 'Исчезание', [{ get: x => x.fadeOut || 0, set: (x, n) => { x.fadeOut = Math.min(n, clipDur(x) / 2); }, min: 0, step: 0.1, unit: 'с', list: p }]);
      if (m && m.image) row(rows, 'Длительность', [{ get: x => clipDur(x), set: (x, n) => { x.out = x.in + n * sp(x); }, min: 0.2, step: 0.1, unit: 'с', list: [v] }]);
    }, () => p.forEach(x => { x.fadeIn = x.fadeOut = 0; }));
  }

  const timed = sel.filter(x => x.track !== 'T1' && !(edMedia(x.media) || {}).image);
  if (timed.length) {
    const t0 = timed[0];
    section('time', 'Скорость и переход', rows => {
      row(rows, 'Скорость', [{ get: () => sp(t0) * 100, set: (x, n) => setSpeed(timed, n / 100), min: 10, max: 1000, step: 5, unit: '%', list: [t0] }]);
      const presets = document.createElement('div');
      presets.className = 'fx-fits';
      for (const v of [25, 50, 100, 200, 400]) {
        const b = document.createElement('button');
        b.className = 'btn small ghost';
        b.classList.toggle('on', Math.abs(sp(t0) * 100 - v) < 0.5);
        b.textContent = v + '%';
        b.onclick = () => { edCommit(); setSpeed(timed, v / 100); edChanged(); };
        presets.append(b);
      }
      rows.append(presets);
      // a transition needs a clip right before this one on its track
      const prev = prevAtCut(t0);
      const r = document.createElement('label');
      r.className = 'fx-row';
      r.innerHTML = '<span class="fx-chain"></span><span class="fx-label">Переход в начале</span>';
      const s = document.createElement('select');
      s.add(new Option(prev ? 'Нет' : 'Нет (впритык нет клипа)', ''));
      for (const [k, name] of TRANS) s.add(new Option(name, k));
      s.value = (t0.trans && t0.trans.kind) || '';
      s.disabled = !prev;
      s.onchange = () => { edCommit(); setTrans(timed, s.value ? { kind: s.value, dur: (t0.trans && t0.trans.dur) || 1 } : null); edChanged(); };
      r.append(s);
      rows.append(r);
      if (t0.trans && prev) {
        row(rows, 'Длительность', [{ get: () => (t0.trans ? t0.trans.dur : 1), set: (x, n) => setTrans(timed, { kind: t0.trans.kind, dur: n }), min: 0.1, max: 10, step: 0.1, unit: 'с', list: [t0] }]);
      }
    }, () => { setSpeed(timed, 1); setTrans(timed, null); });
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
      row(rows, 'Положение', [
        { get: x => titleXY(x)[0] * ed.p.w, set: (x, n) => { const [, cy] = titleXY(x); x.x = n / ed.p.w; x.y = cy; } },
        { get: x => titleXY(x)[1] * ed.p.h, set: (x, n) => { const [cx] = titleXY(x); x.y = n / ed.p.h; x.x = cx; } },
      ]);
      const fr = document.createElement('label');
      fr.className = 'fx-row';
      fr.innerHTML = '<span class="fx-chain"></span><span class="fx-label">Шрифт</span>';
      const fs = document.createElement('select');
      for (const [name, css] of FONTS) { const o = new Option(name, name); o.style.fontFamily = css; fs.add(o); }
      fs.value = c.font || 'Arial';
      fs.style.fontFamily = fontOf(c)[1];
      fs.onchange = () => { edCommit(); for (const x of sel) x.font = fs.value; edChanged(); };
      fr.append(fs);
      rows.append(fr);
      const br = document.createElement('label');
      br.className = 'fx-row fx-check';
      br.innerHTML = '<span class="fx-chain"></span><span class="fx-label">Жирный</span><input type="checkbox">';
      br.querySelector('input').checked = !!c.bold;
      br.querySelector('input').disabled = !fontOf(c)[3];
      br.querySelector('input').onchange = ev => { edCommit(); for (const x of sel) x.bold = ev.target.checked; edChanged(); };
      rows.append(br);
      row(rows, 'Размер', [{ get: x => x.size, set: (x, n) => { x.size = n; }, min: 8, max: 400, unit: 'px' }]);
      row(rows, 'Появление', [{ get: x => x.fadeIn || 0, set: (x, n) => { x.fadeIn = Math.min(n, clipDur(x) / 2); }, min: 0, step: 0.1, unit: 'с' }]);
      row(rows, 'Исчезание', [{ get: x => x.fadeOut || 0, set: (x, n) => { x.fadeOut = Math.min(n, clipDur(x) / 2); }, min: 0, step: 0.1, unit: 'с' }]);
      const colors = document.createElement('div');
      colors.className = 'fx-row fx-colors';
      colors.innerHTML = '<span class="fx-chain"></span><span class="fx-label">Цвет</span>';
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
      box.innerHTML = '<span class="fx-chain"></span><span class="fx-label">Подложка</span><input type="checkbox">';
      box.querySelector('input').checked = !!c.box;
      box.querySelector('input').onchange = ev => { edCommit(); for (const x of sel) x.box = ev.target.checked; edChanged(); };
      rows.append(box);
      const where = document.createElement('div');
      where.className = 'fx-where';
      for (const [label, x, y] of [['Сверху', 0.5, 0.12], ['Центр', 0.5, 0.5], ['Снизу', 0.5, 0.85]]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => { edCommit(); for (const t of sel) Object.assign(t, { x, y }); edChanged(); };
        where.append(b);
      }
      rows.append(where);
    }, () => sel.forEach(x => { x.x = 0.5; x.y = 0.85; x.size = 72; x.fadeIn = x.fadeOut = 0; }));
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
        row(rows, 'Уровень', [{ get: x => (x.volume > 0 ? 20 * Math.log10(x.volume) : -60), set: (x, n) => { x.volume = n <= -60 ? 0 : Math.pow(10, n / 20); },
          min: -60, max: 6, step: 0.1, unit: 'дБ', list: [a], show: v => (v <= -60 ? '−∞' : (v >= 0 ? '+' : '') + v.toFixed(1)) }]);
        row(rows, 'Нарастание', [{ get: x => x.fadeIn || 0, set: (x, n) => { x.fadeIn = Math.min(n, clipDur(x) / 2); }, min: 0, step: 0.1, unit: 'с', list: [a] }]);
        row(rows, 'Затухание', [{ get: x => x.fadeOut || 0, set: (x, n) => { x.fadeOut = Math.min(n, clipDur(x) / 2); }, min: 0, step: 0.1, unit: 'с', list: [a] }]);
        const am = edMedia(a.media);
        if (am && am.audio.length > 1) {
          const r = document.createElement('label');
          r.className = 'fx-row';
          r.innerHTML = '<span class="fx-chain"></span><span class="fx-label">Дорожка файла</span>';
          const s = document.createElement('select');
          am.audio.forEach((t, k) => s.add(new Option(`${k + 1}${soundName(am, k) ? ' — ' + soundName(am, k) : ''}`, k)));
          s.value = a.audioK || 0;
          s.onchange = () => { edCommit(); a.audioK = Number(s.value); edChanged(); };
          r.append(s);
          rows.append(r);
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
// under each track's picture, the clip that goes on under a cross dissolve
const edTail = {};
for (const [track, el] of Object.entries(edV)) {
  edTail[track] = el.cloneNode();
  edTail[track].removeAttribute('id');
  edTail[track].className = 'ed-tail ' + track;
  el.before(edTail[track]);
}
const edAudio = new Map(); // clip id -> <audio>
let clock = null; // { t0, n0 }

// Fades, with those a transition adds. Under a cross dissolve the picture stays whole (the
// next clip shows through over it) and the sound fades out.
function fadeAt(c, t, sound = false) {
  const local = t - c.start;
  const tail = tailOf(c);
  const dur = clipDur(c) + tail;
  const fi = fadeInOf(c), fo = Math.max(fadeOutOf(c), sound ? tail : 0);
  let a = 1;
  if (fi > 0 && local < fi) a = Math.min(a, local / fi);
  if (fo > 0 && dur - local < fo) a = Math.min(a, (dur - local) / fo);
  return clamp(a, 0, 1);
}
// the clip of a track that plays at t, counting the part under a cross dissolve
const tailAt = (track, t) => ed.p.clips.find(c => !c.off && c.track === track && clipEnd(c) <= t && t < clipEnd(c) + tailOf(c));
// Transform of a picture clip, as in After Effects' Layer Transform. The anchor point is in
// the picture's own pixels (its middle by default); the position says where in the frame
// the anchor lands; scale and rotation turn around the anchor.
function motion(c) {
  const m = edMedia(c.media);
  const src = m && m.video && m.video.w ? m.video : { w: ed.p.w, h: ed.p.h };
  const s = c.scale != null ? c.scale : 100; // older projects had one scale
  return {
    x: c.posX != null ? c.posX : ed.p.w / 2,
    y: c.posY != null ? c.posY : ed.p.h / 2,
    sx: c.scaleX != null ? c.scaleX : s,
    sy: c.scaleY != null ? c.scaleY : s,
    rot: c.rot || 0,
    opacity: c.opacity != null ? c.opacity : 100,
    ax: c.anchorX != null ? c.anchorX : src.w / 2,
    ay: c.anchorY != null ? c.anchorY : src.h / 2,
    sw: src.w,
    sh: src.h,
  };
}
// Where the picture ends up in the frame: its size, and where its middle is
function placement(c) {
  const mo = motion(c);
  const fit = Math.min(ed.p.w / mo.sw, ed.p.h / mo.sh); // first fitted into the frame
  const w = mo.sw * fit * mo.sx / 100, h = mo.sh * fit * mo.sy / 100;
  const ox = (mo.ax - mo.sw / 2) * fit * mo.sx / 100, oy = (mo.ay - mo.sh / 2) * fit * mo.sy / 100;
  const a = mo.rot * Math.PI / 180;
  return { w, h, cx: mo.x - (ox * Math.cos(a) - oy * Math.sin(a)), cy: mo.y - (ox * Math.sin(a) + oy * Math.cos(a)), rot: mo.rot, sx: mo.sx / 100, sy: mo.sy / 100, opacity: mo.opacity / 100 };
}
// Centre the picture and size it to the frame: whole picture seen ("fit") or the frame
// covered with the picture's edges cut off ("fill", e.g. a wide video in a 9:16 frame)
function fitClip(c, how) {
  const mo = motion(c);
  const fit = Math.min(ed.p.w / mo.sw, ed.p.h / mo.sh);
  const s = how === 'fill' ? Math.max(ed.p.w / mo.sw, ed.p.h / mo.sh) / fit * 100 : 100;
  c.scaleX = c.scaleY = Math.round(s * 10) / 10;
  c.posX = c.posY = c.anchorX = c.anchorY = c.scale = null;
}

// The same on screen: the preview is the frame shrunk to fit, the picture sits in the middle
function motionCss(c, el) {
  const pl = placement(c);
  const k = $('#ed-screen').clientHeight / ed.p.h;
  el.style.transform = `translate(${(pl.cx - ed.p.w / 2) * k}px, ${(pl.cy - ed.p.h / 2) * k}px) rotate(${pl.rot}deg) scale(${pl.sx}, ${pl.sy})`;
  return pl.opacity;
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
const edWaiting = () => [...Object.values(edV), ...Object.values(edTail), ...edAudio.values()]
  .some(el => el.dataset.src && !el.hidden && el.src && (el.seeking || el.readyState < 3));

// One picture layer of the monitor: a video element, or a picture for an image clip
function showLayer(track, el, c, t, force, key) {
  const screen = $('#ed-screen');
  const m = c && edMedia(c.media);
  let img = screen.querySelector(`img[data-layer="${key}"]`);
  if (!c || !m || !m.image) img?.remove();
  if (!c || !m) {
    el.hidden = true;
    if (!el.paused) el.pause();
    return;
  }
  if (m.image) {
    el.hidden = true;
    if (!img) {
      img = document.createElement('img');
      img.dataset.layer = key;
      img.className = (key.endsWith('-tail') ? 'ed-tail ' : 'ed-layer ') + track;
      el.after(img);
    }
    if (img.dataset.src !== m.path) { img.dataset.src = m.path; img.src = api.toUrl(m.path); }
    img.style.opacity = fadeAt(c, t) * motionCss(c, img);
    return;
  }
  el.hidden = false;
  el.style.opacity = fadeAt(c, t) * motionCss(c, el);
  if (el.playbackRate !== sp(c)) el.playbackRate = sp(c);
  syncEl(el, m.path, srcAt(c, t), force && !ed.playing);
}

function syncPreview(force) {
  const t = ed.t;
  for (const [track, el] of Object.entries(edV)) {
    const shown = !ed.p.tracks[track].hidden;
    showLayer(track, el, shown && clipAt(track, t), t, force, track);
    showLayer(track, edTail[track], shown && tailAt(track, t), t, force, track + '-tail');
  }
  // sound
  const live = new Set();
  for (const c of ed.p.clips) {
    const tr = trackOf(c.track);
    if (tr.kind !== 'audio' || c.off || c.start > t || clipEnd(c) + tailOf(c) <= t) continue;
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
    el.volume = clamp(c.volume * st.volume * fadeAt(c, t, true), 0, 1);
    el.muted = trackSilent(c.track);
    if (el.playbackRate !== sp(c)) el.playbackRate = sp(c);
    syncEl(el, m.path, srcAt(c, t), force && !ed.playing);
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
      d.style.fontFamily = fontOf(c)[1];
      d.style.fontWeight = c.bold && fontOf(c)[3] ? '700' : '400';
      d.style.opacity = fadeAt(c, t);
      titles.append(d);
    }
  }
  placeXform();
  placePlayhead();
}

// A frame around the selected picture on the monitor: drag it to move the picture, drag a
// corner to scale it (around its middle), as with the transform box in Premiere
const xform = $('#ed-xform');
function xformClip() {
  const sel = ed.p.clips.filter(c => ed.sel.has(c.id));
  const c = sel.length === 1 && sel[0];
  if (!c || trackOf(c.track).kind !== 'video' || ed.p.tracks[c.track].hidden || clipAt(c.track, ed.t) !== c) return null;
  return c;
}
function placeXform() {
  const c = xformClip();
  xform.hidden = !c || ed.playing;
  if (xform.hidden) return;
  const pl = placement(c);
  const k = $('#ed-screen').clientHeight / ed.p.h;
  Object.assign(xform.style, {
    left: pl.cx * k + 'px', top: pl.cy * k + 'px',
    width: Math.abs(pl.w) * k + 'px', height: Math.abs(pl.h) * k + 'px',
    transform: `translate(-50%, -50%) rotate(${pl.rot}deg)`,
  });
}
xform.onclick = e => e.stopPropagation();
xform.ondblclick = e => {
  e.stopPropagation();
  const c = xformClip();
  if (!c) return;
  edCommit();
  fitClip(c, 'fill');
  edChanged();
};
xform.onpointerdown = e => {
  const c = xformClip();
  if (!c || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const corner = e.target.dataset.c;
  const k = $('#ed-screen').clientHeight / ed.p.h;
  const r = $('#ed-screen').getBoundingClientRect();
  const mo = motion(c), pl = placement(c);
  // the picture's middle on screen, for scaling by the corners
  const mx = r.left + pl.cx * k, my = r.top + pl.cy * k;
  const d0 = Math.max(1, Math.hypot(e.clientX - mx, e.clientY - my));
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  xform.setPointerCapture(e.pointerId);
  xform.onpointermove = ev => {
    if (!moved) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
      edCommit();
      moved = true;
    }
    if (corner) {
      const f = Math.hypot(ev.clientX - mx, ev.clientY - my) / d0;
      c.scaleX = Math.round(clamp(mo.sx * f, 1, 2000) * 10) / 10;
      c.scaleY = Math.round(clamp(mo.sy * f, 1, 2000) * 10) / 10;
      c.scale = null;
    } else {
      // the middle of the frame pulls the picture in, like a guide
      let x = mo.x + (ev.clientX - sx) / k, y = mo.y + (ev.clientY - sy) / k;
      if (Math.abs(x - ed.p.w / 2) * k < 6) x = ed.p.w / 2;
      if (Math.abs(y - ed.p.h / 2) * k < 6) y = ed.p.h / 2;
      c.posX = Math.round(x);
      c.posY = Math.round(y);
    }
    syncPreview();
  };
  xform.onpointerup = () => {
    xform.onpointermove = xform.onpointerup = null;
    if (moved) edChanged();
  };
};

function seekEd(t, stay = false) {
  ed.t = clamp(t, 0, Math.max(edDuration(), 0));
  if (ed.playing) clock = { t0: ed.t, n0: performance.now() };
  syncPreview(true);
  if (stay) return;
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
  for (const el of [...Object.values(edV), ...Object.values(edTail), ...edAudio.values()]) el.pause();
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
  placeXform();
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
// The wheel over the track names scrolls the tracks too (that column has no scrollbar)
$('#ed-heads').addEventListener('wheel', e => {
  if (e.ctrlKey) return;
  e.preventDefault();
  scroller.scrollTop += e.deltaY;
}, { passive: false });
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
$('#ed-del').onclick = () => (ed.markSel != null ? removeMarker(ed.markSel) : deleteSelected());
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
    F1: () => $('#help-dlg').showModal(),
    KeyF: edFullscreen,
    KeyZ: () => edViewReset(),
    KeyT: addText,
    Delete: () => (ed.markSel != null && (ed.p.markers || []).includes(ed.markSel) ? removeMarker(ed.markSel) : deleteSelected()),
    Backspace: () => (ed.markSel != null && (ed.p.markers || []).includes(ed.markSel) ? removeMarker(ed.markSel) : deleteSelected()),
    Home: () => seekEd(0),
    End: () => seekEd(edDuration()),
    ArrowLeft: () => seekEd(ed.t - (e.shiftKey ? 1 : frame)),
    ArrowRight: () => seekEd(ed.t + (e.shiftKey ? 1 : frame)),
    Equal: () => setZoom(ed.pps * 1.3),
    Minus: () => setZoom(ed.pps / 1.3),
    Escape: () => { if (document.fullscreenElement) return document.exitFullscreen(); ed.sel.clear(); renderTimeline(); renderInspector(); },
  };
  let fn = keys[e.code];
  if (ctrl && e.altKey && e.code === 'KeyM') fn = clearMarkers;
  else if (ctrl) {
    fn = { KeyZ: () => edUndo(!e.shiftKey), KeyY: () => edUndo(false), KeyA: () => { ed.sel = new Set(ed.p.clips.map(c => c.id)); renderTimeline(); renderInspector(); }, KeyC: copySelected, KeyV: pasteClips, KeyM: () => $('#ed-export').click(), KeyI: () => $('#ed-import').click(), KeyU: () => openLinkDialog(), KeyX: () => { copySelected(); deleteSelected(); } }[e.code];
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
      const pl = placement(c);
      // dur counts the part under a cross dissolve into the next clip
      spec.video.push({ file: m.path, vIndex: m.video.index, image: m.image, in: c.in, dur: clipDur(c) + tailOf(c), speed: sp(c), start: c.start, fadeIn: fadeInOf(c), fadeOut: fadeOutOf(c),
        x: pl.cx, y: pl.cy, pw: pl.w, ph: pl.h, rot: pl.rot, opacity: pl.opacity });
    }
  }
  for (const c of ed.p.clips) {
    const st = ed.p.tracks[c.track];
    if (trackOf(c.track).kind !== 'audio' || c.off || trackSilent(c.track)) continue;
    const m = edMedia(c.media);
    if (!m || !m.audio.length) continue;
    const vol = c.volume * st.volume;
    if (vol <= 0) continue;
    const tail = tailOf(c);
    spec.audio.push({ file: m.path, aIndex: m.audio[c.audioK || 0].index, in: c.in, dur: clipDur(c) + tail, speed: sp(c), start: c.start, volume: vol, fadeIn: fadeInOf(c), fadeOut: Math.max(fadeOutOf(c), tail) });
  }
  if (!ed.p.tracks.T1.hidden) {
    for (const c of ed.p.clips.filter(x => x.track === 'T1' && !x.off && x.text.trim())) {
      const [x, y] = titleXY(c);
      spec.texts.push({ text: c.text, start: c.start, dur: clipDur(c), size: c.size, color: c.color, x, y, box: c.box, fontFile: (c.bold && fontOf(c)[3]) || fontOf(c)[2], fadeIn: c.fadeIn, fadeOut: c.fadeOut });
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
  edEnc.vbitrate = clamp(Number(br) || 12, 0.1, 150);
  edEnc.vmax = clamp(Number(mx) || 18, 0.1, 200);
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

// Ready settings for where the video goes. For a size limit the bitrate is worked out from the
// length, a little under the limit, with two passes so the file really fits.
function sizeLimited(mb, w, h, fps, cap) {
  const T = Math.max(1, edDuration());
  const audio = 128;
  const kbps = mb * 8 * 1024 * 0.94 / T - audio; // what is left for the picture, kbit/s
  const v = Math.floor(Math.min(cap, kbps / 1000) * 10) / 10;
  if (v < 0.2) {
    toast(`Ролик слишком длинный для ${mb} МБ: картинка будет почти не видна. Укоротите его или выберите другую настройку.`);
    return null;
  }
  return { w, h, fps, enc: { codec: 'h264', profile: 'high', mode: 'vbr2', vbitrate: v, vmax: Math.round(v * 1.5 * 10) / 10, abitrate: audio, preset: 'veryfast', format: 'mp4' } };
}
const EX_PRESETS = [
  ['YouTube 1080p60', 'Рекомендации YouTube: 1920×1080, 60 к/с, 12 Мбит/с', () => ({ w: 1920, h: 1080, fps: 60, enc: { codec: 'h264', profile: 'high', mode: 'vbr1', vbitrate: 12, vmax: 18, abitrate: 192, format: 'mp4' } })],
  ['YouTube 1440p', '2560×1440, 60 к/с, 24 Мбит/с — YouTube даёт таким роликам лучшее качество', () => ({ w: 2560, h: 1440, fps: 60, enc: { codec: 'h264', profile: 'high', mode: 'vbr1', vbitrate: 24, vmax: 36, abitrate: 192, format: 'mp4' } })],
  ['Shorts / TikTok 9:16', 'Вертикально 1080×1920, 60 к/с. Горизонтальное видео растяните кнопкой «Заполнить» в эффектах', () => ({ w: 1080, h: 1920, fps: 60, enc: { codec: 'h264', profile: 'high', mode: 'vbr1', vbitrate: 10, vmax: 15, abitrate: 192, format: 'mp4' } })],
  ['Discord до 10 МБ', '1280×720, 30 к/с, битрейт под размер ролика — файл влезет в Discord без Nitro', () => sizeLimited(10, 1280, 720, 30, 8)],
  ['Discord Nitro 50 МБ', '1920×1080, 60 к/с, битрейт под 50 МБ', () => sizeLimited(50, 1920, 1080, 60, 12)],
  ['Наилучшее', 'Размер и частота как у исходника, почти без потерь (CRF 17), файл большой', () => {
    const m = ed.p.clips.filter(x => x.track[0] === 'V').map(x => edMedia(x.media)).find(m => m && m.video && !m.image);
    return { w: m ? m.video.w : ed.p.w, h: m ? m.video.h : ed.p.h, fps: (m && m.video.fps) || ed.p.fps, enc: { codec: 'h264', profile: 'high', mode: 'crf', crf: 17, preset: 'fast', abitrate: 256, format: 'mp4' } };
  }],
];
function applyPreset(name, title, p) {
  if (!p) return;
  Object.assign(edEnc, p.enc);
  if (p.w !== ed.p.w || p.h !== ed.p.h || p.fps !== ed.p.fps) {
    edCommit();
    Object.assign(ed.p, { w: p.w, h: p.h, fps: p.fps });
    store('edProject', ed.p);
    renderProjectSettings();
  }
  store('edExport', edEnc);
  renderExportForm();
  toast(`${name}: ${title}`);
}
// The person's own settings, saved under a name next to the ready ones
const ENC_KEYS = ['format', 'codec', 'profile', 'mode', 'crf', 'vbitrate', 'vmax', 'preset', 'abitrate'];
const presetText = p => `${p.w}×${p.h}, ${fpsText(p.fps)} к/с, ${p.enc.codec === 'h265' ? 'H.265' : 'H.264'}, `
  + (p.enc.mode === 'crf' ? `CRF ${p.enc.crf}` : `${p.enc.vbitrate} Мбит/с`) + `, звук ${p.enc.abitrate} кбит/с`;
function renderPresets() {
  const box = $('#ed-ex-presets');
  box.innerHTML = '';
  const add = (name, title, make, remove) => {
    const b = document.createElement('button');
    b.className = 'btn small ghost' + (remove ? ' mine' : '');
    b.textContent = name;
    b.title = title;
    b.onclick = () => applyPreset(name, title, make());
    if (remove) {
      const x = document.createElement('i');
      x.textContent = '×';
      x.title = 'Удалить эту настройку';
      x.onclick = e => { e.stopPropagation(); remove(); };
      b.append(x);
    }
    box.append(b);
  };
  for (const [name, title, make] of EX_PRESETS) add(name, title, make);
  const mine = recall('edMyPresets', []);
  mine.forEach((p, k) => add(p.name, presetText(p), () => p, () => {
    mine.splice(k, 1);
    store('edMyPresets', mine);
    renderPresets();
  }));
  const save = document.createElement('button');
  save.className = 'btn small';
  save.textContent = '+ Сохранить мои';
  save.title = 'Запомнить текущие размер, частоту кадров, кодек, битрейт и звук под своим названием';
  save.onclick = () => {
    const inp = document.createElement('input');
    inp.className = 'time-input ed-ex-name';
    inp.placeholder = 'Название, Enter — сохранить';
    inp.maxLength = 40;
    save.replaceWith(inp);
    inp.focus();
    inp.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); renderPresets(); }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const name = inp.value.trim();
      if (!name) return;
      const enc = {};
      for (const k of ENC_KEYS) enc[k] = edEnc[k];
      const list = recall('edMyPresets', []).filter(p => p.name !== name); // the same name is replaced
      list.push({ name, w: ed.p.w, h: ed.p.h, fps: ed.p.fps, enc });
      store('edMyPresets', list);
      renderPresets();
      toast(`Настройка «${name}» сохранена`);
    };
    inp.onblur = () => setTimeout(() => { if (inp.isConnected) renderPresets(); }, 150);
  };
  box.append(save);
}
renderPresets();

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

// A video from a link, or a part of it, downloaded into a folder and added to the project
$('#ed-link').onclick = () => openLinkDialog();
$('#link-download').onclick = async () => {
  const [url] = linkUrls();
  if (!url) {
    toast('Вставьте ссылку, которая начинается с https://');
    return;
  }
  let from = null, to = null;
  if ($('#link-cut').checked) {
    from = parseTime($('#link-from').value || '0');
    to = $('#link-to').value.trim() ? parseTime($('#link-to').value) : null;
    if (from == null || (to != null && to <= from)) {
      toast('Проверьте время куска: например, с 1:20:00 по 1:25:00');
      return;
    }
  }
  let dir = recall('edLinkDir', null);
  if (!dir) {
    dir = await api.linkPickDir();
    if (!dir) return;
    store('edLinkDir', dir);
  }
  $('#link-dlg').close();
  edJob = newJob();
  const job = edJob;
  $('#ed-progress').hidden = false;
  $('#ed-progress-bar').style.width = '0%';
  $('#ed-progress-text').textContent = 'Узнаю, что по ссылке…';
  try {
    const { file } = await api.linkDownload({ url, dir, from, to, jobId: job });
    const [m] = await edImport([file]);
    toast(`Скачано и добавлено в проект: ${m ? m.name : api.basename(file)}`, 'Показать в папке', () => api.reveal(file));
  } catch (e) {
    toast(`Не удалось скачать:\n${cleanErr(e)}`);
  } finally {
    if (edJob === job) edJob = null;
    $('#ed-progress').hidden = true;
  }
};
api.onLinkProgress(({ jobId, value, stage }) => {
  if (jobId !== edJob) return;
  const pct = Math.round(value * 100);
  $('#ed-progress-text').textContent = stage === 'tool' ? `Первый раз: скачиваю yt-dlp… ${pct}%` : stage === 'download' ? `Скачиваю… ${pct}%` : 'Узнаю, что по ссылке…';
  $('#ed-progress-bar').style.width = (stage === 'resolve' ? 0 : pct) + '%';
});
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
    if (!recall('edTourDone', false)) setTimeout(edTour, 400);
  }
};

// ---------- first look: a short tour that lights up one panel at a time

const TOUR = [
  ['.ed-bin', 'Проект', 'Нажмите «Импорт» или перетащите сюда видео, музыку и картинки. Потом тяните их на таймлайн. Исходные файлы не меняются.'],
  ['.ed-timeline', 'Таймлайн', 'Здесь собирается ролик. S — разрезать под бегунком, Delete — удалить, Ctrl + колесо — приблизить. Вкладка «История» рядом с «Проект» — все шаги, к любому можно вернуться.'],
  ['.ed-insp', 'Эффекты', 'Выберите клип — здесь его положение, масштаб, громкость, скорость и переход с предыдущим клипом. Переход также есть в меню правого клика по клипу.'],
  ['#ed-export', 'Экспорт', 'Когда ролик готов — «Экспорт». Там есть готовые настройки: YouTube, Shorts / TikTok, Discord до 10 МБ.'],
];
function edTour(step = 0) {
  document.querySelector('.ed-tour')?.remove();
  if (step >= TOUR.length) {
    store('edTourDone', true);
    return;
  }
  const [sel, title, text] = TOUR[step];
  const target = document.querySelector(sel);
  if (!target || currentView !== 'editor') return;
  const r = target.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'ed-tour';
  box.innerHTML = '<div class="ed-tour-hole"></div><div class="ed-tour-card"><div class="ed-tour-step"></div><b></b><p></p>'
    + '<div class="ed-tour-btns"><button class="btn small ghost ed-tour-skip">Пропустить</button><button class="btn small accent ed-tour-next"></button></div></div>';
  Object.assign(box.querySelector('.ed-tour-hole').style, { left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px' });
  box.querySelector('.ed-tour-step').textContent = `${step + 1} из ${TOUR.length}`;
  box.querySelector('b').textContent = title;
  box.querySelector('p').textContent = text;
  box.querySelector('.ed-tour-next').textContent = step === TOUR.length - 1 ? 'Понятно' : 'Далее';
  box.querySelector('.ed-tour-next').onclick = () => edTour(step + 1);
  box.querySelector('.ed-tour-skip').onclick = () => edTour(TOUR.length);
  document.body.append(box);
  // the card goes beside the lit panel, where there is room
  const card = box.querySelector('.ed-tour-card');
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x = r.right + 14, y = r.top;
  if (x + cw > innerWidth - 10) x = r.left - cw - 14;
  if (x < 10) { x = clamp(r.left, 10, innerWidth - cw - 10); y = r.bottom + 14 > innerHeight - ch - 10 ? r.top - ch - 14 : r.bottom + 14; }
  card.style.left = x + 'px';
  card.style.top = clamp(y, 10, innerHeight - ch - 10) + 'px';
  card.querySelector('.ed-tour-next').focus();
}
$('#ed-tour-btn').onclick = () => edTour(0);
$('#ed-bug').onclick = () => reportBug('Редактор');
$('#nav-editor').onclick = () => showView('editor');

// From the library: a file dragged onto the editor button opens the editor under the mouse,
// so it can be dropped right on a track or in the bin; the file menu has "В редактор"
let springTimer = 0;
$('#nav-editor').addEventListener('dragenter', () => {
  clearTimeout(springTimer);
  springTimer = setTimeout(() => showView('editor'), 450);
});
$('#nav-editor').addEventListener('dragleave', () => clearTimeout(springTimer));
$('#nav-editor').addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation(); // not opened in the player as well
  clearTimeout(springTimer);
  const files = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
  if (files.length) edFromLibrary(files);
});
async function edFromLibrary(files) {
  showView('editor');
  for (const m of await edImport(files)) edPlace(m, null, edDuration());
}

renderBin();
renderHeads();
renderToggles();
renderProjectSettings();
setZoom(ed.pps);
renderInspector();
syncPreview(true);

// ---------- marquee: drag over empty space to select every clip it touches (Shift adds);
// a plain click there still moves the playhead
function marquee(e) {
  const canvas = $('#ed-canvas');
  const cr = canvas.getBoundingClientRect();
  const x0 = e.clientX - cr.left, y0 = e.clientY - cr.top;
  const base = e.shiftKey ? new Set(ed.sel) : new Set();
  let box = null;
  const move = ev => {
    const x1 = ev.clientX - cr.left, y1 = ev.clientY - cr.top;
    if (!box) {
      if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4) return;
      box = document.createElement('div');
      box.id = 'ed-marquee';
      canvas.append(box);
    }
    const l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    Object.assign(box.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
    const r = { left: l + cr.left, right: l + w + cr.left, top: t + cr.top, bottom: t + h + cr.top };
    ed.sel = new Set(base);
    for (const el of lanesBox.querySelectorAll('.ed-clip')) {
      const q = el.getBoundingClientRect();
      if (q.right > r.left && q.left < r.right && q.bottom > r.top && q.top < r.bottom) {
        const c = ed.p.clips.find(x => x.id === Number(el.dataset.id));
        if (c && !isLocked(c)) ed.sel.add(c.id);
      }
    }
    for (const el of lanesBox.querySelectorAll('.ed-clip')) el.classList.toggle('sel', ed.sel.has(Number(el.dataset.id)));
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (box) {
      box.remove();
    } else {
      if (!e.shiftKey) ed.sel.clear();
      seekEd(tOf(x0));
    }
    renderTimeline();
    renderInspector();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ---------- wrench: track height and links for the whole timeline
function setMiniTracks(on) {
  ed.miniTracks = on;
  store('edMiniTracks', on);
  $('.ed').classList.toggle('mini-tracks', on);
  renderTimeline();
}
setMiniTracks(recall('edMiniTracks', false));

function unlinkAll() {
  const any = ed.p.clips.some(c => c.link);
  if (!any) return toast('Связанных клипов нет.');
  edCommit();
  // only the selected ones when something is selected, otherwise every clip
  const list = ed.sel.size ? ed.p.clips.filter(c => ed.sel.has(c.id)) : ed.p.clips;
  for (const c of list) c.link = 0;
  edChanged();
  toast(ed.sel.size ? 'Выделенные клипы отвязаны.' : 'Все клипы отвязаны друг от друга.');
}
function linkSelected() {
  const list = ed.p.clips.filter(c => ed.sel.has(c.id));
  if (list.length < 2) return toast('Выделите хотя бы два клипа (рамкой или с Shift).');
  edCommit();
  const id = ed.nextId++;
  for (const c of list) c.link = id;
  edChanged();
}

$('#ed-wrench').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  openCtxMenu(r.left, r.bottom + 4, [
    // Premiere's Minimize / Expand All Tracks: every track low, or every track back to normal
    ed.miniTracks || Object.keys(trackH).length
      ? { icon: 'i-chevron', label: 'Развернуть все дорожки (обычная высота)', run: () => { for (const id of Object.keys(trackH)) setTrackH(id, 0); setMiniTracks(false); } }
      : { icon: 'i-chevron', label: 'Свернуть все дорожки — видно больше дорожек сразу', run: () => setMiniTracks(true) },
    '-',
    { icon: 'i-link', label: ed.sel.size ? 'Отвязать выделенные клипы' : 'Отвязать все клипы', run: unlinkAll },
    { icon: 'i-link', label: 'Связать выделенные клипы', run: linkSelected },
  ]);
};

// Hot keys window: a tab for the player and one for the editor; it opens on the one in use
function showKeysTab(name) {
  for (const b of document.querySelectorAll('.keys-tabs button')) b.classList.toggle('on', b.dataset.keys === name);
  for (const t of document.querySelectorAll('#help-dlg table.keys')) t.hidden = t.dataset.keys !== name;
}
for (const b of document.querySelectorAll('.keys-tabs button')) b.onclick = () => showKeysTab(b.dataset.keys);
new MutationObserver(() => { if ($('#help-dlg').open) showKeysTab(currentView === 'editor' ? 'editor' : 'player'); })
  .observe($('#help-dlg'), { attributes: true, attributeFilter: ['open'] });

// Double click on a clip's loudness line puts it back to 100%
lanesBox.addEventListener('dblclick', e => {
  if (!e.target.classList.contains('ed-vol')) return;
  const c = ed.p.clips.find(x => x.id === Number(e.target.closest('.ed-clip').dataset.id));
  if (!c) return;
  edCommit();
  c.volume = 1;
  edChanged();
});

// Program monitor on the whole screen (the picture and its buttons)
function edFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('.ed-preview').requestFullscreen().catch(() => {});
}
$('#ed-full').onclick = edFullscreen;
document.addEventListener('fullscreenchange', () => setTimeout(fitScreen, 50));
$('#ed-screen').ondblclick = edFullscreen;

// Program monitor: Ctrl + wheel zooms the view toward the mouse (only the view, not the
// edit); drag with the middle button or Space+drag... kept simple: double click on the zoom
// badge or Z puts it back to fit
const edView = { k: 1, x: 0, y: 0 };
function applyEdView() {
  $('#ed-screen').style.transform = `translate(calc(-50% + ${edView.x}px), calc(-50% + ${edView.y}px)) scale(${edView.k})`;
  $('#ed-zoom-badge').hidden = edView.k === 1;
  $('#ed-zoom-badge').textContent = Math.round(edView.k * 100) + '%';
}
$('#ed-screen-wrap').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = $('#ed-screen-wrap').getBoundingClientRect();
  const mx = e.clientX - (r.left + r.width / 2), my = e.clientY - (r.top + r.height / 2);
  const k = clamp(edView.k * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 1, 8);
  edView.x = mx - (mx - edView.x) * (k / edView.k);
  edView.y = my - (my - edView.y) * (k / edView.k);
  edView.k = k < 1.02 ? 1 : k;
  if (edView.k === 1) edView.x = edView.y = 0;
  applyEdView();
}, { passive: false });
// a zoomed view is moved by dragging with the right mouse button
$('#ed-screen-wrap').addEventListener('pointerdown', e => {
  if (e.button !== 2 || edView.k === 1) return;
  const x0 = e.clientX - edView.x, y0 = e.clientY - edView.y, w = e.currentTarget;
  w.setPointerCapture(e.pointerId);
  w.onpointermove = ev => { edView.x = ev.clientX - x0; edView.y = ev.clientY - y0; applyEdView(); };
  w.onpointerup = () => { w.onpointermove = w.onpointerup = null; };
});
$('#ed-screen-wrap').addEventListener('contextmenu', e => { if (edView.k !== 1) e.preventDefault(); });
const edViewReset = () => { Object.assign(edView, { k: 1, x: 0, y: 0 }); applyEdView(); };
{
  const b = document.createElement('button');
  b.id = 'ed-zoom-badge';
  b.title = 'Сбросить приближение (Z)';
  b.hidden = true;
  b.onclick = edViewReset;
  $('#ed-screen-wrap').append(b);
}
