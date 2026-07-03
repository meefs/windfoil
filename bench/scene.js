// scene.js — build the shared benchmark scene: one dense grid of real text, laid out once and emitted as BOTH
// a windfoil instance buffer (16 floats/glyph) and a Slug instance buffer (20 floats/glyph) at IDENTICAL glyph
// positions. Same pen walk (font advances + kerning) drives both, so the two renderers draw the exact same
// pixels and only the coverage technique differs — the fair basis for the comparison.
//
// The grid is sized to fill the viewport at the most-minified zoom the benchmark tests (so every zoom level in
// renders a screen full of glyphs — bench/main.js zooms IN from there, always looking at dense text). Glyphs
// are packed at one world em size; the camera does the zooming.

import { advanceOf, kerningOf } from '../src/font.js';

// Near-black ink on the near-white clear (matches the windfoil demos).
export const INK = [12, 15, 28, 0xff].map((x) => x / 0xff);

// A glyph-varied corpus (upper/lower/digits/punctuation) so the atlas is representative, tiled to fill the grid.
const CORPUS = (
  'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow. ' +
  'Pack my box with five dozen liquor jugs; 1234567890 — waltz, nymph, for quick jigs vex Bud. ' +
  'How vexingly quick daft zebras jump! Bright vixens jab, dozy fowl quack. '
).split(/\s+/).filter(Boolean);

// Every character the grid can place — feed this to the atlas builders so they cover the whole corpus.
export const SCENE_TEXT = CORPUS.join(' ');

/**
 * Lay out a grid of text covering the world square [−extent, extent]² at world em size `emWorld`, emitting one
 * instance per non-space glyph into both buffers.
 *
 * @param {object} font                opentype font
 * @param {object} wTable              per-glyph band table from buildGlyphAtlas (windfoil)
 * @param {object} sTable              per-glyph band table from buildSlugAtlas (slug)
 * @param {object} o  { emWorld, extent, color }
 * @returns {{ wInstances: Float32Array, sInstances: Float32Array, count: number,
 *             center: {x,y}, worldSpan: number }}
 */
export function buildScene(font, wTable, sTable, { emWorld, extent, color = INK }) {
  const scale = emWorld / font.unitsPerEm; // font units → world units
  const rule = 0; // nonzero fill
  const [r, g, b, a = 1] = color;
  const lineHeight = 1.32 * emWorld; // world units per text row
  const ascent = 0.58 * emWorld; // baseline drop from a row's top

  const w = [];
  const s = [];
  let count = 0;
  let wi = 0; // running index into the corpus, wrapping — a continuous stream of words

  // Track a "focus" point on a real vertical stem nearest the origin, so the camera can zoom all the way into
  // ink (see just a stem) rather than landing in the whitespace between glyphs. These letters have a left stem;
  // a point ~12% in from the left edge at mid-height sits inside it.
  const STEM = new Set([...'bdhklnmpqurBDHIKLMNPRhi']);
  let focus = { x: 0, y: 0 }, focusD2 = Infinity;

  for (let baselineY = -extent + ascent; baselineY < extent; baselineY += lineHeight) {
    let pen = -extent;
    let prev = null;
    while (pen < extent) {
      const word = CORPUS[wi++ % CORPUS.length] + ' ';
      for (const ch of word) {
        if (prev !== null) pen += kerningOf(font, prev, ch) * scale;
        const wg = wTable[ch];
        const sg = sTable[ch];
        if (wg && sg) {
          if (STEM.has(ch)) {
            const fx = pen + (wg.bbox[0] + 0.12 * (wg.bbox[2] - wg.bbox[0])) * scale;
            const fy = baselineY + 0.5 * (wg.bbox[1] + wg.bbox[3]) * scale;
            const d2 = fx * fx + fy * fy;
            if (d2 < focusD2) { focusD2 = d2; focus = { x: fx, y: fy }; }
          }
          // windfoil instance (16 floats) — matches src/layout.js's packing exactly.
          w.push(
            pen, baselineY, scale, rule,
            wg.bbox[0], wg.bbox[1], wg.bbox[2], wg.bbox[3],
            r, g, b, a,
            wg.rowBase, wg.bandCount, wg.y0, wg.invH,
          );
          // slug instance (20 floats) — same place/bbox/color, plus both band headers.
          s.push(
            pen, baselineY, scale, rule,
            sg.bbox[0], sg.bbox[1], sg.bbox[2], sg.bbox[3],
            r, g, b, a,
            sg.hRowBase, sg.hBandCount, sg.y0, sg.invH,
            sg.vRowBase, sg.vBandCount, sg.rotY0, sg.invW,
          );
          count++;
        }
        pen += advanceOf(font, ch) * scale; // advance for glyphs and spaces alike
        prev = ch;
      }
    }
  }

  return {
    wInstances: new Float32Array(w),
    sInstances: new Float32Array(s),
    count,
    center: focus, // zoom target: a stem near the origin, so deep magnification lands on ink
    worldSpan: 2 * extent,
  };
}
