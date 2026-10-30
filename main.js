const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const FFPROBE = require('ffprobe-static').path.replace('app.asar', 'app.asar.unpacked');

const CACHE = path.join(os.tmpdir(), 'takao-cache');
const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'vob', '3gp', 'ogv'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'ac3', 'dts', 'mka'];
const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT];
const SUB_EXT = ['srt', 'vtt', 'ass', 'ssa'];

// Codecs Chromium can play from an MP4 container without re-encoding
const COPY_VIDEO = ['h264', 'hevc', 'av1', 'vp9'];
const COPY_AUDIO = ['aac', 'mp3', 'opus', 'flac'];

const AUDIO_CODEC = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  wav: ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac'],
};
const SAME_CODEC = { mp3: 'mp3', m4a: 'aac', flac: 'flac' };
const LOSSY = ['mp3', 'm4a'];

// Encoder args for an audio-only format; a chosen bitrate replaces the default quality
function audioCodec(format, kbps) {
  const [flag, codec] = AUDIO_CODEC[format];
  return kbps && LOSSY.includes(format) ? [flag, codec, '-b:a', `${kbps}k`] : AUDIO_CODEC[format];
}
const FF_BASE = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];

// Lets the renderer switch between audio tracks of one file natively
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

// Settings, track names and positions stay in the folder used before the rename
app.setPath('userData', path.join(app.getPath('appData'), 'takao'));

let win = null;
const jobs = new Map();
const probes = new Map();
const audioFeeds = new Map();

if (!app.requestSingleInstanceLock()) app.quit();

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const extOf = p => path.extname(p).slice(1).toLowerCase();

// Media files in dir and its subfolders: files first, then subfolders, in natural name order
function listMedia(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => collator.compare(a.name, b.name));
  const files = entries.filter(e => e.isFile() && MEDIA_EXT.includes(extOf(e.name))).map(e => path.join(dir, e.name));
  if (depth < 8) {
    for (const e of entries) {
      if (e.isDirectory() && !/^[.$]/.test(e.name)) files.push(...listMedia(path.join(dir, e.name), depth + 1));
    }
  }
  return files;
}

// Replaces folders with the media files inside them
function expandPaths(paths) {
  return paths.flatMap(p => {
    try {
      return fs.statSync(p).isDirectory() ? listMedia(p) : [p];
    } catch {
      return [];
    }
  });
}

function argPaths(argv) {
  // When run from source, argv[1] is the app folder itself
  const args = argv.slice(process.defaultApp ? 2 : 1).filter(a => !a.startsWith('--') && fs.existsSync(a));
  return expandPaths(args).filter(a => MEDIA_EXT.includes(extOf(a)) || SUB_EXT.includes(extOf(a)));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#0c0d12',
    title: 'Tako.player',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d12', symbolColor: '#9aa0b4', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => {
    const files = argPaths(process.argv);
    if (files.length) win.webContents.send('open-paths', files);
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const files = argPaths(argv);
  if (files.length) win.webContents.send('open-paths', files);
});

app.whenReady().then(() => {
  fs.mkdirSync(CACHE, { recursive: true });
  createWindow();
  setupUpdates(argPaths(process.argv).length > 0);
});

// ---------- updates from GitHub Releases
//
// On a plain start the splash waits for the check: a new version is downloaded and installed
// before the player opens. Started with a file, or after "skip", the update downloads in the
// background and installs on the next quit (or on "restart"). Runs from source never update.

let updater = null;
let updateState = { status: 'idle' };
let releaseGate;
const startupGate = new Promise(r => { releaseGate = r; });
let blocking = false; // the splash is waiting for the update

function sendUpdate(state) {
  updateState = state;
  if (win) win.webContents.send('update', state);
}

// Lets the player open; a download still in progress carries on in the background
function releaseStartup() {
  blocking = false;
  releaseGate();
}

const STARTUP_CHECK_MS = 6000;

