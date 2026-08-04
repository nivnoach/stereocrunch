const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { renderStereoPairs, SIZES } = require('./renderer');
const { processBatch } = require('./batch');

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

app.post('/batch', (req, res) => {
  const csvPath = (req.body.csvPath || '').trim();
  if (!csvPath) {
    return res.status(400).send('csvPath is required');
  }
  if (!csvPath.toLowerCase().endsWith('.csv')) {
    return res.status(400).send('csvPath must point to a .csv file');
  }
  const resolvedCsvPath = path.resolve(csvPath);
  if (!fs.existsSync(resolvedCsvPath)) {
    return res.status(400).send(`CSV not found: ${resolvedCsvPath}`);
  }

  try {
    const { outputRoot, results } = processBatch(resolvedCsvPath);

    const rows = results.map((r) => {
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
