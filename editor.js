// Video editor (beta): a timeline with video, audio and title tracks, in the spirit of
// Premiere. Source files are only read; the result is rendered into a new file by ffmpeg
// (editor-export in main.js). Runs after ui.js and uses its globals ($, api, toast, ...).

// ---------- project model
//
// media:  files added to the project, with what ffprobe told about them
// clips:  { id, track, media, start, in, out, volume, fadeIn, fadeOut, link, audioK }
//         text clips: { id, track: 'T1', start, in: 0, out: duration, text, size, color, pos, box, fadeIn, fadeOut }
// A video file dropped on the timeline gives a video clip and its sound as a linked audio
// clip; linked clips move, trim, split and get deleted together.

const ED_TRACKS = [
  { id: 'T1', kind: 'text', name: 'Текст' },
  { id: 'V2', kind: 'video', name: 'Видео 2' },
  { id: 'V1', kind: 'video', name: 'Видео 1' },
  { id: 'A1', kind: 'audio', name: 'Звук 1' },
  { id: 'A2', kind: 'audio', name: 'Звук 2' },
  { id: 'A3', kind: 'audio', name: 'Звук 3' },
];
const trackOf = id => ED_TRACKS.find(t => t.id === id);
const IMG_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
const IMAGE_DUR = 5;

function emptyProject() {
  return {
    w: 1920, h: 1080, fps: 30,
    media: [],
    clips: [],
    tracks: Object.fromEntries(ED_TRACKS.map(t => [t.id, { muted: false, hidden: false, volume: 1 }])),
  };
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
  ed.sel = new Set([...ed.sel].filter(id => ed.p.clips.some(c => c.id === id)));
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
        video: v ? { index: v.index, w: v.width, h: v.height } : null,
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
    row.querySelector('button').onclick = e => {
      e.stopPropagation();
      if (ed.p.clips.some(c => c.media === m.path)) {
        toast('Этот файл есть на таймлайне — сначала удалите его клипы.');
        return;
      }
      ed.p.media = ed.p.media.filter(x => x !== m);
      store('edProject', ed.p);
      renderBin();
    };
    box.append(row);
  }
}

$('#ed-import').onclick = async () => {
  const paths = await api.openFiles();
  if (paths.length) edImport(paths);
};