function setupUpdates(openedWithFiles) {
  if (!app.isPackaged) return releaseStartup();
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  updater.on('update-not-available', () => {
    sendUpdate({ status: 'latest' });
    if (blocking) releaseStartup();
  });
  updater.on('update-available', i => sendUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  updater.on('download-progress', p => sendUpdate({ status: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  updater.on('update-downloaded', i => {
    sendUpdate({ status: 'ready', version: i.version });
    if (blocking) updater.quitAndInstall(true, true);
  });
  updater.on('error', e => {
    sendUpdate({ status: 'error', message: String(e && e.message || e).split('\n')[0] });
    if (blocking) releaseStartup();
  });

  if (openedWithFiles) {
    releaseStartup();
    setTimeout(() => updater.checkForUpdates().catch(() => {}), 4000);
    return;
  }
  blocking = true;
  // No answer in time (slow or no network): open the player; a found update keeps downloading
  setTimeout(() => {
    if (blocking && updateState.status !== 'downloading') releaseStartup();
  }, STARTUP_CHECK_MS);
  updater.checkForUpdates().catch(() => { if (blocking) releaseStartup(); });
}

ipcMain.handle('startup-gate', () => startupGate);
ipcMain.handle('startup-skip', () => { if (blocking) releaseStartup(); });

ipcMain.handle('update-state', () => ({ ...updateState, current: app.getVersion(), enabled: !!updater }));
ipcMain.handle('update-check', () => {
  if (updater) updater.checkForUpdates().catch(() => {});
});
ipcMain.handle('update-install', () => {
  // Silent install, then the new version starts by itself
  if (updater && updateState.status === 'ready') updater.quitAndInstall(true, true);
});

const PROJECT_URL = 'https://github.com/soqu4c/Tako.player';
const DONATE_URL = 'https://www.donationalerts.com/r/whytakao';
ipcMain.handle('open-project', () => shell.openExternal(PROJECT_URL));
ipcMain.handle('open-donate', () => shell.openExternal(DONATE_URL));
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  for (const p of jobs.values()) p.kill();
  for (const p of audioFeeds.values()) p.kill();
  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch {}
});

// ---------- ffmpeg helpers

function run(bin, args, { jobId, duration } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    if (jobId) jobs.set(jobId, proc);
    const out = [];
    let err = '';
    let buf = '';
    proc.stdout.on('data', d => {
      out.push(d);
      if (!jobId || !duration) return;
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && win) win.webContents.send('progress', { jobId, value: Math.min(1, Number(m[1]) / 1e6 / duration) });
      }
    });
    proc.stderr.on('data', d => { err = (err + d).slice(-8000); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (jobId) jobs.delete(jobId);
      if (proc.cancelled) reject(new Error('Отменено'));
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(err.trim().split(/\r?\n/).slice(-3).join('\n') || `ffmpeg завершился с кодом ${code}`));
    });
  });
}

async function probe(file) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (!probes.has(key)) {
    const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    probes.set(key, JSON.parse(out.toString('utf8')));
  }
  return probes.get(key);
}

function cachePath(file, parts, ext) {
  const st = fs.statSync(file);
  const hash = crypto.createHash('sha1').update([file, st.size, st.mtimeMs, ...parts].join('|')).digest('hex').slice(0, 16);
  return path.join(CACHE, `${hash}.${ext}`);
}

const realVideo = info => info.streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
const audioStreams = info => info.streams.filter(s => s.codec_type === 'audio');

function stamp(t) {
  const s = Math.floor(t);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join('-');
}

async function subtitleFile(file) {
  const raw = fs.readFileSync(file);
  if (path.extname(file).toLowerCase() === '.vtt') return raw.toString('utf8');
  const out = cachePath(file, ['extsub'], 'vtt');
  const args = ['-hide_banner', '-y'];
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    args.push('-sub_charenc', 'CP1251'); // typical for Russian .srt files
  }
  args.push('-i', file, '-c:s', 'webvtt', out);
  await run(FFMPEG, args);
  return fs.readFileSync(out, 'utf8');
}

