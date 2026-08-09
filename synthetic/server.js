const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nunjucks = require('nunjucks');
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

nunjucks.configure(path.join(__dirname, 'views'), {
  autoescape: true,
  express: app
});

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
// Defaults are a 100kb body and a 1000-parameter cap, either of which a
// folder/batch preview form blows past once it has more than a couple
// hundred rows (each posting its own d_/rx_/ry_/rz_/skip_ fields on
// "Save as CSV" / "Run Batch").
app.use(express.urlencoded({ extended: false, limit: '50mb', parameterLimit: 1000000 }));
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

    // Optionally save one resolution of this render to disk under a
    // hand-picked name, for building a dataset one STL at a time instead of
    // through the CSV/batch pipeline.
    const doExport = req.body.doExport === '1';
    let exportName = '';
    let exportSize = null;
    let resolvedExportFolder = '';
    if (doExport) {
      exportName = (req.body.exportName || '').trim();
      const exportFolder = (req.body.exportFolder || '').trim();
      exportSize = parseInt(req.body.exportSize, 10);

      if (!exportName || /[\\/]/.test(exportName) || exportName === '.' || exportName === '..') {
        cleanup();
        return res.status(400).send('Invalid export name: required, and must not contain "/" or "\\"');
      }
      if (!exportFolder) {
        cleanup();
        return res.status(400).send('exportFolder is required when exporting');
      }
      if (!SIZES.includes(exportSize)) {
        cleanup();
        return res.status(400).send(`Invalid exportSize: must be one of ${SIZES.join(', ')}`);
      }
      resolvedExportFolder = path.resolve(exportFolder);
    }

    try {
      const rendered = renderStereoPairs(req.file.path, d, o, { rx, ry, rz }, SIZES);

      let exportedPaths = null;
      if (doExport) {
        const match = rendered.find((p) => p.size === exportSize);
        fs.mkdirSync(resolvedExportFolder, { recursive: true });
        const leftPath = path.join(resolvedExportFolder, `${exportName}_left.png`);
        const rightPath = path.join(resolvedExportFolder, `${exportName}_right.png`);
        fs.writeFileSync(leftPath, match.image1);
        fs.writeFileSync(rightPath, match.image2);
        exportedPaths = { leftPath, rightPath };
      }

      const pairs = rendered.map(({ size, image1, image2 }) => ({
        size,
        img1: `data:image/png;base64,${image1.toString('base64')}`,
        img2: `data:image/png;base64,${image2.toString('base64')}`
      }));

      res.render('render_result.njk', { d, o, rx, ry, rz, pairs, exportedPaths });
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

  let parsedRows;
  try {
    ({ rows: parsedRows } = parseCSV(fs.readFileSync(resolvedCsvPath, 'utf8')));
  } catch (e) {
    return res.status(400).send('Batch error: ' + e.message);
  }

  const csvDir = path.dirname(resolvedCsvPath);

  const rows = parsedRows.map(({ row }, index) => {
    const lineNo = index + 2;
    const filename = row.filename;

    if (!filename) return { error: 'Missing filename', lineNo, filename: '' };

    const stlPath = path.resolve(csvDir, filename);
    if (!fs.existsSync(stlPath)) return { error: `STL not found: ${stlPath}`, lineNo, filename };

    const d = parseNumber(row.d, NaN);
    const o = parseNumber(row.o, NaN);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(o) || o < 0) {
      return { error: `Invalid d/o in CSV: d="${row.d}", o="${row.o}"`, lineNo, filename };
    }

    const { rx, ry, rz } = effectiveRotation(req.query, lineNo, row);
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) {
      return { error: 'Invalid rx, ry, or rz', lineNo, filename };
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

    return { error: null, lineNo, filename, d, o, rx, ry, rz, thumbSrc, skipped };
  });

  res.render('batch_preview.njk', { resolvedCsvPath, rows, previewSize: PREVIEW_SIZE });
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
    res.render('batch_result.njk', { outputRoot, sizes: SIZES, results });
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

  const defaultOutputCsv = path.join(resolvedFolder, 'base.csv');

  // If this folder was already reviewed once (i.e. saved out to base.csv),
  // reload its per-file d/rx/ry/rz as this visit's defaults instead of
  // starting every file over from scratch. A query-string override (e.g.
  // carried over from a rotation-viewer round trip) still wins over the
  // CSV, same as it wins over the hardcoded '0'/'' defaults below.
  const baseCsvByFilename = new Map();
  let baseCsvO = null;
  let baseCsvLoaded = false;
  if (fs.existsSync(defaultOutputCsv)) {
    try {
      const { rows: baseCsvRows } = parseCSV(fs.readFileSync(defaultOutputCsv, 'utf8'));
      for (const { row } of baseCsvRows) {
        if (row.filename) baseCsvByFilename.set(row.filename, row);
      }
      if (baseCsvRows.length > 0) baseCsvO = baseCsvRows[0].row.o;
      baseCsvLoaded = baseCsvByFilename.size > 0;
    } catch (e) {
      // Malformed base.csv shouldn't block the folder preview — fall back
      // to the usual empty/zeroed defaults below.
    }
  }

  const o = (req.query.o !== undefined ? req.query.o : (baseCsvO !== null ? baseCsvO : '50')).trim();

  const rows = files.map((filename, index) => {
    const idx = index + 1;
    const baseRow = baseCsvByFilename.get(filename);
    const dDefault = baseRow && baseRow.d !== undefined ? baseRow.d : '';
    const rxDefault = baseRow && baseRow.rx !== undefined ? baseRow.rx : '0';
    const ryDefault = baseRow && baseRow.ry !== undefined ? baseRow.ry : '0';
    const rzDefault = baseRow && baseRow.rz !== undefined ? baseRow.rz : '0';

    const dVal = req.query[`d_${idx}`] !== undefined ? req.query[`d_${idx}`] : dDefault;
    const rx = req.query[`rx_${idx}`] !== undefined ? req.query[`rx_${idx}`] : rxDefault;
    const ry = req.query[`ry_${idx}`] !== undefined ? req.query[`ry_${idx}`] : ryDefault;
    const rz = req.query[`rz_${idx}`] !== undefined ? req.query[`rz_${idx}`] : rzDefault;
    const skipped = req.query[`skip_${idx}`] === '1';

    let thumbUrl = `/folder/preview/thumb?stlFolder=${encodeURIComponent(resolvedFolder)}`
      + `&idx=${idx}&o=${encodeURIComponent(o)}&rx=${encodeURIComponent(rx)}&ry=${encodeURIComponent(ry)}&rz=${encodeURIComponent(rz)}`;
    if (dVal !== '') thumbUrl += `&d=${encodeURIComponent(dVal)}`;

    return { idx, filename, dVal, rx, ry, rz, skipped, thumbUrl };
  });

  res.render('folder_preview.njk', {
    resolvedFolder, fileCount: files.length, o, rows, defaultOutputCsv, baseCsvLoaded, previewSize: PREVIEW_SIZE
  });
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

  res.render('folder_saved.njk', { outRowsCount: outRows.length, resolvedOutputCsvPath, errors });
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
  res.render('permute_form.njk', { csvPath, outputSuggestion });
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

  res.render('permute_result.njk', { outRowsCount: outRows.length, n, min, max, resolvedOutputCsvPath, errors });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
