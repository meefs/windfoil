// windfoil-accel.js — build the extra data + renderer for bench/windfoil-accel.wgsl: windfoil's coverage with
// a MOMENTS + BACKDROP acceleration for minification, fused into one 2D-cell structure. Kept in bench/ so
// src/windfoil.wgsl stays the thin reference. See docs/NOTES.md → "Band Moments" and "Backdrop".
//
// windfoil is slowest at minification: the pixel's y-slab spans many row bands and it integrates every curve
// in each. For a band WHOLLY inside the slab we can do better. Split its curves at a fixed grid of ACCEL_CELLS
// vertical cells (uniform over the glyph's x-extent), and precompute per cell:
//
//   S = Σ ∫ (x − xref)·y′ dt   (xref = glyph bbox loX)   — the winding-integral moment over the band's y-range
//   D = Σ ∫ y′ dt = Σ Δy                                 — net signed Δy
//
// Then a fragment classifies each cell against its pixel box [rc.x ± hx]:
//   • fully INSIDE the box  → the clamp never clips → contribute  S + (xref − rc.x + hx)·D   (moment, O(1))
//   • fully RIGHT of the box → the clamp saturates → contribute  sx·D                          (backdrop, O(1))
//   • fully LEFT            → contributes 0
//   • straddling a box edge (≤ 2 cells) → integrate that cell's split sub-pieces the real way.
//
// So an interior band collapses to ~ACCEL_CELLS O(1) cell tests + at most two real integrations, regardless of
// how many curves it holds. Slab-EDGE bands (the y-window is clipped, so the moment's assumptions don't hold)
// fall back to windfoil's plain gather over the original curve atlas. Bit-for-bit identical coverage.

import { loadShaderCode } from '../src/gpu.js';

export const ACCEL_CELLS = 8; // vertical cells per glyph (must match ACCEL_CELLS in windfoil-accel.wgsl)

