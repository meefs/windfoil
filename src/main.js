// main.js — the demo entry point (`deno task render`).
//
// Renders the phrase "area coverage" at a ladder of geometrically increasing sizes, every glyph of every
// row in one instanced draw, and writes an anti-aliased PNG. The sizes share one banded glyph atlas, so the
// geometry is stored once however many times a letter repeats.

import { loadFont } from "./font.js";
import { buildGlyphAtlas } from "./bands.js";
import { layoutStack } from "./layout.js";
import { renderToRGBA } from "./gpu.js";
import { encodePNG } from "./png.js";

// --style <name>: an opt-in perceptual coverage curve (gamma = stem weight <1 bolder / >1 thinner; sharp =
// edge contrast >1 crisper / <1 softer). "exact" is the default identity and writes the unsuffixed file;
// every other style writes output/area-coverage-<style>.png.
const STYLES = {
  exact: [1.0, 1.0],
  sharp: [1.15, 2.2],
  crisp: [1.05, 1.6],
  strong: [0.72, 1.1],
  smooth: [1.0, 0.7],
};
function argValue(name) {
  const i = Deno.args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < Deno.args.length) return Deno.args[i + 1];
  const eq = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}
const styleName = argValue("style") ?? "exact";
if (!(styleName in STYLES)) {
  console.error(`unknown --style "${styleName}"; choose one of: ${Object.keys(STYLES).join(", ")}`);
  Deno.exit(1);
}
const style = STYLES[styleName];
const suffix = styleName === "exact" ? "" : `-${styleName}`;

const TEXT = "area coverage";
const INK = [0.11, 0.11, 0.17, 1]; // near-black ink
const BG = [0.96, 0.95, 0.92, 1]; // warm off-white
const MARGIN = 64;

// The zoom ladder: STEPS sizes in geometric progression from MIN to MAX (a constant ratio between rows),
// preceded by a couple of extra tiny rows to show the box-integral coverage stays clean and evenly weighted
// as the type degrades to a few px (at 8px the x-height is only ~4px, well below one pixel of stem detail).
const STEPS = 10;
const MIN_SIZE = 20;
const MAX_SIZE = 200;
const TINY = [8, 13];
const ratio = (MAX_SIZE / MIN_SIZE) ** (1 / (STEPS - 1));
const sizes = [...TINY, ...Array.from({ length: STEPS }, (_, i) => MIN_SIZE * ratio ** i)];

const font = await loadFont(
  new URL("../assets/Lato-Regular.ttf", import.meta.url),
);
const { curves, rows, table, stats } = buildGlyphAtlas(font, TEXT);

// Lay out one row per size, left-aligned, stacked with spacing proportional to each size so the rhythm
// scales with the geometric ladder (the gaps grow at the same ratio as the type). Same TEXT every row.
const { instances, bounds } = layoutStack(
  sizes.map((size) => ({ text: TEXT, size })),
  table,
  font,
  { x: MARGIN, top: MARGIN, color: INK },
);
const width = Math.ceil(bounds.maxX + MARGIN); // content box + the right/bottom margins
const height = Math.ceil(bounds.maxY + MARGIN);

const instanceData = new Float32Array(instances);
const instanceCount = instanceData.length / 16;

console.log(
  `Rendering "${TEXT}" [style: ${styleName}] at ${sizes.length} sizes (${sizes[0]}–${MAX_SIZE}px) → ${width}×${height}`,
);
const t0 = performance.now();
const rgba = await renderToRGBA({
  width,
  height,
  background: BG,
  curves,
  rows,
  instances: instanceData,
  instanceCount,
  style,
});
const t1 = performance.now();

const png = encodePNG(rgba, width, height);
await Deno.mkdir(new URL("../output/", import.meta.url), { recursive: true });
const outPath = new URL(`../output/area-coverage${suffix}.png`, import.meta.url);
await Deno.writeFile(outPath, png);

console.log(
  `  ${instanceCount} glyph instances, one draw call, ${(t1 - t0).toFixed(1)} ms on the GPU`,
);
console.log(
  `  atlas: ${stats.uniqueGlyphs} unique glyphs → ${stats.monotonePieces} monotone pieces in ` +
    `${stats.bandCount} row bands (${stats.bandedPieces} banded, ${stats.duplication.toFixed(2)}× dup)`,
);
console.log(
  `  wrote ${Deno.realPathSync(outPath)} (${(png.length / 1024).toFixed(1)} KB)`,
);
