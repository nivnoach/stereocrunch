const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { renderStereoPairs, renderPreview, getBoundingRadius, SIZES, DEFAULT_DISTANCE_MULTIPLIER } = require('./renderer');
const { processBatch, parseCSV, parseNumber, csvLine } = require('./batch');

const PREVIEW_SIZE = 160;

function listStlFiles(folder) {
  return fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.stl')).sort();
}

function validateStlFolder(stlFolder) {
  if (!stlFolder) return { error: 'stlFolder is required' };
  const resolvedFolder = path.resolve(stlFolder);
  if (!fs.existsSync(resolvedFolder) || !fs.statSync(resolvedFolder).isDirectory()) {
    return { error: `Folder not found: ${resolvedFolder}` };
  }
  return { resolvedFolder };
}

function validateCsvPath(csvPath) {
  if (!csvPath) return { error: 'csvPath is required' };
  if (!csvPath.toLowerCase().endsWith('.csv')) return { error: 'csvPath must point to a .csv file' };
  const resolvedCsvPath = path.resolve(csvPath);
  if (!fs.existsSync(resolvedCsvPath)) return { error: `CSV not found: ${resolvedCsvPath}` };
  return { resolvedCsvPath };
}

// Effective rx/ry/rz for a preview row: query-string override (if present,
// e.g. carried over from a previous preview visit or a viewer round-trip)
// wins over the CSV's own value.
function effectiveRotation(query, lineNo, row) {
  const pick = (axis, fallback) => {
    const key = `${axis}_${lineNo}`;
    return query[key] !== undefined ? parseFloat(query[key]) : fallback;
  };
  return {
    rx: pick('rx', parseNumber(row.rx, 0)),
    ry: pick('ry', parseNumber(row.ry, 0)),
    rz: pick('rz', parseNumber(row.rz, 0))
  };
}

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.stl')
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.stl')) {
      return cb(new Error('Only .stl files are allowed'));
    }
    cb(null, true);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use('/three-lib', express.static(path.join(__dirname, 'node_modules', 'three')));

app.post('/render', (req, res) => {
  upload.single('stl')(req, res, (err) => {
    if (err) {
      return res.status(400).send('Upload error: ' + err.message);
    }
    if (!req.file) {
      return res.status(400).send('No STL file uploaded');
    }

    const cleanup = () => fs.unlink(req.file.path, () => {});

    const d = parseFloat(req.body.d);
    const o = parseFloat(req.body.o);
    const rx = req.body.rx === undefined || req.body.rx === '' ? 0 : parseFloat(req.body.rx);
    const ry = req.body.ry === undefined || req.body.ry === '' ? 0 : parseFloat(req.body.ry);
    const rz = req.body.rz === undefined || req.body.rz === '' ? 0 : parseFloat(req.body.rz);

    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(o) || o < 0) {
      cleanup();
      return res.status(400).send('Invalid d or o: d must be > 0, o must be >= 0');
    }
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) {
      cleanup();
      return res.status(400).send('Invalid rx, ry, or rz: must be numbers (degrees)');
    }

    try {
      const pairs = renderStereoPairs(req.file.path, d, o, { rx, ry, rz }, SIZES);

      const sections = pairs.map(({ size, image1, image2 }) => {
        const img1 = `data:image/png;base64,${image1.toString('base64')}`;
        const img2 = `data:image/png;base64,${image2.toString('base64')}`;
        return `
  <h2>${size}x${size}</h2>
  <div style="display:flex; gap:20px; margin-bottom:24px;">
    <div><h3>Camera 1 (left)</h3><img src="${img1}" width="${size}" height="${size}" style="image-rendering:pixelated; border:1px solid #ccc;"></div>
    <div><h3>Camera 2 (right)</h3><img src="${img2}" width="${size}" height="${size}" style="image-rendering:pixelated; border:1px solid #ccc;"></div>
  </div>`;
      }).join('\n');

      res.send(`<!DOCTYPE html>
<html>
<head><title>Stereo Render</title></head>
<body>
  <h1>Stereo Render (d=${d}, o=${o}, rx=${rx}&deg;, ry=${ry}&deg;, rz=${rz}&deg;)</h1>
  ${sections}
  <p><a href="/">Render another</a></p>
</body>
</html>`);
    } catch (e) {
      console.error(e);
      res.status(500).send('Render error: ' + e.message);
    } finally {
      cleanup();
    }
  });
});

