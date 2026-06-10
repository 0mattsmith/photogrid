/*
 * PhotoGrid — web version
 *
 *   • Drag photos in, arrange them in a grid, export to PDF or DOCX.
 *   • Each image is center-cropped to a square that fits into a fixed cell
 *     (default 4.4 cm × 4.4 cm).
 *   • Default grid: 4 columns × 5 rows on A4 portrait.
 *   • All processing happens client-side — no server, no upload.
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────────────

const SUPPORTED_EXT = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "tif", "tiff",
  "webp", "ico", "heic", "heif", "hif", "heics", "heifs", "avif",
]);

// Page sizes in mm (portrait)
const PAGE_SIZES_MM = {
  A4:     { w: 210.0, h: 297.0 },
  Letter: { w: 215.9, h: 279.4 },
  Legal:  { w: 215.9, h: 355.6 },
};

const state = {
  images: [],
  // Per-image record:
  //   { id, file, name, loading?, error?,
  //     sourceBlob,     // original image (or HEIC->JPEG conversion) used for export
  //     previewUrl,     // ObjectURL to a small thumbnail blob — used on screen
  //     w, h,           // natural dimensions of the source image
  //     cropAnchor: {x, y},  // 0..1 each, drag-to-pan crop offset
  //     croppedDataUrl, croppedKey   // export crop cache
  //   }
  selectedId: null,
  settings: {
    rows: 5,
    cols: 4,
    cellSizeCm: 4.4,
    pageSize: "A4",
    orientation: "portrait",
    marginMm: 12,
    spacingMm: 3,
    trimEmptyRows: true,
    squareCrop: true,
    // "Reduce File Size" — like MS Word's option. Controls DPI + JPEG quality
    // used when rendering crops for export. Has no effect on the on-screen
    // preview, which always uses the small thumbnail.
    outputQuality: "print",  // "print" | "reduced" | "minimum"
  },
};

// DPI + JPEG quality profile for each output-quality preset.
const QUALITY_PROFILES = {
  print:   { dpi: 300, jpeg: 0.92, label: "Print" },
  reduced: { dpi: 200, jpeg: 0.82, label: "Reduced" },
  minimum: { dpi: 110, jpeg: 0.72, label: "Minimum" },
};

// Thumbnail size used everywhere on screen. ~800px is plenty for retina
// display at the cell sizes we use, and keeps rendering and memory cheap.
const THUMB_MAX_PX = 800;
const THUMB_JPEG_Q = 0.85;

// Image ingestion concurrency — too high and HEIC decode contends with itself.
const INGEST_CONCURRENCY = 3;

let _idCounter = 0;
const nextId = () => `img_${++_idCounter}`;

// ─── DOM refs ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const els = {
  status:      $("statusBar"),
  drop:        $("dropTarget"),
  dropOverlay: $("dropOverlay"),
  fileList:    $("fileList"),
  fileInput:   $("fileInput"),
  btnAdd:      $("btnAdd"),
  btnUp:       $("btnUp"),
  btnDown:     $("btnDown"),
  btnRemove:   $("btnRemove"),
  btnClear:    $("btnClear"),
  preview:     $("previewStack"),
  previewScroll: $("previewScroll"),
  ctlRows:     $("ctlRows"),
  ctlCols:     $("ctlCols"),
  ctlCellCm:   $("ctlCellCm"),
  ctlPage:     $("ctlPage"),
  ctlOrient:   $("ctlOrient"),
  ctlMargin:   $("ctlMargin"),
  ctlSpacing:  $("ctlSpacing"),
  outMargin:   $("outMargin"),
  outSpacing:  $("outSpacing"),
  ctlTrim:     $("ctlTrim"),
  ctlSquareCrop: $("ctlSquareCrop"),
  ctlQuality:  $("ctlQuality"),
  btnExportPdf:  $("btnExportPdf"),
  btnExportDocx: $("btnExportDocx"),
  busy:        $("busyOverlay"),
  busyText:    $("busyText"),
  cropEditor:  $("cropEditor"),
  cropFrame:   $("cropFrame"),
  cropImage:   $("cropImage"),
  cropName:    $("cropName"),
  btnResetCrop:$("btnResetCrop"),
  netIndicator:$("netIndicator"),
  btnInstall:  $("btnInstall"),
  iosInstallTip: $("iosInstallTip"),
  btnDismissIosTip: $("btnDismissIosTip"),
};

// ─── Init ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  syncControlsFromState();
  attachEventListeners();
  attachCropDragHandlers();
  initNetworkIndicator();
  initInstallable();
  render();
});

// ─── PWA install (Chrome/Edge/Android prompt + iOS Safari fallback) ─────
// On Chromium-family browsers the page can prompt the user to install once
// the manifest, service worker, and engagement criteria are all satisfied.
// We hold onto the deferred event and trigger it when the user clicks
// "Install app". iOS Safari uses Share → Add to Home Screen, which we just
// document in a dismissable tip on first visit.

let _deferredInstallPrompt = null;

function initInstallable() {
  // Hide everything in standalone (already installed)
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (isStandalone) {
    els.btnInstall.hidden = true;
    els.iosInstallTip.hidden = true;
    return;
  }

  // Chromium-family: catch the deferred prompt
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    els.btnInstall.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    els.btnInstall.hidden = true;
    els.iosInstallTip.hidden = true;
    setStatus("App installed. Look for PhotoGrid in your apps.");
  });

  els.btnInstall.addEventListener("click", async () => {
    if (!_deferredInstallPrompt) return;
    els.btnInstall.disabled = true;
    try {
      _deferredInstallPrompt.prompt();
      const { outcome } = await _deferredInstallPrompt.userChoice;
      if (outcome === "accepted") {
        els.btnInstall.hidden = true;
      }
    } catch (e) {
      console.warn("install prompt failed", e);
    } finally {
      els.btnInstall.disabled = false;
      _deferredInstallPrompt = null;
    }
  });

  // iOS Safari fallback — show the tip once if relevant
  if (isIosSafari() && !localStorage.getItem("photogrid:iosTipDismissed")) {
    els.iosInstallTip.hidden = false;
  }
  els.btnDismissIosTip.addEventListener("click", () => {
    els.iosInstallTip.hidden = true;
    try { localStorage.setItem("photogrid:iosTipDismissed", "1"); } catch (_) {}
  });
}

function isIosSafari() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && isSafari;
}

// ─── Online/offline indicator ─────────────────────────────────────────────
// Cosmetic only — the app works the same whether online or offline because
// no photo data ever leaves this browser. The indicator just confirms that
// to the user.

function initNetworkIndicator() {
  const update = () => {
    const online = navigator.onLine;
    els.netIndicator.classList.toggle("offline", !online);
    els.netIndicator.title = online
      ? "Online — but your photos still stay on this device."
      : "Offline — app and libraries are cached, photos still process locally.";
  };
  window.addEventListener("online",  update);
  window.addEventListener("offline", update);
  update();
}

function setStatus(text) { els.status.textContent = text; }
function showBusy(text)  { els.busyText.textContent = text || "Working…"; els.busy.hidden = false; }
function hideBusy()       { els.busy.hidden = true; }

// ─── Settings → Controls (and back) ───────────────────────────────────────

function syncControlsFromState() {
  const s = state.settings;
  els.ctlRows.value     = s.rows;
  els.ctlCols.value     = s.cols;
  els.ctlCellCm.value   = s.cellSizeCm;
  els.ctlPage.value     = s.pageSize;
  els.ctlOrient.value   = s.orientation;
  els.ctlMargin.value   = s.marginMm;
  els.ctlSpacing.value  = s.spacingMm;
  els.outMargin.value   = `${s.marginMm} mm`;
  els.outSpacing.value  = `${s.spacingMm} mm`;
  els.ctlTrim.checked   = s.trimEmptyRows;
  els.ctlSquareCrop.checked = s.squareCrop;
  els.ctlQuality.value  = s.outputQuality;
}

function attachEventListeners() {
  // Numeric inputs — realtime
  els.ctlRows.addEventListener("input", () => {
    state.settings.rows = clamp(parseInt(els.ctlRows.value) || 1, 1, 30);
    render();
  });
  els.ctlCols.addEventListener("input", () => {
    state.settings.cols = clamp(parseInt(els.ctlCols.value) || 1, 1, 30);
    render();
  });
  els.ctlCellCm.addEventListener("input", () => {
    state.settings.cellSizeCm = clamp(parseFloat(els.ctlCellCm.value) || 1, 0.5, 20);
    // Live preview reads the thumbnail with bg-position so it updates instantly.
    // Cached export crops at the old size are now stale — invalidate them;
    // they'll be regenerated lazily on the next export.
    for (const im of state.images) { im.croppedDataUrl = null; im.croppedKey = null; }
    render();
  });
  els.ctlPage.addEventListener("change", () => { state.settings.pageSize = els.ctlPage.value; render(); });
  els.ctlOrient.addEventListener("change", () => { state.settings.orientation = els.ctlOrient.value; render(); });
  els.ctlMargin.addEventListener("input", () => {
    state.settings.marginMm = parseInt(els.ctlMargin.value) || 0;
    els.outMargin.value = `${state.settings.marginMm} mm`;
    render();
  });
  els.ctlSpacing.addEventListener("input", () => {
    state.settings.spacingMm = parseInt(els.ctlSpacing.value) || 0;
    els.outSpacing.value = `${state.settings.spacingMm} mm`;
    render();
  });
  els.ctlTrim.addEventListener("change", () => { state.settings.trimEmptyRows = els.ctlTrim.checked; render(); });
  els.ctlSquareCrop.addEventListener("change", () => {
    state.settings.squareCrop = els.ctlSquareCrop.checked;
    for (const im of state.images) { im.croppedDataUrl = null; im.croppedKey = null; }
    render();
  });
  els.ctlQuality.addEventListener("change", () => {
    state.settings.outputQuality = els.ctlQuality.value;
    // Invalidate cached export crops — they were rendered at the old DPI/quality.
    for (const im of state.images) { im.croppedDataUrl = null; im.croppedKey = null; }
    setStatus(`Export quality: ${QUALITY_PROFILES[state.settings.outputQuality].label}.`);
  });

  // File buttons
  els.btnAdd.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => {
    if (e.target.files?.length) ingestFiles(e.target.files);
    e.target.value = ""; // allow re-selecting same files
  });
  els.btnUp.addEventListener   ("click", () => shiftSelection(-1));
  els.btnDown.addEventListener ("click", () => shiftSelection(+1));
  els.btnRemove.addEventListener("click", () => removeSelected());
  els.btnClear.addEventListener ("click", () => {
    if (state.images.length && confirm("Remove all photos from the list?")) {
      for (const im of state.images) {
        if (im.previewUrl) URL.revokeObjectURL(im.previewUrl);
      }
      state.images = [];
      state.selectedId = null;
      render();
    }
  });

  // Export
  els.btnExportPdf.addEventListener ("click", exportPdf);
  els.btnExportDocx.addEventListener("click", exportDocx);

  // Drag and drop — anywhere in the window
  ["dragenter", "dragover"].forEach(evt =>
    window.addEventListener(evt, (e) => {
      if (hasFiles(e.dataTransfer)) {
        e.preventDefault();
        els.dropOverlay.hidden = false;
      }
    }));
  ["dragleave", "drop"].forEach(evt =>
    window.addEventListener(evt, (e) => {
      // Only hide overlay if we're truly leaving the window
      if (evt === "dragleave" && e.relatedTarget) return;
      els.dropOverlay.hidden = true;
    }));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) ingestFiles(e.dataTransfer.files);
  });

  // Keyboard navigation
  window.addEventListener("keydown", onKeyDown);
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hasFiles(dt) { return dt?.types?.some(t => t === "Files"); }

// ─── File ingestion + HEIC conversion + square crop ──────────────────────

async function ingestFiles(fileList) {
  const files = Array.from(fileList).filter((f) => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    return SUPPORTED_EXT.has(ext) || f.type.startsWith("image/");
  });
  if (!files.length) {
    setStatus("No supported image files in that drop.");
    return;
  }

  // Push placeholder records immediately so the user sees the items appear in
  // the list right away. Each placeholder is then hydrated in parallel.
  const placeholders = files.map((f) => ({
    id: nextId(), file: f, name: f.name,
    loading: true,
    sourceBlob: null, previewUrl: null,
    w: 0, h: 0,
    cropAnchor: { x: 0.5, y: 0.5 },
    croppedDataUrl: null, croppedKey: null,
  }));
  state.images.push(...placeholders);
  if (!state.selectedId && state.images.length) {
    state.selectedId = state.images.find((i) => i.loading)?.id || state.images[0].id;
  }
  renderFileList();
  renderPreview();

  setStatus(`Loading ${files.length} image${files.length > 1 ? "s" : ""}…`);

  // Worker pool — keeps HEIC decode from monopolizing the main thread and
  // gives a steady stream of completed items rather than a long blank wait.
  let done = 0;
  const queue = placeholders.slice();
  const work = async () => {
    while (queue.length) {
      const ph = queue.shift();
      try {
        const data = await loadImage(ph.file);
        Object.assign(ph, data);
      } catch (e) {
        console.error("Failed to load", ph.file?.name, e);
        ph.error = e.message || String(e);
      }
      ph.loading = false;
      done++;
      setStatus(`Loaded ${done}/${files.length}…`);
      renderFileList();
      schedulePreviewRedraw();
    }
  };
  await Promise.all(Array.from({ length: INGEST_CONCURRENCY }, work));

  setStatus(`${state.images.length} photo${state.images.length === 1 ? "" : "s"} loaded.`);
  render();
}

// Coalesce preview redraws during bulk ingest so we aren't rebuilding the
// preview DOM after every single image finishes.
let _previewRedrawTO = null;
function schedulePreviewRedraw() {
  if (_previewRedrawTO) return;
  _previewRedrawTO = setTimeout(() => {
    _previewRedrawTO = null;
    renderPreview();
  }, 80);
}

/**
 * Load + thumbnail an image file. Returns a partial record:
 *   { sourceBlob, previewUrl, w, h }
 * sourceBlob is the original (or HEIC-decoded) blob, kept for export-time
 * cropping. previewUrl is an object URL to a small JPEG thumbnail used for
 * everything on screen — list, preview cells, crop editor.
 */
