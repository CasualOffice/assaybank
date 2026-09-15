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
so the two arcs are not the same. The heavy arc is the sample; the light arc is the reference. A
symmetrical version of this mark is a loading spinner; the asymmetry is what makes it ours.

There is **no container**. No rounded square, no badge, no field. The mark sits directly on the
surface at any size, which is what lets it work as a favicon, a nav glyph, a print mark and a
watermark without a second drawing.

## It is a system, not a logo

The mark is **responsive**: its proportions change with size, because a fixed drawing that reads at
256 px does not read at 16 px.

| Variant | Weights | Use |
|---|---|---|
| Display | 18 : 8 | 32 px and above. Full differential, the idea is legible |
| Compact | 17 : 12 | Below 32 px. Reduced differential so the minor arc survives rasterisation |

Below about 14 px, use the wordmark or nothing. A mark nobody can resolve is noise.

| Asset | File |
|---|---|
| Mark, display | [`assaybank-mark.svg`](assaybank-mark.svg) — `currentColor` |
| Mark, compact | [`assaybank-mark-compact.svg`](assaybank-mark-compact.svg) — `currentColor` |
| Mark, fixed ink / paper | [`assaybank-mark-ink.svg`](assaybank-mark-ink.svg), [`assaybank-mark-paper.svg`](assaybank-mark-paper.svg) |
| Wordmark | [`assaybank-wordmark.svg`](assaybank-wordmark.svg), [`assaybank-wordmark-paper.svg`](assaybank-wordmark-paper.svg) |
| Lockup | [`assaybank-lockup.svg`](assaybank-lockup.svg), [`assaybank-lockup-paper.svg`](assaybank-lockup-paper.svg), [`assaybank-lockup-stacked.svg`](assaybank-lockup-stacked.svg) |
| Favicon | [`favicon.svg`](favicon.svg) — the compact variant |
| Raster | `icon-512.png`, `icon-192.png`, `icon-32.png`, `apple-touch-icon.png` |

The mark ships as `currentColor`, so it inherits from its context rather than carrying a hardcoded
value. That is the whole reason there is one mark and not six colourways.

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

**The identity is monochrome.** Ink on paper, paper on ink. There is no brand colour, and that is
deliberate: a gold or gradient accent is the cheapest available signal of "premium" and reads as
dated within two years. Colour here is a *user-interface* concern, not an identity one.

Tokens are authored in **OKLCH** for perceptual uniformity — a 10% lightness step looks like a 10%
step, which HSL does not give you and which matters the moment you generate a ramp.

| Token | OKLCH | Role |
|---|---|---|
| `--ab-ink` | `oklch(18% 0.006 250)` | Primary surface-on-light, text, the mark |
| `--ab-paper` | `oklch(98% 0.004 95)` | Primary surface-on-dark, the mark inverted |
| `--ab-signal` | `oklch(55% 0.13 245)` | The single accent. Interactive state only — focus, selection, active nav |
| `--ab-positive` | `oklch(58% 0.12 150)` | Pass, complete |
| `--ab-caution` | `oklch(72% 0.14 75)` | Flagged for human review — never a verdict (ADR-007) |
| `--ab-critical` | `oklch(58% 0.19 27)` | Destructive action, validation failure |

Rules that are not negotiable:

- The accent never appears in the logo. If a surface needs the mark to be "on brand", it needs ink
  or paper, not colour.
- Colour is never the only carrier of meaning, anywhere, including a pass/fail state — this is a
  WCAG 2.1 AA requirement and an accessibility conformance obligation, not a preference. See
  [`../docs/15-accessibility-conformance.md`](../docs/15-accessibility-conformance.md).
- `--ab-caution` marks something for a human to look at. It never communicates a decision the system
  made, because the system does not make them.

## Clear space, minimum size, misuse

Clear space is **25% of the mark's height** on every side, measured from the ring's outer edge.
Minimums: mark 16 px (compact variant), lockup 140 px wide, stacked lockup 88 px.

Do not: add a container, badge or rounded square behind the mark · recolour it outside ink, paper
or `currentColor` · equalise the two arc weights · close the shear · rotate, shear further, or
mirror · apply a gradient, shadow, glow or bevel · set the wordmark in a substitute typeface ·
rebuild the lockup by hand, its spacing is generated · use the mark to imply third-party
certification of a person — that credential is defined in
[`../docs/10-certification-and-credentials.md`](../docs/10-certification-and-credentials.md).

## Name availability at selection (2026-09-15)

`assaybank.dev`, `assaybank.io`, npm `assaybank` and `github.com/assaybank` were unregistered;
`assaybank.com` is registered but dormant; no company trades under the name. That is availability,
not trademark clearance — a search in the relevant classes is owed before any public use, and it is
Legal's, tracked in [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md).
