# Brand — Assaybank

**Status:** draft
**Owner:** _unassigned_ (design lead)
**Last updated:** 2026-09-16
**Companion docs:** [`../README.md`](../README.md), [`../docs/15-accessibility-conformance.md`](../docs/15-accessibility-conformance.md), [`../docs/17-engineering-standards.md`](../docs/17-engineering-standards.md)

---

## The name

**Assay** (verb) — to test a material to determine its purity and composition. From Old French
*essai*, "a trial or attempt", the same root as *essay* and as *attempt*, the central table in
[`../docs/hiring_platform_schema.sql`](../docs/hiring_platform_schema.sql). **Bank** — the one
shared question bank all three surfaces draw from.

The name takes the position the architecture takes: the system measures, a human decides. Never use
the brand in a way implying the software decides who gets hired.

## The mark — a section cut

In fire assay you **cut a sample to examine its interior**. The mark is a ring sheared along that
cut: two arcs, offset perpendicular to the cut axis, with **unequal weights**.

The inequality is the idea. An assay is not an inspection, it is a *comparison against a standard* —
so the two arcs are not the same. The heavy arc is the sample; the light arc is the reference. The
symmetrical version of this mark is a loading spinner; the asymmetry is what makes it ours.

## House style — this is a sibling, not a standalone

Assaybank sits in a product family with `services/model` (Model Studio) and **deliberately shares
its icon construction**:

| Shared | Value |
|---|---|
| Tile | 96 × 96, `rx 22` (≈23%), dark vertical gradient `#1c1f2b → #0b0c12` |
| Bezel | Inset hairline, `#ffffff` at 10% opacity — the edge light that stops the tile going flat |
| Glyph | Vivid three-stop gradient on the dark field |

What differs is the symbol and the temperature. Model Studio is a **segmented aperture** in
violet → indigo → **cyan** — optical, cool, about seeing. Assaybank is a **sheared ring** in
amber → rose → **violet** — warm, about testing metal. They resolve toward the same violet family,
so the two read as one family at a glance and as different products on inspection.

If a third service joins, it keeps the tile and the bezel, takes its own symbol, and picks a
temperature not already used.

## It is a system, not a single drawing

Proportions change with size, because a drawing that reads at 256 px does not read at 16 px.

| Variant | Weights | Use |
|---|---|---|
| Display | 17 : 9 | 32 px and above |
| Compact | 17 : 13 | Below 32 px — reduced differential so the minor arc survives rasterisation |

Below about 14 px use the wordmark or nothing.

| Asset | File | Use |
|---|---|---|
| App icon | [`assaybank-icon.svg`](assaybank-icon.svg) | Primary. Carries its own field, so it works on any background |
| App icon, compact | [`assaybank-icon-sm.svg`](assaybank-icon-sm.svg) | Below 32 px |
| Favicon | [`favicon.svg`](favicon.svg) | The compact variant |
| Flat mark | [`assaybank-mark.svg`](assaybank-mark.svg), [`assaybank-mark-sm.svg`](assaybank-mark-sm.svg) | `currentColor`, no tile — print, watermark, inline with text, single-colour reproduction |
| Wordmark | [`assaybank-wordmark.svg`](assaybank-wordmark.svg), [`assaybank-wordmark-paper.svg`](assaybank-wordmark-paper.svg) | |
| Lockup | [`assaybank-lockup.svg`](assaybank-lockup.svg), [`assaybank-lockup-paper.svg`](assaybank-lockup-paper.svg) | Icon plus wordmark |
| Raster | `icon-512.png`, `icon-192.png`, `icon-32.png`, `apple-touch-icon.png` | PWA manifest, app icons |

Two marks, and that is deliberate rather than indecision: the **gradient tile** is the product's
face on a screen, and the **flat mark** is what survives a fax, an engraving, a single-colour print
run and a favicon in a theme you do not control.

## The wordmark

Custom letterforms on a **grotesque skeleton** — narrowed bowls (0.88 ratio, not circles), flat
terminals, straight stems, tight tracking with hand-set kerning on `ay`, `yb`, `an`, `nk`, `sa`.