async function loadImage(file) {
  let blob = file;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isHeic = ext === "heic" || ext === "heif" || ext === "hif" ||
                 ext === "heics" || ext === "heifs" ||
                 file.type === "image/heic" || file.type === "image/heif";
  if (isHeic) {
    if (typeof heic2any !== "function") {
      throw new Error("HEIC decoder not loaded — check your internet connection and reload.");
    }
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    blob = Array.isArray(converted) ? converted[0] : converted;
  }

  // Decode the source once to get natural dimensions + a downscaled thumbnail.
  const sourceUrl = URL.createObjectURL(blob);
  let imgEl;
  try {
    imgEl = await loadHtmlImage(sourceUrl);
  } finally {
    // Released after we draw the thumbnail below
  }
  let previewBlob;
  try {
    previewBlob = await makeThumbnailBlob(imgEl, THUMB_MAX_PX, THUMB_JPEG_Q);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
  return {
    sourceBlob: blob,
    previewUrl: URL.createObjectURL(previewBlob),
    w: imgEl.naturalWidth,
    h: imgEl.naturalHeight,
  };
}

function makeThumbnailBlob(imgEl, maxDim, jpegQ) {
  const scale = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
  const w = Math.max(1, Math.round(imgEl.naturalWidth * scale));
  const h = Math.max(1, Math.round(imgEl.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imgEl, 0, 0, w, h);
  return new Promise((res, rej) => {
    canvas.toBlob((b) => b ? res(b) : rej(new Error("Thumbnail encode failed")),
                  "image/jpeg", jpegQ);
  });
}

/** Generate the export-resolution crop for a single image, cached.
 *  Only used at export time; live preview uses the thumbnail with
 *  CSS background-position, which is instant. */
async function ensureCrop(image) {
  if (image.error || !image.sourceBlob) return;
  const profile = QUALITY_PROFILES[state.settings.outputQuality] || QUALITY_PROFILES.print;
  const key = cropSettingsKey(image, profile);
  if (image.croppedDataUrl && image.croppedKey === key) return;

  const sizePx = Math.round(state.settings.cellSizeCm * profile.dpi / 2.54);
  const sourceUrl = URL.createObjectURL(image.sourceBlob);
  try {
    const img = await loadHtmlImage(sourceUrl);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (state.settings.squareCrop) {
      // Square center-crop with per-image anchor offset
      const srcSize = Math.min(img.naturalWidth, img.naturalHeight);
      const ax = image.cropAnchor?.x ?? 0.5;
      const ay = image.cropAnchor?.y ?? 0.5;
      const sx = (img.naturalWidth  - srcSize) * ax;
      const sy = (img.naturalHeight - srcSize) * ay;
      canvas.width = sizePx;
      canvas.height = sizePx;
      ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, sizePx, sizePx);
    } else {
      // Fit-without-cropping: downscale entire image to fit a square at sizePx
      const s = Math.min(sizePx / img.naturalWidth, sizePx / img.naturalHeight, 1);
      const w = Math.max(1, Math.round(img.naturalWidth  * s));
      const h = Math.max(1, Math.round(img.naturalHeight * s));
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
    }
    image.croppedDataUrl = canvas.toDataURL("image/jpeg", profile.jpeg);
    image.croppedKey = key;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function cropSettingsKey(image, profile) {
  const a = image?.cropAnchor || { x: 0.5, y: 0.5 };
  const p = profile || QUALITY_PROFILES.print;
  return `${state.settings.cellSizeCm}@${state.settings.squareCrop}` +
         `@${a.x.toFixed(4)},${a.y.toFixed(4)}` +
         `@${p.dpi}@${p.jpeg}`;
}

function loadHtmlImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error("HTML image load failed"));
    img.src = src;
  });
}