const WGSL_URL = new URL('./windfoil-accel.wgsl', import.meta.url);
export function loadAccelShaderCode() {
  return loadShaderCode(WGSL_URL);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// de Casteljau split of a 6-float quad [x0,y0,cx,cy,x1,y1] at t → [left, right] (shared midpoint identical).
function subdivide(q, t) {
  const l = (a, b) => a + (b - a) * t;
  const x01 = l(q[0], q[2]), y01 = l(q[1], q[3]), x12 = l(q[2], q[4]), y12 = l(q[3], q[5]);
  const xm = l(x01, x12), ym = l(y01, y12);
  return [[q[0], q[1], x01, y01, xm, ym], [xm, ym, x12, y12, q[4], q[5]]];
}

// Solve a monotone quadratic component (q0 at t=0, qe at t=1) for value = target on [0,1], saturating.
function solveMonoT(a2, a1, q0, qe, target) {
  const rising = qe >= q0;
  if (rising) { if (q0 >= target) return 0; if (qe <= target) return 1; }
  else { if (q0 <= target) return 0; if (qe >= target) return 1; }
  const c = q0 - target;
  if (Math.abs(a2) < 1e-12 * Math.max(Math.abs(a1), 1)) return clamp01(-c / a1);
  const disc = Math.max(a1 * a1 - 4 * a2 * c, 0);
  const sq = Math.sqrt(disc);
  const qq = -0.5 * (a1 + (a1 >= 0 ? sq : -sq));
  const r1 = qq / a2, r2 = qq !== 0 ? c / qq : 0;
  const want = rising ? 1 : -1;
  return clamp01((2 * a2 * r1 + a1) * want >= 0 ? r1 : r2);
}

// y-clip a 6-float quad to [b0, b1] → sub-quad (still xy-monotone) or null if it doesn't reach the band.
function clipY(q, b0, b1) {
  const a2 = q[1] - 2 * q[3] + q[5], a1 = 2 * (q[3] - q[1]);
  const yLo = Math.min(q[1], q[5]), yHi = Math.max(q[1], q[5]);
  const cLo = Math.max(b0, yLo), cHi = Math.min(b1, yHi);
  if (cHi <= cLo) return null;
  const t0 = solveMonoT(a2, a1, q[1], q[5], cLo);
  const t1 = solveMonoT(a2, a1, q[1], q[5], cHi);
  const ta = Math.min(t0, t1), tb = Math.max(t0, t1);
  if (tb <= ta) return null;
  let r = q;
  if (ta > 0) r = subdivide(r, ta)[1];        // drop [0, ta] → r spans [ta, 1]
  if (tb < 1) r = subdivide(r, (tb - ta) / (1 - ta))[0]; // keep [ta, tb]
  return r;
}

// x-split a 6-float quad (xy-monotone) at the boundaries of a uniform x-cell grid → [{cell, quad}], each run
// inside one cell. Splits at every internal boundary the quad crosses, then assigns by x-midpoint.
function splitX(q, cellX0, cellW, C) {
  const a2 = q[0] - 2 * q[2] + q[4], a1 = 2 * (q[2] - q[0]);
  const clampCell = (x) => Math.min(Math.max(Math.floor((x - cellX0) / cellW), 0), C - 1);
  const cLo = clampCell(Math.min(q[0], q[4])), cHi = clampCell(Math.max(q[0], q[4]));
  if (cHi <= cLo) return [{ cell: cLo, q }];
  const ts = [];
  for (let c = cLo + 1; c <= cHi; c++) {
    const t = solveMonoT(a2, a1, q[0], q[4], cellX0 + c * cellW);
    if (t > 0 && t < 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out = [];
  let rest = q, consumed = 0;
  for (const t of ts) {
    const local = (t - consumed) / (1 - consumed);
    if (!(local > 0 && local < 1)) continue;
    const [left, right] = subdivide(rest, local);
    out.push(left);
    rest = right;
    consumed = t;
  }
  out.push(rest);
  return out.map((sq) => ({ cell: clampCell((sq[0] + sq[4]) * 0.5), q: sq }));
}

// Moment (S, D) of a 6-float sub-quad already inside the band and one cell: S = ∫(x−xref)y′, D = ∫y′ over [0,1].
function subMoment(q, xref) {
  const a2x = q[0] - 2 * q[2] + q[4], a1x = 2 * (q[2] - q[0]);
  const a2y = q[1] - 2 * q[3] + q[5], a1y = 2 * (q[3] - q[1]);
  const D = q[5] - q[1];
  const u0 = q[0] - xref;
  const c0 = u0 * a1y, c1 = u0 * 2 * a2y + a1x * a1y, c2 = 2 * a1x * a2y + a2x * a1y, c3 = 2 * a2x * a2y;
  const S = ((c3 * 0.25 + c2 / 3) + c1 * 0.5) + c0; // ∫_0^1 = c0 + c1/2 + c2/3 + c3/4
  return { S, D };
}

/**
 * Build the accel buffers for a windfoil atlas. Reuses the packed windfoil instances to recover each glyph's
 * band header (rowBase, bandCount, y0, invH) and x-extent (bbox loX/hiX).
 * @returns {{ cellData: Float32Array, cellCurves: Float32Array }}
 *   cellData:  ACCEL_CELLS vec4 per band = (S, D, subStart, subCount), indexed (rowBase+ri)*ACCEL_CELLS + cc
 *   cellCurves: the split sub-pieces (3 vec2 each), grouped by cell
 */
export function buildAccel(curves, rows, instances) {
  const C = ACCEL_CELLS;
  const nBands = rows.length / 2;
  const cellData = new Float32Array(nBands * C * 4);
  const cellCurves = []; // flat, 6 floats per sub-piece

  const headers = new Map();
  for (let i = 0; i < instances.length; i += 16) {
    const rowBase = instances[i + 12];
    if (!headers.has(rowBase)) {
      headers.set(rowBase, {
        R: instances[i + 13] | 0, y0: instances[i + 14], invH: instances[i + 15],
        loX: instances[i + 4], hiX: instances[i + 6],
      });
    }
  }

  for (const [rowBase, h] of headers) {
    if (!(h.invH > 0) || h.R <= 1) continue; // cell path only for multi-band glyphs
    const cellX0 = h.loX;
    const cellW = (h.hiX - h.loX) / C || 1;
    for (let ri = 0; ri < h.R; ri++) {
      const b0 = h.y0 + ri / h.invH, b1 = h.y0 + (ri + 1) / h.invH;
      const rIdx = (rowBase + ri) * 2;
      const start = rows[rIdx], count = rows[rIdx + 1];
      const cellS = new Float64Array(C), cellD = new Float64Array(C);
      const cellSub = Array.from({ length: C }, () => []); // 6-float sub-pieces per cell
      for (let k = 0; k < count; k++) {
        const b = (start + k) * 6;
        const q = [curves[b], curves[b + 1], curves[b + 2], curves[b + 3], curves[b + 4], curves[b + 5]];
        const yc = clipY(q, b0, b1);
        if (!yc) continue;
        for (const seg of splitX(yc, cellX0, cellW, C)) {
          const m = subMoment(seg.q, cellX0);
          cellS[seg.cell] += m.S;
          cellD[seg.cell] += m.D;
          cellSub[seg.cell].push(seg.q);
        }
      }
      for (let cc = 0; cc < C; cc++) {
        const subStart = cellCurves.length / 6;
        for (const sq of cellSub[cc]) cellCurves.push(...sq);
        const o = ((rowBase + ri) * C + cc) * 4;
        cellData[o] = cellS[cc];
        cellData[o + 1] = cellD[cc];
        cellData[o + 2] = subStart;
        cellData[o + 3] = cellSub[cc].length;
      }
    }
  }
  return { cellData, cellCurves: new Float32Array(cellCurves) };
}

function storage(device, typed) {
  const buf = device.createBuffer({ size: Math.max(typed.byteLength, 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  if (typed.byteLength) device.queue.writeBuffer(buf, 0, typed);
  return buf;
}

/** Renderer for the accelerated shader — windfoil's 4 bindings plus cellData (4) and cellCurves (5). */
export function createAccelRenderer(device, { code, format, curves, rows, cellData, cellCurves, instances, instanceCount }) {
  const module = device.createShaderModule({ code });
  const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bufs = [
    storage(device, instances), storage(device, curves), storage(device, rows),
    storage(device, cellData), storage(device, cellCurves),
  ];
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-strip' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: bufs[0] } },
      { binding: 2, resource: { buffer: bufs[1] } },
      { binding: 3, resource: { buffer: bufs[2] } },
      { binding: 4, resource: { buffer: bufs[3] } },
      { binding: 5, resource: { buffer: bufs[4] } },
    ],
  });
  return {
    setUniforms({ width, height, style = [1, 1], cam = [1, 1, 0, 0] }) {
      device.queue.writeBuffer(uniform, 0, new Float32Array([width, height, style[0], style[1], cam[0], cam[1], cam[2], cam[3]]));
    },
    draw(pass) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(4, instanceCount);
    },
  };
}
