/*
 * image-worker.js — runs in a Web Worker.
 *
 * Decodes any incoming image file off the main thread and returns:
 *   - sourceBlob: the original file (or a HEIC->JPEG conversion of it),
 *     used at export time for high-resolution cropping.
 *   - thumbBlob:  a small JPEG thumbnail used everywhere on screen.
 *   - w, h:       natural dimensions of the source.
 *
 * Decoding strategy:
 *   1. Try the browser's native createImageBitmap on the file.
 *      This works for JPG/PNG/WebP/AVIF universally, and for HEIC on
 *      Safari and Chrome on macOS (which now ship native HEIC). When it
 *      works it's ~10× faster than the JS HEIC decoder.
 *   2. Only if native decode fails AND the file looks HEIC, lazy-load
 *      heic2any (libheif compiled to JS), convert to JPEG, then bitmap that.
 *
 * Multiple workers run in parallel, so the user sees a steady stream of
 * completions instead of one long freeze.
 */

const HEIC2ANY_URL = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";

function looksLikeHeic(file) {
  const name = (file && file.name) || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const heicExts = ["heic", "heif", "hif", "heics", "heifs"];
  const heicMimes = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
  return heicExts.includes(ext) || heicMimes.includes(file?.type || "");
}

async function ensureHeic2Any() {
  if (typeof heic2any === "function") return;
  importScripts(HEIC2ANY_URL);
}

async function decode(file) {
  // Path 1 — try native decode (fast, off-main-thread for the browser too).
  try {
    return { bitmap: await createImageBitmap(file), sourceBlob: file };
  } catch (_) { /* fall through */ }

  // Path 2 — HEIC fallback via heic2any.
  if (!looksLikeHeic(file)) {
    throw new Error("Image format not supported by this browser.");
  }
  await ensureHeic2Any();
  let converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  if (Array.isArray(converted)) converted = converted[0];
  const bitmap = await createImageBitmap(converted);
  return { bitmap, sourceBlob: converted };
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

self.onmessage = async (e) => {
  const { id, file, thumbMax, thumbQ } = e.data || {};
  if (!id) return;
  try {
    const { bitmap, sourceBlob } = await decode(file);
    const w = bitmap.width;
    const h = bitmap.height;
    const thumbBlob = await makeThumbBlob(bitmap, thumbMax, thumbQ);
    bitmap.close && bitmap.close();
    self.postMessage({ id, sourceBlob, thumbBlob, w, h });
  } catch (err) {
    self.postMessage({ id, error: err && (err.message || String(err)) || "Decode failed" });
  }
};