/* Crops are generated lazily at export time via ensureCrop(). */

// ─── Selection + ordering ────────────────────────────────────────────────

function selectImageById(id) {
  state.selectedId = id;
  renderFileList();
  renderPreview();
}

function selectedIndex() {
  return state.images.findIndex(i => i.id === state.selectedId);
}

function shiftSelection(delta) {
  const i = selectedIndex();
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= state.images.length) return;
  [state.images[i], state.images[j]] = [state.images[j], state.images[i]];
  render();
}

function removeSelected() {
  const i = selectedIndex();
  if (i < 0) return;
  const [removed] = state.images.splice(i, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  state.selectedId = state.images[i]?.id || state.images[i - 1]?.id || null;
  render();
}

function onKeyDown(e) {
  // Don't hijack arrows while the user is typing in a control
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    if (!(tag === "input" && (e.target.type === "checkbox" || e.target.type === "range"))) {
      return;
    }
  }
  if (!state.images.length) return;

  if (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp"   || e.key === "ArrowDown") {
    e.preventDefault();
    const cols = state.settings.cols || 1;
    const idx = selectedIndex();
    const cur = idx < 0 ? 0 : idx;
    let next = cur;
    if (e.key === "ArrowLeft")  next = Math.max(0, cur - 1);
    if (e.key === "ArrowRight") next = Math.min(state.images.length - 1, cur + 1);
    if (e.key === "ArrowUp")    next = Math.max(0, cur - cols);
    if (e.key === "ArrowDown")  next = Math.min(state.images.length - 1, cur + cols);
    selectImageById(state.images[next].id);
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    removeSelected();
  }
}

