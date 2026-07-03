# windfoil acceleration — engineering notes

Working notes from exploring ways to speed up windfoil where it loses badly to Slug. Two moment-based
accelerations were built, measured, and reverted; this records *why*, so we don't repeat them, and points at the
one path that could actually work. Condensed version lives in `README.md` → "Rejected: band-moments
acceleration"; this is the long form.

Machine: Apple GPU via Deno 2.x WebGPU (Metal). Numbers are relative and machine-specific.

## 1. Where windfoil loses to Slug (from the benchmark)

| regime | gap (slug faster) | why |
| --- | --- | --- |
| **minification, dense art** | **5–30×** (complex shape @2px: windfoil 1254 ms/frame vs slug 42) | windfoil integrates the *whole footprint* — O(bands × curves/band). Slug point-samples one band per ray — O(1). |
| minification, text | 3–7× | same, milder (fewer curves/band) |
| small/medium text 16–64px | 1.5–2.6× | footprint ≈ 1 band; per-crossing ALU (windfoil ~4 monotone solves + polynomial vs slug 1 solve + a ramp) |

windfoil *wins* deep magnification (footprint = 1 band of ~1 curve), memory (~half Slug's atlas), and exact
quality. The gap is minification, and it's structural: **an exact box-integral over a large footprint of many
curves is inherently O(footprint)** — there is no analytic O(1) for "integrate this 2D region against N curves."
Slug is faster there precisely because it *doesn't* integrate the footprint; it point-samples one scanline.

## 2. The moment idea and its ceiling

`docs/NOTES.md` → "Band Moments": a band wholly inside the pixel's y-slab, where the box also x-contains it (so
the winding-integral clamp never clips), contributes the closed form `S + (xref − rc.x + hx)·D`, O(1), with
`S = Σ∫(x−xref)·y′`, `D = Σ∫y′`. Only the ≤2 slab-edge bands need real integration.

