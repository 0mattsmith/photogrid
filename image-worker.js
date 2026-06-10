/*
 * image-worker.js — runs in a Web Worker.
 *
 * Decodes any browser-native image format off the main thread and returns:
 *   - sourceBlob: the original file, kept for export-time cropping.
 *   - thumbBlob:  a small JPEG thumbnail used everywhere on screen.
 *   - w, h:       natural dimensions.
 *
 * Native createImageBitmap handles JPG/PNG/WebP/AVIF universally, and HEIC
 * on Safari + Chrome-on-macOS (which now ship a system HEIC decoder).
 * For HEIC files on browsers WITHOUT native support, we report
 * { fallback: true } so the main thread can run the JS HEIC decoder
 * (heic2any), which uses document.createElement and therefore can't run here.
 */

function looksLikeHeic(file) {
  const name = (file && file.name) || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const heicExts = ["heic", "heif", "hif", "heics", "heifs"];
  const heicMimes = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
  return heicExts.includes(ext) || heicMimes.includes(file?.type || "");
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
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      // Native decode failed. If it's HEIC, ask the main thread to handle it
      // via heic2any (which needs document.createElement and can't run here).
      if (looksLikeHeic(file)) {
        self.postMessage({ id, fallback: true });
        return;
      }
      throw new Error(`Image format not supported: ${file.name}`);
    }
    const w = bitmap.width;
    const h = bitmap.height;
    const thumbBlob = await makeThumbBlob(bitmap, thumbMax, thumbQ);
    bitmap.close && bitmap.close();
    self.postMessage({ id, sourceBlob: file, thumbBlob, w, h });
  } catch (err) {
    self.postMessage({ id, error: err && (err.message || String(err)) || "Decode failed" });
  }
};
