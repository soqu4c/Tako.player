'use strict';

// `api` is the bridge exposed by preload.js
const $ = sel => document.querySelector(sel);
const video = $('#video');

const LANGS = {
  rus: 'Русский', ru: 'Русский', eng: 'English', en: 'English', ukr: 'Українська', uk: 'Українська',
  jpn: '日本語', ja: '日本語', ger: 'Deutsch', deu: 'Deutsch', de: 'Deutsch', fre: 'Français', fra: 'Français',
  spa: 'Español', ita: 'Italiano', chi: '中文', zho: '中文', kor: '한국어', und: '',
};
// Codecs Chromium decodes directly; anything else goes through ffmpeg first
const PLAYABLE_VIDEO = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'theora'];
const PLAYABLE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'wav', 'flac'];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const state = {
  playlist: [],
  current: -1,
  info: null,
  videoStream: null,
  audioStreams: [],
  subStreams: [],
  audioK: 0,
  embeddedK: 0, // audio track the video element plays by itself
  pickDefault: false, // select the file's default audio track once the source is ready
  ext: null, // AudioStream that is heard instead of the video's own sound
  pendingExt: null, // AudioStream being buffered for a track switch
  names: {}, // user-given track names: stream index -> name
  volume: 1,
  muted: false,
  level: 0, // 0 original file, 1 remuxed, 2 fully re-encoded
  baseLevel: 0, // lowest level this file plays at
  resumeAt: 0,
  inPt: null,
  outPt: null,
  loop: false,
  playSel: false,
  fps: 25,
  token: 0,
  busyJob: null,
  exportJob: null,
  subTracks: new Map(),
  loadedPath: null, // file whose info and position the player currently holds
};

// ---------- utils

function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function recall(key, def) {
  try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; }
}

const p2 = n => String(n).padStart(2, '0');
function split(t) {
  const ms = isFinite(t) ? Math.max(0, Math.round(t * 1000)) : 0;
  return { h: Math.floor(ms / 3600000), m: Math.floor(ms / 60000) % 60, s: Math.floor(ms / 1000) % 60, ms: ms % 1000 };
}
function fmt(t) {
  const { h, m, s } = split(Math.floor(isFinite(t) ? t : 0));
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}
function fmtPrecise(t) {
  const { h, m, s, ms } = split(t);
  return `${h ? h + ':' + p2(m) : m}:${p2(s)}.${String(ms).padStart(3, '0')}`;
}
function parseTime(str) {
  const parts = String(str).trim().replace(',', '.').split(':');
  if (!parts[0] || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some(n => !isFinite(n) || n < 0)) return null;
  return nums.reduce((a, n) => a * 60 + n, 0);
}
function parseRate(r) {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cleanErr = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let jobSeq = 0;
const newJob = () => `job${Date.now()}_${++jobSeq}`;

function duration() {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  return (state.info && parseFloat(state.info.format.duration)) || 0;
}
const currentItem = () => state.playlist[state.current];

function channelsLabel(n) {
  return { 1: 'моно', 2: 'стерео', 6: '5.1', 8: '7.1' }[n] || `${n} кан.`;
}
// Muxers put their own name into handler_name when the track has none; those are not titles
const STOCK_HANDLER = /handler$|^(core media|iso media|gpac|l-smash|mainconcept|apple)/i;

// The name stored in the file itself: `title`, or a handler_name that someone actually set
// (OBS writes its track names there in MP4)
function ownTitle(s) {
  const t = s.tags || {};
  if (t.title) return t.title.trim();
  const h = (t.handler_name || '').trim();
  return h && !STOCK_HANDLER.test(h) ? h : '';
}

let obsTracks = null; // track names from the OBS profile: { profile, names[6], recTracks }

// Name for audio track k when the file has none: one the user set for all files, else OBS's.
// OBS writes only the tracks enabled in RecTracks, so the file's k-th track maps through it.
function presetName(k) {
  const own = recall('defaultNames', {})[k];
  if (own) return own;
  if (!obsTracks || !settings.obsNames) return '';
  const enabled = [1, 2, 3, 4, 5, 6].filter(n => obsTracks.recTracks & (1 << (n - 1)));
  const n = enabled.length === state.audioStreams.length ? enabled[k] : k + 1;
  return obsTracks.names[n - 1] || '';
}

// The name a track goes by: the user's for this file, the file's own, else the preset
function trackName(s, k) {
  return state.names[s.index] || ownTitle(s) || (s.codec_type === 'audio' ? presetName(k) : '');
}

function streamLabel(s, k, original = false) {
  const t = s.tags || {};
  const lang = t.language ? (LANGS[t.language] ?? t.language) : '';
  const custom = !original && state.names[s.index];
  const own = ownTitle(s) || (!original && s.codec_type === 'audio' ? presetName(k) : '');
  const names = custom ? [custom] : [lang, own && own !== lang ? own : ''].filter(Boolean);
  const tech = [s.codec_name && s.codec_name.toUpperCase(), s.channels ? channelsLabel(s.channels) : ''].filter(Boolean).join(', ');
  return `${k + 1}. ${names.join(' — ') || 'Дорожка'}${tech ? ` (${tech})` : ''}`;
}

let osdTimer;
function osd(text) {
  const el = $('#osd');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('show'), 1300);
}

let toastTimer;
function toast(text, actionLabel, action) {
  // The toast goes where it can be seen: the fullscreen player, the library or the player view
  const host = document.fullscreenElement
    || (typeof currentView !== 'undefined' && currentView === 'library' ? $('#view-library') : $('#player'));
  if ($('#toast').parentElement !== host) host.append($('#toast'));
  $('#toast-text').textContent = text;
  const btn = $('#toast-action');
  btn.hidden = !actionLabel;
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.onclick = () => { action(); $('#toast').hidden = true; };
  }
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 7000);
}

function showBusy(text, jobId) {
  state.busyJob = jobId;
  $('#busy-text').textContent = text;
  $('#busy-bar').style.width = '0%';
  $('#busy').hidden = false;
}
function hideBusy() {
  state.busyJob = null;
  $('#busy').hidden = true;
}

api.onProgress(({ jobId, value }) => {
  const pct = Math.round(value * 100) + '%';
  if (jobId === state.busyJob) $('#busy-bar').style.width = pct;
  if (jobId === state.exportJob) {
    $('#ex-bar').style.width = pct;
    $('#ex-status').textContent = 'Сохранение… ' + pct;
  }
});

// ---------- playlist

const SUB_RE = /\.(srt|vtt|ass|ssa)$/i;

