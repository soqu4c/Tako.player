const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const https = require('https');
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

// Installed, the beta is the same program as the main version (switched in Settings → About) and
// keeps its settings; run from the source folder it keeps its own, so testing never touches them
app.setPath('userData', app.isPackaged ? path.join(app.getPath('appData'), 'takao') : path.join(app.getPath('appData'), 'takao-beta'));

// Interface language. The page keeps the choice; it is mirrored here for native dialogs and
// file names, and for Chromium's own words (picture-in-picture title) from the next start.
const langFile = path.join(app.getPath('userData'), 'lang.json');
let uiLang = (() => {
  try {
    return JSON.parse(fs.readFileSync(langFile, 'utf8')).lang;
  } catch {
    return null;
  }
})();
if (uiLang) app.commandLine.appendSwitch('lang', uiLang === 'en' ? 'en-US' : 'ru');
const L = (ru, en) => (uiLang === 'en' ? en : ru);

ipcMain.on('set-lang', (_e, lang) => {
  if (lang !== 'ru' && lang !== 'en') return;
  uiLang = lang;
  try {
    fs.writeFileSync(langFile, JSON.stringify({ lang }));
  } catch {}
});

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
      // Keeps timers at full speed while minimized or covered: a separately
      // streamed audio track is kept in sync by them
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => {
    // Files are opened once the startup update check is over, so an update installing
    // first does not start playback behind the splash
    const files = argPaths(process.argv);
    const toOpen = files.length ? files : takePendingOpen();
    startupGate.then(() => {
      if (toOpen.length && win) win.webContents.send('open-paths', toOpen);
    });
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
  setupUpdates(argPaths(process.argv));
});

// Files the player was started with survive the restart that installs an update
const pendingOpenFile = () => path.join(app.getPath('userData'), 'pending-open.json');
const PENDING_OPEN_MAX_AGE = 10 * 60 * 1000;

function savePendingOpen(files) {
  if (!files.length) return;
  try {
    fs.writeFileSync(pendingOpenFile(), JSON.stringify({ at: Date.now(), files }));
  } catch {}
}

function takePendingOpen() {
  try {
    const { at, files } = JSON.parse(fs.readFileSync(pendingOpenFile(), 'utf8'));
    fs.rmSync(pendingOpenFile(), { force: true });
    return Date.now() - at < PENDING_OPEN_MAX_AGE ? files.filter(f => fs.existsSync(f)) : [];
  } catch {
    return [];
  }
}

// ---------- updates from GitHub Releases
//
// Every start waits on the splash for the check: a new version is downloaded and installed
// before the player opens (files it was started with reopen after the restart). After "skip"
// or a slow network the update downloads in the background and installs by itself on quit,
// or right away from the title bar button. Runs from source never update.

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

