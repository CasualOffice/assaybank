# Brand — Assaybank

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`../README.md`](../README.md), [`../docs/15-accessibility-conformance.md`](../docs/15-accessibility-conformance.md)

---

## The name

**Assay** (verb) — to test a material in order to determine its purity and composition. It is
the word an assay office uses before it strikes a hallmark, and it comes from Old French *essai*,
"a trial or attempt" — the same root as *essay* and as *attempt*, which is the central table in
[`../docs/hiring_platform_schema.sql`](../docs/hiring_platform_schema.sql).

**Bank** — the one shared question bank that all three assessment surfaces draw from. It is the
asset the whole design protects, and the reason the product exists rather than three separate tools.

The name commits to a position: this system measures, it does not judge. That is the same position
ADR-007 and ADR-011 take, and the brand should never be used in a way that implies the software
decides who gets hired.

## The mark

An assay-office punch — the stamp struck into metal that has been tested and found true. The
counter reads as an **A**; the bar across it is the assay line, the single point of colour in the
system, and the only element that carries the accent.

| Asset | File | Use |
|---|---|---|
| Mark | [`assaybank-mark.svg`](assaybank-mark.svg) | Primary. Carries its own ink field, so it works on any background |
| Mark, inverse | [`assaybank-mark-inverse.svg`](assaybank-mark-inverse.svg) | On saturated or photographic backgrounds |
| Mark, mono | [`assaybank-mark-mono.svg`](assaybank-mark-mono.svg) | Inherits `currentColor`. Single-colour print, engraving, favicons in constrained themes |
| Wordmark | [`assaybank-wordmark.svg`](assaybank-wordmark.svg) | Where the mark is already present or the context is unmistakable |
| Lockup | [`assaybank-lockup.svg`](assaybank-lockup.svg) | Default for headers, README, documentation |
| Lockup, inverse | [`assaybank-lockup-inverse.svg`](assaybank-lockup-inverse.svg) | Dark surfaces |
| Lockup, stacked | [`assaybank-lockup-stacked.svg`](assaybank-lockup-stacked.svg) | Narrow columns, square crops, social avatars |
| Favicon | [`favicon.svg`](favicon.svg) | 16–32 px. The assay bar is thickened for legibility at that size |
| Raster | `icon-512.png`, `icon-192.png`, `icon-32.png`, `apple-touch-icon.png` | PWA manifest, app icons, contexts that reject SVG |

All vector assets are self-contained: no external fonts, no embedded rasters, no network
dependencies. The wordmark is drawn as geometry, not set in a typeface, so it renders identically
everywhere and carries no font licence.

## Palette

| Token | Hex | Role |
|---|---|---|
| `--ab-ink` | `#14161A` | The punch field, body text, the wordmark on light surfaces |
| `--ab-paper` | `#FAFAF7` | The counter of the mark, the wordmark on dark surfaces |
| `--ab-assay` | `#C8963C` | The assay bar. Accent only — never a background, never body text |

`--ab-assay` on `--ab-ink` clears WCAG AA for non-text contrast comfortably. It does **not** clear
AA for body text on `--ab-paper`, so it is never used for running text. Accessibility is a
conformance requirement here rather than a preference — see
[`../docs/15-accessibility-conformance.md`](../docs/15-accessibility-conformance.md).

Colour is never the only carrier of meaning anywhere in the product, including in the mark: strip
the accent and the A still reads.

## Construction

Both the mark and the wordmark come from one geometric system — a 24-unit x-height, a 4.4-unit
monoline stroke, and round letterforms built on a circle whose outer edge fills the x-height.
[`generate.py`](generate.py) is the source of the wordmark and lockup geometry. If a letterform,
the tracking, the kerning pairs or the lockup ratio needs to change, change it there and re-run:

```
python3 brand/generate.py brand/
```

Editing the emitted SVG path data by hand puts the files out of sync with the generator, which is
the same failure the rest of this repository guards against — see
[`../CODE-GRAPH.md`](../CODE-GRAPH.md).

## Clear space and minimum size

Clear space on every side is the height of the assay bar — 6 units at the mark's 64-unit scale,
or roughly 9% of the mark's height. Nothing intrudes into it.

Minimum sizes: mark 16 px, lockup 120 px wide, stacked lockup 72 px wide. Below the lockup
minimum, use the mark alone rather than shrinking the wordmark past legibility.

## Misuse

Do not recolour the mark outside the palette. Do not place the assay bar anywhere but across the A.
Do not add a gradient, bevel, drop shadow or outline. Do not rotate or shear. Do not set the
wordmark in a substitute typeface — use the asset. Do not stretch any asset non-uniformly. Do not
reconstruct the lockup by hand; the spacing is generated.

Do not use the mark to imply certification of a person by a third party. The credential the
platform issues is a separate mark defined in
[`../docs/10-certification-and-credentials.md`](../docs/10-certification-and-credentials.md), and
conflating the two overstates what a score means.

## Name availability at time of selection (2026-09-15)

Checked against registry RDAP, the npm registry and the GitHub handle namespace:
`assaybank.dev`, `assaybank.io`, the npm name `assaybank` and `github.com/assaybank` were all
unregistered. `assaybank.com` is registered but dormant — it serves no site. No company was
trading under the name.

None of this is a trademark clearance. Before any public launch or any use in commerce, a search
in the relevant classes and jurisdictions is required, and the owner of that task is Legal. Tracked
in [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md).