// Opening media replaces what was open. Several files (or a folder) become the list ⏮ ⏭ step
// through; a single file brings its folder neighbours along, so ⏮ ⏭ work for it too.
// Subtitle files attach to the video already playing.
async function addFiles(paths) {
  const subs = paths.filter(p => SUB_RE.test(p));
  const seen = new Set();
  const media = paths.filter(p => !SUB_RE.test(p) && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
  if (!media.length) {
    if (subs.length && state.info) loadExternalSub(subs[0]);
    return;
  }
  let list = media;
  let start = 0;
  if (media.length === 1) {
    const around = await api.folderMedia(media[0]).catch(() => []);
    const i = around.findIndex(p => p.toLowerCase() === media[0].toLowerCase());
    if (i >= 0) {
      list = around;
      start = i;
    }
  }
  // Only a list the user opened on purpose (a folder, several files) plays on by itself
  playList(list, start, media.length > 1);
  if (media.length > 1) osd(`Открыто файлов: ${media.length}`);
}

function playList(paths, start, playOn = false) {
  state.playlist = paths.map(p => ({ path: p, name: api.basename(p) }));
  state.playOn = playOn;
  state.current = -1;
  renderPlaylist();
  loadIndex(start);
}

// Only the ⏮ ⏭ buttons depend on the list now
function renderPlaylist() {
  $('#btn-prev').disabled = state.current <= 0;
  $('#btn-next').disabled = state.current < 0 || state.current >= state.playlist.length - 1;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Esc: stop and go back to the start screen
function closeVideo() {
  if (!state.info) return;
  if (document.fullscreenElement) document.exitFullscreen();
  state.playlist = [];
  state.playOn = false;
  state.current = -1;
  unload();
  renderPlaylist();
}

function unload() {
  savePosition();
  state.token++;
  state.info = null;
  state.loadedPath = null;
  dropExt();
  hideBusy();
  disableSubs();
  video.removeAttribute('src');
  video.load();
  document.body.classList.remove('loaded', 'audio-only');
  document.title = 'Tako.player';
  $('#title-file').textContent = '';
  resetTrim();
  updateProgress();
}

// ---------- resume position

const RESUME_MIN = 10; // seconds; positions near the start or the end are not remembered
const RESUME_MAX_FILES = 200;

function savePosition() {
  const file = state.loadedPath;
  if (!file || !state.info) return;
  const t = video.currentTime || 0;
  const all = recall('positions', {});
  delete all[file];
  if (t > RESUME_MIN && duration() - t > RESUME_MIN) all[file] = Math.round(t);
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - RESUME_MAX_FILES))) delete all[k];
  store('positions', all);
}

function savedPosition(file, total) {
  if (!settings.resume) return 0;
  const t = recall('positions', {})[file];
  return t > RESUME_MIN && (!total || total - t > RESUME_MIN) ? t : 0;
}

setInterval(() => { if (!video.paused) savePosition(); }, 5000);
window.addEventListener('beforeunload', savePosition);

// ---------- loading

async function loadIndex(i, startAt = 0) {
  if (i < 0 || i >= state.playlist.length) return;
  savePosition();
  state.loadedPath = null;
  const token = ++state.token;
  state.current = i;
  renderPlaylist();
  const item = currentItem();
  hideBusy();

  let info;
  try {
    info = await api.probe(item.path);
  } catch (e) {
    if (token === state.token) toast(`Не удалось открыть «${item.name}»:\n${cleanErr(e)}`);
    return;
  }
  if (token !== state.token) return;

  state.info = info;
  if (!startAt) {
    startAt = savedPosition(item.path, parseFloat(info.format.duration));
    if (startAt) toast(`Продолжаю с ${fmt(startAt)}`, 'С начала', () => { video.currentTime = 0; });
  }
  state.videoStream = info.streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) || null;
  state.audioStreams = info.streams.filter(s => s.codec_type === 'audio');
  state.subStreams = info.streams.filter(s => s.codec_type === 'subtitle');
  state.fps = (state.videoStream && parseRate(state.videoStream.avg_frame_rate || state.videoStream.r_frame_rate)) || 25;
  state.audioK = 0;
  state.embeddedK = 0;
  state.pickDefault = true;
  dropExt();
  state.names = recall('trackNames', {})[item.path] || {};
  disableSubs();
  state.subTracks = new Map();
  resetTrim();
  fillTracks();

  document.title = `${item.name} — Tako.player`;
  $('#title-file').textContent = item.name;
  document.body.classList.add('loaded');
  document.body.classList.toggle('audio-only', !state.videoStream);
  $('#audio-name').textContent = item.name;

  const v = state.videoStream;
  // Unsupported video needs a converted copy; unsupported audio is streamed separately
  const videoOk = !v || PLAYABLE_VIDEO.includes(v.codec_name);
  state.baseLevel = videoOk ? 0 : 1;
  if (!videoOk) {
    buildPlayable(1, startAt, settings.autoplay);
  } else {
    state.level = 0;
    setSource(item.path, startAt, settings.autoplay);
  }
}

let pendingMeta = null;
function setSource(file, time, play) {
  if (pendingMeta) video.removeEventListener('loadedmetadata', pendingMeta);
  state.resumeAt = time || 0;
  const owner = currentItem().path;
  pendingMeta = () => {
    pendingMeta = null;
    if (time > 0) video.currentTime = time;
    state.loadedPath = owner;
    state.startedAt = performance.now();
    sourceReady();
    video.playbackRate = video.defaultPlaybackRate = Number($('#speed').value);
    if (play) video.play().catch(() => {});
  };
  video.addEventListener('loadedmetadata', pendingMeta);
  video.src = api.toUrl(file);
}

// Asks ffmpeg for a copy of the file Chromium can play (first audio track included) and switches to it
async function buildPlayable(level, time, play) {
  const item = currentItem();
  const token = state.token;
  const jobId = newJob();
  state.level = level;
  showBusy(level >= 2 ? 'Конвертирую файл для воспроизведения…' : 'Подготавливаю воспроизведение…', jobId);
  try {
    const out = await api.playable({ file: item.path, audio: 0, level, jobId });
    if (token !== state.token) return;
    setSource(out, time ?? video.currentTime, play ?? !video.paused);
  } catch (e) {
    if (token !== state.token) return;
    const msg = cleanErr(e);
    if (msg !== 'Отменено') toast('Ошибка: ' + msg);
  } finally {
    if (state.busyJob === jobId) hideBusy();
  }
}

// Runs once a new source has metadata and is positioned. Switching video.audioTracks would
// make Chromium re-seek the whole file, which freezes the picture for seconds on big videos,
// so the video keeps the track it picked and other tracks play from a separate AudioStream.
function sourceReady() {
  const tracks = video.audioTracks;
  let k = 0;
  if (state.level === 0 && tracks && tracks.length === state.audioStreams.length) {
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].enabled) { k = i; break; }
    }
  }
  state.embeddedK = k;
  if (state.pickDefault) {
    state.pickDefault = false;
    state.audioK = k;
    $('#audio-select').value = k;
  }
  if (state.audioStreams.length) routeAudio(state.audioK);
}

video.addEventListener('loadedmetadata', () => {
  syncExt(true);
  renderSelection();
  updateProgress();
});