// Shows a thumbnail + skip checkbox + rx/ry/rz fields per CSV row, so a
// batch can be eyeballed and trimmed/adjusted before the real render runs.
// GET (not POST) so the "Adjust rotation..." button on each row can submit
// the whole form's current state straight to /batch/preview/open via a
// per-button formaction override, with no JS needed to capture field state.
app.get('/batch/preview', (req, res) => {
  const csvPath = (req.query.csvPath || '').trim();
  const { error, resolvedCsvPath } = validateCsvPath(csvPath);
  if (error) {
    return res.status(400).send(error);
  }

  let rows;
  try {
    ({ rows } = parseCSV(fs.readFileSync(resolvedCsvPath, 'utf8')));
  } catch (e) {
    return res.status(400).send('Batch error: ' + e.message);
  }

  const csvDir = path.dirname(resolvedCsvPath);

  const rowsHtml = rows.map(({ row }, index) => {
    const lineNo = index + 2;
    const filename = row.filename;
    const errorRow = (message) => `
  <div style="border:1px solid #e99; background:#fee; padding:12px; margin-bottom:12px;">
    <strong>Line ${lineNo}</strong> — ${filename || '(no filename)'}<br>
    <span style="color:#a00;">${message}</span> — this row will be excluded from the batch.
  </div>`;

    if (!filename) return errorRow('Missing filename');

    const stlPath = path.resolve(csvDir, filename);
    if (!fs.existsSync(stlPath)) return errorRow(`STL not found: ${stlPath}`);

    const d = parseNumber(row.d, NaN);
    const o = parseNumber(row.o, NaN);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(o) || o < 0) {
      return errorRow(`Invalid d/o in CSV: d="${row.d}", o="${row.o}"`);
    }

    const { rx, ry, rz } = effectiveRotation(req.query, lineNo, row);
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) {
      return errorRow('Invalid rx, ry, or rz');
    }

    // The thumbnail itself is NOT rendered here: with hundreds of rows,
    // rendering every thumbnail before responding would make the page look
    // hung for tens of seconds. Instead the page returns immediately with
    // an <img> per row pointing at /batch/preview/thumb, so the browser
    // fetches (and progressively displays) them itself after the page has
    // already loaded.
    const thumbSrc = `/batch/preview/thumb?csvPath=${encodeURIComponent(resolvedCsvPath)}`
      + `&lineNo=${lineNo}&rx=${rx}&ry=${ry}&rz=${rz}`;

    const skipped = req.query[`skip_${lineNo}`] === '1';

    return `
  <div style="display:flex; gap:16px; align-items:flex-start; border:1px solid #ccc; padding:12px; margin-bottom:12px;">
    <img src="${thumbSrc}" width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}" loading="lazy" style="image-rendering:pixelated; border:1px solid #999; background:#eee;">
    <div>
      <div><strong>Line ${lineNo}</strong> — ${filename}</div>
      <div>d=${d}, o=${o}</div>
      <div style="display:flex; gap:10px; margin:8px 0;">
        <label>rx <input type="number" step="any" name="rx_${lineNo}" value="${rx}" style="width:80px;"></label>
        <label>ry <input type="number" step="any" name="ry_${lineNo}" value="${ry}" style="width:80px;"></label>
        <label>rz <input type="number" step="any" name="rz_${lineNo}" value="${rz}" style="width:80px;"></label>
      </div>
      <label><input type="checkbox" name="skip_${lineNo}" value="1" ${skipped ? 'checked' : ''}> Skip this row</label>
      <button type="submit" name="openLineNo" value="${lineNo}" formaction="/batch/preview/open" formmethod="GET" style="display:block; margin-top:8px;">Adjust rotation&hellip;</button>
    </div>
  </div>`;
  }).join('\n');

  res.send(`<!DOCTYPE html>
<html>
<head><title>Batch Preview</title></head>
<body style="font-family:sans-serif; max-width:720px; margin:40px auto;">
  <h1>Batch Preview</h1>
  <p>CSV: <code>${resolvedCsvPath}</code></p>
  <p>Review the planned renders below. Uncheck "Skip this row" to keep a row
  out of the batch, or click "Adjust rotation&hellip;" to fix a misaligned
  one in the 3D viewer &mdash; it'll bring you right back here with the
  updated rx/ry/rz already filled in.</p>
  <form method="POST" action="/batch">
    <input type="hidden" name="csvPath" value="${resolvedCsvPath}">
    ${rowsHtml}
    <button type="submit">Run Batch</button>
  </form>
  <p><a href="/">Back</a></p>
</body>
</html>`);
});

