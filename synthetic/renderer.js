// Minimal software STL renderer: parses an STL file and rasterizes it
// from an arbitrary camera position/target, with no GPU/browser dependency.
const fs = require('fs');
const { PNG } = require('pngjs');

const SS = 2; // supersampling factor for basic anti-aliasing
const SIZES = [64, 128, 256];
// The camera-distance-to-radius ratio that produces a "naturally framed"
// shot (matches viewer.html's auto-frame distance and the folder-preview
// default d). Used as the reference apparent size that distance-compensated
// renders are zoomed to match, regardless of the actual d used.
const DEFAULT_DISTANCE_MULTIPLIER = 2.8;

function parseSTL(buffer) {
  const triangles = [];

  const isBinary = () => {
    if (buffer.length < 84) return false;
    const nTri = buffer.readUInt32LE(80);
    return 84 + nTri * 50 === buffer.length;
  };

  if (isBinary()) {
    const nTri = buffer.readUInt32LE(80);
    let offset = 84;
    for (let i = 0; i < nTri; i++) {
      offset += 12; // skip stored normal, we recompute it
      const v0 = [buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8)];
      offset += 12;
      const v1 = [buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8)];
      offset += 12;
      const v2 = [buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8)];
      offset += 12;
      offset += 2; // attribute byte count
      triangles.push([v0, v1, v2]);
    }
  } else {
    const text = buffer.toString('utf8');
    const nums = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m;
    let verts = [];
    while ((m = nums.exec(text)) !== null) {
      verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
      if (verts.length === 3) {
        triangles.push(verts);
        verts = [];
      }
    }
  }

  if (triangles.length === 0) {
    throw new Error('No triangles found in STL file');
  }
  return triangles;
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a) { return Math.sqrt(dot(a, a)); }
function normalize(a) {
  const l = length(a) || 1e-9;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function centerAndBounds(triangles) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const tri of triangles) {
    for (const v of tri) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
    }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let radius = 0;
  for (const tri of triangles) {
    for (const v of tri) {
      const r = length(sub(v, center));
      if (r > radius) radius = r;
    }
  }
  const centered = triangles.map((tri) => tri.map((v) => sub(v, center)));
  return { triangles: centered, radius: radius || 1 };
}

// Applies pitch (rx), then yaw (ry), then roll (rz) about the origin.
// Distances from the origin are preserved, so a pre-computed bounding
// radius stays valid after rotation.
function rotatePoint([x, y, z], rx, ry, rz) {
  let cx = x, cy = y, cz = z;

  let c = Math.cos(rx), s = Math.sin(rx);
  [cy, cz] = [cy * c - cz * s, cy * s + cz * c];

  c = Math.cos(ry); s = Math.sin(ry);
  [cx, cz] = [cx * c + cz * s, -cx * s + cz * c];

  c = Math.cos(rz); s = Math.sin(rz);
  [cx, cy] = [cx * c - cy * s, cx * s + cy * c];

  return [cx, cy, cz];
}

function rotateTriangles(triangles, rxDeg, ryDeg, rzDeg) {
  if (!rxDeg && !ryDeg && !rzDeg) return triangles;
  const rx = (rxDeg * Math.PI) / 180;
  const ry = (ryDeg * Math.PI) / 180;
  const rz = (rzDeg * Math.PI) / 180;
  return triangles.map((tri) => tri.map((v) => rotatePoint(v, rx, ry, rz)));
}

function renderView(triangles, radius, { eye, target, up, d, width, height, fov = 45, compensateDistance = false, grayscale = false }) {
  const w = width * SS;
  const h = height * SS;

  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, up));
  const camUp = cross(right, forward);

  const near = Math.max(d - radius * 1.5, 0.01);
  const baseScale = 1 / Math.tan((fov * Math.PI) / 180 / 2);
  // Apparent size of an object at distance d is proportional to 1/d for a
  // fixed scale; to cancel that out (so distance permutations of the same
  // STL all look the same size — otherwise a model could learn to infer
  // distance from apparent size instead of stereo disparity), zoom in
  // proportionally to d, referenced against the distance that would
  // naturally frame this object at the default fov.
  const referenceD = radius * DEFAULT_DISTANCE_MULTIPLIER;
  const scale = compensateDistance ? baseScale * (d / referenceD) : baseScale;
  const aspect = w / h;

  const lightDir = normalize([0.4, 0.6, 1]);

  const project = (p) => {
    const rel = sub(p, eye);
    const vx = dot(rel, right);
    const vy = dot(rel, camUp);
    const vz = dot(rel, forward);
    if (vz <= near) return null;
    const ndcX = (vx / vz) * (scale / aspect);
    const ndcY = (vy / vz) * scale;
    return {
      x: (ndcX * 0.5 + 0.5) * w,
      y: (1 - (ndcY * 0.5 + 0.5)) * h,
      invz: 1 / vz
    };
  };

  const framebuffer = new Float32Array(w * h * 3).fill(255); // white background
  const zbuffer = new Float32Array(w * h).fill(0);

  const baseColor = [70, 130, 180];

  for (const tri of triangles) {
    const p0 = project(tri[0]);
    const p1 = project(tri[1]);
    const p2 = project(tri[2]);
    if (!p0 || !p1 || !p2) continue;

    const normal = normalize(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
    const intensity = 0.35 + 0.65 * Math.abs(dot(normal, lightDir));
    const color = [baseColor[0] * intensity, baseColor[1] * intensity, baseColor[2] * intensity];

    const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
    const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
    if (minX > maxX || minY > maxY) continue;

    const area = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    if (Math.abs(area) < 1e-9) continue;

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        const w0 = (p1.x - p0.x) * (cy - p0.y) - (p1.y - p0.y) * (cx - p0.x);
        const w1 = (p2.x - p1.x) * (cy - p1.y) - (p2.y - p1.y) * (cx - p1.x);
        const w2 = (p0.x - p2.x) * (cy - p2.y) - (p0.y - p2.y) * (cx - p2.x);

        const inside = (w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0);
        if (!inside) continue;

        const b0 = w1 / area;
        const b1 = w2 / area;
        const b2 = w0 / area;
        const invz = b0 * p0.invz + b1 * p1.invz + b2 * p2.invz;

        const idx = py * w + px;
        if (invz > zbuffer[idx]) {
          zbuffer[idx] = invz;
          const fi = idx * 3;
          framebuffer[fi] = color[0];
          framebuffer[fi + 1] = color[1];
          framebuffer[fi + 2] = color[2];
        }
      }
    }
  }

  return downsample(framebuffer, w, h, width, height, grayscale);
}