video.addEventListener('error', () => {
  if (!video.getAttribute('src') || !state.info) return;
  const t = video.currentTime > 0 ? video.currentTime : state.resumeAt;
  if (state.level >= 2) {
    toast('Не удалось воспроизвести этот файл.');
    return;
  }
  state.baseLevel = state.level + 1;
  buildPlayable(state.level + 1, t, true);
});

// ---------- tracks

function fillTracks() {
  const a = $('#audio-select');
  a.innerHTML = '';
  state.audioStreams.forEach((s, k) => a.add(new Option(streamLabel(s, k), k)));
  if (!state.audioStreams.length) a.add(new Option('Нет звука', ''));
  a.value = state.audioK;
  a.disabled = state.audioStreams.length < 2;

  const sub = $('#sub-select');
  sub.innerHTML = '';
  sub.add(new Option('Выкл', 'off'));
  state.subStreams.forEach((s, k) => {
    const o = new Option(streamLabel(s, k), 's' + k);
    if (!['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(s.codec_name)) {
      o.disabled = true;
      o.text += ' — графические, не поддерживаются';
    }
    sub.add(o);
  });
  sub.add(new Option('Загрузить из файла…', 'file'));
  sub.value = 'off';
}

function selectAudio(k) {
  if (!state.info || k === state.audioK || k < 0 || k >= state.audioStreams.length) return;
  state.pickDefault = false;
  const prevK = state.audioK;
  state.audioK = k;
  $('#audio-select').value = k;
  osd('Аудио: ' + streamLabel(state.audioStreams[k], k));
  routeAudio(k, prevK);
}

// ---------- separate audio track playback
//
// Tracks Chromium can't switch to (or can't decode) are played by a hidden <audio> fed
// through Media Source Extensions with AAC that ffmpeg streams from the current position.
// The video keeps playing muted and the audio element is kept in sync with it.

const feeds = new Map(); // feed id -> AudioStream

class AudioStream {
  constructor(file, index, k) {
    this.file = file;
    this.index = index;
    this.k = k;
    this.id = null;
    this.queue = [];
    this.finished = false;
    this.waitingAck = false;
    this.failed = null;
    this.dead = false;
    this.sb = null;
    this.el = new Audio();
    this.ms = new MediaSource();
    this.url = URL.createObjectURL(this.ms);
    this.el.src = this.url;
    this.opened = new Promise(resolve => {
      this.ms.addEventListener('sourceopen', () => {
        if (!this.sb) {
          this.sb = this.ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
          this.sb.addEventListener('updateend', () => this.pump());
        }
        resolve();
      });
    });
  }

  idle() {
    return new Promise(r => (this.sb.updating ? this.sb.addEventListener('updateend', r, { once: true }) : r()));
  }

  async start(pos) {
    this.stopFeed();
    const id = newJob();
    this.id = id;
    this.queue = [];
    this.finished = false;
    await this.opened;
    await this.idle();
    if (this.dead || this.id !== id) return;
    if (this.sb.buffered.length) {
      this.sb.remove(0, Infinity);
      await this.idle();
      if (this.dead || this.id !== id) return;
    }
    this.sb.timestampOffset = pos;
    feeds.set(id, this);
    api.astreamStart({ id, file: this.file, index: this.index, start: pos });
  }

  stopFeed() {
    if (this.id) {
      feeds.delete(this.id);
      api.astreamStop(this.id);
    }
    this.waitingAck = false;
  }

  onData(msg) {
    if (msg.id !== this.id || this.dead) return;
    if (msg.chunk) {
      this.queue.push(msg.chunk);
      this.waitingAck = true;
    }
    if (msg.done) {
      feeds.delete(msg.id);
      this.finished = true;
      if (msg.error) this.failed = msg.error;
    }
    this.pump();
  }

  pump() {
    if (this.dead || !this.sb || this.sb.updating) return;
    if (this.queue.length) {
      try {
        this.sb.appendBuffer(this.queue[0]);
        this.queue.shift();
      } catch (e) {
        if (e.name === 'QuotaExceededError') this.trim(3);
        else this.failed = e.message;
      }
      return;
    }
    if (this.finished && this.ms.readyState === 'open') {
      try { this.ms.endOfStream(); } catch {}
    }
    this.maybeAck();
  }

  // seconds of audio buffered from t onwards
  ahead(t) {
    if (!this.sb) return 0;
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.1 && b.end(i) > t) return b.end(i) - t;
    }
    return 0;
  }

  covers(t) {
    const a = this.ahead(t);
    return a > 0.4 || (this.finished && a > 0);
  }

  maybeAck() {
    if (this.waitingAck && !this.queue.length && this.sb && !this.sb.updating && this.ahead(video.currentTime) < 30) {
      this.waitingAck = false;
      api.astreamAck(this.id);
    }
  }

  trim(keep = 15) {
    if (!this.sb || this.sb.updating) return;
    const b = this.sb.buffered;
    const t = video.currentTime;
    if (b.length && b.start(0) < t - keep - 5) this.sb.remove(0, t - keep);
  }

  maintain() {
    this.trim();
    this.maybeAck();
  }

  destroy() {
    this.dead = true;
    this.stopFeed();
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    URL.revokeObjectURL(this.url);
  }
}

api.onAstream(msg => {
  const s = feeds.get(msg.id);
  if (s) s.onData(msg);
});

// Whether track k is the one the video element plays itself, in a codec it can decode
function embeddedOk(k) {
  const a = state.audioStreams[k];
  return k === state.embeddedK && (state.level >= 1 || !a || PLAYABLE_AUDIO.includes(a.codec_name));
}

function dropExt() {
  if (state.pendingExt) state.pendingExt.destroy();
  if (state.ext) state.ext.destroy();
  state.pendingExt = state.ext = null;
  applyVolume();
}

function routeAudio(k, prevK = k) {
  if (state.pendingExt) {
    state.pendingExt.destroy();
    state.pendingExt = null;
  }
  if (embeddedOk(k)) {
    dropExt();
    return;
  }
  if (state.ext && state.ext.k === k) return;
  // The current sound keeps playing until the new track has buffered
  const s = new AudioStream(currentItem().path, state.audioStreams[k].index, k);
  s.prevK = prevK;
  state.pendingExt = s;
  applyVolume();
  s.start(video.currentTime);
}

function syncExt(hard) {
  const s = state.ext;
  if (!s) return;
  const el = s.el;
  const vt = video.currentTime;
  const playing = !video.paused && !video.seeking && video.readyState >= 3;
  if (!playing || !s.covers(vt)) {
    if (!el.paused) el.pause();
    if ((hard || Math.abs(el.currentTime - vt) > 0.05) && s.ahead(vt) > 0) el.currentTime = vt;
    return;
  }
  const drift = el.currentTime - vt;
  if (hard || el.paused || Math.abs(drift) > 0.25) {
    el.currentTime = vt;
    el.playbackRate = video.playbackRate;
  } else if (Math.abs(drift) > 0.04) {
    el.playbackRate = video.playbackRate * (drift > 0 ? 0.97 : 1.03);
  } else {
    el.playbackRate = video.playbackRate;
  }
  if (el.paused) el.play().catch(() => {});
}

