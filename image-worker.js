/*
 * image-worker.js — runs in a Web Worker.
 *
 * Multi-tier decode pipeline so HEIC files don't take forever:
 *
 *   Tier 1  — createImageBitmap(file).
 *             Works for JPG/PNG/WebP/AVIF universally, and for HEIC on
 *             Safari and Chrome-on-macOS (system codec). Essentially free.
 *
 *   Tier 2  — ImageDecoder API.
 *             Chrome 94+ exposes the system image codec via WebCodecs;
 *             when 'image/heic' is supported this decodes a 4032×3024
 *             iPhone photo in tens of milliseconds, vs seconds for WASM.
 *
 *   Tier 3  — libheif-js (WASM).
 *             Last-resort fallback for browsers with no native HEIC
 *             (Chrome on Windows/Linux, Firefox). Slow but reliable.
 *             Cached per worker — we pay the WASM init cost once.
 *
 * Returns to the main thread:
 *   { id, sourceBlob, thumbBlob, w, h, decoder }     // success
 *   { id, error }                                     // failure
 * `decoder` is informational — main thread logs it so you can tell which
 * tier each photo went through.
 */

// WASM-backed bundle of libheif. Dramatically faster than the pure-JS
// implementation in the same package, and pinned to a real published
// version (1.18.x didn't exist and was 404'ing — which is why HEICs
// were failing immediately).
const LIBHEIF_URL = "https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js";

function looksLikeHeic(file) {
  const name = (file && file.name) || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const heicExts = ["heic", "heif", "hif", "heics", "heifs"];
  const heicMimes = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
  return heicExts.includes(ext) || heicMimes.includes(file?.type || "");
}

// ─── Tier 2: ImageDecoder API (WebCodecs) ────────────────────────────────
// Some browsers have it, some don't. When they do AND HEIC is supported,
// it's by far the fastest path.

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
    // image is a VideoFrame; createImageBitmap converts it to an ImageBitmap
    // (it can also be drawn directly to a canvas).
    const bitmap = await createImageBitmap(image);
    image.close && image.close();
    return bitmap;
  } finally {
    decoder.close && decoder.close();
  }
}

// ─── Tier 3: libheif-js (WASM) ───────────────────────────────────────────
// Lazy-load once per worker. The HeifDecoder instance is reused.

let _libheifReady = null;
let _heifDecoder = null;

function ensureLibheif() {
  if (_libheifReady) return _libheifReady;
  _libheifReady = (async () => {
    importScripts(LIBHEIF_URL);
    if (typeof libheif === "undefined") {
      throw new Error("libheif failed to load");
    }
    let mod = libheif;
    if (typeof libheif === "function") {
      mod = await libheif();
      self.libheif = mod;
    } else if (libheif.ready && typeof libheif.ready.then === "function") {
      await libheif.ready;
    }
    const Decoder = mod.HeifDecoder || (mod.default && mod.default.HeifDecoder);
    if (!Decoder) throw new Error("libheif: HeifDecoder not found");
    _heifDecoder = new Decoder();
    return _heifDecoder;
  })();
  return _libheifReady;
}

async function decodeWithLibheif(file) {
  const decoder = await ensureLibheif();
  const buffer = await file.arrayBuffer();
  const decoded = decoder.decode(buffer);
  if (!decoded || !decoded.length) throw new Error("HEIC file contains no images");

  const image = decoded[0];
  const w = typeof image.get_width  === "function" ? image.get_width()  : image.width;
  const h = typeof image.get_height === "function" ? image.get_height() : image.height;

  const rgba = new Uint8ClampedArray(w * h * 4);
  await new Promise((resolve, reject) => {
    try {
      image.display(
        { data: rgba, width: w, height: h },
        (out) => out ? resolve() : reject(new Error("libheif display returned null"))
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
  let bitmap, sourceBlob = file, tier = "native";

  try {
    // Tier 1 — fastest path, also handles all common formats.
    try {
      bitmap = await createImageBitmap(file);
      tier = "createImageBitmap";
    } catch (_) {
      // Tier 2 — ImageDecoder API. Especially good for HEIC on Chrome/Edge.
      if (looksLikeHeic(file)) {
        try {
          bitmap = await decodeWithImageDecoder(file);
          if (bitmap) tier = "ImageDecoder";
        } catch (_) { /* fall through to libheif */ }
      }
    }

    // Tier 3 — WASM libheif. Slow but reliable.
    if (!bitmap) {
      if (!looksLikeHeic(file)) {
        throw new Error(`Format not supported: ${file.name}`);
      }
      bitmap = await decodeWithLibheif(file);
      tier = "libheif";
      // Re-encode as JPEG so the export pipeline has a usable blob (the
      // raw HEIC original can't be drawn on a canvas in the main thread).
      sourceBlob = await reencodeBitmapAsJpeg(bitmap, 0.92);
    }

    const w = bitmap.width;
    const h = bitmap.height;
    const thumbBlob = await makeThumbBlob(bitmap, thumbMax, thumbQ);
    bitmap.close && bitmap.close();
    const took = Math.round(performance.now() - t0);
    self.postMessage({ id, sourceBlob, thumbBlob, w, h, decoder: tier, took });
  } catch (err) {
    self.postMessage({
      id,
      error: (err && (err.message || String(err))) || "Decode failed",
      tier,
    });
  }
};
