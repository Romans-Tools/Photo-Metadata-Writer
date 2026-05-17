import * as exifr from 'exifr';
import JSZip from 'jszip';
import piexif from 'piexifjs';

const fields = [
  ['title', 'Title'], ['description', 'Caption / Description'], ['credit', 'Photographer / Credit'],
  ['copyright', 'Copyright'], ['eventName', 'Event Name'], ['location', 'Location'],
  ['city', 'City'], ['state', 'State'], ['country', 'Country'], ['dateTaken', 'Date Taken (YYYY:MM:DD HH:MM:SS)'],
  ['organization', 'Organization / Unit'], ['keywords', 'Keywords / Tags (comma separated)']
];

const state = { photos: [] };
const el = (id) => document.getElementById(id);

function createFields(form, prefix, values = {}) {
  form.innerHTML = '';
  fields.forEach(([key, label]) => {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const input = document.createElement('input');
    input.name = key;
    input.value = values[key] ?? '';
    input.placeholder = label;
    input.id = `${prefix}-${key}`;
    wrap.appendChild(input);
    form.appendChild(wrap);
  });
}

function formToObject(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v).trim()]));
}

function mergeMetadata(base, override) {
  const merged = { ...base };
  for (const [k, v] of Object.entries(override)) if (v) merged[k] = v;
  return merged;
}

function sanitizeFileNamePart(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '_').replace(/-+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
}

function getFileStemAndExt(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { stem: fileName, ext: '' };
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

function buildRenamedFileName(photo, index) {
  const { stem, ext } = getFileStemAndExt(photo.file.name);
  const custom = sanitizeFileNamePart(photo.rename || '');
  if (custom) return `${custom}${ext}`;

  const prefix = sanitizeFileNamePart(el('renamePrefix').value.trim());
  const suffix = sanitizeFileNamePart(el('renameSuffix').value.trim());
  const digits = Math.max(1, Number.parseInt(el('renameDigits').value || '3', 10));
  const startAt = Number.parseInt(el('renameStart').value || '1', 10);
  const sequence = String(startAt + index).padStart(digits, '0');

  const newStem = [prefix, stem, suffix, sequence].filter(Boolean).join('_');
  return `${newStem || stem}${ext}`;
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function toWindowsXpBytes(value) {
  const bytes = [];
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (code > 0xffff) {
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const low = ((code - 0x10000) % 0x400) + 0xdc00;
      bytes.push(high & 0xff, high >> 8, low & 0xff, low >> 8);
    } else {
      bytes.push(code & 0xff, code >> 8);
    }
  }
  bytes.push(0, 0);
  return bytes;
}

function applyExifToJpeg(dataUrl, meta) {
  const exif = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null };
  if (meta.title) exif['0th'][piexif.ImageIFD.ImageDescription] = meta.title;
  if (meta.description) exif['0th'][piexif.ImageIFD.XPComment] = toWindowsXpBytes(meta.description);
  if (meta.credit) exif['0th'][piexif.ImageIFD.Artist] = meta.credit;
  if (meta.copyright) exif['0th'][piexif.ImageIFD.Copyright] = meta.copyright;
  const place = [meta.location, meta.city, meta.state, meta.country].filter(Boolean).join(', ');
  if (place) exif['0th'][piexif.ImageIFD.XPSubject] = toWindowsXpBytes(place);
  if (meta.dateTaken) exif.Exif[piexif.ExifIFD.DateTimeOriginal] = meta.dateTaken;
  if (meta.keywords) exif['0th'][piexif.ImageIFD.XPKeywords] = toWindowsXpBytes(meta.keywords);
  const exifStr = piexif.dump(exif);
  return piexif.insert(exifStr, dataUrl);
}