function audioTick() {
  const p = state.pendingExt;
  if (p) {
    if (p.failed) {
      toast('Не удалось включить дорожку: ' + p.failed);
      p.destroy();
      state.pendingExt = null;
      state.audioK = p.prevK;
      $('#audio-select').value = state.audioK;
    } else if (p.covers(video.currentTime)) {
      const old = state.ext;
      state.ext = p;
      state.pendingExt = null;
      applyVolume();
      syncExt(true);
      if (old) old.destroy();
    } else {
      p.maintain();
    }
  }
  const s = state.ext;
  if (s && s.failed) {
    toast('Ошибка звуковой дорожки: ' + s.failed);
    dropExt();
  } else if (s) {
    syncExt(false);
    s.maintain();
  }
}
setInterval(audioTick, 200);

// After a jump outside what is buffered, restart the feed from the new position
video.addEventListener('seeking', () => {
  const t = video.currentTime;
  for (const s of [state.ext, state.pendingExt]) {
    if (s && !s.covers(t)) s.start(t);
  }
  syncExt();
});
video.addEventListener('waiting', () => syncExt());
video.addEventListener('pause', () => syncExt());
video.addEventListener('playing', () => syncExt(true));
video.addEventListener('ratechange', () => syncExt());

// ---------- track names

function refreshTrackLabels() {
  for (const o of $('#audio-select').options) {
    const k = Number(o.value);
    if (state.audioStreams[k]) o.text = streamLabel(state.audioStreams[k], k);
  }
  for (const o of $('#sub-select').options) {
    if (!/^s\d+$/.test(o.value)) continue;
    const k = Number(o.value.slice(1));
    const s = state.subStreams[k];
    o.text = streamLabel(s, k) + (o.disabled ? ' — графические, не поддерживаются' : '');
  }
}

function nameRow(s, k, kind) {
  const row = document.createElement('label');
  row.className = 'name-row';
  const cap = document.createElement('span');
  cap.textContent = `${kind} ${streamLabel(s, k, true)}`;
  const input = document.createElement('input');
  input.dataset.index = s.index;
  input.dataset.k = k;
  input.dataset.kind = s.codec_type;
  const preset = s.codec_type === 'audio' ? presetName(k) : '';
  input.value = state.names[s.index] || '';
  input.placeholder = ownTitle(s) || preset ? `Сейчас: ${ownTitle(s) || preset}` : 'Например: Игра, Микрофон, Дискорд…';
  input.spellcheck = false;
  row.append(cap, input);
  return row;
}

function openNames() {
  if (!state.info) return;
  const list = $('#names-list');
  list.innerHTML = '';
  const section = (title, streams, kind) => {
    if (!streams.length) return;
    const h = document.createElement('h3');
    h.textContent = title;
    list.append(h);
    streams.forEach((s, k) => list.append(nameRow(s, k, kind)));
  };
  section('Аудиодорожки', state.audioStreams, 'Аудио');
  section('Субтитры', state.subStreams, 'Субтитры');
  if (!state.audioStreams.length && !state.subStreams.length) list.textContent = 'В файле нет аудиодорожек и субтитров.';
  $('#names-all-row').hidden = !state.audioStreams.length;
  $('#names-all').checked = !!recall('namesForAll', false);
  video.pause();
  $('#names-dlg').showModal();
  const first = list.querySelector('input');
  if (first) first.focus();
}

function saveNames() {
  const names = {};
  // "For all files": audio names become defaults by track number instead of belonging to this file
  const forAll = $('#names-all').checked && !$('#names-all-row').hidden;
  store('namesForAll', forAll);
  const defaults = recall('defaultNames', {});
  for (const input of $('#names-list').querySelectorAll('input')) {
    const v = input.value.trim();
    if (forAll && input.dataset.kind === 'audio') {
      if (v) defaults[input.dataset.k] = v;
      else delete defaults[input.dataset.k];
    } else if (v) {
      names[input.dataset.index] = v;
    }
  }
  if (forAll) store('defaultNames', defaults);
  state.names = names;
  const all = recall('trackNames', {});
  if (Object.keys(names).length) all[currentItem().path] = names;
  else delete all[currentItem().path];
  store('trackNames', all);
  refreshTrackLabels();
  $('#names-dlg').close();
}

$('#names-save').addEventListener('click', saveNames);
$('#names-reset').addEventListener('click', () => {
  for (const input of $('#names-list').querySelectorAll('input')) input.value = '';
});
$('#names-list').addEventListener('keydown', e => { if (e.key === 'Enter') saveNames(); });

function disableSubs() {
  for (const t of video.textTracks) t.mode = 'disabled';
}

function parseVtt(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->').map(s => parseTime(s.trim().split(/\s+/)[0]));
    const body = lines.slice(i + 1).join('\n').trim();
    if (a != null && z != null && body) cues.push(new VTTCue(a, z, body));
  }
  return cues;
}

async function activateSub(key, label, loader) {
  disableSubs();
  const token = state.token;
  let tt = state.subTracks.get(key);
  if (!tt) {
    osd('Загрузка субтитров…');
    let vtt;
    try {
      vtt = await loader();
    } catch (e) {
      toast('Не удалось загрузить субтитры: ' + cleanErr(e));
      $('#sub-select').value = 'off';
      return;
    }
    if (token !== state.token) return;
    tt = video.addTextTrack('subtitles', label);
    for (const c of parseVtt(vtt)) tt.addCue(c);
    state.subTracks.set(key, tt);
  }
  disableSubs();
  tt.mode = 'showing';
  osd('Субтитры: ' + label);
}

async function selectSub(val) {
  const sel = $('#sub-select');
  if (val === 'off') {
    disableSubs();
    osd('Субтитры выключены');
    return;
  }
  if (val === 'file') {
    const p = await api.pickSubtitle();
    if (!p) {
      sel.value = 'off';
      disableSubs();
      return;
    }
    return loadExternalSub(p);
  }
  if (val.startsWith('x:')) {
    const p = val.slice(2);
    return activateSub(val, api.basename(p), () => api.loadSubtitle(p));
  }
  const k = Number(val.slice(1));
  const s = state.subStreams[k];
  return activateSub(val, streamLabel(s, k), () => api.subtitle({ file: currentItem().path, index: s.index }));
}

function loadExternalSub(p) {
  const sel = $('#sub-select');
  const val = 'x:' + p;
  if (![...sel.options].some(o => o.value === val)) {
    sel.add(new Option(api.basename(p), val), sel.options[sel.options.length - 1]);
  }
  sel.value = val;
  return selectSub(val);
}

function cycleSub() {
  const sel = $('#sub-select');
  const opts = [...sel.options].filter(o => !o.disabled && o.value !== 'file');
  if (opts.length < 2) return;
  const i = opts.findIndex(o => o.value === sel.value);
  sel.value = opts[(i + 1) % opts.length].value;
  selectSub(sel.value);
}