function downsample(framebuffer, w, h, outW, outH, grayscale = false) {
  const png = new PNG({ width: outW, height: outH });
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = ((y * SS + sy) * w + (x * SS + sx)) * 3;
          r += framebuffer[idx];
          g += framebuffer[idx + 1];
          b += framebuffer[idx + 2];
        }
      }
      const n = SS * SS;
      let rOut = Math.min(255, Math.round(r / n));
      let gOut = Math.min(255, Math.round(g / n));
      let bOut = Math.min(255, Math.round(b / n));
      if (grayscale) {
        // Rec. 601 luma weights.
        const lum = Math.round(0.299 * rOut + 0.587 * gOut + 0.114 * bOut);
        rOut = gOut = bOut = lum;
      }
      const outIdx = (y * outW + x) * 4;
      png.data[outIdx] = rOut;
      png.data[outIdx + 1] = gOut;
      png.data[outIdx + 2] = bOut;
      png.data[outIdx + 3] = 255;
    }
  }
  // png.data is always laid out RGBA regardless of output format; passing
  // colorType 0 (true single-channel grayscale, per the PNG spec) here has
  // pngjs collapse it on write instead of writing a 4x-larger RGBA file
  // with R=G=B in every pixel.
  return grayscale
    ? PNG.sync.write(png, { colorType: 0, inputColorType: 6 })
    : PNG.sync.write(png);
}

// Loads an STL, centers it, and applies (rx, ry, rz) degree rotation about
// its own center, returning triangles ready for renderView plus the
// bounding radius. Shared by renderStereoPairs and renderPreview.
function loadAndPrepare(stlPath, rx, ry, rz) {
  const buffer = fs.readFileSync(stlPath);
  const parsed = parseSTL(buffer);
  const { triangles: centered, radius } = centerAndBounds(parsed);
  const triangles = rotateTriangles(centered, rx, ry, rz);
  return { triangles, radius };
}

// Just the bounding radius of an STL, with no rotation/rasterization work.
// Note this still pays nearly the full parse cost of loadAndPrepare (the
// triangle-array parse dominates the time, not the rendering), so callers
// with many files should treat this as no cheaper than a preview render.
function getBoundingRadius(stlPath) {
  const buffer = fs.readFileSync(stlPath);
  const parsed = parseSTL(buffer);
  const { radius } = centerAndBounds(parsed);
  return radius;
}

/**
 * Renders stereo view pairs of an STL file at each given (square) size:
 * cameras at (-o/2, 0, d) and (o/2, 0, d), both looking at the object's
 * center, distance d away, separated by baseline o. The object is rotated
 * by (rx, ry, rz) degrees (pitch, yaw, roll) about its own center before
 * rendering. The STL is parsed and rotated once and reused across sizes.
 *
 * Output is grayscale, and zoom is compensated for d (see renderView) so
 * that distance permutations of the same STL all appear the same apparent
 * size — the training images shouldn't let a model infer distance from
 * apparent size, only from stereo disparity. Preview thumbnails elsewhere
 * intentionally do NOT get this treatment (renderPreview doesn't set these
 * flags) since they're for human alignment-checking, not training data.
 */
function renderStereoPairs(stlPath, d, o, { rx = 0, ry = 0, rz = 0 } = {}, sizes = SIZES) {
  const { triangles, radius } = loadAndPrepare(stlPath, rx, ry, rz);

  const up = [0, 1, 0];
  return sizes.map((size) => {
    const image1 = renderView(triangles, radius, {
      eye: [-o / 2, 0, d], target: [0, 0, 0], up, d, width: size, height: size,
      compensateDistance: true, grayscale: true
    });
    const image2 = renderView(triangles, radius, {
      eye: [o / 2, 0, d], target: [0, 0, 0], up, d, width: size, height: size,
      compensateDistance: true, grayscale: true
    });
    return { size, image1, image2 };
  });
}

/**
 * Renders a single quick preview image (left camera only, one small size)
 * of an STL for the given d/o/rotation, so a planned render's alignment
 * can be eyeballed cheaply without paying for the full stereo/multi-size
 * batch render.
 */
function renderPreview(stlPath, d, o, { rx = 0, ry = 0, rz = 0 } = {}, size = 160) {
  const { triangles, radius } = loadAndPrepare(stlPath, rx, ry, rz);
  const up = [0, 1, 0];
  return renderView(triangles, radius, {
    eye: [-o / 2, 0, d], target: [0, 0, 0], up, d, width: size, height: size
  });
}

module.exports = { renderStereoPairs, renderPreview, getBoundingRadius, SIZES, DEFAULT_DISTANCE_MULTIPLIER };