// Renders one row's thumbnail on demand — the slow part of the preview
// page, split out so /batch/preview can respond instantly and let the
// browser pull these in the background (see the comment at that route).
app.get('/batch/preview/thumb', (req, res) => {
  const csvPath = (req.query.csvPath || '').trim();
  const lineNo = parseInt(req.query.lineNo, 10);
  const { error, resolvedCsvPath } = validateCsvPath(csvPath);
  if (error || !Number.isFinite(lineNo)) {
    return res.status(400).send(error || 'lineNo is required');
  }

  let rows;
  try {
    ({ rows } = parseCSV(fs.readFileSync(resolvedCsvPath, 'utf8')));
  } catch (e) {
    return res.status(400).send('Batch error: ' + e.message);
  }

  const rowEntry = rows[lineNo - 2];
  if (!rowEntry || !rowEntry.row.filename) {
    return res.status(400).send(`No such CSV row: line ${lineNo}`);
  }
  const stlPath = path.resolve(path.dirname(resolvedCsvPath), rowEntry.row.filename);
  if (!fs.existsSync(stlPath)) {
    return res.status(404).send(`STL not found: ${stlPath}`);
  }

  const d = parseNumber(rowEntry.row.d, NaN);
  const o = parseNumber(rowEntry.row.o, NaN);
  const rx = req.query.rx !== undefined ? parseFloat(req.query.rx) : parseNumber(rowEntry.row.rx, 0);
  const ry = req.query.ry !== undefined ? parseFloat(req.query.ry) : parseNumber(rowEntry.row.ry, 0);
  const rz = req.query.rz !== undefined ? parseFloat(req.query.rz) : parseNumber(rowEntry.row.rz, 0);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(o) || o < 0
      || !Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) {
    return res.status(400).send('Invalid d, o, rx, ry, or rz');
  }

  try {
    const png = renderPreview(stlPath, d, o, { rx, ry, rz }, PREVIEW_SIZE);
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).send('Render error: ' + e.message);
  }
});

// Hands off a single row to the rotation viewer, carrying the *entire*
// preview form's current state (every row's rx_/ry_/rz_/skip_ fields) in
// returnUrl so navigating back restores it untouched except for the one
// row being edited.
app.get('/batch/preview/open', (req, res) => {
  const csvPath = (req.query.csvPath || '').trim();
  const openLineNo = parseInt(req.query.openLineNo, 10);
  if (!Number.isFinite(openLineNo)) {
    return res.status(400).send('openLineNo is required');
  }
  const { error, resolvedCsvPath } = validateCsvPath(csvPath);
  if (error) {
    return res.status(400).send(error);
  }

  let rows;
  try {
    ({ rows } = parseCSV(fs.readFileSync(resolvedCsvPath, 'utf8')));
  } catch (e) {
    return res.status(400).send('Batch error: ' + e.message);
  }

  const rowEntry = rows[openLineNo - 2];
  if (!rowEntry || !rowEntry.row.filename) {
    return res.status(400).send(`No such CSV row: line ${openLineNo}`);
  }
  const stlPath = path.resolve(path.dirname(resolvedCsvPath), rowEntry.row.filename);
  if (!fs.existsSync(stlPath)) {
    return res.status(400).send(`STL not found: ${stlPath}`);
  }

  const { rx, ry, rz } = effectiveRotation(req.query, openLineNo, rowEntry.row);

  const returnParams = new URLSearchParams(req.query);
  returnParams.delete('openLineNo');
  const returnUrl = `/batch/preview?${returnParams.toString()}`;

  const viewerParams = new URLSearchParams({
    stlPath, rx: String(rx), ry: String(ry), rz: String(rz), lineNo: String(openLineNo), returnUrl
  });
  res.redirect(`/viewer.html?${viewerParams.toString()}`);
});

