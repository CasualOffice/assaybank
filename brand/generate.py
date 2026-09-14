import math, os, sys
OUT = sys.argv[1]
H, W = 24.0, 4.4
R = (H - W) / 2.0
ASC, DESC = -10.0, 34.0
TRACK = 6.0
KERN = {('a','y'): -1.8, ('y','b'): -2.6, ('a','n'): -0.6, ('n','k'): -0.8, ('s','a'): -0.8}
INK, PAPER, ASSAY = "#14161A", "#FAFAF7", "#C8963C"

def pt(cx, cy, rx, ry, d):
    a = math.radians(d); return (cx + rx*math.cos(a), cy + ry*math.sin(a))
def f(p): return f"{p[0]:.2f} {p[1]:.2f}"

def g_a(x):
    c = x + R
    return (f'M{c-R:.2f} 12 A {R} {R} 0 1 1 {c+R:.2f} 12 A {R} {R} 0 1 1 {c-R:.2f} 12 '
            f'M{c+R:.2f} 0 V 24'), 2*R + W
def g_s(x):
    rx, ry = 6.5, 4.9
    cx = x + rx + W/2; cy1 = ry + W/2; cy2 = H - ry - W/2
    return (f'M{f(pt(cx,cy1,rx,ry,-30))} A {rx} {ry} 0 1 0 {f((cx,cy1+ry))} '
            f'A {rx} {ry} 0 1 1 {f(pt(cx,cy2,rx,ry,150))}'), 2*rx + W
def g_y(x):
    return f'M{x:.2f} 0 L{x+11.35:.2f} 21 M{x+20:.2f} 0 L{x+6:.2f} {DESC}', 20 + W
def g_b(x):
    s = x + W/2
    return (f'M{s:.2f} {ASC} V 24 M{s:.2f} 12 A {R} {R} 0 1 1 {s+2*R:.2f} 12 '
            f'A {R} {R} 0 1 1 {s:.2f} 12'), 2*R + W
def g_n(x):
    s = x + W/2
    return f'M{s:.2f} 0 V 24 M{s:.2f} 12 A {R} {R} 0 0 1 {s+2*R:.2f} 12 V 24', 2*R + W
def g_k(x):
    s = x + W/2
    return (f'M{s:.2f} {ASC} V 24 M{s+16:.2f} 5.5 L{s+2.2:.2f} 15.6 '
            f'M{s+4.6:.2f} 13.6 L{s+16.5:.2f} 24'), 18.5 + W

G = {'a':g_a,'s':g_s,'y':g_y,'b':g_b,'n':g_n,'k':g_k}
def word(t):
    ps, x = [], 0.0
    for i, ch in enumerate(t):
        d, adv = G[ch](x); ps.append(d)
        x += adv + TRACK + (KERN.get((ch, t[i+1]), 0.0) if i+1 < len(t) else 0.0)
    return ' '.join(ps), x - TRACK
WD, WW = word('assaybank')

def wpath(col): return (f'<path d="{WD}" fill="none" stroke="{col}" stroke-width="{W}" '
                        f'stroke-linecap="round" stroke-linejoin="round"/>')
def mk(bg, fg, ac, bar=6.0, sq=True):
    p = f'<rect x="2" y="2" width="60" height="60" rx="15" fill="{bg}"/>' if sq else ''
    return (p + f'<path d="M16.5 49 L32 15 L47.5 49" fill="none" stroke="{fg}" stroke-width="6.5" '
            f'stroke-linejoin="bevel"/><path d="M21.5 37.5 H42.5" stroke="{ac}" stroke-width="{bar}"/>')

HDR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" aria-label="{t}">'
def write(name, body, vb, w, h, title="Assaybank"):
    open(os.path.join(OUT, name), 'w').write(
        HDR.format(vb=vb, w=w, h=h, t=title) + f'<title>{title}</title>' + body + '</svg>\n')

# --- marks
write('assaybank-mark.svg', mk(INK, PAPER, ASSAY), '0 0 64 64', 256, 256)
write('assaybank-mark-inverse.svg', mk(PAPER, INK, ASSAY), '0 0 64 64', 256, 256)
write('assaybank-mark-mono.svg', mk(None, 'currentColor', 'currentColor', sq=False),
      '8 9 48 46', 256, 245, 'Assaybank mark')
write('favicon.svg', mk(INK, PAPER, ASSAY, bar=7.0), '0 0 64 64', 64, 64)

# --- wordmarks
pad = 4
vb_w = f'{-pad} {ASC-pad} {WW+2*pad} {DESC-ASC+2*pad}'
write('assaybank-wordmark.svg', wpath(INK), vb_w, round(WW+2*pad), round(DESC-ASC+2*pad), 'assaybank')
write('assaybank-wordmark-inverse.svg', wpath(PAPER), vb_w, round(WW+2*pad), round(DESC-ASC+2*pad), 'assaybank')

# --- lockups: mark 64, wordmark x-height 22 => scale 22/24
S = 22.0/H
gap = 18.0
wm_w = WW*S
lw = 64 + gap + wm_w
# baseline of wordmark placed so x-height band centres on the mark
ty = 32 - (H*S)/2 + H*S   # baseline
def lockup(fg_sq, fg_a, wcol):
    return (f'<g>{mk(*fg_sq)}</g>'
            f'<g transform="translate({64+gap},{ty:.2f}) scale({S:.4f})">'
            f'<path d="{WD}" fill="none" stroke="{wcol}" stroke-width="{W}" '
            f'stroke-linecap="round" stroke-linejoin="round"/></g>')
write('assaybank-lockup.svg', lockup((INK,PAPER,ASSAY), None, INK),
      f'0 0 {lw:.0f} 64', round(lw), 64)
write('assaybank-lockup-inverse.svg', lockup((PAPER,INK,ASSAY), None, PAPER),
      f'0 0 {lw:.0f} 64', round(lw), 64)
# stacked
sw = max(64.0, WW*S)
write('assaybank-lockup-stacked.svg',
      f'<g transform="translate({(sw-64)/2:.2f},0)">{mk(INK,PAPER,ASSAY)}</g>'
      f'<g transform="translate({(sw-wm_w)/2:.2f},{64+16+H*S:.2f}) scale({S:.4f})">'
      f'<path d="{WD}" fill="none" stroke="{INK}" stroke-width="{W}" stroke-linecap="round" stroke-linejoin="round"/></g>',
      f'0 0 {sw:.0f} {64+16+H*S+abs(DESC-H)*S+2:.0f}', round(sw), round(64+16+H*S+abs(DESC-H)*S+2))
print(f'wordmark_w={WW:.1f} lockup_w={lw:.1f}')