// ─── Page layout math ─────────────────────────────────────────────────────

function getPageDimsMm() {
  const base = PAGE_SIZES_MM[state.settings.pageSize] || PAGE_SIZES_MM.A4;
  return state.settings.orientation === "landscape"
    ? { w: base.h, h: base.w }
    : { w: base.w, h: base.h };
}

/**
 * Page descriptor list. Each page knows its image range and how many rows
 * to draw (the last page can be trimmed when trim_empty_rows is on).
 */
function pages() {
  const s = state.settings;
  const cols = Math.max(1, s.cols);
  const rowsPer = Math.max(1, s.rows);
  const perPage = cols * rowsPer;
  const n = state.images.length;
  if (n === 0) {
    return [{ start: 0, count: 0, rows: rowsPer, cols }];
  }
  const out = [];
  for (let start = 0; start < n; start += perPage) {
    const count = Math.min(perPage, n - start);
    const isLast = start + count >= n;
    const rows = isLast && s.trimEmptyRows
      ? Math.max(1, Math.ceil(count / cols))
      : rowsPer;
    out.push({ start, count, rows, cols });
  }
  return out;
}

// ─── Render ───────────────────────────────────────────────────────────────

function render() {
  renderFileList();
  renderPreview();
  renderCropEditor();
}