// Serves a raw STL from disk so the browser-side rotation viewer can load
// it directly (via fetch) instead of requiring a manual file picker when
// arriving from the batch preview.
app.get('/stl-file', (req, res) => {
  const stlPath = (req.query.path || '').trim();
  if (!stlPath) {
    return res.status(400).send('path is required');
  }
  if (!stlPath.toLowerCase().endsWith('.stl')) {
    return res.status(400).send('path must point to a .stl file');
  }
  const resolved = path.resolve(stlPath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).send(`STL not found: ${resolved}`);
  }
  res.sendFile(resolved);
});

app.post('/batch', (req, res) => {
  const csvPath = (req.body.csvPath || '').trim();
  const { error, resolvedCsvPath } = validateCsvPath(csvPath);
  if (error) {
    return res.status(400).send(error);
  }

  const skipLineNos = new Set();
  const rotationOverrides = new Map();
  for (const [key, value] of Object.entries(req.body)) {
    const skipMatch = key.match(/^skip_(\d+)$/);
    if (skipMatch && value === '1') {
      skipLineNos.add(parseInt(skipMatch[1], 10));
      continue;
    }
    const rxMatch = key.match(/^rx_(\d+)$/);
    if (rxMatch) {
      const lineNo = parseInt(rxMatch[1], 10);
      const entry = rotationOverrides.get(lineNo) || {};
      entry.rx = parseFloat(value);
      rotationOverrides.set(lineNo, entry);
    }
    const ryMatch = key.match(/^ry_(\d+)$/);
    if (ryMatch) {
      const lineNo = parseInt(ryMatch[1], 10);
      const entry = rotationOverrides.get(lineNo) || {};
      entry.ry = parseFloat(value);
      rotationOverrides.set(lineNo, entry);
    }
    const rzMatch = key.match(/^rz_(\d+)$/);
    if (rzMatch) {
      const lineNo = parseInt(rzMatch[1], 10);
      const entry = rotationOverrides.get(lineNo) || {};
      entry.rz = parseFloat(value);
      rotationOverrides.set(lineNo, entry);
    }
  }

  try {
    const { outputRoot, results } = processBatch(resolvedCsvPath, { skipLineNos, rotationOverrides });

    const rows = results.map((r) => {
      if (r.skipped) {
        return `<tr><td>${r.lineNo}</td><td>${r.filename}</td><td style="color:#888">SKIPPED</td><td>Excluded via batch preview</td></tr>`;
      }
      if (r.ok) {
        return `<tr><td>${r.lineNo}</td><td>${r.filename}</td><td style="color:green">OK</td><td>d=${r.d}, o=${r.o}, rx=${r.rx}&deg;, ry=${r.ry}&deg;, rz=${r.rz}&deg;</td></tr>`;
      }
      return `<tr><td>${r.lineNo}</td><td>${r.filename}</td><td style="color:red">FAILED</td><td>${r.error}</td></tr>`;
    }).join('\n');

    res.send(`<!DOCTYPE html>
<html>
<head><title>Batch Render</title></head>
<body>
  <h1>Batch Render Complete</h1>
  <p>Output folder: <code>${outputRoot}</code></p>
  <p>Subfolders: ${SIZES.map((s) => `${s}x${s}`).join(', ')}</p>
  <table border="1" cellpadding="6" style="border-collapse:collapse;">
    <tr><th>Line</th><th>Filename</th><th>Status</th><th>Details</th></tr>
    ${rows}
  </table>
  <p><a href="/">Back</a></p>
</body>
</html>`);
  } catch (e) {
    // parseCSV throws for malformed input (missing columns, empty file) -
    // that's a client-side data problem, not a server fault.
    console.error(e);
    res.status(400).send('Batch error: ' + e.message);
  }
});