// ---------- transport

function togglePlay() {
  if (!state.info) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function seekBy(dt) {
  if (!state.info) return;
  video.currentTime = clamp(video.currentTime + dt, 0, duration());
  updateProgress();
}

function stepFrame(dir) {
  if (!state.info) return;
  video.pause();
  seekBy(dir / state.fps);
  osd(fmtPrecise(video.currentTime));
}

function setSpeed(v) {
  video.playbackRate = video.defaultPlaybackRate = v;
  $('#speed').value = String(v);
  osd(`Скорость ${v}×`);
}

function changeSpeed(dir) {
  const i = SPEEDS.indexOf(Number($('#speed').value));
  setSpeed(SPEEDS[clamp(i + dir, 0, SPEEDS.length - 1)]);
}

// Sound comes either from the video itself or from a separate AudioStream
// Volume goes up to 200%. Above 100% the sound runs through a Web Audio gain, which is set up
// only the first time it is needed; until then the elements play their sound directly.
const MAX_VOLUME = 2;
const boost = { ctx: null, gain: null, wired: new WeakSet() };

function boostWire(el) {
  if (!boost.ctx || boost.wired.has(el)) return;
  boost.ctx.createMediaElementSource(el).connect(boost.gain);
  boost.wired.add(el);
}

function applyVolume() {
  const { volume, muted } = state;
  if (volume > 1 && !boost.ctx) {
    boost.ctx = new AudioContext();
    boost.gain = boost.ctx.createGain();
    boost.gain.connect(boost.ctx.destination);
  }
  const els = [video, ...[state.ext, state.pendingExt].filter(Boolean).map(s => s.el)];
  if (boost.ctx) {
    els.forEach(boostWire);
    boost.gain.gain.value = volume;
    if (boost.ctx.state === 'suspended') boost.ctx.resume();
  }
  const elVolume = boost.ctx ? 1 : volume;
  video.volume = elVolume;
  video.muted = state.ext ? true : muted;
  for (const s of [state.ext, state.pendingExt]) {
    if (!s) continue;
    s.el.volume = elVolume;
    s.el.muted = muted;
  }
  $('#volume').value = muted ? 0 : volume;
  $('#volume').style.setProperty('--fill', (muted ? 0 : volume) / MAX_VOLUME * 100 + '%');
  $('#volume').classList.toggle('boost', !muted && volume > 1);
  $('#mute-icon').setAttribute('href', muted || volume === 0 ? '#i-mute' : '#i-vol');
  store('volume', volume);
  store('muted', muted);
}

function setVolume(v) {
  state.volume = clamp(Math.round(v * 100) / 100, 0, MAX_VOLUME);
  state.muted = false;
  applyVolume();
}

function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
  osd(state.muted ? 'Без звука' : 'Звук включён');
}

function changeVolume(dv) {
  setVolume(state.volume + dv);
  osd(`Громкость ${Math.round(state.volume * 100)}%`);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#player').requestFullscreen().catch(() => {});
}

let prevT = 0;
function tick() {
  const t = video.currentTime;
  const r = selRange();
  if (r && (state.loop || state.playSel) && prevT < r[1] && t >= r[1] && prevT >= r[0] - 0.05) {
    if (state.loop) {
      video.currentTime = r[0];
    } else {
      video.pause();
      video.currentTime = r[1];
      state.playSel = false;
    }
  }
  prevT = video.currentTime;
  updateProgress();
  if (!video.paused) requestAnimationFrame(tick);
}

video.addEventListener('play', () => {
  $('#play-icon').setAttribute('href', '#i-pause');
  prevT = video.currentTime;
  requestAnimationFrame(tick);
});
video.addEventListener('pause', () => {
  $('#play-icon').setAttribute('href', '#i-play');
  poke();
  savePosition();
});
video.addEventListener('seeked', () => { prevT = video.currentTime; updateProgress(); });
video.addEventListener('timeupdate', () => { if (video.paused) updateProgress(); });
video.addEventListener('ended', () => {
  if (state.loop) {
    const r = selRange();
    video.currentTime = r ? r[0] : 0;
    video.play();
  } else if (settings.autoNext && state.playOn && state.current < state.playlist.length - 1
    && performance.now() - state.startedAt > 3000) {
    // The time check stops a run of broken or empty files from flipping through by itself
    loadIndex(state.current + 1);
  }
});

function updateProgress() {
  const d = duration();
  const t = video.currentTime || 0;
  const pct = d ? clamp(t / d * 100, 0, 100) : 0;
  $('#played').style.width = pct + '%';
  $('#handle').style.left = pct + '%';
  $('#strip-head').style.left = pct + '%';
  const f = state.precise ? fmtPrecise : fmt;
  $('#time').textContent = state.info ? `${f(t)} / ${fmt(d)}` : '0:00 / 0:00';
}

// ---------- trimming

function selRange() {
  if (state.inPt == null && state.outPt == null) return null;
  return [state.inPt ?? 0, state.outPt ?? duration()];
}

function resetTrim() {
  state.inPt = state.outPt = null;
  state.playSel = false;
  renderSelection();
}

function setIn(t) {
  if (!state.info) return;
  t = clamp(t, 0, duration());
  if (state.outPt != null && t >= state.outPt) state.outPt = null;
  state.inPt = t;
  renderSelection();
}

function setOut(t) {
  if (!state.info) return;
  t = clamp(t, 0, duration());
  if (state.inPt != null && t <= state.inPt) state.inPt = null;
  state.outPt = t;
  renderSelection();
}

function renderSelection() {
  const d = duration();
  const r = selRange();
  const sel = $('#sel');
  sel.hidden = !r || !d;
  if (r && d) {
    sel.style.left = r[0] / d * 100 + '%';
    sel.style.width = (r[1] - r[0]) / d * 100 + '%';
  }
  const mi = $('#mark-in');
  const mo = $('#mark-out');
  mi.hidden = state.inPt == null || !d;
  mo.hidden = state.outPt == null || !d;
  if (d) {
    mi.style.left = (state.inPt ?? 0) / d * 100 + '%';
    mo.style.left = (state.outPt ?? 0) / d * 100 + '%';
  }
  $('#in-time').value = state.inPt == null ? '' : fmtPrecise(state.inPt);
  $('#out-time').value = state.outPt == null ? '' : fmtPrecise(state.outPt);
  $('#sel-len').textContent = r ? 'длина ' + fmtPrecise(r[1] - r[0]) : '';
  if (r) setTrimOpen(true);
  renderStrip();
}

function playSelection() {
  const r = selRange();
  if (!r) {
    osd('Сначала отметьте начало (I) и/или конец (O)');
    return;
  }
  state.playSel = true;
  video.currentTime = r[0];
  prevT = r[0];
  video.play().catch(() => {});
}