// Which builds to take: 'stable', or 'beta' (pre-releases with the video editor, ahead of the
// main version). Going back to stable installs the newest main version even though its number
// is lower than the beta's.
const channelFile = path.join(app.getPath('userData'), 'update-channel.json');
let updateChannel = (() => {
  try {
    return JSON.parse(fs.readFileSync(channelFile, 'utf8')).channel === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
})();

function applyChannel() {
  if (!updater) return;
  updater.allowPrerelease = updateChannel === 'beta';
  updater.allowDowngrade = updateChannel === 'stable' && app.getVersion().includes('-');
}

function setupUpdates(openedFiles) {
  if (!app.isPackaged) return releaseStartup();
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  applyChannel();
  updater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  updater.on('update-not-available', () => {
    sendUpdate({ status: 'latest' });
    if (blocking) releaseStartup();
  });
  updater.on('update-available', i => sendUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  updater.on('download-progress', p => sendUpdate({ status: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  updater.on('update-downloaded', i => {
    sendUpdate({ status: 'ready', version: i.version });
    if (blocking) {
      savePendingOpen(openedFiles);
      updater.quitAndInstall(true, true);
    }
  });
  updater.on('error', e => {
    sendUpdate({ status: 'error', message: String(e && e.message || e).split('\n')[0] });
    if (blocking) releaseStartup();
  });

  blocking = true;
  // No answer in time (slow or no network): open the player; a found update keeps downloading
  setTimeout(() => {
    if (blocking && updateState.status !== 'downloading') releaseStartup();
  }, STARTUP_CHECK_MS);
  updater.checkForUpdates().catch(() => { if (blocking) releaseStartup(); });
}

ipcMain.handle('startup-gate', () => startupGate);
ipcMain.handle('startup-skip', () => { if (blocking) releaseStartup(); });

ipcMain.handle('update-state', () => ({ ...updateState, current: app.getVersion(), enabled: !!updater, channel: updateChannel }));
ipcMain.handle('update-channel', (_e, channel) => {
  if (channel !== 'stable' && channel !== 'beta') return updateChannel;
  updateChannel = channel;
  try {
    fs.writeFileSync(channelFile, JSON.stringify({ channel }));
  } catch {}
  applyChannel();
  if (updater) updater.checkForUpdates().catch(() => {});
  return updateChannel;
});
ipcMain.handle('update-check', () => {
  if (updater) updater.checkForUpdates().catch(() => {});
});
ipcMain.handle('update-install', () => {
  // Silent install, then the new version starts by itself
  if (updater && updateState.status === 'ready') updater.quitAndInstall(true, true);
});

// ---------- Discord status (Rich Presence through Discord's local IPC pipe)
//
// Frames are an 8-byte header (opcode, length, little-endian) and JSON. The page sends the
// activity it wants shown; it is pushed at most every few seconds, the newest one winning.

const DISCORD_CLIENT_ID = '1565895532579389470';
const DISCORD_PUSH_MS = 4000;
let rpc = null; // { sock, ready }
let rpcActivity = null;
let rpcEnabled = false;
let rpcLastPush = 0;
let rpcPushTimer = null;

function rpcFrame(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

// Discord listens on the first free pipe of discord-ipc-0…9
function rpcConnect(pipe = 0) {
  if (rpc || !rpcEnabled || !DISCORD_CLIENT_ID || pipe > 9) return;
  const sock = net.connect(`\\\\?\\pipe\\discord-ipc-${pipe}`);
  let connected = false;
  let buf = Buffer.alloc(0);
  sock.on('error', () => {
    sock.destroy();
    if (!connected) rpcConnect(pipe + 1);
  });
  sock.on('connect', () => {
    connected = true;
    rpc = { sock, ready: false };
    sock.write(rpcFrame(0, { v: 1, client_id: DISCORD_CLIENT_ID }));
  });
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
      const op = buf.readInt32LE(0);
      const len = buf.readInt32LE(4);
      let msg = {};
      try {
        msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
      } catch {}
      buf = buf.subarray(8 + len);
      if (op === 3) sock.write(rpcFrame(4, msg)); // ping -> pong
      else if (op === 2) sock.end(); // Discord closed the connection
      else if (msg.evt === 'READY' && rpc && rpc.sock === sock) {
        rpc.ready = true;
        rpcPush(true);
      }
    }
  });
  sock.on('close', () => { if (rpc && rpc.sock === sock) rpc = null; });
}

function rpcPush(now = false) {
  if (!rpc || !rpc.ready) return;
  clearTimeout(rpcPushTimer);
  const wait = now ? 0 : Math.max(0, rpcLastPush + DISCORD_PUSH_MS - Date.now());
  rpcPushTimer = setTimeout(() => {
    if (!rpc || !rpc.ready) return;
    rpcLastPush = Date.now();
    rpc.sock.write(rpcFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: rpcActivity }, nonce: String(rpcLastPush) }));
  }, wait);
}

// Discord may start after the player, so keep looking for it while the status is on
setInterval(() => rpcConnect(), 30000);

ipcMain.on('discord-activity', (_e, { enabled, activity }) => {
  rpcEnabled = !!enabled;
  // Friends see a button under the status that leads to the latest installer
  rpcActivity = rpcEnabled && activity ? { ...activity, buttons: [{ label: L('Скачать Tako.player', 'Download Tako.player'), url: DOWNLOAD_URL }] } : null;
  if (!rpc) rpcConnect();
  else rpcPush();
});

const PROJECT_URL = 'https://github.com/soqu4c/Tako.player';
const DOWNLOAD_URL = 'https://github.com/soqu4c/Tako.player/releases/latest';
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

// part: [start, share] of the progress bar this run fills (a two-pass export has two runs)
function run(bin, args, { jobId, duration, part = [0, 1], cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, cwd });
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
        if (m && win) win.webContents.send('progress', { jobId, value: part[0] + part[1] * Math.min(1, Number(m[1]) / 1e6 / duration) });
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
// `volumes` maps a stream index to its loudness in the mix (1 = as recorded)
function mixFilter(info, indexes, volumes = {}) {
  const srcs = indexes.map(i => info.streams.find(s => s.index === i));
  const same = srcs.every(s => s && s.channel_layout && s.channel_layout === srcs[0].channel_layout);
  const format = `aformat=sample_fmts=fltp:sample_rates=48000${same ? '' : ':channel_layouts=stereo'}`;
  const gain = i => {
    const v = Number(volumes[i]);
    return Number.isFinite(v) && v >= 0 && v !== 1 ? `,volume=${v.toFixed(2)}` : '';
  };
  const inputs = indexes.map((i, j) => `[0:${i}]${format}${gain(i)}[a${j}]`).join(';');
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

// Dragging a file out of the player into another program (Discord, Telegram, Explorer)
let dragIcon = null;
ipcMain.on('start-drag', (e, file) => {
  if (typeof file !== 'string' || !fs.existsSync(file)) return;
  if (!dragIcon) dragIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 48, height: 48 });
  e.sender.startDrag({ file, icon: dragIcon });
});

// Small always-on-top window: the main window itself shrinks into a corner of the screen and
// floats over other windows, so every key and track keeps working; the old size comes back after
let miniBack = null; // { bounds, maximized } to return to
const MINI_BAR = 30; // title bar height in the small window

