const fs = require('fs');
const path = require('path');
const { renderStereoPairs, SIZES } = require('./renderer');

function parseCSV(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }
  const headerLine = lines[0];
  const header = headerLine.split(',').map((h) => h.trim().toLowerCase());
  if (!header.includes('filename') || !header.includes('d') || !header.includes('o')) {
    throw new Error('CSV header must include at least: filename, d, o');
  }
  const rawLines = lines.slice(1);
  const rows = rawLines.map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
  return { headerLine, rows, rawLines };
}

function parseNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Reads a CSV of filename,d,o,rx,ry,rz rows and renders each referenced STL
 * (resolved relative to the CSV's own folder) at every size in SIZES, writing
 * results into <csvDir>/<csvBaseName>_output/<size>x<size>/<name>_row<N>_{left,right}.png,
 * where <N> is the CSV line number. The row number keeps names unique when the
 * same STL is referenced by multiple rows with different parameters.
 * A failing row is recorded in the results and does not abort the rest of the batch.
 *
 * Each <size>x<size> folder also gets a manifest CSV (same name as the
 * original) that reproduces every original row verbatim plus two appended
 * columns, "left" and "right", holding the image filenames (blank for rows
 * that failed to render).
 */
function processBatch(csvPath) {
  const csvDir = path.dirname(csvPath);
  const csvBaseName = path.basename(csvPath, path.extname(csvPath));
  const outputRoot = path.join(csvDir, `${csvBaseName}_output`);

  for (const size of SIZES) {
    fs.mkdirSync(path.join(outputRoot, `${size}x${size}`), { recursive: true });
  }

  const text = fs.readFileSync(csvPath, 'utf8');
  const { headerLine, rows, rawLines } = parseCSV(text);

  const manifestLines = {};
  for (const size of SIZES) {
    manifestLines[size] = [`${headerLine},left,right`];
  }

  const results = rows.map((row, index) => {
    const lineNo = index + 2; // +1 for header, +1 for 1-indexing
    const rawLine = rawLines[index];
    const filename = row.filename;

    const fail = (error) => {
      for (const size of SIZES) {
        manifestLines[size].push(`${rawLine},,`);
      }
      return { lineNo, filename: filename || '', ok: false, error };
    };

    if (!filename) {
      return fail('Missing filename');
    }

    const stlPath = path.resolve(csvDir, filename);
    if (!fs.existsSync(stlPath)) {
      return fail(`STL not found: ${stlPath}`);
    }

    const d = parseNumber(row.d, NaN);
    const o = parseNumber(row.o, NaN);
    const rx = parseNumber(row.rx, 0);
    const ry = parseNumber(row.ry, 0);
    const rz = parseNumber(row.rz, 0);

    if (!Number.isFinite(d) || d <= 0) {
      return fail(`Invalid d: "${row.d}"`);
    }
    if (!Number.isFinite(o) || o < 0) {
      return fail(`Invalid o: "${row.o}"`);
    }
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) {
      return fail('Invalid rx, ry, or rz');
    }

    try {
      const baseName = path.basename(filename, path.extname(filename));
      const leftName = `${baseName}_row${lineNo}_left.png`;
      const rightName = `${baseName}_row${lineNo}_right.png`;
      const pairs = renderStereoPairs(stlPath, d, o, { rx, ry, rz }, SIZES);
      for (const { size, image1, image2 } of pairs) {
        const dir = path.join(outputRoot, `${size}x${size}`);
        fs.writeFileSync(path.join(dir, leftName), image1);
        fs.writeFileSync(path.join(dir, rightName), image2);
        manifestLines[size].push(`${rawLine},${leftName},${rightName}`);
      }
      return { lineNo, filename, ok: true, d, o, rx, ry, rz };
    } catch (e) {
      return fail(e.message);
    }
  });

  for (const size of SIZES) {
    const manifestPath = path.join(outputRoot, `${size}x${size}`, `${csvBaseName}.csv`);
    fs.writeFileSync(manifestPath, manifestLines[size].join('\n') + '\n');
  }

  return { outputRoot, results };
}

module.exports = { processBatch };