// Mode 1 of the pipeline: review the *raw* STL folder (default orientation,
// no CSV yet) before any permutations exist, so misalignment only has to be
// fixed once per STL instead of once per generated permutation. Same
// instant-page + async-thumbnail shape as /batch/preview, since computing a
// per-STL default distance requires (nearly) the same STL parse cost as
// rendering a thumbnail — see getBoundingRadius in renderer.js.
app.get('/folder/preview', (req, res) => {
  const stlFolder = (req.query.stlFolder || '').trim();
  const { error, resolvedFolder } = validateStlFolder(stlFolder);
  if (error) {
    return res.status(400).send(error);
  }

  const files = listStlFiles(resolvedFolder);
  if (files.length === 0) {
    return res.status(400).send(`No .stl files found in ${resolvedFolder}`);
  }

  const o = (req.query.o || '50').trim();

  const rowsHtml = files.map((filename, index) => {
    const idx = index + 1;
    const dVal = req.query[`d_${idx}`] !== undefined ? req.query[`d_${idx}`] : '';
    const rx = req.query[`rx_${idx}`] !== undefined ? req.query[`rx_${idx}`] : '0';
    const ry = req.query[`ry_${idx}`] !== undefined ? req.query[`ry_${idx}`] : '0';
    const rz = req.query[`rz_${idx}`] !== undefined ? req.query[`rz_${idx}`] : '0';
    const skipped = req.query[`skip_${idx}`] === '1';

    let thumbUrl = `/folder/preview/thumb?stlFolder=${encodeURIComponent(resolvedFolder)}`
      + `&idx=${idx}&o=${encodeURIComponent(o)}&rx=${encodeURIComponent(rx)}&ry=${encodeURIComponent(ry)}&rz=${encodeURIComponent(rz)}`;
    if (dVal !== '') thumbUrl += `&d=${encodeURIComponent(dVal)}`;

    return `
  <div class="folderRow" data-thumb-base="${thumbUrl}" style="display:flex; gap:16px; align-items:flex-start; border:1px solid #ccc; padding:12px; margin-bottom:12px;">
    <img class="thumb" width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}" style="image-rendering:pixelated; border:1px solid #999; background:#eee;">
    <div>
      <div><strong>#${idx}</strong> — ${filename}</div>
      <div style="display:flex; gap:10px; margin:8px 0;">
        <label>d <input type="number" step="any" class="dInput" name="d_${idx}" value="${dVal}" placeholder="loading&hellip;" style="width:90px;"></label>
        <label>rx <input type="number" step="any" name="rx_${idx}" value="${rx}" style="width:80px;"></label>
        <label>ry <input type="number" step="any" name="ry_${idx}" value="${ry}" style="width:80px;"></label>
        <label>rz <input type="number" step="any" name="rz_${idx}" value="${rz}" style="width:80px;"></label>
      </div>
      <label><input type="checkbox" name="skip_${idx}" value="1" ${skipped ? 'checked' : ''}> Skip this file</label>
      <button type="submit" name="openIdx" value="${idx}" formaction="/folder/preview/open" formmethod="GET" style="display:block; margin-top:8px;">Adjust rotation&hellip;</button>
    </div>
  </div>`;
  }).join('\n');

  const defaultOutputCsv = path.join(resolvedFolder, 'base.csv');

  res.send(`<!DOCTYPE html>
<html>
<head><title>Folder Preview</title></head>
<body style="font-family:sans-serif; max-width:720px; margin:40px auto;">
  <h1>Folder Preview</h1>
  <p>Folder: <code>${resolvedFolder}</code> (${files.length} STL files)</p>
  <p>Each file's default distance is auto-computed from its own size once its
  thumbnail loads (parsing a large STL can take a moment per file). Skip
  files you don't want, or click "Adjust rotation&hellip;" to align a
  misaligned one in the 3D viewer &mdash; it brings you right back here.</p>
  <form method="POST" action="/folder/save">
    <input type="hidden" name="stlFolder" value="${resolvedFolder}">
    <label>Baseline o (shared by all rows): <input type="number" step="any" name="o" value="${o}" style="width:90px;"></label>
    <div style="margin:16px 0;">
      ${rowsHtml}
    </div>
    <label>Save as CSV:<br><input type="text" name="outputCsvPath" value="${defaultOutputCsv}" style="width:100%;"></label>
    <button type="submit" style="margin-top:12px;">Save as CSV</button>
  </form>
  <p><a href="/">Back</a></p>
  <script>
    document.querySelectorAll('.folderRow').forEach((row) => {
      const img = row.querySelector('.thumb');
      const dInput = row.querySelector('.dInput');
      const wasEmpty = dInput.value === '';
      fetch(row.dataset.thumbBase)
        .then((resp) => {
          if (!resp.ok) return;
          if (wasEmpty && dInput.value === '') {
            const defaultD = resp.headers.get('X-Default-D');
            if (defaultD) dInput.value = defaultD;
          }
          return resp.blob();
        })
        .then((blob) => { if (blob) img.src = URL.createObjectURL(blob); })
        .catch(() => {});
    });
  </script>
</body>
</html>`);
});