function toggleLoop() {
  state.loop = !state.loop;
  $('#btn-loop').classList.toggle('active', state.loop);
  osd(state.loop ? (selRange() ? 'Повтор фрагмента' : 'Повтор файла') : 'Повтор выключен');
}

function bindTimeInput(el, setter) {
  el.addEventListener('change', () => {
    if (el.value.trim() === '') {
      if (el.id === 'in-time') state.inPt = null; else state.outPt = null;
      renderSelection();
      return;
    }
    const t = parseTime(el.value);
    if (t == null) renderSelection();
    else setter(t);
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') el.blur();
  });
}
bindTimeInput($('#in-time'), setIn);
bindTimeInput($('#out-time'), setOut);

// ---------- timeline

const bar = $('#timeline');
function timeAt(e) {
  const r = bar.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * duration();
}

bar.addEventListener('pointerdown', e => {
  if (!state.info || e.button !== 0) return;
  const flag = e.target.closest('.flag');
  const which = flag && flag.dataset.which;
  bar.setPointerCapture(e.pointerId);
  const move = ev => {
    let t = timeAt(ev);
    if (which === 'in') {
      t = Math.min(t, (state.outPt ?? Infinity) - 0.05);
      setIn(t);
    } else if (which === 'out') {
      t = Math.max(t, (state.inPt ?? -Infinity) + 0.05);
      setOut(t);
    }
    video.currentTime = t;
    updateProgress();
  };
  if (!which) move(e);
  const up = () => {
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
});

// ---------- screenshot & info

async function screenshot() {
  if (!state.info || !state.videoStream) return;
  const wasPlaying = !video.paused;
  video.pause();
  try {
    const p = await api.screenshot({ file: currentItem().path, time: video.currentTime });
    if (p) toast('Кадр сохранён', 'Показать в папке', () => api.reveal(p));
  } catch (e) {
    toast('Не удалось сохранить кадр: ' + cleanErr(e));
  }
  if (wasPlaying) video.play().catch(() => {});
}

function infoTable(rows) {
  const table = document.createElement('table');
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  return table;
}

function showInfo() {
  if (!state.info) return;
  const { format, streams } = state.info;
  const body = $('#info-body');
  body.innerHTML = '';
  const size = Number(format.size);
  body.append(infoTable([
    ['Файл', currentItem().path],
    ['Контейнер', format.format_long_name],
    ['Длительность', fmtPrecise(parseFloat(format.duration))],
    ['Размер', size ? (size / 1048576).toFixed(1) + ' МБ' : ''],
    ['Битрейт', format.bit_rate ? Math.round(format.bit_rate / 1000) + ' кбит/с' : ''],
    ['Воспроизведение', ['исходный файл', 'через перепаковку', 'через конвертацию'][state.level]],
  ]));
  const kinds = { video: 'Видео', audio: 'Аудио', subtitle: 'Субтитры', attachment: 'Вложение', data: 'Данные' };
  for (const s of streams) {
    const h = document.createElement('h3');
    h.textContent = `#${s.index} ${kinds[s.codec_type] || s.codec_type}`;
    const t = s.tags || {};
    body.append(h, infoTable([
      ['Кодек', s.codec_long_name || s.codec_name],
      ['Язык', t.language],
      ['Название в файле', ownTitle(s)],
      ['Ваша подпись', state.names[s.index]],
      ['Разрешение', s.width ? `${s.width}×${s.height}` : ''],
      ['Частота кадров', s.codec_type === 'video' ? parseRate(s.avg_frame_rate).toFixed(3).replace(/\.?0+$/, '') + ' к/с' : ''],
      ['Каналы', s.channels ? channelsLabel(s.channels) : ''],
      ['Дискретизация', s.sample_rate ? s.sample_rate + ' Гц' : ''],
      ['Битрейт', s.bit_rate ? Math.round(s.bit_rate / 1000) + ' кбит/с' : ''],
    ]));
  }
  $('#info-dlg').showModal();
}

// ---------- export

const exDlg = $('#export-dlg');

function checkbox(label, value, checked) {
  const l = document.createElement('label');
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.value = value;
  c.checked = checked;
  l.append(c, ' ' + label);
  return l;
}

// An audio track in the export dialog: a checkbox, and a loudness slider used when mixing
function audioRow(s, k) {
  const row = document.createElement('div');
  row.className = 'ex-track';
  const box = checkbox('Аудио ' + streamLabel(s, k), s.index, k === state.audioK);
  const vol = document.createElement('span');
  vol.className = 'ex-vol';
  vol.title = 'Громкость дорожки в смеси';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = 0;
  range.max = 2;
  range.step = 0.05;
  range.value = 1;
  range.dataset.index = s.index;
  const val = document.createElement('b');
  const show = () => {
    val.textContent = Math.round(range.value * 100) + '%';
    range.style.setProperty('--fill', range.value / 2 * 100 + '%');
  };
  range.oninput = show;
  range.ondblclick = () => { range.value = 1; show(); };
  show();
  vol.append(range, val);
  row.append(box, vol);
  return row;
}

function openExport() {
  if (!state.info || state.exportJob) return;
  video.pause();
  const r = selRange();
  $('#ex-range-sel').disabled = !r;
  $('#ex-range-sel-text').textContent = r
    ? `Выделенный фрагмент: ${fmtPrecise(r[0])} — ${fmtPrecise(r[1])}`
    : 'Выделенный фрагмент (не отмечен — используйте I и O)';
  (r ? $('#ex-range-sel') : $('#ex-range-all')).checked = true;

  const ext = currentItem().path.split('.').pop().toLowerCase();
  const fmtSel = $('#ex-format');
  if ([...fmtSel.options].some(o => o.value === ext)) fmtSel.value = ext;
  else fmtSel.value = state.videoStream ? 'mp4' : 'mp3';

  const audio = $('#ex-audio');
  audio.innerHTML = '';
  state.audioStreams.forEach((s, k) => audio.append(audioRow(s, k)));
  const subs = $('#ex-subs');
  subs.innerHTML = '';
  state.subStreams.forEach((s, k) => subs.append(checkbox('Субтитры ' + streamLabel(s, k), s.index, false)));

  $('#ex-video').checked = !!state.videoStream;
  $('#ex-mix').checked = false;
  $('#ex-quality').value = recall('exQuality', 'crf:22');
  if (!$('#ex-quality').value) $('#ex-quality').value = 'crf:22';
  $('#ex-vbr').value = recall('exVbr', '');
  $('#ex-abr').value = recall('exAbr', '');
  if ($('#ex-abr').selectedIndex < 0) $('#ex-abr').value = '';
  $('#ex-progress').hidden = true;
  $('#ex-go').disabled = false;
  $('#ex-cancel').textContent = 'Отмена';
  updateExportForm();
  exDlg.showModal();
}

function updateExportForm() {
  const format = $('#ex-format').value;
  const audioOnly = AUDIO_FORMATS.includes(format);
  const encode = document.querySelector('input[name=ex-mode]:checked').value === 'encode';
  $('#ex-video').disabled = audioOnly || !state.videoStream;
  $('#ex-video-row').style.opacity = $('#ex-video').disabled ? 0.45 : 1;
  const subsOk = format === 'mkv';
  $('#ex-subs').classList.toggle('disabled', !subsOk);
  for (const c of $('#ex-subs').querySelectorAll('input')) c.disabled = !subsOk;
  const audioChecked = $('#ex-audio').querySelectorAll('input:checked').length;
  $('#ex-mix-row').hidden = audioChecked < 2;
  const mix = audioChecked > 1 && $('#ex-mix').checked;
  // Loudness sliders matter only for tracks going into the mix
  for (const row of $('#ex-audio').children) {
    row.querySelector('.ex-vol').hidden = !mix || !row.querySelector('input[type=checkbox]').checked;
  }
  updateBitrateForm({ format, audioOnly, encode, mix, audioTracks: mix || audioOnly ? Math.min(1, audioChecked) : audioChecked });
  const notes = [];
  if (audioOnly && !mix) notes.push('В аудиофайл попадёт только первая отмеченная аудиодорожка.');
  if (!subsOk && state.subStreams.length) notes.push('Субтитры сохраняются только в MKV.');
  $('#ex-note').textContent = notes.join(' ');
}

function streamKbps(s) {
  if (!s) return 0;
  const t = s.tags || {};
  const bps = Number(s.bit_rate) || Number(t.BPS || t['BPS-eng']);
  return bps ? Math.round(bps / 1000) : 0;
}

function exportVideoKbps() {
  const q = $('#ex-quality').value;
  if (q.startsWith('br:')) return Number(q.slice(3));
  if (q === 'custom') return Math.round(Number($('#ex-vbr').value)) || 0;
  return 0;
}

// Bitrate rows show only for streams that actually get encoded
function updateBitrateForm({ format, audioOnly, encode, mix, audioTracks }) {
  const withVideo = !audioOnly && $('#ex-video').checked && !!state.videoStream;
  const showVideo = encode && withVideo;
  const showAudio = audioTracks > 0 && !['wav', 'flac'].includes(format) && (audioOnly || encode || mix);
  $('#ex-quality-row').hidden = !showVideo;
  $('#ex-vbr-wrap').hidden = $('#ex-quality').value !== 'custom';
  $('#ex-abr-row').hidden = !showAudio;
  $('#ex-bitrate').hidden = !showVideo && !showAudio;

  const src = [];
  const vk = streamKbps(state.videoStream);
  if (showVideo && vk) src.push(`видео ~${vk} кбит/с`);
  const firstAudio = $('#ex-audio').querySelector('input:checked');
  const ak = firstAudio && streamKbps(state.audioStreams.find(s => s.index === Number(firstAudio.value)));
  if (showAudio && ak) src.push(`звук ~${ak} кбит/с`);

  const vkbps = showVideo ? exportVideoKbps() : 0;
  let size = '';
  if ((showVideo && vkbps) || (audioOnly && showAudio)) {
    const r = $('#ex-range-sel').checked ? selRange() : null;
    const len = r ? r[1] - r[0] : duration();
    const akbps = Number($('#ex-abr').value) || 192;
    const mb = (vkbps + akbps * audioTracks) * len / 8 / 1024;
    size = `Примерный размер: ${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ`;
  }
  $('#ex-bitrate-note').textContent = [src.length ? 'Исходный файл: ' + src.join(', ') : '', size].filter(Boolean).join(' · ');
}

$('#ex-quality').addEventListener('change', () => {
  store('exQuality', $('#ex-quality').value);
  updateExportForm();
  if ($('#ex-quality').value === 'custom') $('#ex-vbr').focus();
});
$('#ex-vbr').addEventListener('input', () => { store('exVbr', $('#ex-vbr').value); updateExportForm(); });
$('#ex-abr').addEventListener('change', () => { store('exAbr', $('#ex-abr').value); updateExportForm(); });
$('#ex-video').addEventListener('change', updateExportForm);
for (const r of document.querySelectorAll('input[name=ex-range]')) r.addEventListener('change', updateExportForm);
$('#ex-format').addEventListener('change', updateExportForm);
$('#ex-audio').addEventListener('change', updateExportForm);
$('#ex-mix').addEventListener('change', updateExportForm);
for (const r of document.querySelectorAll('input[name=ex-mode]')) r.addEventListener('change', updateExportForm);

async function doExport() {
  const item = currentItem();
  const format = $('#ex-format').value;
  const audioOnly = AUDIO_FORMATS.includes(format);
  const checked = sel => [...document.querySelectorAll(sel + ' input:checked')].map(c => Number(c.value));
  const audio = checked('#ex-audio');
  const subs = format === 'mkv' ? checked('#ex-subs') : [];
  const withVideo = !audioOnly && $('#ex-video').checked && !!state.videoStream;
  if (!audio.length && (audioOnly || !withVideo)) {
    $('#ex-progress').hidden = false;
    $('#ex-status').textContent = 'Отметьте хотя бы одну дорожку.';
    return;
  }
  const vbitrate = $('#ex-quality-row').hidden ? 0 : exportVideoKbps();
  if (!$('#ex-quality-row').hidden && $('#ex-quality').value === 'custom' && !(vbitrate >= 100 && vbitrate <= 200000)) {
    $('#ex-progress').hidden = false;
    $('#ex-status').textContent = 'Укажите битрейт видео от 100 до 200000 кбит/с.';
    $('#ex-vbr').focus();
    return;
  }
  const abitrate = $('#ex-abr-row').hidden ? 0 : Number($('#ex-abr').value) || 0;
  const quality = $('#ex-quality').value;
  const mix = audio.length > 1 && $('#ex-mix').checked;
  const volumes = Object.fromEntries([...document.querySelectorAll('#ex-audio .ex-vol input')].map(r => [r.dataset.index, Number(r.value)]));
  // Title of the mixed track: the short names of its parts, e.g. "Дубляж + Оригинал"
  const mixTitle = mix ? audio.map(i => {
    const k = state.audioStreams.findIndex(s => s.index === i);
    const t = state.audioStreams[k].tags || {};
    return trackName(state.audioStreams[k], k) || (t.language && LANGS[t.language]) || t.language || `Дорожка ${k + 1}`;
  }).join(' + ') : null;
  const r = $('#ex-range-sel').checked ? selRange() : null;
  const out = await api.saveDialog({ source: item.path, ext: format });
  if (!out) return;

  const jobId = newJob();
  state.exportJob = jobId;
  $('#ex-progress').hidden = false;
  $('#ex-bar').style.width = '0%';
  $('#ex-status').textContent = 'Сохранение…';
  $('#ex-go').disabled = true;
  try {
    await api.exportClip({
      jobId,
      file: item.path,
      out,
      start: r ? r[0] : 0,
      end: r ? r[1] : null,
      format,
      mode: document.querySelector('input[name=ex-mode]:checked').value,
      crf: quality.startsWith('crf:') ? Number(quality.slice(4)) : 22,
      vbitrate,
      abitrate,
      video: withVideo,
      audio,
      subs,
      mix,
      mixTitle,
      volumes,
      titles: Object.fromEntries([...state.audioStreams.map((s, k) => [s.index, trackName(s, k)]), ...Object.entries(state.names)].filter(([, v]) => v)),
    });
    exDlg.close();
    toast('Сохранено: ' + api.basename(out), 'Показать в папке', () => api.reveal(out));
  } catch (e) {
    const msg = cleanErr(e);
    $('#ex-status').textContent = msg === 'Отменено' ? 'Отменено.' : 'Ошибка: ' + msg;
    $('#ex-go').disabled = false;
  } finally {
    state.exportJob = null;
  }
}

$('#ex-go').addEventListener('click', doExport);
$('#ex-cancel').addEventListener('click', () => {
  if (state.exportJob) api.cancel(state.exportJob);
  else exDlg.close();
});
exDlg.addEventListener('cancel', e => { if (state.exportJob) e.preventDefault(); });

for (const b of document.querySelectorAll('.close-dlg')) b.addEventListener('click', () => b.closest('dialog').close());

// ---------- UI wiring

async function openFiles() {
  const paths = await api.openFiles();
  if (paths.length) addFiles(paths);
}

async function openFolder() {
  const paths = await api.openFolder();
  if (!paths) return;
  if (paths.length) addFiles(paths);
  else toast('В этой папке нет видео и музыки.');
}

$('#btn-open').onclick = openFiles;
$('#btn-open-big').onclick = openFiles;
$('#btn-open-folder-big').onclick = openFolder;
$('#btn-play').onclick = togglePlay;
$('#btn-prev').onclick = () => loadIndex(state.current - 1);
$('#btn-next').onclick = () => loadIndex(state.current + 1);
$('#btn-back').onclick = () => seekBy(-settings.seekStep);
$('#btn-fwd').onclick = () => seekBy(settings.seekStep);
// Clicking the time switches to milliseconds and back
$('#time').onclick = () => {
  state.precise = !state.precise;
  store('timePrecise', state.precise);
  updateProgress();
};
$('#btn-frame-back').onclick = () => stepFrame(-1);
$('#btn-frame-fwd').onclick = () => stepFrame(1);
$('#btn-mute').onclick = toggleMute;
$('#btn-names').onclick = openNames;
$('#btn-shot').onclick = screenshot;
$('#btn-info').onclick = showInfo;
$('#btn-help').onclick = () => $('#help-dlg').showModal();
$('#btn-full').onclick = toggleFullscreen;
$('#btn-play-sel').onclick = playSelection;
$('#btn-loop').onclick = toggleLoop;
$('#btn-export').onclick = openExport;
$('#busy-cancel').onclick = () => { if (state.busyJob) api.cancel(state.busyJob); };

$('#audio-select').addEventListener('change', e => { selectAudio(Number(e.target.value)); e.target.blur(); });
$('#sub-select').addEventListener('change', e => { selectSub(e.target.value); e.target.blur(); });
$('#speed').addEventListener('change', e => { setSpeed(Number(e.target.value)); e.target.blur(); });
$('#volume').addEventListener('input', e => setVolume(Number(e.target.value)));
$('#volume').addEventListener('change', e => e.target.blur());

// Buttons keep focus after a click, which would make Space press them again
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && !b.closest('dialog')) b.blur();
});