// A file on the timeline: its picture on a video track and its sound on an audio track
function edPlace(m, trackId, start) {
  edCommit();
  const dur = m.image ? IMAGE_DUR : m.dur;
  const link = m.video && m.audio.length ? ed.nextId : 0;
  const made = [];
  const base = { media: m.path, start: Math.max(0, start), in: 0, out: dur, volume: 1, fadeIn: 0, fadeOut: 0, link };
  // the other half goes to the first track of its kind that is free there
  const order = { video: ['V1', 'V2'], audio: ['A1', 'A2', 'A3'] };
  const free = kind => order[kind].find(id => !ed.p.clips.some(c => c.track === id && c.start < base.start + dur && clipEnd(c) > base.start));
  const pick = kind => (trackId && trackOf(trackId).kind === kind ? trackId : free(kind) || order[kind][0]);
  const vTrack = pick('video');
  const aTrack = pick('audio');
  if (m.video) made.push({ ...base, id: ed.nextId++, track: vTrack });
  if (m.audio.length && !m.image) made.push({ ...base, id: ed.nextId++, track: aTrack, audioK: 0 });
  ed.p.clips.push(...made);
  // the first video sets the frame size and rate of the project
  if (m.video && !ed.p.clips.some(c => c.track[0] === 'V' && !made.includes(c)) && m.video.w && m.video.h && !m.image) {
    const res = `${m.video.w}x${m.video.h}`;
    if ([...$('#ed-res').options].some(o => o.value === res)) {
      ed.p.w = m.video.w;
      ed.p.h = m.video.h;
    }
  }
  resolveOverlaps(made);
  ed.sel = new Set(made.map(c => c.id));
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

function renderHeads() {
  const box = $('#ed-heads');
  box.innerHTML = '<div class="ed-ruler-pad"></div>';
  for (const tr of ED_TRACKS) {
    const st = ed.p.tracks[tr.id];
    const h = document.createElement('div');
    h.className = `ed-trhead ${tr.kind}`;
    h.innerHTML = '<b></b><span class="sp"></span>';
    h.querySelector('b').textContent = tr.id;
    h.title = tr.name;
    const btn = document.createElement('button');
    btn.className = 'icon sm';
    if (tr.kind === 'audio') {
      btn.title = st.muted ? 'Включить звук дорожки' : 'Выключить звук дорожки';
      btn.innerHTML = `<svg class="i"><use href="#${st.muted ? 'i-mute' : 'i-vol'}"/></svg>`;
      btn.onclick = () => { edCommit(); st.muted = !st.muted; renderHeads(); edChanged(); };
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
      h.append(btn, vol);
    } else {
      btn.title = st.hidden ? 'Показать дорожку' : 'Скрыть дорожку';
      btn.innerHTML = `<svg class="i"><use href="#${st.hidden ? 'i-eye-off' : 'i-eye'}"/></svg>`;
      btn.classList.toggle('off', st.hidden);
      btn.onclick = () => { edCommit(); st.hidden = !st.hidden; renderHeads(); edChanged(); };
      h.append(btn);
    }
    h.classList.toggle('off', st.muted || st.hidden);
    box.append(h);
  }
}

function renderRuler() {
  const ruler = $('#ed-ruler');
  ruler.innerHTML = '';
  const total = Math.max(edDuration() + 30, tOf(scroller.clientWidth) + 5);
  $('#ed-canvas').style.width = xOf(total) + 'px';
  // a label every 50+ px, on a round number of seconds
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find(s => xOf(s) >= 70) || 600;
  for (let t = 0; t <= total; t += step) {
    const tick = document.createElement('span');
    tick.style.left = xOf(t) + 'px';
    tick.textContent = step < 1 ? fmtEd(t).replace(/0$/, '') : fmt(t);
    ruler.append(tick);
  }
}

function renderTimeline() {
  renderRuler();
  lanesBox.innerHTML = '';
  for (const tr of ED_TRACKS) {
    const lane = document.createElement('div');
    lane.className = `ed-lane ${tr.kind}`;
    lane.dataset.track = tr.id;
    lane.classList.toggle('off', ed.p.tracks[tr.id].muted || ed.p.tracks[tr.id].hidden);
    for (const c of ed.p.clips.filter(x => x.track === tr.id)) lane.append(clipEl(c, tr));
    lanesBox.append(lane);
  }
  placePlayhead();
}

function clipEl(c, tr) {
  const el = document.createElement('div');
  el.className = `ed-clip ${tr.kind}`;
  el.classList.toggle('sel', ed.sel.has(c.id));
  el.classList.toggle('linked', !!c.link);
  el.dataset.id = c.id;
  el.style.left = xOf(c.start) + 'px';
  el.style.width = Math.max(4, xOf(clipDur(c))) + 'px';
  const m = edMedia(c.media);
  const label = tr.kind === 'text' ? c.text.split('\n')[0] || 'Текст' : (m ? m.name : '?');
  el.innerHTML = '<span class="ed-name"></span><i class="ed-edge l"></i><i class="ed-edge r"></i>';
  el.querySelector('.ed-name').textContent = label + (c.volume !== 1 && tr.kind === 'audio' ? `  ${Math.round(c.volume * 100)}%` : '');
  if (c.fadeIn > 0) el.style.setProperty('--fi', xOf(c.fadeIn) + 'px');
  if (c.fadeOut > 0) el.style.setProperty('--fo', xOf(c.fadeOut) + 'px');
  el.classList.toggle('fi', c.fadeIn > 0);
  el.classList.toggle('fo', c.fadeOut > 0);
  return el;
}

function placePlayhead() {
  $('#ed-playhead').style.left = xOf(ed.t) + 'px';
  $('#ed-time').textContent = `${fmtEd(ed.t)} / ${fmtEd(edDuration())}`;
}

// Zoom: the slider is logarithmic, 2…400 px per second
function setZoom(pps, anchorT = ed.t) {
  const before = xOf(anchorT) - scroller.scrollLeft;
  ed.pps = clamp(pps, 2, 400);
  $('#ed-zoom').value = Math.round(Math.log(ed.pps / 2) / Math.log(200) * 100);
  renderTimeline();
  scroller.scrollLeft = xOf(anchorT) - before;
}
$('#ed-zoom').oninput = e => setZoom(2 * Math.pow(200, e.target.value / 100));
scroller.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = scroller.getBoundingClientRect();
  setZoom(ed.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2), tOf(e.clientX - r.left + scroller.scrollLeft));
}, { passive: false });