// ─── Crop editor (per-image drag-to-pan) ─────────────────────────────────

function getSelectedImage() {
  return state.images.find(i => i.id === state.selectedId) || null;
}

function renderCropEditor() {
  const im = getSelectedImage();
  if (!im || !im.previewUrl || im.error || !state.settings.squareCrop) {
    els.cropEditor.hidden = true;
    return;
  }
  els.cropEditor.hidden = false;
  els.cropName.textContent = im.name;
  // Thumbnail with cover + anchor position so what's visible inside the frame
  // is exactly what gets exported.
  els.cropImage.style.backgroundImage = `url(${im.previewUrl})`;
  els.cropImage.style.backgroundSize = "cover";
  els.cropImage.style.backgroundPosition =
    `${(im.cropAnchor.x * 100).toFixed(2)}% ${(im.cropAnchor.y * 100).toFixed(2)}%`;
}

// Drag-to-pan inside the crop frame
let _drag = null;
function attachCropDragHandlers() {
  const frame = els.cropFrame;

  const begin = (clientX, clientY) => {
    const im = getSelectedImage();
    if (!im || im.error || !im.previewUrl) return;
    _drag = {
      startX: clientX, startY: clientY,
      startAnchor: { ...im.cropAnchor },
      frame: frame.getBoundingClientRect(),
      imgW: im.w, imgH: im.h,
      id: im.id,
    };
  };
  const move = (clientX, clientY) => {
    if (!_drag) return;
    const im = state.images.find(i => i.id === _drag.id);
    if (!im) return;
    const dx = clientX - _drag.startX;
    const dy = clientY - _drag.startY;
    // Background-size: cover behavior:
    //   For each axis, the scaled image extends past the frame by
    //     overflow_axis = frame_axis * (other_dim/this_dim - 1)
    //   only on the LONGER axis. Pan range (px) = overflow_axis.
    //   bg-position percent moves the image by overflow at 100%.
    let dax = 0, day = 0;
    const W = _drag.imgW, H = _drag.imgH;
    if (W < H) {
      const overflowY = _drag.frame.height * (H / W - 1);
      if (overflowY > 0) day = -dy / overflowY;
    } else if (H < W) {
      const overflowX = _drag.frame.width * (W / H - 1);
      if (overflowX > 0) dax = -dx / overflowX;
    }
    im.cropAnchor.x = clamp(_drag.startAnchor.x + dax, 0, 1);
    im.cropAnchor.y = clamp(_drag.startAnchor.y + day, 0, 1);
    // Invalidate cached export crop
    im.croppedDataUrl = null; im.croppedKey = null;
    // Update editor view + every preview cell of this image
    renderCropEditor();
    updatePreviewCellsFor(im);
  };
  const end = () => { _drag = null; };

  frame.addEventListener("mousedown", (e) => {
    e.preventDefault();
    begin(e.clientX, e.clientY);
    const onMove = (ev) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      end();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  frame.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    begin(t.clientX, t.clientY);
  }, { passive: true });
  frame.addEventListener("touchmove", (e) => {
    if (!_drag || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    move(t.clientX, t.clientY);
  }, { passive: false });
  frame.addEventListener("touchend", end);
  frame.addEventListener("touchcancel", end);

  els.btnResetCrop.addEventListener("click", () => {
    const im = getSelectedImage();
    if (!im) return;
    im.cropAnchor = { x: 0.5, y: 0.5 };
    im.croppedDataUrl = null; im.croppedKey = null;
    renderCropEditor();
    updatePreviewCellsFor(im);
  });
}

/** Live-update every preview cell that shows a given image — no full re-render. */
function updatePreviewCellsFor(im) {
  const ax = (im.cropAnchor.x * 100).toFixed(2);
  const ay = (im.cropAnchor.y * 100).toFixed(2);
  els.preview.querySelectorAll(`.img[data-img-id="${CSS.escape(im.id)}"]`)
    .forEach((node) => {
      node.style.backgroundPosition = `${ax}% ${ay}%`;
    });
}

function renderFileList() {
  const list = els.fileList;
  list.replaceChildren();
  state.images.forEach((img, i) => {
    const li = document.createElement("li");
    li.dataset.id = img.id;
    if (img.id === state.selectedId) li.classList.add("sel");
    if (img.loading) li.classList.add("loading");

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1).padStart(2, "0");

    const thumb = document.createElement("span");
    thumb.className = "thumb";
    if (img.previewUrl) {
      thumb.style.backgroundImage = `url(${img.previewUrl})`;
    }

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = img.name + (img.error ? "  (failed)" : img.loading ? "  (loading…)" : "");
    if (img.error) name.style.color = "var(--warn)";

    li.append(idx, thumb, name);
    li.addEventListener("click", () => selectImageById(img.id));
    list.appendChild(li);
  });
}