ipcMain.handle('win-mini', (_e, { on, aspect }) => {
  if (!win) return false;
  if (on && !miniBack) {
    miniBack = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const width = 480;
    const height = Math.round(width / (aspect > 0.3 && aspect < 4 ? aspect : 16 / 9)) + MINI_BAR;
    win.setMinimumSize(240, 160);
    win.setMaximizable(false);
    win.setTitleBarOverlay({ height: MINI_BAR });
    win.setBounds({ x: area.x + area.width - width - 16, y: area.y + area.height - height - 16, width, height });
    win.setAlwaysOnTop(true, 'floating');
    return true;
  }
  if (!on && miniBack) {
    win.setAlwaysOnTop(false);
    win.setTitleBarOverlay({ height: 40 });
    win.setMaximizable(true);
    win.setMinimumSize(820, 520);
    win.setBounds(miniBack.bounds);
    if (miniBack.maximized) win.maximize();
    miniBack = null;
    win.focus();
  }
  return false;
});

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

// ---------- waveforms of the audio tracks, for the trim panel
//
// ffmpeg decodes the tracks to 2000 Hz mono; the loudest sample of each of `points` slices is
// kept. In a game recording the sound is spread across the whole multi-gigabyte file, so
// reading it is limited by the disk: every audio track is therefore done in the same single
// pass (one channel each), and switching tracks afterwards is instant. Partial results are
// sent as they come in; finished waveforms are cached on disk next to the thumbnails.

const WAVE_RATE = 2000;
const waveJobs = new Map(); // file|points -> { proc, indexes, peaks: { index: [] }, done, waiters: Map(id -> { sender, index }) }
const waveWaiters = new Map(); // id -> job

const waveCache = (file, st, index, points) => path.join(thumbDir(),
  crypto.createHash('sha1').update([file, st.size, st.mtimeMs, index, points, 'wave1'].join('|')).digest('hex').slice(0, 16) + '.wave.json');

function startWaveJob(file, st, info, points) {
  const indexes = info.streams.filter(s => s.codec_type === 'audio').map(s => s.index);
  if (!indexes.length) throw new Error('в файле нет звука');
  const dur = parseFloat(info.format.duration) || 1;
  const total = Math.max(1, dur * WAVE_RATE);
  const per = total / points;
  const n = indexes.length;
  const job = { indexes, peaks: {}, done: 0, waiters: new Map() };
  for (const i of indexes) job.peaks[i] = new Array(points).fill(0);
  // Each track becomes one channel of the output; tracks that end early are padded with silence
  const graph = indexes.map((i, k) => `[0:${i}]aresample=${WAVE_RATE},aformat=sample_fmts=s16:channel_layouts=mono,apad[w${k}]`).join(';')
    + (n > 1 ? `;${indexes.map((_, k) => `[w${k}]`).join('')}amerge=inputs=${n}[out]` : '');
  const proc = spawn(FFMPEG, ['-v', 'error', '-i', file, '-filter_complex', graph, '-map', n > 1 ? '[out]' : '[w0]',
    '-t', String(dur), '-f', 's16le', 'pipe:1'], { windowsHide: true });
  job.proc = proc;
  let frame = 0;
  let rest = null; // bytes of an incomplete frame left over from the previous chunk
  let lastSent = 0;
  const step = n * 2;
  const send = final => {
    for (const [id, w] of job.waiters) {
      if (!w.sender.isDestroyed()) w.sender.send('waveform-progress', { id, peaks: job.peaks[w.index], done: final ? 1 : job.done });
    }
  };
  proc.stdout.on('data', chunk => {
    if (rest) {
      chunk = Buffer.concat([rest, chunk]);
      rest = null;
    }
    const end = chunk.length - (chunk.length % step);
    if (end < chunk.length) rest = chunk.subarray(end);
    for (let o = 0; o < end; o += step, frame++) {
      const b = Math.min(points - 1, Math.floor(frame / per));
      for (let k = 0; k < n; k++) {
        const v = Math.abs(chunk.readInt16LE(o + k * 2)) / 32768;
        const arr = job.peaks[indexes[k]];
        if (v > arr[b]) arr[b] = v;
      }
    }
    job.done = Math.min(1, frame / total);
    if (Date.now() - lastSent > 500) {
      lastSent = Date.now();
      send(false);
    }
  });
  job.result = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => {
      if (proc.cancelled) return reject(new Error('Отменено'));
      if (code !== 0 && !frame) return reject(new Error('не удалось прочитать звук'));
      try {
        fs.mkdirSync(thumbDir(), { recursive: true });
        for (const i of indexes) fs.writeFileSync(waveCache(file, st, i, points), JSON.stringify(job.peaks[i]));
      } catch {}
      resolve(job.peaks);
    });
  });
  job.result.catch(() => {}).finally(() => {
    for (const id of job.waiters.keys()) waveWaiters.delete(id);
    for (const [k, j] of waveJobs) if (j === job) waveJobs.delete(k);
  });
  return job;
}