// Snap points: clip edges and the playhead, within 8 px
function snapPoints(exclude) {
  const pts = [0, ed.t];
  for (const c of ed.p.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
  return pts;
}
function snap(t, pts) {
  if (!$('#ed-snap').checked) return { t, hit: null };
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

lanesBox.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const el = e.target.closest('.ed-clip');
  if (!el) {
    if (!e.shiftKey) ed.sel.clear();
    seekEd(tOf(canvasX(e)));
    renderTimeline();
    renderInspector();
    return;
  }
  const c = ed.p.clips.find(x => x.id === Number(el.dataset.id));
  if (ed.tool === 'razor') {
    splitClips([c], snap(tOf(canvasX(e)), snapPoints(new Set([c.id]))).t);
    return;
  }
  if (e.shiftKey || e.ctrlKey) {
    for (const x of linked(c)) ed.sel.has(c.id) ? ed.sel.delete(x.id) : ed.sel.add(x.id);
  } else if (!ed.sel.has(c.id)) ed.sel = new Set(linked(c).map(x => x.id));
  renderTimeline();
  renderInspector();
  const edge = e.target.classList.contains('ed-edge') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  dragClips(e, c, edge);
});

function dragClips(e, c, edge) {
  const group = edge ? linked(c) : ed.p.clips.filter(x => ed.sel.has(x.id));
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
  for (const c of list) for (const x of linked(c)) if (!cut.includes(x) && x.start + 0.02 < t && clipEnd(x) - 0.02 > t) cut.push(x);
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

function splitAtPlayhead() {
  const sel = ed.p.clips.filter(c => ed.sel.has(c.id));
  splitClips(sel.length ? sel : ed.p.clips, ed.t);
}

function deleteSelected() {
  if (!ed.sel.size) return;
  edCommit();
  ed.p.clips = ed.p.clips.filter(c => !ed.sel.has(c.id));
  ed.sel.clear();
  edChanged();
}

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
  const c = { id: ed.nextId++, track: 'T1', start: ed.t, in: 0, out: 4, text: 'Новый текст', size: 72, color: 'white', pos: 'bottom', box: false, fadeIn: 0.3, fadeOut: 0.3, volume: 1 };
  ed.p.clips.push(c);
  resolveOverlaps([c]);
  ed.sel = new Set([c.id]);
  edChanged();
  const ta = $('#ed-insp-body textarea');
  if (ta) { ta.focus(); ta.select(); }
}

// ---------- inspector