It is drawn as geometry, not set in a typeface: it renders identically everywhere, carries no font
licence, and cannot be approximated by someone with the same font. [`generate.py`](generate.py) is
its source. Change the letterforms, tracking, kerning or lockup ratio there and re-run:

```
python3 brand/generate.py brand/
```

Editing emitted path data by hand desynchronises the files from the generator — the same failure the
rest of this repository guards against.

## Colour

The **icon** carries the family gradient: `#fbbf24 → #fb7185 → #a78bfa` on the dark tile. That
gradient is the identity and is not recoloured.

Everything else is monochrome. The flat mark ships as `currentColor` and inherits its context, which
is why there is one flat mark rather than six colourways.

**User-interface** colour is a separate system, authored in OKLCH for perceptual uniformity — a 10%
lightness step looks like a 10% step, which HSL does not give you and which matters the moment you
generate a ramp.

| Token | OKLCH | Role |
|---|---|---|
| `--ab-ink` | `oklch(18% 0.006 250)` | Text, flat mark on light |
| `--ab-paper` | `oklch(98% 0.004 95)` | Surfaces, flat mark on dark |
| `--ab-signal` | `oklch(55% 0.13 245)` | Interactive state only — focus, selection, active nav |
| `--ab-positive` | `oklch(58% 0.12 150)` | Pass, complete |
| `--ab-caution` | `oklch(72% 0.14 75)` | Flagged for human review — never a verdict (ADR-007) |
| `--ab-critical` | `oklch(58% 0.19 27)` | Destructive action, validation failure |

Rules that are not negotiable:

- The icon gradient is never used as a UI colour, and UI colour never enters the icon. They are
  different systems that happen to live in the same product.
- Colour is never the only carrier of meaning, anywhere, including pass/fail — a WCAG 2.1 AA
  requirement, not a preference. See [`../docs/15-accessibility-conformance.md`](../docs/15-accessibility-conformance.md).
- `--ab-caution` marks something for a human to look at. It never communicates a decision the system
  made, because the system does not make them.

## Regenerating the assets

```
python3 brand/generate.py brand/
```

Raster exports are produced with **headless Chrome**, not `qlmanage`. `qlmanage -t` is a
*thumbnailer*: it pads and offsets the artwork inside the requested box, which produced icons with
the tile in the top-left and blank margins on the right and bottom. The command is in the commit
that fixed it; use a real rasteriser or check the output pixel by pixel.

Two invariants to check after any regeneration, because both failures are silent:

1. **`viewBox` aspect must equal `width`/`height` aspect.** SVG letterboxes when they disagree, and
   letterboxing looks exactly like blank margins. `generate.py` derives width and height from the
   padded viewBox for this reason — deriving them from the raw glyph extents is what broke it.
2. **The wordmark must fit its box.** Glyph space puts `y=0` at the x-height top and `y=H` at the
   baseline, so placing artwork by its intended baseline and letting the glyph add another `H`
   pushes the real baseline outside the viewBox and clips the text. Placement is computed from the
   `ASC..DESC` extent instead.

## Clear space, minimum size, misuse

Clear space is **25% of the mark's height** on every side, measured from the ring's outer edge.
Minimums: mark 16 px (compact variant), lockup 140 px wide, stacked lockup 88 px.

Do not: recolour the icon gradient · put the flat mark on a tile of your own invention · equalise the two arc weights · close the shear · rotate, shear further, or
mirror · apply a gradient, shadow, glow or bevel · set the wordmark in a substitute typeface ·
rebuild the lockup by hand, its spacing is generated · use the mark to imply third-party
certification of a person — that credential is defined in
[`../docs/10-certification-and-credentials.md`](../docs/10-certification-and-credentials.md).

## Name availability at selection (2026-09-15)

`assaybank.dev`, `assaybank.io`, npm `assaybank` and `github.com/assaybank` were unregistered;
`assaybank.com` is registered but dormant; no company trades under the name. That is availability,
not trademark clearance — a search in the relevant classes is owed before any public use, and it is
Legal's, tracked in [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md).