ipcMain.handle('waveform', async (e, { id, file, index, points }) => {
  const st = fs.statSync(file);
  const cacheFile = waveCache(file, st, index, points);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const jobKey = `${file}|${points}`;
  let job = waveJobs.get(jobKey);
  if (!job) {
    job = startWaveJob(file, st, await probe(file), points);
    waveJobs.set(jobKey, job);
  }
  if (!job.indexes.includes(index)) throw new Error('нет такой дорожки');
  clearTimeout(job.idle);
  job.waiters.set(id, { sender: e.sender, index });
  waveWaiters.set(id, job);
  if (job.done) e.sender.send('waveform-progress', { id, peaks: job.peaks[index], done: job.done });
  return (await job.result)[index];
});

// Nobody waiting any more: stop reading, but only after a moment, since switching tracks
// cancels the old request just before asking again for the same file
ipcMain.on('waveform-cancel', (_e, id) => {
  const job = waveWaiters.get(id);
  if (!job) return;
  waveWaiters.delete(id);
  job.waiters.delete(id);
  if (job.waiters.size) return;
  clearTimeout(job.idle);
  job.idle = setTimeout(() => {
    if (job.waiters.size) return;
    job.proc.cancelled = true;
    job.proc.kill();
  }, 1500);
});

// ---------- speech recognition (whisper.cpp) for automatic subtitles
//
// The recognizer and the model are downloaded once into a folder the user picks (by default
// on drive E:, which has room) and checked against known SHA-256 sums. The chosen audio track
// is turned into 16 kHz mono WAV, whisper-cli writes an SRT, and the times are shifted when
// only a fragment was recognized.

const WHISPER = {
  build: 'b5454',
  zip: {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  },
  model: {
    file: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    size: 487601967,
  },
};

const defaultModelsDir = () => (fs.existsSync('E:\\') ? 'E:\\Tako.player\\models' : path.join(app.getPath('userData'), 'models'));
const whisperExe = dir => path.join(dir, `whisper-${WHISPER.build}`, 'Release', 'whisper-cli.exe');
const whisperModel = dir => path.join(dir, WHISPER.model.file);

function asrProgress(jobId, value, stage) {
  if (win) win.webContents.send('asr-progress', { jobId, value, stage });
}