function renderPreview() {
  const stack = els.preview;
  stack.replaceChildren();

  const dims = getPageDimsMm();
  const scrollW = els.previewScroll.clientWidth - 36; // padding x2
  const scrollH = els.previewScroll.clientHeight - 36;
  if (scrollW < 50 || scrollH < 50) return;

  // Scale a page so a single page fits in the visible viewport.
  const scale = Math.min(scrollW / dims.w, scrollH / dims.h);
  const pageW = dims.w * scale;
  const pageH = dims.h * scale;

  const s = state.settings;
  const cellPx = s.cellSizeCm * 10 * scale;   // cm -> mm -> px
  const marginPx  = s.marginMm  * scale;
  const spacingPx = s.spacingMm * scale;

  const pagesArr = pages();
  pagesArr.forEach((p, p_i) => {
    const page = document.createElement("div");
    page.className = "page";
    page.style.width  = `${pageW}px`;
    page.style.height = `${pageH}px`;

    // Page label
    if (pagesArr.length > 1) {
      const lbl = document.createElement("span");
      lbl.className = "page-label";
      lbl.textContent = `Page ${p_i + 1} of ${pagesArr.length}`;
      page.appendChild(lbl);
    }

    // Center the cell block within the printable area
    const usableW = pageW - 2 * marginPx;
    const usableH = pageH - 2 * marginPx;
    const blockW = p.cols * cellPx + (p.cols - 1) * spacingPx;
    const blockH = p.rows * cellPx + (p.rows - 1) * spacingPx;
    const blockX = marginPx + Math.max(0, (usableW - blockW) / 2);
    const blockY = marginPx + Math.max(0, (usableH - blockH) / 2);

    // Margin guide
    const guide = document.createElement("div");
    guide.className = "margin-guide";
    guide.style.left   = `${marginPx}px`;
    guide.style.top    = `${marginPx}px`;
    guide.style.width  = `${usableW}px`;
    guide.style.height = `${usableH}px`;
    page.appendChild(guide);

    for (let slot = 0; slot < p.rows * p.cols; slot++) {
      const r = Math.floor(slot / p.cols);
      const c = slot % p.cols;
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.style.left   = `${blockX + c * (cellPx + spacingPx)}px`;
      cell.style.top    = `${blockY + r * (cellPx + spacingPx)}px`;
      cell.style.width  = `${cellPx}px`;
      cell.style.height = `${cellPx}px`;

      const imgIdx = p.start + slot;
      if (slot < p.count && imgIdx < state.images.length) {
        const im = state.images[imgIdx];
        cell.classList.add("filled");
        cell.dataset.imgId = im.id;
        if (im.id === state.selectedId) cell.classList.add("sel");

        if (im.error) {
          const err = document.createElement("div");
          err.className = "err";
          err.innerHTML = `⚠<br><small>${escapeHtml(im.name)}</small>`;
          cell.appendChild(err);
        } else if (!im.previewUrl) {
          // Still decoding — show a light placeholder so the layout is stable
          cell.style.background =
            `repeating-linear-gradient(135deg,#f3f4f7 0 8px,#e5e7ed 8px 16px)`;
        } else {
          // Use the small thumbnail with background-size: cover + position
          // derived from cropAnchor. Dragging in the crop editor updates every
          // preview cell of this image instantly — no canvas re-render needed.
          const ph = document.createElement("div");
          ph.className = "img";
          ph.dataset.imgId = im.id;
          ph.style.backgroundImage = `url(${im.previewUrl})`;
          if (state.settings.squareCrop) {
            const ax = (im.cropAnchor?.x ?? 0.5) * 100;
            const ay = (im.cropAnchor?.y ?? 0.5) * 100;
            ph.style.backgroundSize = "cover";
            ph.style.backgroundPosition = `${ax}% ${ay}%`;
          } else {
            ph.style.backgroundSize = "contain";
            ph.style.backgroundPosition = "center";
          }
          cell.appendChild(ph);
        }
        cell.addEventListener("click", () => selectImageById(im.id));
      }
      page.appendChild(cell);
    }

    stack.appendChild(page);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// Re-render on window resize so the preview rescales
let _resizeTO;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTO);
  _resizeTO = setTimeout(renderPreview, 80);
});

