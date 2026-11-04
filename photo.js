'use strict';
// Photo editor (beta): opens an image, crops / rotates / flips it, and saves as PNG, JPG or
// GIF, or pulls every frame out of a GIF. Pixel work is done here on a canvas; GIF encoding and
// frame extraction are done by ffmpeg in the main process. Runs after the other page scripts.

const ph = {
  src: null,        // the opened file path
  canvas: null,     // working image at full resolution
  crop: null,       // { x, y, w, h } in image pixels, or null
  scale: 1,         // displayed px per image px
};

const phEl = {};
// a crop box covering the whole image: always visible, so cropping is "drag the handles"
function fullCrop() { ph.crop = { x: 0, y: 0, w: ph.canvas.width, h: ph.canvas.height }; }
function cropIsFull() { const r = ph.crop, c = ph.canvas; return r && c && r.x === 0 && r.y === 0 && r.w === c.width && r.h === c.height; }
function phInit() {
  for (const id of ['photo', 'ph-canvas', 'ph-crop', 'ph-stage', 'ph-wrap', 'ph-name', 'ph-size', 'ph-frames']) {
    phEl[id] = document.getElementById(id);
  }
}

// ---------- opening

function openPhoto(file) {
  phInit();
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    ph.src = file;
    ph.canvas = c;
    fullCrop();
    phEl['ph-name'].textContent = api.basename(file);
    phEl['ph-frames'].hidden = !/\.gif$/i.test(file);
    phEl['photo'].hidden = false;
    document.body.classList.add('photo-open');
    phRender();
  };
  img.onerror = () => toast('Не удалось открыть картинку');
  img.src = api.toUrl(file);
}

function closePhoto() {
  phEl['photo'].hidden = true;
  document.body.classList.remove('photo-open');
  ph.canvas = null;
  ph.src = null;
}

// ---------- drawing the working image, fitted into the stage

function phRender() {
  const c = ph.canvas;
  if (!c) return;
  const canvas = phEl['ph-canvas'];
  canvas.width = c.width;
  canvas.height = c.height;
  canvas.getContext('2d').drawImage(c, 0, 0);
  const stage = phEl['ph-stage'];
  const pad = 40;
  const maxW = stage.clientWidth - pad, maxH = stage.clientHeight - pad;
  ph.scale = Math.min(1, maxW / c.width, maxH / c.height) || 1;
  const w = Math.round(c.width * ph.scale), h = Math.round(c.height * ph.scale);
  phEl['ph-wrap'].style.width = w + 'px';
  phEl['ph-wrap'].style.height = h + 'px';
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  phEl['ph-size'].textContent = c.width + ' × ' + c.height;
  drawCrop();
}

// ---------- the crop box

function drawCrop() {
  const box = phEl['ph-crop'];
  if (!ph.crop) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const s = ph.scale;
  box.style.left = ph.crop.x * s + 'px';
  box.style.top = ph.crop.y * s + 'px';
  box.style.width = ph.crop.w * s + 'px';
  box.style.height = ph.crop.h * s + 'px';
}

function clampCrop() {
  const c = ph.canvas;
  const r = ph.crop;
  r.w = Math.max(8, Math.min(r.w, c.width));
  r.h = Math.max(8, Math.min(r.h, c.height));
  r.x = Math.max(0, Math.min(r.x, c.width - r.w));
  r.y = Math.max(0, Math.min(r.y, c.height - r.h));
}