// Renders one folder-mode row's thumbnail on demand (same reasoning as
// /batch/preview/thumb). If no d was supplied, computes one from the STL's
// own bounding radius and reports it back via X-Default-D so the preview
// page's script can backfill that row's d field.
app.get('/folder/preview/thumb', (req, res) => {
  const stlFolder = (req.query.stlFolder || '').trim();
  const idx = parseInt(req.query.idx, 10);
  const { error, resolvedFolder } = validateStlFolder(stlFolder);
  if (error || !Number.isFinite(idx)) {
    return res.status(400).send(error || 'idx is required');
  }

  const filename = listStlFiles(resolvedFolder)[idx - 1];
  if (!filename) {
    return res.status(400).send(`No such file index: ${idx}`);
  }
  const stlPath = path.join(resolvedFolder, filename);

  const o = parseNumber(req.query.o, NaN);
  const rx = req.query.rx !== undefined ? parseFloat(req.query.rx) : 0;
  const ry = req.query.ry !== undefined ? parseFloat(req.query.ry) : 0;
  const rz = req.query.rz !== undefined ? parseFloat(req.query.rz) : 0;
  if (!Number.isFinite(o) || o < 0 || !Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) {
    return res.status(400).send('Invalid o, rx, ry, or rz');
  }

  try {
    let d = req.query.d !== undefined && req.query.d !== '' ? parseFloat(req.query.d) : NaN;
    if (!Number.isFinite(d) || d <= 0) {
      d = getBoundingRadius(stlPath) * DEFAULT_DISTANCE_MULTIPLIER;
      res.set('X-Default-D', String(d));
    }
    const png = renderPreview(stlPath, d, o, { rx, ry, rz }, PREVIEW_SIZE);
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).send('Render error: ' + e.message);
  }
});

// Hands off one folder-mode row to the rotation viewer, same round-trip
// mechanism as /batch/preview/open (viewer.html is generic enough to need
// no changes — it doesn't care whether lineNo is a CSV line or file index).
app.get('/folder/preview/open', (req, res) => {
  const stlFolder = (req.query.stlFolder || '').trim();
  const openIdx = parseInt(req.query.openIdx, 10);
  const { error, resolvedFolder } = validateStlFolder(stlFolder);
  if (error || !Number.isFinite(openIdx)) {
    return res.status(400).send(error || 'openIdx is required');
  }

  const filename = listStlFiles(resolvedFolder)[openIdx - 1];
  if (!filename) {
    return res.status(400).send(`No such file index: ${openIdx}`);
  }
  const stlPath = path.join(resolvedFolder, filename);

  const rx = req.query[`rx_${openIdx}`] !== undefined ? req.query[`rx_${openIdx}`] : '0';
  const ry = req.query[`ry_${openIdx}`] !== undefined ? req.query[`ry_${openIdx}`] : '0';
  const rz = req.query[`rz_${openIdx}`] !== undefined ? req.query[`rz_${openIdx}`] : '0';

  const returnParams = new URLSearchParams(req.query);
  returnParams.delete('openIdx');
  const returnUrl = `/folder/preview?${returnParams.toString()}`;

  const viewerParams = new URLSearchParams({
    stlPath, rx, ry, rz, lineNo: String(openIdx), returnUrl
  });
  res.redirect(`/viewer.html?${viewerParams.toString()}`);
});