// ─── PDF Export ───────────────────────────────────────────────────────────

async function exportPdf() {
  if (!state.images.length) { alert("Add some images first."); return; }
  if (typeof window.jspdf?.jsPDF !== "function") {
    alert("PDF library not loaded. Check your connection and reload."); return;
  }
  if (state.images.some(im => im.loading)) {
    if (!confirm("Some images are still loading. Export anyway? They'll be skipped.")) return;
  }
  showBusy("Building PDF…");
  try {
    // Make sure every image has a fresh square crop at the current quality
    for (const im of state.images) await ensureCrop(im);

    const { jsPDF } = window.jspdf;
    const dims = getPageDimsMm();
    const orientation = state.settings.orientation;
    const doc = new jsPDF({
      orientation, unit: "mm",
      format: [dims.w, dims.h],
    });

    const s = state.settings;
    const pagesArr = pages();
    pagesArr.forEach((p, p_i) => {
      if (p_i > 0) doc.addPage([dims.w, dims.h], orientation);

      const usableW = dims.w - 2 * s.marginMm;
      const usableH = dims.h - 2 * s.marginMm;
      const cellMm = s.cellSizeCm * 10;
      const blockW = p.cols * cellMm + (p.cols - 1) * s.spacingMm;
      const blockH = p.rows * cellMm + (p.rows - 1) * s.spacingMm;
      const blockX = s.marginMm + Math.max(0, (usableW - blockW) / 2);
      const blockY = s.marginMm + Math.max(0, (usableH - blockH) / 2);

      for (let slot = 0; slot < p.count; slot++) {
        const r = Math.floor(slot / p.cols);
        const c = slot % p.cols;
        const x = blockX + c * (cellMm + s.spacingMm);
        const y = blockY + r * (cellMm + s.spacingMm);
        const im = state.images[p.start + slot];
        if (!im || im.error || !im.croppedDataUrl) continue;
        try {
          doc.addImage(im.croppedDataUrl, "JPEG", x, y, cellMm, cellMm, undefined, "FAST");
        } catch (e) {
          console.error("PDF addImage failed for", im.name, e);
        }
      }
    });

    doc.save(suggestedFilename("pdf"));
    setStatus(`PDF exported (${pagesArr.length} page${pagesArr.length > 1 ? "s" : ""}).`);
  } catch (e) {
    console.error(e);
    alert(`PDF export failed: ${e.message || e}`);
  } finally { hideBusy(); }
}