// pointer on the image area: draw a new box, move it, or drag a handle
function phPointerDown(e) {
  if (!ph.canvas) return;
  const wrap = phEl['ph-wrap'].getBoundingClientRect();
  const s = ph.scale;
  let lastX = e.clientX, lastY = e.clientY;
  const px = () => clamp((lastX - wrap.left) / s, 0, ph.canvas.width);
  const py = () => clamp((lastY - wrap.top) / s, 0, ph.canvas.height);
  const handle = e.target.dataset ? e.target.dataset.h : null;
  const start = ph.crop ? { x: ph.crop.x, y: ph.crop.y, w: ph.crop.w, h: ph.crop.h } : null;
  const x0 = px(), y0 = py();
  let mode;
  if (handle === 'move' && !cropIsFull()) mode = 'move';
  else if (handle && handle !== 'move') mode = handle;
  else { mode = 'new'; ph.crop = { x: x0, y: y0, w: 0, h: 0 }; }
  phEl['ph-wrap'].setPointerCapture(e.pointerId);
  const move = ev => {
    lastX = ev.clientX; lastY = ev.clientY;
    const x = px(), y = py();
    const r = ph.crop;
    if (mode === 'new') {
      r.x = Math.min(x0, x); r.y = Math.min(y0, y);
      r.w = Math.abs(x - x0); r.h = Math.abs(y - y0);
    } else if (mode === 'move') {
      r.x = start.x + (x - x0); r.y = start.y + (y - y0);
    } else {
      if (mode.indexOf('w') >= 0) { r.w = start.x + start.w - x; r.x = x; }
      if (mode.indexOf('e') >= 0) { r.w = x - r.x; }
      if (mode.indexOf('n') >= 0) { r.h = start.y + start.h - y; r.y = y; }
      if (mode.indexOf('s') >= 0) { r.h = y - r.y; }
      if (r.w < 0) { r.x += r.w; r.w = -r.w; }
      if (r.h < 0) { r.y += r.h; r.h = -r.h; }
    }
    clampCrop();
    drawCrop();
  };
  const up = () => {
    phEl['ph-wrap'].removeEventListener('pointermove', move);
    phEl['ph-wrap'].removeEventListener('pointerup', up);
    if (ph.crop && (ph.crop.w < 8 || ph.crop.h < 8)) fullCrop();
    drawCrop();
  };
  phEl['ph-wrap'].addEventListener('pointermove', move);
  phEl['ph-wrap'].addEventListener('pointerup', up);
}

// ---------- edits

function applyCrop() {
  if (!ph.crop || cropIsFull()) {
    toast('Потяните уголки рамки внутрь, чтобы обрезать');
    return;
  }
  const r = ph.crop;
  const c = document.createElement('canvas');
  c.width = Math.round(r.w);
  c.height = Math.round(r.h);
  c.getContext('2d').drawImage(ph.canvas, Math.round(r.x), Math.round(r.y), c.width, c.height, 0, 0, c.width, c.height);
  ph.canvas = c;
  fullCrop();
  phRender();
}

function rotate(dir) {
  const src = ph.canvas;
  const c = document.createElement('canvas');
  c.width = src.height;
  c.height = src.width;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate(dir * Math.PI / 2);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  ph.canvas = c;
  fullCrop();
  phRender();
}

function flip(horizontal) {
  const src = ph.canvas;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  g.translate(horizontal ? c.width : 0, horizontal ? 0 : c.height);
  g.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
  g.drawImage(src, 0, 0);
  ph.canvas = c;
  fullCrop();
  phRender();
}

// ---------- saving

// the working image, with a pending crop applied, as a data URL in the wanted format
function phData(format) {
  let c = ph.canvas;
  if (ph.crop && !cropIsFull()) {
    const r = ph.crop;
    const t = document.createElement('canvas');
    t.width = Math.round(r.w);
    t.height = Math.round(r.h);
    t.getContext('2d').drawImage(c, Math.round(r.x), Math.round(r.y), t.width, t.height, 0, 0, t.width, t.height);
    c = t;
  }
  if (format === 'jpg') return c.toDataURL('image/jpeg', 0.92);
  if (format === 'webp') return c.toDataURL('image/webp', 0.92);
  return c.toDataURL('image/png'); // png, and the source ffmpeg turns into a gif
}

async function phSave(format) {
  if (!ph.canvas) return;
  try {
    const out = await api.photoExport({ data: phData(format), format, source: ph.src });
    if (out) toast('Сохранено: ' + api.basename(out), 'Показать в папке', () => api.reveal(out));
  } catch (e) {
    toast('Не удалось сохранить: ' + (e && e.message || e));
  }
}

async function phFrames() {
  if (!ph.src) return;
  try {
    const r = await api.gifExtract(ph.src);
    if (r) toast('Сохранено кадров: ' + r.count, 'Показать в папке', () => api.reveal(r.dir));
  } catch (e) {
    toast('Не удалось разобрать GIF: ' + (e && e.message || e));
  }
}