// Writes the folder review's current state out as a base CSV: one
// filename,d,o,rx,ry,rz row per non-skipped file, ready for /permute or a
// direct /batch/preview.
app.post('/folder/save', (req, res) => {
  const stlFolder = (req.body.stlFolder || '').trim();
  const outputCsvPath = (req.body.outputCsvPath || '').trim();
  const { error, resolvedFolder } = validateStlFolder(stlFolder);
  if (error) {
    return res.status(400).send(error);
  }
  if (!outputCsvPath) {
    return res.status(400).send('outputCsvPath is required');
  }

  const files = listStlFiles(resolvedFolder);
  const o = req.body.o || '';

  const outRows = [];
  const errors = [];
  files.forEach((filename, index) => {
    const idx = index + 1;
    if (req.body[`skip_${idx}`] === '1') return;
    const d = req.body[`d_${idx}`];
    if (!d || !Number.isFinite(parseFloat(d))) {
      errors.push(`#${idx} ${filename}: missing/invalid d (its thumbnail may not have finished loading) — excluded`);
      return;
    }
    const rx = req.body[`rx_${idx}`] || '0';
    const ry = req.body[`ry_${idx}`] || '0';
    const rz = req.body[`rz_${idx}`] || '0';
    outRows.push([filename, d, o, rx, ry, rz]);
  });

  const resolvedOutputCsvPath = path.resolve(outputCsvPath);
  const lines = [csvLine(['filename', 'd', 'o', 'rx', 'ry', 'rz'])];
  for (const row of outRows) lines.push(csvLine(row));
  fs.writeFileSync(resolvedOutputCsvPath, lines.join('\n') + '\n');

  res.send(`<!DOCTYPE html>
<html>
<head><title>Folder Saved</title></head>
<body style="font-family:sans-serif; max-width:640px; margin:40px auto;">
  <h1>Base CSV Saved</h1>
  <p>Wrote <strong>${outRows.length}</strong> row(s) to <code>${resolvedOutputCsvPath}</code>.</p>
  ${errors.length ? `<p style="color:#a00;">${errors.length} file(s) excluded:</p><ul>${errors.map((e) => `<li>${e}</li>`).join('')}</ul>` : ''}
  <p><a href="/permute?csvPath=${encodeURIComponent(resolvedOutputCsvPath)}">Next: Generate Permutations &rarr;</a></p>
  <p><a href="/batch/preview?csvPath=${encodeURIComponent(resolvedOutputCsvPath)}">Or: Preview this CSV directly &rarr;</a></p>
  <p><a href="/">Back</a></p>
</body>
</html>`);
});