// Mixes audio streams into one labelled [mix]. Tracks with different channel layouts
// are brought to stereo first; the limiter keeps the sum from clipping.
function mixFilter(info, indexes) {
  const srcs = indexes.map(i => info.streams.find(s => s.index === i));
  const same = srcs.every(s => s && s.channel_layout && s.channel_layout === srcs[0].channel_layout);
  const format = `aformat=sample_fmts=fltp:sample_rates=48000${same ? '' : ':channel_layouts=stereo'}`;
  const inputs = indexes.map((i, j) => `[0:${i}]${format}[a${j}]`).join(';');
  const labels = indexes.map((_, j) => `[a${j}]`).join('');
  return `${inputs};${labels}amix=inputs=${indexes.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=0[mix]`;
}

// One JPEG frame near `time`, decoding only key frames so it is quick even on huge files.
// Past the last key frame that finds nothing, so then the frame is decoded exactly.
async function grabFrame(file, time, width) {
  const out = ['-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
  const ss = Math.max(0, time).toFixed(2);
  let img = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-noaccurate_seek', '-skip_frame', 'nokey', '-ss', ss, '-i', file, ...out]);
  if (!img.length && time > 0) img = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', ss, '-i', file, ...out]);
  return img.length ? img : null;
}

// Library thumbnails are generated two at a time and cached on disk between runs
const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
let thumbSlots = 2;
const thumbWaiting = [];
async function withThumbSlot(fn) {
  while (thumbSlots <= 0) await new Promise(r => thumbWaiting.push(r));
  thumbSlots--;
  try {
    return await fn();
  } finally {
    thumbSlots++;
    const next = thumbWaiting.shift();
    if (next) next();
  }
}

async function libraryThumb(file) {
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update([file, st.size, st.mtimeMs].join('|')).digest('hex').slice(0, 16);
  const dir = thumbDir();
  const meta = path.join(dir, key + '.json');
  const jpg = path.join(dir, key + '.jpg');
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return { duration: m.duration, thumb: m.thumb ? jpg : null };
  }
  const info = await probe(file);
  const duration = parseFloat(info.format.duration) || 0;
  let img = null;
  if (info.streams.some(s => s.codec_type === 'video')) {
    img = await grabFrame(file, Math.min(duration * 0.1, 60), 400).catch(() => null);
    if (!img) img = await grabFrame(file, 0, 400).catch(() => null);
  }
  fs.mkdirSync(dir, { recursive: true });
  if (img) fs.writeFileSync(jpg, img);
  fs.writeFileSync(meta, JSON.stringify({ duration, thumb: !!img }));
  return { duration, thumb: img ? jpg : null };
}

// ---------- IPC

ipcMain.handle('app-info', () => ({ version: app.getVersion() }));