function renderInspector() {
  const body = $('#ed-insp-body');
  body.innerHTML = '';
  const sel = ed.p.clips.filter(c => ed.sel.has(c.id));
  if (!sel.length) {
    body.innerHTML = '<div class="ed-hint">Выберите клип на таймлайне.<br><br><b>Пробел</b> — смотреть<br><b>S</b> — разрезать по линии<br><b>C</b> / <b>V</b> — бритва / выбор<br><b>Delete</b> — удалить<br><b>T</b> — надпись<br><b>Ctrl+Z</b> — отменить<br><b>Ctrl + колесо</b> — масштаб</div>';
    return;
  }
  const c = sel.length === 1 ? sel[0] : sel.find(x => x.track[0] === 'V') || sel[0];
  const kind = trackOf(c.track).kind;
  const m = edMedia(c.media);
  const field = (label, input) => {
    const l = document.createElement('label');
    l.className = 'ed-field';
    l.append(document.createTextNode(label), input);
    body.append(l);
    return input;
  };
  const head = document.createElement('div');
  head.className = 'ed-insp-title';
  head.textContent = kind === 'text' ? 'Надпись' : m ? m.name : '';
  body.append(head);
  const info = document.createElement('div');
  info.className = 'ed-insp-info';
  info.textContent = `${trackOf(c.track).name} · с ${fmtEd(c.start)} · длина ${fmtEd(clipDur(c))}` + (sel.length > 1 ? ` · выбрано ${sel.length}` : '');
  body.append(info);

  const numIn = (val, min, max, step, onSet) => {
    const i = document.createElement('input');
    i.type = 'number';
    Object.assign(i, { min, max, step, value: val });
    i.className = 'time-input';
    i.onchange = () => { edCommit(); onSet(clamp(Number(i.value) || 0, min, max)); edChanged(); };
    return i;
  };
  const slider = (val, min, max, step, show, onSet) => {
    const wrap = document.createElement('div');
    wrap.className = 'ed-slider';
    const i = document.createElement('input');
    i.type = 'range';
    Object.assign(i, { min, max, step, value: val });
    const out = document.createElement('span');
    out.textContent = show(val);
    i.onpointerdown = () => edCommit();
    i.oninput = () => { onSet(Number(i.value)); out.textContent = show(Number(i.value)); store('edProject', ed.p); syncPreview(true); };
    i.onchange = () => renderTimeline();
    wrap.append(i, out);
    return wrap;
  };

  if (kind === 'text') {
    const ta = document.createElement('textarea');
    ta.value = c.text;
    ta.rows = 3;
    ta.onfocus = () => edCommit();
    ta.oninput = () => { c.text = ta.value; store('edProject', ed.p); syncPreview(true); };
    ta.onchange = () => renderTimeline();
    field('Текст', ta);
    field('Размер', slider(c.size, 20, 200, 2, v => v + ' px', v => (c.size = v)));
    const color = document.createElement('div');
    color.className = 'ed-colors';
    for (const col of ['white', 'yellow', '#ff5d3a', '#3ad1ff', '#7bff6b', 'black']) {
      const b = document.createElement('button');
      b.style.background = col;
      b.classList.toggle('on', c.color === col);
      b.onclick = () => { edCommit(); c.color = col; edChanged(); };
      color.append(b);
    }
    field('Цвет', color);
    const pos = document.createElement('select');
    pos.innerHTML = '<option value="top">Сверху</option><option value="center">По центру</option><option value="bottom">Снизу</option>';
    pos.value = c.pos;
    pos.onchange = () => { edCommit(); c.pos = pos.value; edChanged(); };
    field('Где', pos);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = c.box;
    box.onchange = () => { edCommit(); c.box = box.checked; edChanged(); };
    const l = field('Подложка', box);
    l.parentNode.classList.add('row');
  }
  if (kind === 'audio') {
    for (const x of sel.filter(x => trackOf(x.track).kind === 'audio')) {
      const xm = edMedia(x.media);
      if (sel.length > 1) {
        const n = document.createElement('div');
        n.className = 'ed-insp-sub';
        n.textContent = x.track;
        body.append(n);
      }
      field('Громкость', slider(x.volume, 0, 2, 0.05, v => Math.round(v * 100) + '%', v => (x.volume = v)));
      if (xm && xm.audio.length > 1) {
        const s = document.createElement('select');
        xm.audio.forEach((a, k) => s.add(new Option(`Дорожка ${k + 1}${a.name ? ' — ' + a.name : ''}`, k)));
        s.value = x.audioK || 0;
        s.onchange = () => { edCommit(); x.audioK = Number(s.value); edChanged(); };
        field('Звуковая дорожка файла', s);
      }
    }
  } else if (sel.some(x => trackOf(x.track).kind === 'audio')) {
    const a = sel.find(x => trackOf(x.track).kind === 'audio');
    field('Громкость звука', slider(a.volume, 0, 2, 0.05, v => Math.round(v * 100) + '%', v => (a.volume = v)));
  }
  field('Появление, с', numIn(c.fadeIn, 0, Math.max(0, clipDur(c) / 2), 0.1, v => { for (const x of sel) x.fadeIn = Math.min(v, clipDur(x) / 2); }));
  field('Исчезание, с', numIn(c.fadeOut, 0, Math.max(0, clipDur(c) / 2), 0.1, v => { for (const x of sel) x.fadeOut = Math.min(v, clipDur(x) / 2); }));
  if (m && m.image) field('Длительность, с', numIn(+clipDur(c).toFixed(2), 0.2, 3600, 0.5, v => { c.out = c.in + v; }));

  const btns = document.createElement('div');
  btns.className = 'ed-insp-btns';
  if (sel.some(x => x.link)) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = 'Отвязать звук от видео';
    b.title = 'Двигать и резать картинку и звук отдельно';
    b.onclick = () => { edCommit(); for (const x of sel) x.link = 0; edChanged(); };
    btns.append(b);
  }
  const del = document.createElement('button');
  del.className = 'btn small';
  del.textContent = 'Удалить';
  del.onclick = deleteSelected;
  btns.append(del);
  body.append(btns);
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
const clipAt = (track, t) => ed.p.clips.find(c => c.track === track && c.start <= t && clipEnd(c) > t);

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
  } else if (force || Math.abs(el.currentTime - local) > 0.3) {
    el.currentTime = local;
  }
  if (ed.playing && el.paused) el.play().catch(() => {});
  if (!ed.playing && !el.paused) el.pause();
}

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
      img.style.opacity = fadeAt(c, t);
      continue;
    }
    screen.querySelector(`img[data-track="${track}"]`)?.remove();
    el.hidden = false;
    el.style.opacity = fadeAt(c, t);
    syncEl(el, m.path, c.in + (t - c.start), force && !ed.playing);
  }
  // sound
  const live = new Set();
  for (const c of ed.p.clips) {
    const tr = trackOf(c.track);
    if (tr.kind !== 'audio' || c.start > t || clipEnd(c) <= t) continue;
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
    el.muted = st.muted;
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
    for (const c of ed.p.clips.filter(x => x.track === 'T1' && x.start <= t && clipEnd(x) > t)) {
      const d = document.createElement('div');
      d.className = `ed-title ${c.pos}`;
      d.classList.toggle('box', c.box);
      d.textContent = c.text;
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
}

function edTick() {
  if (!ed.playing) return;
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
$('#ed-home').onclick = () => seekEd(0);
$('#ed-end').onclick = () => seekEd(edDuration());
$('#ed-screen').onclick = edToggle;

// The preview keeps the project's frame shape
function fitScreen() {
  const wrap = $('#ed-screen-wrap');
  const r = wrap.getBoundingClientRect();
  const k = Math.min(r.width / ed.p.w, r.height / ed.p.h);
  const s = $('#ed-screen');
  s.style.width = Math.floor(ed.p.w * k) + 'px';
  s.style.height = Math.floor(ed.p.h * k) + 'px';
  s.style.setProperty('--ed-h', Math.floor(ed.p.h * k) + 'px');
}
new ResizeObserver(fitScreen).observe($('#ed-screen-wrap'));
new ResizeObserver(() => renderRuler()).observe(scroller);
// track names follow the lanes when the timeline scrolls up and down
scroller.addEventListener('scroll', () => { $('#ed-heads').scrollTop = scroller.scrollTop; });

// ---------- project settings

function renderProjectSettings() {
  $('#ed-res').value = `${ed.p.w}x${ed.p.h}`;
  $('#ed-fps').value = String(ed.p.fps);
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
$('#ed-new').onclick = () => confirmDialog('Новый проект?', 'Таймлайн и список медиа очистятся. Исходные файлы не пострадают.', () => {
  edPause();
  edCommit();
  ed.p = emptyProject();
  ed.sel.clear();
  ed.t = 0;
  renderBin();
  renderHeads();
  renderProjectSettings();
  edChanged();
});

// ---------- toolbar and keys

function setTool(tool) {
  ed.tool = tool;
  for (const b of document.querySelectorAll('[data-edtool]')) b.classList.toggle('on', b.dataset.edtool === tool);
  lanesBox.classList.toggle('razor', tool === 'razor');
}
for (const b of document.querySelectorAll('[data-edtool]')) b.onclick = () => setTool(b.dataset.edtool);
$('#ed-split').onclick = splitAtPlayhead;
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
    KeyS: splitAtPlayhead,
    KeyC: () => setTool('razor'),
    KeyV: () => setTool('select'),
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
    fn = { KeyZ: () => edUndo(!e.shiftKey), KeyY: () => edUndo(false), KeyA: () => { ed.sel = new Set(ed.p.clips.map(c => c.id)); renderTimeline(); renderInspector(); } }[e.code];
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
    for (const c of ed.p.clips.filter(x => x.track === tr).sort((a, b) => a.start - b.start)) {
      const m = edMedia(c.media);
      if (!m || !m.video) continue;
      spec.video.push({ file: m.path, vIndex: m.video.index, image: m.image, in: c.in, dur: clipDur(c), start: c.start, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
    }
  }
  for (const c of ed.p.clips) {
    const st = ed.p.tracks[c.track];
    if (trackOf(c.track).kind !== 'audio' || st.muted) continue;
    const m = edMedia(c.media);
    if (!m || !m.audio.length) continue;
    const vol = c.volume * st.volume;
    if (vol <= 0) continue;
    spec.audio.push({ file: m.path, aIndex: m.audio[c.audioK || 0].index, in: c.in, dur: clipDur(c), start: c.start, volume: vol, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
  }
  if (!ed.p.tracks.T1.hidden) {
    for (const c of ed.p.clips.filter(x => x.track === 'T1' && x.text.trim())) {
      spec.texts.push({ text: c.text, start: c.start, dur: clipDur(c), size: c.size, color: c.color, pos: c.pos, box: c.box, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
    }
  }
  return spec;
}

let edJob = null;
$('#ed-export').onclick = async () => {
  if (!edDuration()) {
    toast('Таймлайн пуст — перетащите на него файлы из «Медиа».');
    return;
  }
  edPause();
  const first = ed.p.clips.find(c => c.media) || {};
  const out = await api.saveDialog({ source: first.media || 'C:\\video.mp4', ext: 'mp4', name: 'Проект Tako' });
  if (!out) return;
  const spec = { ...exportSpec(), out };
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
renderProjectSettings();
setZoom(ed.pps);
renderInspector();
syncPreview(true);