// Mode 2 of the pipeline: expands an aligned base CSV into N distance
// permutations per row. Rotation is copied unchanged (already fixed in
// folder/batch preview); only d varies, as a random multiplier of each
// row's own d — never one absolute range for every STL, since STL scale
// varies a lot across the source set.
app.get('/permute', (req, res) => {
  const csvPath = (req.query.csvPath || '').trim();
  let outputSuggestion = '';
  if (csvPath) {
    const dir = path.dirname(csvPath);
    const base = path.basename(csvPath, path.extname(csvPath));
    outputSuggestion = path.join(dir, `${base}_permuted.csv`);
  }
  res.send(`<!DOCTYPE html>
<html>
<head><title>Generate Permutations</title></head>
<body style="font-family:sans-serif; max-width:560px; margin:40px auto;">
  <h1>Generate Permutations</h1>
  <p>Takes a CSV of aligned STLs (e.g. from Folder Preview) and generates
  several rows per entry with distance randomized within a multiplier range
  of that row's own <code>d</code>. Rotation (<code>rx/ry/rz</code>) is
  copied unchanged &mdash; align rows first via Folder Preview or Batch
  Preview, not here.</p>
  <form method="POST" action="/permute">
    <label>Input CSV path:<br><input type="text" name="csvPath" value="${csvPath}" style="width:100%;" required></label><br><br>
    <label>Permutations per entry:<br><input type="number" name="permutationsPerEntry" value="3" min="1" step="1" required></label><br><br>
    <label>Distance multiplier min:<br><input type="number" name="distanceMultiplierMin" value="0.6" min="0.01" step="any" required></label><br><br>
    <label>Distance multiplier max:<br><input type="number" name="distanceMultiplierMax" value="1.5" min="0.01" step="any" required></label><br><br>
    <label>Output CSV path:<br><input type="text" name="outputCsvPath" value="${outputSuggestion}" style="width:100%;" required></label><br><br>
    <button type="submit">Generate</button>
  </form>
  <p><a href="/">Back</a></p>
</body>
</html>`);
});

app.post('/permute', (req, res) => {
  const csvPath = (req.body.csvPath || '').trim();
  const outputCsvPath = (req.body.outputCsvPath || '').trim();
  const n = parseInt(req.body.permutationsPerEntry, 10);
  const min = parseFloat(req.body.distanceMultiplierMin);
  const max = parseFloat(req.body.distanceMultiplierMax);

  const { error, resolvedCsvPath } = validateCsvPath(csvPath);
  if (error) {
    return res.status(400).send(error);
  }
  if (!outputCsvPath) {
    return res.status(400).send('outputCsvPath is required');
  }
  if (!Number.isFinite(n) || n < 1) {
    return res.status(400).send('permutationsPerEntry must be a positive integer');
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    return res.status(400).send('Invalid distance multiplier range');
  }

  let rows;
  try {
    ({ rows } = parseCSV(fs.readFileSync(resolvedCsvPath, 'utf8')));
  } catch (e) {
    return res.status(400).send('Batch error: ' + e.message);
  }

  const outRows = [];
  const errors = [];
  rows.forEach(({ row }, index) => {
    const lineNo = index + 2;
    const baseD = parseNumber(row.d, NaN);
    if (!row.filename || !Number.isFinite(baseD) || baseD <= 0) {
      errors.push(`Line ${lineNo}: missing filename or invalid d — skipped`);
      return;
    }
    const o = row.o ?? '';
    const rx = row.rx ?? '0';
    const ry = row.ry ?? '0';
    const rz = row.rz ?? '0';
    for (let i = 0; i < n; i++) {
      const multiplier = min + Math.random() * (max - min);
      outRows.push([row.filename, (baseD * multiplier).toFixed(2), o, rx, ry, rz]);
    }
  });

  const resolvedOutputCsvPath = path.resolve(outputCsvPath);
  const lines = [csvLine(['filename', 'd', 'o', 'rx', 'ry', 'rz'])];
  for (const r of outRows) lines.push(csvLine(r));
  fs.writeFileSync(resolvedOutputCsvPath, lines.join('\n') + '\n');

  res.send(`<!DOCTYPE html>
<html>
<head><title>Permutations Generated</title></head>
<body style="font-family:sans-serif; max-width:640px; margin:40px auto;">
  <h1>Permutations Generated</h1>
  <p>Wrote <strong>${outRows.length}</strong> row(s) (${n} per entry, d in
  [${min}x, ${max}x] of each source row's own d) to <code>${resolvedOutputCsvPath}</code>.</p>
  ${errors.length ? `<p style="color:#a00;">${errors.length} source row(s) skipped:</p><ul>${errors.map((e) => `<li>${e}</li>`).join('')}</ul>` : ''}
  <p><a href="/batch/preview?csvPath=${encodeURIComponent(resolvedOutputCsvPath)}">Review the generated CSV &rarr;</a></p>
  <p><a href="/">Back</a></p>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
