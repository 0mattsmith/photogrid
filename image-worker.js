/*
 * image-worker.js — runs in a Web Worker.
 *
 * Multi-tier decode pipeline:
 *   1. createImageBitmap(file) — handles JPG/PNG/WebP/AVIF universally,
 *      and HEIC on Safari and Chrome-on-macOS (system codec).
 *   2. ImageDecoder (WebCodecs) — Chrome 94+ via the OS image decoder.
 *      Very fast when 'image/heic' is supported.
 *   3. libheif-js (WASM bundle, lazy-loaded) — last resort.
 *
 * The worker is heavily logged so it's easy to diagnose any failure from
 * DevTools → Console.
 */

const LIBHEIF_URL = "https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js";

function log(...args)  { try { console.log("[image-worker]", ...args); } catch (_) {} }
function warn(...args) { try { console.warn("[image-worker]", ...args); } catch (_) {} }

function looksLikeHeic(file) {
  const name = (file && file.name) || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const heicExts = ["heic", "heif", "hif", "heics", "heifs"];
  const heicMimes = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
  return heicExts.includes(ext) || heicMimes.includes(file?.type || "");
}

// ─── Tier 2: ImageDecoder API ────────────────────────────────────────────
const _imageDecoderTypeCache = new Map();
async function imageDecoderSupports(type) {
  if (typeof ImageDecoder === "undefined") return false;
  if (_imageDecoderTypeCache.has(type)) return _imageDecoderTypeCache.get(type);
  try {
    const ok = await ImageDecoder.isTypeSupported(type);
    _imageDecoderTypeCache.set(type, ok);
    return ok;
  } catch (_) {
    _imageDecoderTypeCache.set(type, false);
    return false;
  }
}

async function decodeWithImageDecoder(file) {
  const type = file.type || "image/heic";
  if (!await imageDecoderSupports(type)) return null;
  const decoder = new ImageDecoder({ data: file.stream(), type });
  try {
    const { image } = await decoder.decode();
    const bitmap = await createImageBitmap(image);
    image.close && image.close();
    return bitmap;
  } finally {
    decoder.close && decoder.close();
  }
}

// ─── Tier 3: libheif-js (WASM) ───────────────────────────────────────────
// Lazy-loaded. Resolves to an initialized libheif module with HeifDecoder.

let _libheifReady = null;

function ensureLibheif() {
  if (_libheifReady) return _libheifReady;
  _libheifReady = (async () => {
    log("loading libheif from", LIBHEIF_URL);
    try {
      importScripts(LIBHEIF_URL);
    } catch (e) {
      throw new Error(`libheif importScripts failed: ${e.message || e}`);
    }
    if (typeof libheif === "undefined") {
      throw new Error("libheif global not defined after importScripts");
    }
    log("libheif loaded. typeof:", typeof libheif);

    let mod;
    if (typeof libheif === "function") {
      log("calling libheif() factory…");
      mod = await libheif();
      log("libheif() resolved. keys:", Object.keys(mod || {}).slice(0, 8).join(", "));
      self.libheif = mod;
    } else if (libheif && typeof libheif === "object") {
      mod = libheif;
      if (libheif.ready && typeof libheif.ready.then === "function") {
        log("awaiting libheif.ready…");
        await libheif.ready;
      }
    } else {
      throw new Error(`libheif is unexpected type: ${typeof libheif}`);
    }

    const Decoder = mod.HeifDecoder
      || (mod.default && mod.default.HeifDecoder);
    if (!Decoder) {
      const seen = Object.keys(mod || {}).slice(0, 20).join(", ");
      throw new Error(`HeifDecoder not exported from libheif. Saw: ${seen}`);
    }
    log("libheif init OK — HeifDecoder available");
    return Decoder;
  })().catch((e) => {
    // Reset so we can try again next time
    _libheifReady = null;
    throw e;
  });
  return _libheifReady;
}

async function decodeWithLibheif(file) {
  const Decoder = await ensureLibheif();
  log("decode start:", file.name, "type:", file.type);
  const decoder = new Decoder();
  const buffer = await file.arrayBuffer();
  // libheif's HeifDecoder.decode requires a Uint8Array (not a raw ArrayBuffer)
  const decoded = decoder.decode(new Uint8Array(buffer));
  if (!decoded || !decoded.length) {
    throw new Error("HEIC: libheif returned no images (file may be unsupported)");
  }
  const image = decoded[0];
  const w = typeof image.get_width  === "function" ? image.get_width()  : image.width;
  const h = typeof image.get_height === "function" ? image.get_height() : image.height;
  if (!w || !h) throw new Error(`HEIC: invalid dimensions ${w}×${h}`);
  log("decoded HEIC:", w, "×", h);

  const rgba = new Uint8ClampedArray(w * h * 4);
  await new Promise((resolve, reject) => {
    try {
      image.display(
        { data: rgba, width: w, height: h },
        (out) => out ? resolve() : reject(new Error("HEIC: libheif display returned null"))
      );
    } catch (e) { reject(e); }
  });
  return await createImageBitmap(new ImageData(rgba, w, h));
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function makeThumbBlob(bitmap, maxDim, jpegQ) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await canvas.convertToBlob({ type: "image/jpeg", quality: jpegQ });
}

async function reencodeBitmapAsJpeg(bitmap, jpegQ) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return await canvas.convertToBlob({ type: "image/jpeg", quality: jpegQ });
}

// ─── Main handler ────────────────────────────────────────────────────────

self.onmessage = async (e) => {
  const { id, file, thumbMax, thumbQ } = e.data || {};
  if (!id) return;
  const t0 = performance.now();
  let bitmap, sourceBlob = file, tier = "none";

  try {
    try {
      bitmap = await createImageBitmap(file);
      tier = "createImageBitmap";
    } catch (eBitmap) {
      log(`createImageBitmap failed for ${file.name}: ${eBitmap.message || eBitmap}`);
      if (looksLikeHeic(file)) {
        try {
          bitmap = await decodeWithImageDecoder(file);
          if (bitmap) tier = "ImageDecoder";
        } catch (eDec) {
          log(`ImageDecoder failed for ${file.name}: ${eDec.message || eDec}`);
        }
      }
    }

    if (!bitmap) {
      if (!looksLikeHeic(file)) {
        throw new Error(`Format not supported: ${file.name}`);
      }
      bitmap = await decodeWithLibheif(file);
      tier = "libheif";
      sourceBlob = await reencodeBitmapAsJpeg(bitmap, 0.92);
    }

    const w = bitmap.width;
    const h = bitmap.height;
    const thumbBlob = await makeThumbBlob(bitmap, thumbMax, thumbQ);
    bitmap.close && bitmap.close();
    const took = Math.round(performance.now() - t0);
    log(`OK ${file.name}: ${tier}, ${took}ms`);
    self.postMessage({ id, sourceBlob, thumbBlob, w, h, decoder: tier, took });
  } catch (err) {
    const msg = (err && (err.message || String(err))) || "Decode failed";
    warn(`FAILED ${file.name}: ${msg} (tier=${tier})`);
    self.postMessage({ id, error: msg, tier });
  }
};