async function processFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const readable = await exifr.parse(file).catch(() => ({}));
  const dataUrl = await fileToDataUrl(file);
  const id = crypto.randomUUID();
  const photo = {
    id, file, ext, dataUrl, existing: readable || {},
    batchMeta: {}, overrideMeta: {}, rename: '', warning: ''
  };
  if (!['jpg', 'jpeg'].includes(ext)) {
    photo.warning = 'Non-JPEG file — metadata will be included in CSV export but cannot be embedded in this format.';
  }
  return photo;
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  el('globalWarnings').innerHTML = '';
  const unsupported = files.filter((f) =>
    !['image/jpeg', 'image/png', 'image/heic', 'image/heif'].includes(f.type) &&
    !/\.(jpe?g|png|heic|heif)$/i.test(f.name)
  );
  if (unsupported.length) {
    el('globalWarnings').innerHTML = `<div class="error">Unsupported: ${unsupported.map((f) => f.name).join(', ')}</div>`;
  }
  const accepted = files.filter((f) => !unsupported.includes(f));
  const failed = [];
  for (const file of accepted) {
    try {
      state.photos.push(await processFile(file));
    } catch (err) {
      failed.push(`${file.name} (${err.message})`);
    }
  }
  if (failed.length) {
    el('globalWarnings').innerHTML += `<div class="error">Could not load: ${failed.join(', ')}</div>`;
  }
  updateUI();
  render();
}

function filesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];

  const itemFiles = [...(dataTransfer.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (itemFiles.length) return itemFiles;
  return [...(dataTransfer.files || [])];
}

function removePhoto(id) {
  state.photos = state.photos.filter((p) => p.id !== id);
  updateUI();
  render();
}

function clearAllPhotos() {
  state.photos = [];
  updateUI();
  render();
  showToast('All photos cleared');
}

function updateUI() {
  const hasPhotos = state.photos.length > 0;
  el('gallerySection').hidden = !hasPhotos;
  el('metadataSection').hidden = !hasPhotos;
  el('renameSection').hidden = !hasPhotos;
  el('downloadSection').hidden = !hasPhotos;
  el('photoCount').textContent = state.photos.length;

  const steps = document.querySelectorAll('.step');
  const connectors = document.querySelectorAll('.step-connector');
  steps[0].classList.add('active');
  steps[1].classList.toggle('active', hasPhotos);
  steps[2].classList.toggle('active', hasPhotos);
  if (connectors.length >= 2) {
    connectors[0].classList.toggle('active', hasPhotos);
    connectors[1].classList.toggle('active', hasPhotos);
  }
}

function render() {
  const list = el('filesList');
  list.innerHTML = '';
  const template = el('fileCardTemplate');
  state.photos.forEach((photo, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.style.animationDelay = `${index * 40}ms`;

    node.querySelector('.photo-thumb').src = photo.dataUrl;

    const meta = mergeMetadata(photo.batchMeta, photo.overrideMeta);
    const hasMeta = Object.values(meta).some(Boolean);
    const statusEl = node.querySelector('.photo-status');
    if (hasMeta) {
      statusEl.textContent = 'Metadata set';
      statusEl.classList.add('has-meta');
    } else {
      statusEl.textContent = 'No metadata';
    }

    node.querySelector('.photo-name').textContent = photo.file.name;
    node.querySelector('.photo-rename-preview').textContent = `→ ${buildRenamedFileName(photo, index)}`;
    node.querySelector('.photo-size').textContent = `${(photo.file.size / 1024).toFixed(1)} KB · ${photo.file.type || photo.ext.toUpperCase()}`;

    node.querySelector('.photo-warning').textContent = photo.warning;

    node.querySelector('.photo-remove').addEventListener('click', () => removePhoto(photo.id));

    const renameInput = node.querySelector('.rename-input');
    renameInput.value = photo.rename;
    renameInput.addEventListener('input', () => {
      photo.rename = renameInput.value;
      render();
    });

    const form = node.querySelector('.photo-form');
    createFields(form, photo.id, photo.overrideMeta);
    form.addEventListener('input', () => {
      photo.overrideMeta = formToObject(form);
    });

    node.querySelector('.download-one').addEventListener('click', () => downloadOne(photo, index));

    list.appendChild(node);
  });
}

async function updatedBlob(photo) {
  const meta = mergeMetadata(photo.batchMeta, photo.overrideMeta);
  if (['jpg', 'jpeg'].includes(photo.ext)) {
    if (!Object.values(meta).some(Boolean)) {
      const res = await fetch(photo.dataUrl);
      return await res.blob();
    }
    const written = applyExifToJpeg(photo.dataUrl, meta);
    const res = await fetch(written);
    return await res.blob();
  }
  const res = await fetch(photo.dataUrl);
  return await res.blob();
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadOne(photo, index) {
  try {
    const blob = await updatedBlob(photo);
    downloadBlob(blob, buildRenamedFileName(photo, index));
  } catch (err) {
    showToast(err.message);
  }
}

function toCsv() {
  const headers = ['filename', 'renamedFilename', ...fields.map(([k]) => k)];
  const rows = state.photos.map((p, index) => {
    const meta = mergeMetadata(p.batchMeta, p.overrideMeta);
    return [p.file.name, buildRenamedFileName(p, index), ...fields.map(([k]) => (meta[k] || '').replaceAll('"', '""'))].map((v) => `"${v}"`).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

function showProgress(text) {
  el('progressOverlay').hidden = false;
  el('progressText').textContent = text || 'Processing photos…';
  el('progressFill').style.width = '0%';
}

function updateProgress(fraction, text) {
  el('progressFill').style.width = `${Math.round(fraction * 100)}%`;
  if (text) el('progressText').textContent = text;
}

function hideProgress() {
  el('progressOverlay').hidden = true;
}

let toastTimer;
function showToast(message) {
  const t = el('toast');
  t.textContent = message;
  t.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), 2800);
}

createFields(el('batchForm'), 'batch');

el('applyAllBtn').addEventListener('click', () => {
  const meta = formToObject(el('batchForm'));
  if (!Object.values(meta).some(Boolean)) {
    showToast('Fill in at least one metadata field first');
    return;
  }
  state.photos.forEach((p) => { p.batchMeta = { ...meta }; });
  render();
  showToast(`Metadata applied to ${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}`);
});

['renamePrefix', 'renameSuffix', 'renameStart', 'renameDigits'].forEach((id) => {
  el(id).addEventListener('input', () => render());
});

el('clearAllBtn').addEventListener('click', clearAllPhotos);

el('downloadAllBtn').addEventListener('click', async () => {
  if (!state.photos.length) {
    showToast('Upload photos first');
    return;
  }
  showProgress('Preparing ZIP file…');
  const zip = new JSZip();
  const total = state.photos.length;
  for (const [index, p] of state.photos.entries()) {
    updateProgress((index + 1) / total, `Processing ${index + 1} of ${total}…`);
    try {
      const blob = await updatedBlob(p);
      zip.file(buildRenamedFileName(p, index), blob);
    } catch (err) {
      zip.file(`${p.file.name}.error.txt`, `Metadata write failed: ${err.message}`);
    }
  }
  updateProgress(1, 'Compressing…');
  const content = await zip.generateAsync({ type: 'blob' });
  hideProgress();
  downloadBlob(content, 'photo-metadata-writer.zip');
  showToast('ZIP download started');
});

el('exportCsvBtn').addEventListener('click', () => {
  if (!state.photos.length) {
    showToast('Upload photos first');
    return;
  }
  const csv = toCsv();
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'photo-metadata.csv');
  showToast('CSV export started');
});

function openFilePicker() {
  const input = el('fileInput');
  if (typeof input.showPicker === 'function') {
    input.showPicker();
    return;
  }
  input.click();
}

const dropzone = el('dropzone');
let dragDepth = 0;

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
    }
  });
});

dropzone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('dragover');
  handleFiles(filesFromDataTransfer(e.dataTransfer));
});

dropzone.addEventListener('click', (e) => {
  if (e.target.closest('label[for="fileInput"]')) return;
  openFilePicker();
});

dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openFilePicker();
  }
});

el('fileInput').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});
