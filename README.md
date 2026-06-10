# PhotoGrid (web)

Drag photos in, arrange them in a customisable grid (default 4 × 5), crop each photo to a square cell (default 4.4 cm × 4.4 cm) with per-image pan adjustment, export to PDF or DOCX.

Runs entirely in the browser — no upload, no server. Works on Chrome, Safari, Firefox, Edge.

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
- **Export to PDF or DOCX** with crops baked in at 300 DPI.
- **HEIC support** via `heic2any` (decodes Apple's iPhone photos in-browser).
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