// Audio track names from the current OBS profile (Settings → Output → Audio), and which of
// the six tracks recordings include. null when OBS is not installed.
ipcMain.handle('obs-tracks', () => {
  const root = path.join(app.getPath('appData'), 'obs-studio');
  const read = f => {
    try {
      return fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
    } catch {
      return '';
    }
  };
  let profiles;
  try {
    profiles = fs.readdirSync(path.join(root, 'basic', 'profiles'));
  } catch {
    return null;
  }
  // OBS 31+ keeps the current profile in user.ini, older versions in global.ini
  const m = /^ProfileDir=(.+)$/m.exec(read(path.join(root, 'user.ini')) || read(path.join(root, 'global.ini')));
  const profile = m && profiles.includes(m[1].trim()) ? m[1].trim() : profiles[0];
  if (!profile) return null;
  const ini = read(path.join(root, 'basic', 'profiles', profile, 'basic.ini'));
  const section = name => {
    const s = new RegExp(`^\\[${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(ini);
    return s ? s[1] : '';
  };
  const key = (text, k) => {
    const r = new RegExp(`^${k}=(.*)$`, 'm').exec(text);
    return r ? r[1].trim() : '';
  };
  const adv = section('AdvOut');
  const mode = key(section('Output'), 'Mode');
  const recTracks = Number(key(mode === 'Advanced' ? adv : section('SimpleOutput'), 'RecTracks')) || 1;
  return { profile, recTracks, names: [1, 2, 3, 4, 5, 6].map(n => key(adv, `Track${n}Name`)) };
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('library-scan', (_e, folders) => folders.map(dir => ({
  dir,
  name: path.basename(dir) || dir,
  exists: fs.existsSync(dir),
  files: listMedia(dir).flatMap(f => {
    try {
      const st = fs.statSync(f);
      return [{ path: f, name: path.basename(f), size: st.size, mtime: st.mtimeMs, audio: AUDIO_EXT.includes(extOf(f)) }];
    } catch {
      return [];
    }
  }),
})));

ipcMain.handle('library-thumb', (_e, file) => withThumbSlot(() => libraryThumb(file)));

ipcMain.handle('frame-thumb', async (_e, { file, time }) => {
  const img = await grabFrame(file, time, 320);
  return img ? 'data:image/jpeg;base64,' + img.toString('base64') : null;
});

ipcMain.handle('clear-thumbs', () => {
  fs.rmSync(thumbDir(), { recursive: true, force: true });
});

ipcMain.handle('open-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Медиафайлы', extensions: MEDIA_EXT },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('open-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : listMedia(r.filePaths[0]);
});

ipcMain.handle('expand-paths', (_e, paths) => expandPaths(paths));

ipcMain.handle('pick-subtitle', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Субтитры', extensions: SUB_EXT }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('load-subtitle', (_e, file) => subtitleFile(file));

ipcMain.handle('probe', (_e, file) => probe(file));

// Builds an MP4 copy of the file that Chromium can play, with the chosen audio track.
// level 1: copy what is compatible, re-encode the rest; level 2: re-encode everything.
ipcMain.handle('playable', async (_e, { file, audio, level, jobId }) => {
  const info = await probe(file);
  const out = cachePath(file, ['play', audio, level], 'mp4');
  if (fs.existsSync(out)) return out;
  const v = realVideo(info);
  const a = audioStreams(info)[audio];
  if (!v && !a) throw new Error('В файле нет воспроизводимых дорожек');
  const args = [...FF_BASE, '-i', file];
  if (v) {
    args.push('-map', `0:${v.index}`);
    if (level < 2 && COPY_VIDEO.includes(v.codec_name)) {
      args.push('-c:v', 'copy');
      if (v.codec_name === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p');
    }
  }
  if (a) {
    args.push('-map', `0:${a.index}`);
    if (level < 2 && COPY_AUDIO.includes(a.codec_name)) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  const tmp = out + '.part';
  args.push('-sn', '-dn', '-f', 'mp4', tmp);
  await run(FFMPEG, args, { jobId, duration: parseFloat(info.format.duration) || 0 });
  fs.renameSync(tmp, out);
  return out;
});

ipcMain.handle('subtitle', async (_e, { file, index }) => {
  const out = cachePath(file, ['sub', index], 'vtt');
  if (!fs.existsSync(out)) await run(FFMPEG, ['-hide_banner', '-y', '-i', file, '-map', `0:${index}`, '-c:s', 'webvtt', out]);
  return fs.readFileSync(out, 'utf8');
});

ipcMain.handle('screenshot', async (_e, { file, time }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('pictures'), `${path.parse(file).name}_${stamp(time)}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await run(FFMPEG, ['-hide_banner', '-y', '-ss', time.toFixed(3), '-i', file, '-frames:v', '1', '-update', '1', '-q:v', '2', r.filePath]);
  return r.filePath;
});

ipcMain.handle('save-dialog', async (_e, { source, ext }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(path.dirname(source), `${path.parse(source).name}_фрагмент.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

ipcMain.handle('export', async (_e, o) => {
  if (path.resolve(o.out).toLowerCase() === path.resolve(o.file).toLowerCase()) {
    throw new Error('Нельзя сохранить поверх исходного файла');
  }
  const info = await probe(o.file);
  const v = realVideo(info);
  const total = parseFloat(info.format.duration) || 0;
  const start = Math.max(0, o.start || 0);
  const end = o.end != null ? o.end : total;
  const audioOnly = o.format in AUDIO_CODEC;

  const args = [...FF_BASE];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', o.file);
  if (o.end != null) args.push('-t', (end - start).toFixed(3));

  // Several checked audio tracks can be mixed into one; that track is always re-encoded
  const mix = !!o.mix && o.audio.length > 1;
  const audio = mix ? [] : audioOnly ? o.audio.slice(0, 1) : o.audio;
  const subs = o.format === 'mkv' ? o.subs : [];
  if (mix) args.push('-filter_complex', mixFilter(info, o.audio));
  // Output streams in order: video, audio (or the mix), subtitles
  const outputs = [
    ...(!audioOnly && o.video && v ? [v.index] : []).map(i => ({ map: `0:${i}`, title: o.titles && o.titles[i] })),
    ...(mix ? [{ map: '[mix]', title: o.mixTitle }] : audio.map(i => ({ map: `0:${i}`, title: o.titles && o.titles[i] }))),
    ...subs.map(i => ({ map: `0:${i}`, title: o.titles && o.titles[i] })),
  ];
  for (const s of outputs) args.push('-map', s.map);
  // Track names the user gave in the player become stream titles
  if (!audioOnly) {
    outputs.forEach((s, j) => { if (s.title) args.push(`-metadata:s:${j}`, `title=${s.title}`); });
  }

  if (audioOnly) {
    const src = info.streams.find(s => s.index === audio[0]);
    if (!mix && !o.abitrate && o.mode === 'copy' && src && SAME_CODEC[o.format] === src.codec_name) args.push('-c:a', 'copy');
    else args.push(...audioCodec(o.format, o.abitrate));
    args.push('-vn', '-sn');
  } else if (o.mode === 'copy') {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    if (mix) args.push('-c:a', 'aac', '-b:a', `${o.abitrate || 192}k`);
  } else {
    // A fixed video bitrate (average, with a capped peak) or constant quality
    const vb = o.vbitrate;
    const rate = vb ? ['-b:v', `${vb}k`, '-maxrate', `${Math.round(vb * 1.5)}k`, '-bufsize', `${vb * 2}k`] : ['-crf', String(o.crf || 22)];
    args.push('-c:v', 'libx264', '-preset', 'medium', ...rate, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', `${o.abitrate || 192}k`);
    if (subs.length) args.push('-c:s', 'copy');
  }
  if (['mp4', 'mov', 'm4a'].includes(o.format)) args.push('-movflags', '+faststart');
  args.push(o.out);

  await run(FFMPEG, args, { jobId: o.jobId, duration: end - start });
  return o.out;
});

// Streams one audio track from `start` as fragmented AAC for Media Source Extensions,
// so the video keeps playing while the track is switched. After each chunk the feed
// pauses until the renderer acks, which keeps the renderer's buffer bounded.
ipcMain.handle('astream-start', (e, { id, file, index, start }) => {
  const sender = e.sender;
  const proc = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', file,
    '-map', `0:${index}`, '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof', '-frag_duration', '500000', 'pipe:1',
  ], { windowsHide: true });
  audioFeeds.set(id, proc);
  let err = '';
  proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
  proc.stdout.on('data', chunk => {
    proc.stdout.pause();
    if (!sender.isDestroyed()) sender.send('astream', { id, chunk });
  });
  proc.on('close', code => {
    audioFeeds.delete(id);
    if (proc.stopped || sender.isDestroyed()) return;
    sender.send('astream', { id, done: true, error: code ? err.trim().split(/\r?\n/).pop() || `код ${code}` : null });
  });
});

ipcMain.on('astream-ack', (_e, id) => {
  const p = audioFeeds.get(id);
  if (p) p.stdout.resume();
});

ipcMain.on('astream-stop', (_e, id) => {
  const p = audioFeeds.get(id);
  if (!p) return;
  p.stopped = true;
  audioFeeds.delete(id);
  p.stdout.destroy();
  p.kill();
});

ipcMain.handle('cancel', (_e, jobId) => {
  const p = jobs.get(jobId);
  if (p) {
    p.cancelled = true;
    p.kill();
  }
});

ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));