**Ceiling test** (forced the x-contained check true — wrong coverage, timing only): the moment math is worth
**2.2× on glyphs and ~8× on the shape at 2px**. So the math has real potential — but it's gated by x-containment
(box ⊇ the band's curves in x), which for full-width bands is only satisfied near sub-pixel widths.

## 3. Attempt 1 — 2D-cell fusion (moments + backdrop)

Split each interior band's curves at a fixed grid of vertical cells; classify each cell vs the pixel box: fully
inside → moment, fully right → backdrop `sx·D`, fully left → 0, straddling → integrate its split sub-pieces.
Removes the x-containment restriction (each *cell* is contained or not). Built in a windfoil-accel shader,
benchmarked as `windfoil+`. **Bit-exact** (`--check` |Δrgb| 0.00000).

Result: **only ~1.6× at deep minification of dense art** (shape @2px 1254→797 ms), and **~5–20% slower
everywhere else**. Wide curves (ellipse arcs spanning the shape) x-split into up to 8 sub-pieces each, so the ≤2
straddle cells stay as expensive as the plain gather — only the *interior* cells collapse to O(1). Reverted.

## 4. Attempt 2 — analytic y-prefix-sum of moments

Precompute a per-band inclusive prefix sum of `(S, D)`. Then the whole run of interior fully-covered bands a
footprint spans collapses to **one subtraction** `prefix[ri1−1] − prefix[ri0]`, O(1); only the ≤2 slab-edge
bands integrate. No cells (lean shader). Gated at the instance level (engages only when the box x-contains the
glyph AND the slab spans ≥3 bands — i.e. minified text) so the average case should skip it. **Bit-exact.**

Result: **worse than the cells.** ~**3.8× slower** at 2px, ~19% slower at 256px.

| glyph px | windfoil (ms) | windfoil+ y-prefix (ms) | ratio |
| --- | --- | --- | --- |
| 2 | 58.9 | 221 | 0.27× |
| 8 | 4.34 | 10.9 | 0.40× |
| 256 (gate off) | 0.19 | 0.24 | 0.81× |

Reverted.

## 5. Root cause — the GPU execution model, not the math

Both attempts fail for the same two reasons:

1. **Register pressure → lower occupancy** (the "bloat" cost — why unexecuted code still slows things).
   A GPU hides memory latency (windfoil is gathering curves from storage buffers) by keeping many warps in flight
   on each core; how many is capped by how many **registers** each thread needs, since the register file is a
   fixed size split among the resident threads. Register allocation is done **statically for the whole pipeline**
   — the peak across *all* branches, including ones a given fragment never takes at runtime. So adding the moment
   path raises the shader's peak register count (its own live values: the prefix reads, the S/D combine, the edge
   setup); the pipeline then runs at the *lower* occupancy that peak dictates, and **every** fragment — including
   the ones that fall straight through to the plain gather — gets less latency hiding and runs slower. Measured at
   256px, where the gate is provably off and every fragment runs plain windfoil, windfoil+ was still ~19% slower.
   (Register spilling, if the peak is high enough, adds it directly as extra memory traffic.) Caveat: this is
   *inferred* from the symptom — slower even when the branch is untaken — not read off the Metal compiler's
   occupancy report (Deno doesn't surface it); and at ~0.2 ms/frame that 19% is close to run-to-run noise, so
   read it as "a real occupancy effect of unknown exact size," not a precise 19%.
2. **Per-fragment branch divergence.** The moment is exact *only where the box x-contains the glyph* — a
   per-fragment condition. At the small sizes where it fires, a warp straddles many tiny glyphs (narrow ⇒ moment
   lane, wide ⇒ plain lane) and center-vs-edge pixels, so warps execute **both** the moment path *and* the
   variable-length plain loop. Divergence *rises* as glyphs shrink — exactly the regime the moment targets —
   which is why the y-prefix gets progressively worse toward 2px.

Conclusion: **an exact per-fragment moment cannot beat windfoil's plain gather inside one shader.** The O(1) win
is real but the bloat + divergence swamp it. This is now confirmed from two independent designs (cells and
prefix), so it's a property of the approach, not a tuning miss.

## 6. The one path that could work — and its cost

To sidestep *both* bloat and divergence you need a **separate, cheaper shader selected per instance/zoom**, not a
branch inside the coverage shader. Concretely, a **prefiltered coverage mip**:

- Render each unique glyph/shape's coverage with windfoil at level 0, box-average down to a mip pyramid, atlas
  them. Below a crossover size, sample the mip (one trilinear tap) instead of gathering. **O(1), no divergence.**
- **A mip level *is* a box filter**, so a trilinear sample at the footprint size *reproduces* windfoil's exact
  box filter (converging with resolution) — not a separate AA model. Above the crossover, keep the analytic
  gather (crisp at any zoom). This is the hybrid every production text stack makes.
- Would close the whole minification column (and the 16–64px per-crossing-ALU gap if the crossover is ~32–48px).

**The catch:** baked assets (atlas memory, per-glyph). That trades away windfoil's differentiator — analytic,
atlas-free, resolution-independent, no baked data. So it's a **product decision**, not a free win. If atlas-free
is the point, minification simply *is* windfoil's weak flank and it's fine to cede it (windfoil wins
magnification, memory, and exact quality).

## 7. What did work / other rejected ideas

- **`TARGET_PER_BAND` 6 → 10** (`src/bands.js`, committed): ~8–19% faster at small/medium, no large-size
  regression, ~15% smaller atlas, bit-identical coverage. This is the analytic ceiling that actually helped.
- **Straight-piece fast path** — rejected: `mono_root` already skips the `sqrt` for lines, so the ceiling is
  tiny and would add divergence.

## 8. Recommendation

Don't attempt further in-shader moment/backdrop variants — the bloat+divergence ceiling is now well established.
If minification performance becomes a product priority, build the coverage-mip hybrid (separate shader, O(1)).
Otherwise treat minification as windfoil's known trade-off and lean on its wins elsewhere.
