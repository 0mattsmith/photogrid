# PhotoGrid (web)

Drag photos in, arrange them in a customisable grid (default 4 × 5), crop each photo to a square cell (default 4.4 cm × 4.4 cm) with per-image pan adjustment, export to PDF or DOCX.

## Privacy

**Your photos never leave this device.** Everything — decoding HEIC, cropping, generating PDF/DOCX — runs inside your browser. There is no server, no upload, no analytics, no telemetry. The only network requests the page ever makes are to load the app code itself (HTML/CSS/JS and a handful of library files), and after the first visit those are cached, so subsequent loads make zero network requests for your photos or anything else.

You can verify this yourself by opening DevTools → Network while you drop photos in. Nothing fires.

## Offline

PhotoGrid is a PWA. After your first visit:

- The app shell and all libraries are cached by a service worker, so it loads and works fully **with no internet connection**.
- You can install it (Chrome/Edge: "Install app"; Safari iOS: Share → Add to Home Screen) to run it like a native app.
- A tiny dot in the top-right shows your connection state — green = online, grey + "offline" label = offline. Either way, the app works the same.

## Quick deploy with the GitHub CLI

```
bash deploy.sh photogrid
```

This creates a public GitHub repo named `photogrid`, pushes the code, and enables GitHub Pages via the included Actions workflow. The first deploy takes ~30–60 s.

For a private repo: `bash deploy.sh photogrid private`.

Once it's up, your site is at `https://<your-username>.github.io/photogrid/`. Any later push to `main` redeploys automatically.

## Running locally

It's static HTML/JS/CSS, so you can open `index.html` directly — *but* most browsers refuse to load HEIC files from a `file://` URL. Either:

```
python3 -m http.server 8000   # then open http://localhost:8000/
```

or any other simple static server (`npx serve`, `caddy file-server`, etc.).

## Features

- **Drag-and-drop anywhere** in the window, or click "Add files…".
- **Per-image square crop with drag-to-pan.** Click a photo; the crop editor appears below the file list. Drag inside the frame to choose what shows in the 4.4 cm square. Every preview cell of that image updates live.
- **Live preview** of the printed page with rows × columns, margins, spacing, page size, orientation.
- **Selection sync.** Click a cell in the preview → its row is selected in the list. Click a row in the list → its cells are highlighted in the preview.
- **Arrow keys** navigate the grid (Up/Down jump by column count, Left/Right by one).
- **Multi-page** automatic when image count exceeds rows × columns.
- **Export to PDF or DOCX**, with an **Export quality** dropdown that works like Word's "Reduce File Size":
  - *Print* — 300 DPI, q 0.92 (default)
  - *Reduced* — 200 DPI, q 0.82 (typically 3–5× smaller file)
  - *Minimum* — 110 DPI, q 0.72 (smallest, screen-only)
- **HEIC support** via `heic2any` (decodes Apple's iPhone photos in-browser).
- **Fast ingestion**: photos are decoded in parallel and a small thumbnail is generated for the UI. The full-resolution source is kept in memory only for export, so dragging crops, switching pages, and re-rendering are all instant even with dozens of HEIC images.
- **Light + dark mode** automatic.

## Customisation defaults (all editable in the UI)

| Setting | Default |
|--|--|
| Columns × Rows | 4 × 5 |
| Cell size | 4.4 cm × 4.4 cm (square) |
| Page | A4 portrait |
| Margins | 12 mm |
| Spacing between cells | 3 mm |
| Trim unused empty rows on last page | on |
| Center-crop to square | on |

## Tech

- Static HTML/CSS/JS — no build step.
- `heic2any` for HEIC decode (libheif/WASM).
- `jsPDF` for PDF export.
- `docx` (`docx.js`) for Word export.
- `file-saver` for the download.

All libraries load from jsDelivr CDN.