// GET with redirects into `dest`, hashing on the way; the file appears only once the sum matches
function download(url, dest, sha256, jobId, stage) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part';
    const job = { cancelled: false, kill: () => { job.req && job.req.destroy(); } };
    jobs.set(jobId, job);
    const fail = err => {
      jobs.delete(jobId);
      fs.rmSync(part, { force: true });
      reject(job.cancelled ? new Error('Отменено') : err);
    };
    const get = (u, hops) => {
      job.req = https.get(u, { headers: { 'User-Agent': `Tako.player/${app.getVersion()}` } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 8) {
          res.resume();
          return get(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`сервер ответил ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        const hash = crypto.createHash('sha256');
        const outStream = fs.createWriteStream(part);
        let got = 0;
        let last = 0;
        res.on('data', d => {
          hash.update(d);
          got += d.length;
          if (total && Date.now() - last > 300) {
            last = Date.now();
            asrProgress(jobId, got / total, stage);
          }
        });
        res.on('error', fail);
        res.pipe(outStream);
        outStream.on('error', fail);
        outStream.on('finish', () => {
          if (job.cancelled) return fail(new Error('Отменено'));
          if (hash.digest('hex') !== sha256) return fail(new Error('скачанный файл повреждён (контрольная сумма не совпала)'));
          jobs.delete(jobId);
          fs.renameSync(part, dest);
          resolve(dest);
        });
      });
      job.req.on('error', err => fail(new Error('нет связи: ' + err.message)));
    };
    get(url, 0);
  });
}

ipcMain.handle('asr-info', (_e, dir) => {
  const d = dir || defaultModelsDir();
  return { dir: d, defaultDir: defaultModelsDir(), ready: fs.existsSync(whisperExe(d)) && fs.existsSync(whisperModel(d)), modelMB: Math.round(WHISPER.model.size / 1e6) };
});

ipcMain.handle('asr-pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// Downloads whatever is missing: the recognizer (unpacked with Windows' own tar) and the model
async function asrEnsure(dir, jobId) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(whisperExe(dir))) {
    const zip = path.join(dir, `whisper-${WHISPER.build}.zip`);
    await download(WHISPER.zip.url, zip, WHISPER.zip.sha256, jobId, 'program');
    const target = path.join(dir, `whisper-${WHISPER.build}`);
    fs.mkdirSync(target, { recursive: true });
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', target]);
    fs.rmSync(zip, { force: true });
    if (!fs.existsSync(whisperExe(dir))) throw new Error('в архиве распознавателя не нашлось whisper-cli.exe');
  }
  if (!fs.existsSync(whisperModel(dir))) {
    const free = (() => { try { const d = fs.statfsSync(dir); return d.bavail * d.bsize; } catch { return Infinity; } })();
    if (free < WHISPER.model.size + 100e6) throw new Error(`в папке для модели не хватает места: нужно около ${Math.ceil(WHISPER.model.size / 1e6)} МБ`);
    await download(WHISPER.model.url, whisperModel(dir), WHISPER.model.sha256, jobId, 'model');
  }
}

// "00:01:02,345" shifted by `by` seconds
function shiftSrt(text, by) {
  if (!by) return text;
  const toMs = (h, m, s, ms) => ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
  const fromMs = v => {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(v / 3600000))}:${p(Math.floor(v / 60000) % 60)}:${p(Math.floor(v / 1000) % 60)},${p(v % 1000, 3)}`;
  };
  return text.replace(/(\d+):(\d\d):(\d\d)[,.](\d{3})/g, (_m, h, mi, s, ms) => fromMs(toMs(h, mi, s, ms) + Math.round(by * 1000)));
}

ipcMain.handle('asr-run', async (_e, o) => {
  const dir = o.dir || defaultModelsDir();
  await asrEnsure(dir, o.jobId);
  const start = Math.max(0, o.start || 0);
  const info = await probe(o.file);
  const end = o.end != null ? o.end : parseFloat(info.format.duration) || 0;
  const tmpBase = path.join(dir, `tmp-${o.jobId}`);
  const wav = tmpBase + '.wav';
  try {
    // 1. the track as 16 kHz mono WAV, which is what whisper wants
    const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
    if (start > 0) args.push('-ss', start.toFixed(3));
    args.push('-i', o.file);
    if (o.end != null) args.push('-t', (end - start).toFixed(3));
    args.push('-map', `0:${o.index}`, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
    asrProgress(o.jobId, 0, 'audio');
    await run(FFMPEG, args, { jobId: o.jobId, duration: end - start });
    // 2. recognition; whisper prints "progress = N%" while it works
    asrProgress(o.jobId, 0, 'recognize');
    const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
    await new Promise((resolve, reject) => {
      const proc = spawn(whisperExe(dir), ['-m', whisperModel(dir), '-f', wav, '-l', o.lang || 'ru', '-t', threads, '-osrt', '-of', tmpBase, '-pp'],
        { windowsHide: true, cwd: path.dirname(whisperExe(dir)) });
      jobs.set(o.jobId, proc);
      let err = '';
      const onText = d => {
        const s = d.toString();
        err = (err + s).slice(-4000);
        const m = /progress\s*=\s*(\d+)%/g;
        let p;
        let last = null;
        while ((p = m.exec(s))) last = Number(p[1]);
        if (last != null) asrProgress(o.jobId, last / 100, 'recognize');
      };
      proc.stdout.on('data', onText);
      proc.stderr.on('data', onText);
      proc.on('error', reject);
      proc.on('close', code => {
        jobs.delete(o.jobId);
        if (proc.cancelled) reject(new Error('Отменено'));
        else if (code === 0) resolve();
        else reject(new Error(err.trim().split(/\r?\n/).slice(-2).join(' ') || `распознаватель завершился с кодом ${code}`));
      });
    });
    // 3. the SRT next to the video, with times back on the whole file's clock
    const srt = shiftSrt(fs.readFileSync(tmpBase + '.srt', 'utf8'), start);
    const { dir: vdir, name } = path.parse(o.file);
    const out = freePath(path.join(vdir, `${name}${o.end != null ? L(' (фрагмент)', ' (fragment)') : ''}.${o.lang && o.lang !== 'auto' ? o.lang + '.' : ''}srt`));
    fs.writeFileSync(out, srt, 'utf8');
    return { out, lines: (srt.match(/-->/g) || []).length };
  } finally {
    for (const ext of ['.wav', '.srt']) fs.rmSync(tmpBase + ext, { force: true });
  }
});

// ---------- removing an audio or subtitle track from a file
//
// The file is rewritten without that stream (no re-encoding) next to itself; then the
// original goes to the recycle bin and the new file takes its name.

ipcMain.handle('remove-stream', async (_e, { file, index, jobId }) => {
  const info = await probe(file);
  const s = info.streams.find(x => x.index === index);
  if (!s || !['audio', 'subtitle'].includes(s.codec_type)) throw new Error('эту дорожку удалить нельзя');
  const size = fs.statSync(file).size;
  let free = Infinity;
  try {
    const d = fs.statfsSync(path.dirname(file));
    free = d.bavail * d.bsize;
  } catch {}
  if (free < size + 200e6) throw new Error(`на диске не хватает места: на время пересборки нужно около ${(size / 1e9).toFixed(1)} ГБ свободных`);
  const { dir, name, ext } = path.parse(file);
  const tmp = path.join(dir, `${name}.tako-tmp${ext}`);
  try {
    await run(FFMPEG, [...FF_BASE, '-i', file, '-map', '0', '-map', `-0:${index}`, '-map', '-0:d?', '-c', 'copy',
      '-map_metadata', '0', '-map_chapters', '0', tmp], { jobId, duration: parseFloat(info.format.duration) || 0 });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  await shell.trashItem(file);
  fs.renameSync(tmp, file);
  return file;
});

// ---------- files in the library: recycle bin, renaming, durations for sorting

ipcMain.handle('trash-file', async (_e, file) => {
  await shell.trashItem(file);
});

const BAD_NAME = /[\\/:*?"<>|]/;

// `name` may come with or without the extension; the file keeps its own extension
ipcMain.handle('rename-file', (_e, { file, name }) => {
  const ext = path.extname(file);
  let base = String(name).trim();
  if (base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length).trim();
  if (!base || /^\.+$/.test(base)) throw new Error('имя не может быть пустым');
  if (BAD_NAME.test(base)) throw new Error('в имени нельзя использовать \\ / : * ? " < > |');
  const target = path.join(path.dirname(file), base + ext);
  if (target === file) return file;
  // Only the letter case may change for a name that already exists (the same file)
  if (fs.existsSync(target) && target.toLowerCase() !== file.toLowerCase()) throw new Error('файл с таким именем уже есть');
  fs.renameSync(file, target);
  return target;
});

// Durations for sorting: from the thumbnail cache when it has them, else a quick ffprobe
ipcMain.handle('library-durations', async (_e, files) => {
  const out = {};
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      try {
        const st = fs.statSync(file);
        const key = crypto.createHash('sha1').update([file, st.size, st.mtimeMs].join('|')).digest('hex').slice(0, 16);
        const meta = path.join(thumbDir(), key + '.json');
        if (fs.existsSync(meta)) {
          out[file] = JSON.parse(fs.readFileSync(meta, 'utf8')).duration || 0;
        } else {
          const d = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
          out[file] = parseFloat(d.toString()) || 0;
        }
      } catch {
        out[file] = 0;
      }
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  return out;
});

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
      { name: L('Медиафайлы', 'Media files'), extensions: MEDIA_EXT },
      { name: L('Все файлы', 'All files'), extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('open-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : listMedia(r.filePaths[0]);
});

ipcMain.handle('expand-paths', (_e, paths) => expandPaths(paths));

// Media files next to `file` (same folder, no subfolders), in natural name order
ipcMain.handle('folder-media', (_e, file) => {
  const dir = path.dirname(file);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && MEDIA_EXT.includes(extOf(e.name)))
      .map(e => e.name)
      .sort(collator.compare)
      .map(name => path.join(dir, name));
  } catch {
    return [file];
  }
});

ipcMain.handle('pick-subtitle', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: L('Субтитры', 'Subtitles'), extensions: SUB_EXT }],
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

// ---------- drawing on a frame: the exact frame, then saving or copying the finished picture

ipcMain.handle('grab-frame', async (_e, { file, time }) => {
  const png = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, time).toFixed(3), '-i', file,
    '-map', '0:v:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
  if (!png.length) throw new Error('не удалось взять кадр');
  return 'data:image/png;base64,' + png.toString('base64');
});

const PNG_DATA = 'data:image/png;base64,';

ipcMain.handle('save-image', async (_e, { data, file, time }) => {
  if (!String(data).startsWith(PNG_DATA)) throw new Error('неверная картинка');
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('pictures'), `${path.parse(file).name}_${stamp(time)}_${L('рисунок', 'drawing')}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data.slice(PNG_DATA.length), 'base64'));
  return r.filePath;
});

ipcMain.handle('copy-image', (_e, data) => {
  if (!String(data).startsWith(PNG_DATA)) throw new Error('неверная картинка');
  clipboard.writeImage(nativeImage.createFromDataURL(data));
});

ipcMain.handle('save-dialog', async (_e, { source, ext, name }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(path.dirname(source), `${name || path.parse(source).name + L('_фрагмент', '_clip')}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

// "name.mp4" -> "name (2).mp4" and so on until the name is free
function freePath(file) {
  if (!fs.existsSync(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let n = 2; ; n++) {
    const p = path.join(dir, `${name} (${n})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

ipcMain.handle('export', async (_e, o) => {
  // Batch exports never overwrite: an existing name gets a number
  if (o.unique) o.out = freePath(o.out);
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
  if (mix) args.push('-filter_complex', mixFilter(info, o.audio, o.volumes));
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

// Several fragments of one file glued into one video, in time order. Overlapping fragments
// are merged so nothing plays twice. Each fragment is a separate fast-seeking input; audio is
// brought to 48 kHz stereo (and mixed when several tracks are asked for) before concat.
function mergeRanges(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.filter(([a, b]) => b - a > 0.05);
}

ipcMain.handle('concat-clips', async (_e, o) => {
  if (path.resolve(o.out).toLowerCase() === path.resolve(o.file).toLowerCase()) {
    throw new Error('Нельзя сохранить поверх исходного файла');
  }
  const info = await probe(o.file);
  const v = realVideo(info);
  const ranges = mergeRanges(o.ranges);
  if (!ranges.length) throw new Error('нет фрагментов');
  const audio = o.audio || [];
  const args = [...FF_BASE];
  for (const [a, b] of ranges) args.push('-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-i', o.file);
  const fmtA = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const filters = [];
  const parts = ranges.map((_, k) => {
    let seg = '';
    if (v) {
      filters.push(`[${k}:${v.index}]setpts=PTS-STARTPTS,format=yuv420p[v${k}]`);
      seg += `[v${k}]`;
    }
    if (audio.length > 1) {
      audio.forEach((i, j) => filters.push(`[${k}:${i}]${fmtA}[a${k}_${j}]`));
      filters.push(`${audio.map((_, j) => `[a${k}_${j}]`).join('')}amix=inputs=${audio.length}:normalize=0,alimiter=limit=0.95:level=0,asetpts=PTS-STARTPTS[a${k}]`);
      seg += `[a${k}]`;
    } else if (audio.length) {
      filters.push(`[${k}:${audio[0]}]${fmtA},asetpts=PTS-STARTPTS[a${k}]`);
      seg += `[a${k}]`;
    }
    return seg;
  });
  filters.push(`${parts.join('')}concat=n=${ranges.length}:v=${v ? 1 : 0}:a=${audio.length ? 1 : 0}${v ? '[v]' : ''}${audio.length ? '[a]' : ''}`);
  args.push('-filter_complex', filters.join(';'));
  if (v) args.push('-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf || 21), '-pix_fmt', 'yuv420p');
  if (audio.length) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart', o.out);
  await run(FFMPEG, args, { jobId: o.jobId, duration: ranges.reduce((s, [a, b]) => s + b - a, 0) });
  return { out: o.out, parts: ranges.length };
});

// ---------- editor (beta): renders the whole timeline into one video
//
// Every clip is its own input, cut with an input seek. Video clips are fitted into the frame
// with transparent bars and laid over a black canvas from the lowest track up, each shifted
// to its place on the timeline; fades are fades of transparency. Audio clips are delayed to
// their place and mixed. Titles are drawn last. The graph goes through a script file, so
// paths and text need no shell quoting.

// Paths inside a quoted filter option: forward slashes, and the drive colon escaped
const ffPath = p => p.replace(/\\/g, '/').replace(/:/g, '\\:');
const FONT = ffPath(path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', 'arial.ttf'));
const num = x => (Math.round(x * 1000) / 1000).toString();

ipcMain.handle('editor-export', async (_e, o) => {
  const { w, h } = o;
  // NTSC rates are exact fractions for ffmpeg
  const fps = { 23.976: '24000/1001', 29.97: '30000/1001', 59.94: '60000/1001' }[o.fps] || String(o.fps);
  const T = o.duration;
  if (!(T > 0)) throw new Error(L('Таймлайн пуст', 'The timeline is empty'));
  if ([...o.video, ...o.audio].some(c => path.resolve(c.file).toLowerCase() === path.resolve(o.out).toLowerCase())) {
    throw new Error(L('Нельзя сохранить поверх исходного файла', 'Cannot save over a source file'));
  }
  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'tako-edit-'));
  const args = [...FF_BASE];
  const graph = [];
  let input = 0;
  graph.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${num(T)},format=yuva420p[base0]`);
  let base = 'base0';
  o.video.forEach((c, k) => {
    // a picture is one frame, repeated for as long as its clip lasts
    if (c.image) args.push('-loop', '1', '-framerate', String(fps), '-t', num(c.dur), '-i', c.file);
    else args.push('-ss', num(c.in), '-t', num(c.dur), '-i', c.file);
    // fitted into the frame, then the clip's own scale, rotation and opacity (Effect Controls)
    // the editor works out the picture's size on screen (width and height may differ)
    const even = v => Math.max(2, Math.round(v / 2) * 2);
    const size = c.pw > 0 && c.ph > 0 ? `${even(c.pw)}:${even(c.ph)}` : `${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    const a = num((c.rot || 0) * Math.PI / 180);
    let f = `[${input}:${c.vIndex}]setpts=PTS-STARTPTS,fps=${fps},scale=${size},format=yuva420p`;
    if (c.rot) f += `,rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=none`;
    if (c.opacity != null && c.opacity < 1) f += `,colorchannelmixer=aa=${num(Math.max(0, c.opacity))}`;
    if (c.fadeIn > 0) f += `,fade=t=in:st=0:d=${num(c.fadeIn)}:alpha=1`;
    if (c.fadeOut > 0) f += `,fade=t=out:st=${num(Math.max(0, c.dur - c.fadeOut))}:d=${num(c.fadeOut)}:alpha=1`;
    graph.push(`${f},setpts=PTS+${num(c.start)}/TB[v${k}]`);
    // the clip's centre goes to its position (the middle of the frame unless moved)
    const cx = c.x != null ? c.x : w / 2, cy = c.y != null ? c.y : h / 2;
    graph.push(`[${base}][v${k}]overlay=x=${num(cx)}-overlay_w/2:y=${num(cy)}-overlay_h/2:eof_action=pass:format=auto[base${k + 1}]`);
    base = `base${k + 1}`;
    input++;
  });
  o.texts.forEach((t, k) => {
    const file = path.join(tmp, `t${k}.txt`);
    fs.writeFileSync(file, t.text, 'utf8');
    const s = t.start, e = t.start + t.dur;
    const size = Math.round(t.size * h / 1080);
    // x and y are where the text's centre is, as parts of the frame
    const x = `w*${num(t.x)}-text_w/2`;
    const y = `h*${num(t.y)}-text_h/2`;
    const fi = Math.max(0.001, t.fadeIn || 0), fo = Math.max(0.001, t.fadeOut || 0);
    const alpha = `if(lt(t,${num(s + fi)}),(t-${num(s)})/${num(fi)},if(gt(t,${num(e - fo)}),(${num(e)}-t)/${num(fo)},1))`;
    // the title's font from Windows\Fonts, Arial when it is missing
    const fontPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', t.fontFile || '');
    const ff = /^[\w.-]+\.ttf$/i.test(t.fontFile || '') && fs.existsSync(fontPath) ? ffPath(fontPath) : FONT;
    let f = `[${base}]drawtext=fontfile='${ff}':textfile='${ffPath(file)}':fontsize=${size}:fontcolor=${t.color}:x=${x}:y=${y}:line_spacing=${Math.round(size * 0.2)}:enable='between(t,${num(s)},${num(e)})':alpha='${alpha}'`;
    if (t.box) f += `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size * 0.35)}`;
    graph.push(`${f}[txt${k}]`);
    base = `txt${k}`;
  });
  graph.push(`[${base}]format=yuv420p[vout]`);
  const fmtA = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const mixed = o.audio.map((c, k) => {
    args.push('-ss', num(c.in), '-t', num(c.dur), '-i', c.file);
    let f = `[${input}:${c.aIndex}]${fmtA},asetpts=PTS-STARTPTS,volume=${num(c.volume)}`;
    if (c.fadeIn > 0) f += `,afade=t=in:st=0:d=${num(c.fadeIn)}`;
    if (c.fadeOut > 0) f += `,afade=t=out:st=${num(Math.max(0, c.dur - c.fadeOut))}:d=${num(c.fadeOut)}`;
    graph.push(`${f},adelay=${Math.round(c.start * 1000)}:all=1[a${k}]`);
    input++;
    return `[a${k}]`;
  });
  if (mixed.length) graph.push(`${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:duration=longest,apad[aout]`);
  else graph.push(`anullsrc=r=48000:cl=stereo[aout]`);
  const script = path.join(tmp, 'graph.txt');
  fs.writeFileSync(script, graph.join(';\n'), 'utf8');
  // Encoding from the export window: H.264 or H.265, by quality (CRF) or by bitrate
  // Bitrate modes as in Premiere: quality (CRF), constant (CBR), variable in one or two passes
  const enc = o.enc || {};
  const h265 = enc.codec === 'h265';
  const mode = enc.mode === 'bitrate' ? 'vbr1' : enc.mode || 'crf';
  const vArgs = ['-c:v', h265 ? 'libx265' : 'libx264', '-preset', enc.preset || 'veryfast'];
  const target = Math.round((enc.vbitrate || 12) * 1000);
  const max = Math.max(target, Math.round((enc.vmax || enc.vbitrate * 1.5 || 18) * 1000));
  if (mode === 'crf') vArgs.push('-crf', String(enc.crf || (h265 ? 24 : 20)));
  else if (mode === 'cbr') {
    vArgs.push('-b:v', `${target}k`, '-minrate', `${target}k`, '-maxrate', `${target}k`, '-bufsize', `${target}k`);
    if (!h265) vArgs.push('-x264-params', 'nal-hrd=cbr');
  } else vArgs.push('-b:v', `${target}k`, '-maxrate', `${max}k`, '-bufsize', `${max * 2}k`);
  if (!h265 && enc.profile) vArgs.push('-profile:v', enc.profile);
  if (h265 && /\.mp4$/i.test(o.out)) vArgs.push('-tag:v', 'hvc1'); // so Windows and phones play it
  if (h265) vArgs.push('-x265-params', 'log-level=error');
  const common = ['-filter_complex_script', script, '-map', '[vout]', '-t', num(T), ...vArgs, '-pix_fmt', 'yuv420p', '-r', fps];
  try {
    if (mode === 'vbr2') {
      // first pass only measures the picture; the second one writes the file
      const log = path.join(tmp, 'pass');
      // x265 keeps its statistics next to it (a drive letter would break its option string)
      const pass = h265 ? n => ['-x265-params', `log-level=error:pass=${n}:stats=pass.log`] : n => ['-pass', String(n), '-passlogfile', log];
      await run(FFMPEG, [...args, ...common, ...pass(1), '-map', '[aout]', '-c:a', 'aac', '-f', 'null', 'NUL'], { jobId: o.jobId, duration: T, part: [0, 0.5], cwd: tmp });
      args.push(...common, ...pass(2));
    } else args.push(...common);
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', `${enc.abitrate || 192}k`);
    if (/\.mp4$/i.test(o.out)) args.push('-movflags', '+faststart');
    args.push(o.out);
    await run(FFMPEG, args, { jobId: o.jobId, duration: T, part: mode === 'vbr2' ? [0.5, 0.5] : [0, 1], cwd: tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { out: o.out };
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