const stage = $('#stage');
stage.addEventListener('click', e => { if (e.target === video && !zoom.justPanned) togglePlay(); });
stage.addEventListener('dblclick', e => { if (e.target === video) toggleFullscreen(); });
stage.addEventListener('wheel', e => {
  if (!state.info) return;
  e.preventDefault();
  changeVolume(e.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });

// drag & drop
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  const dropped = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
  if (!dropped.length) return;
  const paths = await api.expandPaths(dropped);
  if (paths.length) addFiles(paths);
  else toast('Здесь нет видео и музыки.');
});

api.onOpenPaths(paths => addFiles(paths));

// keyboard (by physical key, so it works with the Russian layout too)
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  const el = e.target;
  if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'range')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const handlers = {
    Space: togglePlay,
    KeyK: togglePlay,
    ArrowLeft: () => seekBy(ctrl ? -30 : e.shiftKey ? -1 : -settings.seekStep),
    ArrowRight: () => seekBy(ctrl ? 30 : e.shiftKey ? 1 : settings.seekStep),
    ArrowUp: () => changeVolume(0.05),
    ArrowDown: () => changeVolume(-0.05),
    Comma: () => stepFrame(-1),
    Period: () => stepFrame(1),
    KeyM: toggleMute,
    KeyN: openNames,
    KeyF: toggleFullscreen,
    BracketLeft: () => changeSpeed(-1),
    BracketRight: () => changeSpeed(1),
    KeyA: () => selectAudio((state.audioK + 1) % Math.max(1, state.audioStreams.length)),
    KeyS: cycleSub,
    KeyI: () => { setIn(video.currentTime); osd('Начало: ' + fmtPrecise(video.currentTime)); },
    KeyO: () => { setOut(video.currentTime); osd('Конец: ' + fmtPrecise(video.currentTime)); },
    KeyP: playSelection,
    KeyL: toggleLoop,
    KeyX: () => setTrimOpen(false),
    // In fullscreen Esc only leaves fullscreen; then it closes trimming, then the video (to the library)
    Escape: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (trimOpen()) setTrimOpen(false);
      else {
        closeVideo();
        showView('library');
      }
    },
    KeyH: toggleCollapse,
    KeyZ: resetZoom,
    KeyW: togglePip,
    KeyC: screenshot,
    KeyT: toggleTrim,
    KeyD: toggleDraw,
    PageUp: () => loadIndex(state.current - 1),
    PageDown: () => loadIndex(state.current + 1),
    Home: () => seekBy(-Infinity),
    End: () => seekBy(duration()),
    F1: () => $('#help-dlg').showModal(),
  };
  const ctrlHandlers = {
    KeyO: () => (e.shiftKey ? openFolder() : openFiles()),
    KeyE: openExport,
    KeyI: showInfo,
    KeyL: () => showView(currentView === 'library' ? 'player' : 'library'),
    Comma: openSettings,
    Equal: () => zoomBy(1.25),
    NumpadAdd: () => zoomBy(1.25),
    Minus: () => zoomBy(1 / 1.25),
    NumpadSubtract: () => zoomBy(1 / 1.25),
    Digit0: resetZoom,
  };
  const fn = ctrl ? ctrlHandlers[e.code] : handlers[e.code];
  if (!fn) return;
  e.preventDefault();
  fn();
});

// ---------- init

state.precise = !!recall('timePrecise', false);
state.volume = clamp(Number(recall('volume', 1)) || 0, 0, MAX_VOLUME);
state.muted = !!recall('muted', false);
applyVolume();
renderPlaylist();
updateProgress();
