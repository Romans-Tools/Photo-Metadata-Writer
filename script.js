import * as exifr from 'exifr';
import JSZip from 'jszip';
import piexif from 'piexifjs';

const fields = [
  ['title', 'Title'], ['description', 'Caption/Description'], ['credit', 'Photographer/Credit'],
  ['copyright', 'Copyright'], ['eventName', 'Event name'], ['location', 'Location'],
  ['city', 'City'], ['state', 'State'], ['country', 'Country'], ['dateTaken', 'Date taken (YYYY:MM:DD HH:MM:SS)'],
  ['organization', 'Organization/Unit'], ['keywords', 'Keywords/tags (comma separated)']
];

const state = { photos: [], selectedId: null };
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
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/\s+/g, '_').replace(/-+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
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

function applyExifToJpeg(dataUrl, meta) {
  const exif = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null };
  if (meta.title) exif['0th'][piexif.ImageIFD.ImageDescription] = meta.title;
  if (meta.description) exif['0th'][piexif.ImageIFD.XPComment] = meta.description;
  if (meta.credit) exif['0th'][piexif.ImageIFD.Artist] = meta.credit;
  if (meta.copyright) exif['0th'][piexif.ImageIFD.Copyright] = meta.copyright;
  const place = [meta.location, meta.city, meta.state, meta.country].filter(Boolean).join(', ');
  if (place) exif['0th'][piexif.ImageIFD.XPSubject] = place;
  if (meta.dateTaken) exif.Exif[piexif.ExifIFD.DateTimeOriginal] = meta.dateTaken;
  if (meta.keywords) exif['0th'][piexif.ImageIFD.XPKeywords] = meta.keywords;
  const exifStr = piexif.dump(exif);
  return piexif.insert(exifStr, dataUrl);
}

async function processFile(file) {
  const type = file.type.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const readable = await exifr.parse(file).catch(() => ({}));
  const dataUrl = await fileToDataUrl(file);
  const id = crypto.randomUUID();
  const photo = {
    id, file, type, ext, dataUrl, existing: readable || {},
    batchMeta: {}, overrideMeta: {}, rename: '', warning: ''
  };
  if (!['jpg', 'jpeg'].includes(ext)) {
    photo.warning = 'Non-JPEG detected. Embedded metadata writing may be limited for this format.';
  }
  return photo;
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const unsupported = files.filter((f) => !['image/jpeg', 'image/png', 'image/heic', 'image/heif'].includes(f.type) && !/\.(jpe?g|png|heic|heif)$/i.test(f.name));
  if (unsupported.length) {
    el('globalWarnings').innerHTML = `<div class="error">Unsupported file(s): ${unsupported.map((f) => f.name).join(', ')}</div>`;
  }
  const accepted = files.filter((f) => !unsupported.includes(f));
  for (const file of accepted) state.photos.push(await processFile(file));
  if (!state.selectedId && state.photos.length) state.selectedId = state.photos[0].id;
  render();
}

function render() {
  const list = el('filesList');
  list.innerHTML = '';
  const template = el('fileCardTemplate');
  state.photos.forEach((photo, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('.thumb').src = photo.dataUrl;
    const existingDesc = Object.entries(photo.existing || {}).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join('<br>') || 'No readable metadata found.';
    node.querySelector('.file-info').innerHTML = `<strong>${photo.file.name}</strong><br>Renamed to: <strong>${buildRenamedFileName(photo, index)}</strong><br>Size: ${(photo.file.size / 1024).toFixed(1)} KB<br>Type: ${photo.file.type || photo.ext}<br><em>Existing metadata:</em><br>${existingDesc}`;
    node.querySelector('.file-warning').textContent = photo.warning;

    const renameInput = node.querySelector('.rename-input');
    renameInput.value = photo.rename;
    renameInput.addEventListener('input', () => {
      photo.rename = renameInput.value;
      state.selectedId = photo.id;
      render();
    });

    const form = node.querySelector('.photo-form');
    createFields(form, `${photo.id}`, photo.overrideMeta);
    form.addEventListener('input', () => { photo.overrideMeta = formToObject(form); state.selectedId = photo.id; });
    node.querySelector('.download-one').addEventListener('click', () => downloadOne(photo, index));
    list.appendChild(node);
  });
}

async function updatedBlob(photo) {
  const meta = mergeMetadata(photo.batchMeta, photo.overrideMeta);
  if (!Object.values(meta).some(Boolean)) throw new Error('No metadata entered. Fill at least one field.');
  if (['jpg', 'jpeg'].includes(photo.ext)) {
    const written = applyExifToJpeg(photo.dataUrl, meta);
    const res = await fetch(written);
    return await res.blob();
  }
  throw new Error('Metadata embedding is not fully supported for this file type in-browser. Use CSV export or JPEG.');
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
  } catch (err) { alert(err.message); }
}

function toCsv() {
  const headers = ['filename', 'renamedFilename', ...fields.map(([k]) => k)];
  const rows = state.photos.map((p, index) => {
    const meta = mergeMetadata(p.batchMeta, p.overrideMeta);
    return [p.file.name, buildRenamedFileName(p, index), ...fields.map(([k]) => (meta[k] || '').replaceAll('"', '""'))].map((v) => `"${v}"`).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

createFields(el('batchForm'), 'batch');
el('applyAllBtn').addEventListener('click', () => {
  const meta = formToObject(el('batchForm'));
  if (!Object.values(meta).some(Boolean)) return alert('No metadata entered in batch form.');
  state.photos.forEach((p) => { p.batchMeta = { ...meta }; });
  render();
});

['renamePrefix', 'renameSuffix', 'renameStart', 'renameDigits'].forEach((id) => {
  el(id).addEventListener('input', () => render());
});

el('downloadSelectedBtn').addEventListener('click', async () => {
  const selected = state.photos.find((p) => p.id === state.selectedId) || state.photos[0];
  if (!selected) return alert('No photo selected.');
  const idx = state.photos.findIndex((p) => p.id === selected.id);
  await downloadOne(selected, idx);
});

el('downloadAllBtn').addEventListener('click', async () => {
  if (!state.photos.length) return alert('No photos uploaded.');
  const zip = new JSZip();
  for (const [index, p] of state.photos.entries()) {
    try {
      const blob = await updatedBlob(p);
      zip.file(buildRenamedFileName(p, index), blob);
    } catch (err) {
      zip.file(`${p.file.name}.txt`, `Metadata write failed: ${err.message}`);
    }
  }
  const content = await zip.generateAsync({ type: 'blob' });
  downloadBlob(content, 'photo-metadata-writer.zip');
});

el('exportCsvBtn').addEventListener('click', () => {
  const csv = toCsv();
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'photo-metadata.csv');
});

const dropzone = el('dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
el('fileInput').addEventListener('change', (e) => handleFiles(e.target.files));