// ---------- wiring

phInit();
phEl['ph-wrap'].addEventListener('pointerdown', phPointerDown);
document.getElementById('ph-open').onclick = async () => {
  const f = await api.openImage();
  if (f) openPhoto(f);
};
document.getElementById('ph-close').onclick = closePhoto;
document.getElementById('ph-rotl').onclick = () => rotate(-1);
document.getElementById('ph-rotr').onclick = () => rotate(1);
document.getElementById('ph-fliph').onclick = () => flip(true);
document.getElementById('ph-flipv').onclick = () => flip(false);
document.getElementById('ph-cropbtn').onclick = applyCrop;
document.getElementById('ph-reset').onclick = () => { if (ph.src) openPhoto(ph.src); };
document.getElementById('ph-png').onclick = () => phSave('png');
document.getElementById('ph-jpg').onclick = () => phSave('jpg');
document.getElementById('ph-gif').onclick = () => phSave('gif');
document.getElementById('ph-frames').onclick = phFrames;
window.addEventListener('resize', () => { if (!phEl['photo'].hidden) phRender(); });
document.addEventListener('keydown', e => {
  if (phEl['photo'].hidden) return;
  if (e.key === 'Escape') closePhoto();
});

const phBig = document.getElementById('btn-photo-big');
if (phBig) phBig.onclick = async () => {
  const f = await api.openImage();
  if (f) openPhoto(f);
};

// ---------- the Photos tab: a gallery of images from chosen folders

const photos = { folders: recall('photoFolders', []), data: [], loaded: false };

async function loadPhotos() {
  photos.loaded = true;
  try {
    photos.data = photos.folders.length ? await api.photosScan(photos.folders) : [];
  } catch {
    photos.data = [];
  }
  renderPhotos();
}

function renderPhotos() {
  const body = document.getElementById('photos-body');
  const any = photos.folders.length > 0;
  const total = photos.data.reduce((n, f) => n + f.files.length, 0);
  document.getElementById('photos-empty').hidden = any;
  body.hidden = !any;
  document.getElementById('photos-count').textContent = any ? total + ' фото' : '';
  body.innerHTML = '';
  for (const folder of photos.data) {
    const sec = document.createElement('div');
    sec.className = 'photos-folder';
    const head = document.createElement('div');
    head.className = 'photos-fhead';
    const name = document.createElement('b');
    name.textContent = folder.name + (folder.exists ? '' : ' (нет на диске)');
    const cnt = document.createElement('span');
    cnt.className = 'photos-fn';
    cnt.textContent = folder.files.length;
    const rm = document.createElement('button');
    rm.className = 'icon sm photos-frm';
    rm.title = 'Убрать папку из «Фото»';
    rm.textContent = '✕';
    rm.onclick = () => {
      photos.folders = photos.folders.filter(d => d !== folder.dir);
      store('photoFolders', photos.folders);
      loadPhotos();
    };
    head.append(name, cnt, rm);
    sec.append(head);
    const grid = document.createElement('div');
    grid.className = 'photos-grid';
    for (const im of folder.files) {
      const card = document.createElement('button');
      card.className = 'photo-card';
      card.title = im.name;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = api.toUrl(im.path);
      const nm = document.createElement('span');
      nm.className = 'photo-name';
      nm.textContent = im.name;
      card.append(img, nm);
      card.onclick = () => openPhoto(im.path);
      grid.append(card);
    }
    sec.append(grid);
    body.append(sec);
  }
}

async function addPhotoFolder() {
  const dir = await api.pickFolder();
  if (!dir) return;
  if (!photos.folders.some(d => d.toLowerCase() === dir.toLowerCase())) {
    photos.folders.push(dir);
    store('photoFolders', photos.folders);
  }
  await loadPhotos();
}

document.getElementById('nav-photos').onclick = () => showView('photos');
document.getElementById('photos-add').onclick = addPhotoFolder;
document.getElementById('photos-add2').onclick = addPhotoFolder;
document.getElementById('photos-refresh').onclick = loadPhotos;
// after saving an edited image back into a watched folder, refresh the gallery next time it opens
