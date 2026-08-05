const fs = require('fs');
const path = require('path');
const { renderStereoPairs, SIZES } = require('./renderer');

// Minimal RFC 4180 parser: handles double-quoted fields, commas and quotes
// inside them ("" is an escaped quote). Needed because real filenames can
// contain commas (seen in real STL datasets), which would otherwise shift
// every column after it.
function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function csvField(value) {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(fields) {
  return fields.map(csvField).join(',');
}

function parseCSV(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }
  const headerRaw = parseCSVLine(lines[0]).map((h) => h.trim());
  const headerLower = headerRaw.map((h) => h.toLowerCase());
  if (!headerLower.includes('filename') || !headerLower.includes('d') || !headerLower.includes('o')) {
    throw new Error('CSV header must include at least: filename, d, o');
  }
  const rows = lines.slice(1).map((line) => {
    const values = parseCSVLine(line).map((c) => c.trim());
    const row = {};
    headerLower.forEach((h, i) => { row[h] = values[i]; });
    return { row, values };
  });
  return { headerRaw, rows };
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
 * original) that reproduces every original row plus two appended columns,
 * "left" and "right", holding the image filenames (blank for rows that
 * failed to render). Fields are CSV-quoted as needed on the way out.
 */
function processBatch(csvPath) {
  const csvDir = path.dirname(csvPath);
  const csvBaseName = path.basename(csvPath, path.extname(csvPath));
  const outputRoot = path.join(csvDir, `${csvBaseName}_output`);

  for (const size of SIZES) {
    fs.mkdirSync(path.join(outputRoot, `${size}x${size}`), { recursive: true });
  }

  const text = fs.readFileSync(csvPath, 'utf8');
  const { headerRaw, rows } = parseCSV(text);

  const manifestLines = {};
  for (const size of SIZES) {
    manifestLines[size] = [csvLine([...headerRaw, 'left', 'right'])];
  }

  const batchStart = Date.now();
  console.log(`[batch] Starting: ${rows.length} rows from ${csvPath}, sizes ${SIZES.join(', ')} -> ${outputRoot}`);

  const results = rows.map(({ row, values }, index) => {
    const lineNo = index + 2; // +1 for header, +1 for 1-indexing
    const paddedValues = headerRaw.map((_, i) => values[i] ?? '');
    const filename = row.filename;
    const progress = `[batch] (${index + 1}/${rows.length}) line ${lineNo}`;
    const rowStart = Date.now();

    const fail = (error) => {
      for (const size of SIZES) {
        manifestLines[size].push(csvLine([...paddedValues, '', '']));
      }
      console.log(`${progress} ${filename || '(no filename)'}: FAILED - ${error}`);
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
        manifestLines[size].push(csvLine([...paddedValues, leftName, rightName]));
      }
      console.log(`${progress} ${filename}: OK (${Date.now() - rowStart}ms)`);
      return { lineNo, filename, ok: true, d, o, rx, ry, rz };
    } catch (e) {
      return fail(e.message);
    }
  });

  for (const size of SIZES) {
    const manifestPath = path.join(outputRoot, `${size}x${size}`, `${csvBaseName}.csv`);
    fs.writeFileSync(manifestPath, manifestLines[size].join('\n') + '\n');
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`[batch] Done: ${okCount}/${results.length} succeeded in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);

  return { outputRoot, results };
}

module.exports = { processBatch, parseCSVLine, csvField, csvLine };