// ─── DOCX Export ──────────────────────────────────────────────────────────

async function exportDocx() {
  if (!state.images.length) { alert("Add some images first."); return; }
  if (typeof window.docx === "undefined") {
    alert("DOCX library not loaded. Check your connection and reload."); return;
  }
  if (state.images.some(im => im.loading)) {
    if (!confirm("Some images are still loading. Export anyway? They'll be skipped.")) return;
  }
  showBusy("Building Word document…");
  try {
    for (const im of state.images) await ensureCrop(im);
    const D = window.docx;
    const s = state.settings;
    const dims = getPageDimsMm();
    const cellMm = s.cellSizeCm * 10;

    // mm → twips (1 mm = 56.6929 twips approx; docx wants twips for table widths)
    const mmToTwips = (mm) => Math.round(mm * 56.6929);
    // mm → EMU for images (1 mm = 36000 EMU)
    const mmToEmu = (mm) => Math.round(mm * 36000);

    const pagesArr = pages();
    const children = [];
    for (let p_i = 0; p_i < pagesArr.length; p_i++) {
      const p = pagesArr[p_i];

      const tableRows = [];
      for (let r = 0; r < p.rows; r++) {
        const tableCells = [];
        for (let c = 0; c < p.cols; c++) {
          const slot = r * p.cols + c;
          const im = slot < p.count ? state.images[p.start + slot] : null;

          const cellChildren = [];
          if (im && im.croppedDataUrl && !im.error) {
            const arrayBuf = await dataUrlToArrayBuffer(im.croppedDataUrl);
            cellChildren.push(new D.Paragraph({
              spacing: { before: 0, after: 0 },
              alignment: D.AlignmentType.CENTER,
              children: [new D.ImageRun({
                data: arrayBuf,
                transformation: { width: cellMm * 2.834, height: cellMm * 2.834 }, // mm -> pt
              })],
            }));
          } else {
            cellChildren.push(new D.Paragraph({ spacing: { before: 0, after: 0 }, text: "" }));
          }

          tableCells.push(new D.TableCell({
            width: { size: mmToTwips(cellMm), type: D.WidthType.DXA },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            children: cellChildren,
          }));
        }
        tableRows.push(new D.TableRow({
          height: { value: mmToTwips(cellMm), rule: D.HeightRule.EXACT },
          children: tableCells,
        }));
      }

      const table = new D.Table({
        rows: tableRows,
        width: { size: mmToTwips(p.cols * cellMm + (p.cols - 1) * s.spacingMm), type: D.WidthType.DXA },
        alignment: D.AlignmentType.CENTER,
      });

      children.push(table);
      if (p_i < pagesArr.length - 1) {
        children.push(new D.Paragraph({
          children: [new D.PageBreak()],
        }));
      }
    }

    const doc = new D.Document({
      sections: [{
        properties: {
          page: {
            size: {
              width:  mmToTwips(dims.w),
              height: mmToTwips(dims.h),
              orientation: s.orientation === "landscape" ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT,
            },
            margin: {
              top:    mmToTwips(s.marginMm),
              bottom: mmToTwips(s.marginMm),
              left:   mmToTwips(s.marginMm),
              right:  mmToTwips(s.marginMm),
            },
          },
        },
        children,
      }],
    });

    const blob = await D.Packer.toBlob(doc);
    saveAs(blob, suggestedFilename("docx"));
    setStatus(`Word document exported (${pagesArr.length} page${pagesArr.length > 1 ? "s" : ""}).`);
  } catch (e) {
    console.error(e);
    alert(`DOCX export failed: ${e.message || e}`);
  } finally { hideBusy(); }
}

function dataUrlToArrayBuffer(dataUrl) {
  return fetch(dataUrl).then(r => r.arrayBuffer());
}

function suggestedFilename(ext) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  return `PhotoGrid-${stamp}.${ext}`;
}
