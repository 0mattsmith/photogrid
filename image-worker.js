/*
 * image-worker.js — runs in a Web Worker.
 *
 * Pipeline:
 *   • For browser-native formats (JPG/PNG/WebP/AVIF, plus HEIC on Safari and
 *     Chrome-on-macOS), use createImageBitmap directly. Fast, off-main-thread.
 *   • For HEIC files on browsers without native HEIC, lazy-load libheif-js
 *     (a WASM build of libheif) and decode it here. Modern iPhone HEICs use
 *     HEVC, which the older heic2any library frequently fails on; libheif
 *     handles them properly. Crucially this all runs in the worker so the
 *     UI stays responsive.
 *
 * Returns to the main thread:
 *   { id, sourceBlob, thumbBlob, w, h }
 * where sourceBlob is the original file when natively decoded, or a
 * re-encoded JPEG when libheif was used.
 */

const LIBHEIF_URL = "https://cdn.jsdelivr.net/npm/libheif-js@1.18.1/libheif/libheif.js";

function looksLikeHeic(file) {
  const name = (file && file.name) || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const heicExts = ["heic", "heif", "hif", "heics", "heifs"];
  const heicMimes = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
  return heicExts.includes(ext) || heicMimes.includes(file?.type || "");
}

// libheif lazy loader — only fetches the ~3 MB WASM when a HEIC actually arrives.
let _libheifReady = null;
function ensureLibheif() {
  if (_libheifReady) return _libheifReady;
  _libheifReady = (async () => {
    importScripts(LIBHEIF_URL);
    // The script exposes `libheif` and optionally a ready promise / function.
    if (typeof libheif === "undefined") {
      throw new Error("libheif failed to load");
    }
    // Some libheif-js builds expose libheif as a function returning a promise;
    // others expose ready/loaded promises. Normalize both.
    if (typeof libheif === "function") {
      // libheif() initializes and returns the module
      const mod = await libheif();
      // Replace the global so subsequent calls use it directly
      self.libheif = mod;
    } else if (libheif.ready && typeof libheif.ready.then === "function") {
      await libheif.ready;
    }
    return self.libheif || libheif;
  })();
  return _libheifReady;
}

async function decodeHeicToBitmap(file) {
  const heif = await ensureLibheif();
  const Decoder = (heif.HeifDecoder || (heif.default && heif.default.HeifDecoder));
  if (!Decoder) throw new Error("libheif: HeifDecoder not found on module");
  const decoder = new Decoder();

  const buffer = await file.arrayBuffer();
  const decoded = decoder.decode(buffer);
  if (!decoded || !decoded.length) throw new Error("HEIC file contains no images");

  const image = decoded[0];
  const w = typeof image.get_width  === "function" ? image.get_width()  : image.width;
  const h = typeof image.get_height === "function" ? image.get_height() : image.height;

  // Render the decoded frame to an RGBA buffer
  const rgba = new Uint8ClampedArray(w * h * 4);
  await new Promise((resolve, reject) => {
    try {
      image.display(
        { data: rgba, width: w, height: h },
        (out) => out ? resolve() : reject(new Error("libheif display returned null"))
      );
    } catch (e) { reject(e); }
  });

  const imageData = new ImageData(rgba, w, h);
  return await createImageBitmap(imageData);
}

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

self.onmessage = async (e) => {
  const { id, file, thumbMax, thumbQ } = e.data || {};
  if (!id) return;
  try {
    let bitmap, sourceBlob = file;

    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      if (!looksLikeHeic(file)) {
        throw new Error(`Format not supported: ${file.name}`);
      }
      // HEIC fallback via libheif-js (runs entirely in this worker)
      bitmap = await decodeHeicToBitmap(file);
      // Re-encode as JPEG at export-friendly quality so the source blob is
      // usable by the same export pipeline as everything else.
      sourceBlob = await reencodeBitmapAsJpeg(bitmap, 0.92);
    }

    const w = bitmap.width;
    const h = bitmap.height;
    const thumbBlob = await makeThumbBlob(bitmap, thumbMax, thumbQ);
    bitmap.close && bitmap.close();
    self.postMessage({ id, sourceBlob, thumbBlob, w, h });
  } catch (err) {
    self.postMessage({
      id,
      error: (err && (err.message || String(err))) || "Decode failed",
    });
  }
};
