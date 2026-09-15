import math, os, sys
OUT=sys.argv[1]
H=100.0; W=17.0
RX,RY=(H-W)/2*0.88,(H-W)/2
ASC,DESC=-38.0,138.0; TRACK=9.0
KERN={('a','y'):-7,('y','b'):-9,('a','n'):-3,('n','k'):-4,('s','a'):-4,('a','s'):-3,('b','a'):-3}
INK="#111315"; PAPER="#FAFAF8"

def e(cx,cy,rx,ry):
    return (f'M{cx-rx:.1f} {cy:.1f} A {rx:.1f} {ry:.1f} 0 1 1 {cx+rx:.1f} {cy:.1f} '
            f'A {rx:.1f} {ry:.1f} 0 1 1 {cx-rx:.1f} {cy:.1f}')
def g_a(x):
    cx=x+RX+W/2; return f'{e(cx,H/2,RX,RY)} M{cx+RX:.1f} 0 V {H}', 2*RX+W
def g_s(x):
    rx,ry=RX*0.82,(H-W)/4; cx=x+rx+W/2; cy1=ry+W/2; cy2=H-ry-W/2
    p=lambda c,d:(cx+rx*math.cos(math.radians(d)), c+ry*math.sin(math.radians(d)))
    s0,s2=p(cy1,-25),p(cy2,155)
    return (f'M{s0[0]:.1f} {s0[1]:.1f} A {rx:.1f} {ry:.1f} 0 1 0 {cx:.1f} {cy1+ry:.1f} '
            f'A {rx:.1f} {ry:.1f} 0 1 1 {s2[0]:.1f} {s2[1]:.1f}'), 2*rx+W
def g_y(x):
    w=2*RX+W-6
    return f'M{x:.1f} 0 L{x+w/2:.1f} {H*0.86:.1f} M{x+w:.1f} 0 L{x+w*0.30:.1f} {DESC:.1f}', w+W
def g_b(x):
    stem=x+W/2; return f'M{stem:.1f} {ASC} V {H} {e(stem+RX,H/2,RX,RY)}', 2*RX+W
def g_n(x):
    stem=x+W/2
    return (f'M{stem:.1f} 0 V {H} M{stem:.1f} {H/2:.1f} A {RX:.1f} {RY:.1f} 0 0 1 '
            f'{stem+2*RX:.1f} {H/2:.1f} V {H}'), 2*RX+W
def g_k(x):
    stem=x+W/2; aw=2*RX-2
    return (f'M{stem:.1f} {ASC} V {H} M{stem+aw:.1f} {H*0.20:.1f} L{stem+W*0.30:.1f} {H*0.62:.1f} '
            f'M{stem+W*0.55:.1f} {H*0.50:.1f} L{stem+aw+2:.1f} {H}'), aw+W
G={'a':g_a,'s':g_s,'y':g_y,'b':g_b,'n':g_n,'k':g_k}
def word(t):
    ps,x=[],0.0
    for i,ch in enumerate(t):
        d,adv=G[ch](x); ps.append(d)
        x+=adv+TRACK+(KERN.get((ch,t[i+1]),0) if i+1<len(t) else 0)
    return ' '.join(ps), x-TRACK
WD,WW=word('assaybank')

def pt(cx,cy,r,d):
    a=math.radians(d); return (cx+r*math.cos(a), cy+r*math.sin(a))
def fp(p): return f"{p[0]:.2f} {p[1]:.2f}"
def mark(w1=18,w2=8,cut=60,gap=12,r=34,size=100,col="currentColor"):
    cx=cy=size/2
    px,py=math.cos(math.radians(cut+90)),math.sin(math.radians(cut+90))
    ox,oy=px*gap/2,py*gap/2
    A=f'<path d="M{fp(pt(cx,cy,r,cut))} A {r} {r} 0 0 1 {fp(pt(cx,cy,r,cut+180))}" stroke-width="{w1}" transform="translate({ox:.2f},{oy:.2f})"/>'
    B=f'<path d="M{fp(pt(cx,cy,r,cut+180))} A {r} {r} 0 0 1 {fp(pt(cx,cy,r,cut+360))}" stroke-width="{w2}" transform="translate({-ox:.2f},{-oy:.2f})"/>'
    return f'<g fill="none" stroke="{col}" stroke-linecap="butt">{A}{B}</g>'

def wm(col): return f'<path d="{WD}" fill="none" stroke="{col}" stroke-width="{W}" stroke-linecap="butt" stroke-linejoin="miter"/>'
def svg(vb,w,h,body,title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" '
            f'role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n')
def write(n,s): open(os.path.join(OUT,n),'w').write(s)

# --- marks: display (>=32px) and compact (<32px, reduced differential)
# --- wordmark
# width/height MUST be derived from the padded viewBox, not the raw glyph extents.
# Deriving them from WW/(DESC-ASC) gives an aspect ratio that disagrees with the viewBox,
# and SVG then letterboxes the artwork inside the declared box — which shows up as blank
# margins on the right and bottom. Keep these two lines in sync or the asset is wrong.
pad=10
VBW=WW+2*pad; VBH=DESC-ASC+2*pad
vbw=f'{-pad} {ASC-pad} {VBW} {VBH}'
_w=round(VBW/4); _h=round(VBH/4)
write('assaybank-wordmark.svg',        svg(vbw,_w,_h,wm(INK),'assaybank'))
write('assaybank-wordmark-paper.svg',  svg(vbw,_w,_h,wm(PAPER),'assaybank'))
# --- lockup: mark 100 tall, wordmark x-height 62, optical baseline align
S=62.0/H; gap=34.0; wmw=WW*S
lw=100+gap+wmw
ty=50+ (H*S)/2
def lockup(c):
    return (f'{mark(18,8,col=c)}'
            f'<g transform="translate({100+gap},{ty:.1f}) scale({S:.4f})">'
            f'<path d="{WD}" fill="none" stroke="{c}" stroke-width="{W}" stroke-linecap="butt"/></g>')
sw=max(100.0,wmw)
print(f'wordmark={WW:.0f} lockup={lw:.0f}')

# ---------------------------------------------------------------- app icon (house style)
# Sibling to services/model: same tile construction (rx 22/96, hairline bezel at 10% white),
# same dark gradient field. Warm gradient where the sibling is cool, resolving to the same
# violet family so they read as one product family without being confusable.
STOPS=[("0","#fbbf24"),("0.55","#fb7185"),("1","#a78bfa")]
def _defs():
    g=''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o,c in STOPS)
    return ('<defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">'
            '<stop offset="0" stop-color="#1c1f2b"/><stop offset="1" stop-color="#0b0c12"/>'
            f'</linearGradient><linearGradient id="assay" x1="0" y1="0" x2="1" y2="1">{g}</linearGradient></defs>')
def _tile():
    return ('<rect width="96" height="96" rx="22" fill="url(#tile)"/>'
            '<rect x="0.75" y="0.75" width="94.5" height="94.5" rx="21.25" fill="none" '
            'stroke="#ffffff" stroke-opacity="0.10"/>')
def _ring(stroke, cut=60, gap=10, w1=17, w2=9, r=31, cx=48, cy=48):
    px,py=math.cos(math.radians(cut+90)),math.sin(math.radians(cut+90))
    ox,oy=px*gap/2,py*gap/2
    A=(f'<path d="M{fp(pt(cx,cy,r,cut))} A {r} {r} 0 0 1 {fp(pt(cx,cy,r,cut+180))}" '
       f'stroke="{stroke}" stroke-width="{w1}" transform="translate({ox:.2f},{oy:.2f})"/>')
    B=(f'<path d="M{fp(pt(cx,cy,r,cut+180))} A {r} {r} 0 0 1 {fp(pt(cx,cy,r,cut+360))}" '
       f'stroke="{stroke}" stroke-width="{w2}" transform="translate({-ox:.2f},{-oy:.2f})"/>')
    return f'<g fill="none" stroke-linecap="butt">{A}{B}</g>'
def _svg(body,w,h,vb="0 0 96 96",d="",title="Assaybank"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" '
            f'role="img" aria-label="{title}"><title>{title}</title>{d}{body}</svg>\n')

write('assaybank-icon.svg',    _svg(_tile()+_ring("url(#assay)"),256,256,d=_defs()))
write('assaybank-icon-sm.svg', _svg(_tile()+_ring("url(#assay)",w1=17,w2=13),32,32,d=_defs()))
write('favicon.svg',           _svg(_tile()+_ring("url(#assay)",w1=17,w2=13),32,32,d=_defs()))
write('assaybank-mark.svg',    _svg(_ring("currentColor"),256,256))
write('assaybank-mark-sm.svg', _svg(_ring("currentColor",w1=17,w2=13),32,32))

# lockup: tile icon + wordmark
#
# VERTICAL PLACEMENT — the bug this replaces: glyph space puts y=0 at the x-height TOP
# and y=H at the BASELINE, so translating to the intended baseline and then letting the
# glyph add another H put the real baseline below the viewBox and clipped the wordmark.
# Place by the glyph extent instead: ASC..DESC is the full vertical span, and it is fitted
# into the tile height with a margin, then centred. Nothing is positioned by eye.
_TILE = 96.0
_EXTENT = DESC - ASC                      # full ascender-to-descender span in glyph units
_MARGIN = 6.0                             # breathing room top and bottom
_S = (_TILE - 2 * _MARGIN) / _EXTENT      # scale so the whole glyph extent fits the tile
_TOP = _MARGIN - ASC * _S                 # maps glyph y=ASC to y=_MARGIN
_gap = 26.0
_wmw = WW * _S
_lw = _TILE + _gap + _wmw

def _lock(col):
    return (_tile() + _ring("url(#assay)")
            + f'<g transform="translate({_TILE + _gap},{_TOP:.2f}) scale({_S:.4f})">'
              f'<path d="{WD}" fill="none" stroke="{col}" stroke-width="{W}" '
              f'stroke-linecap="butt" stroke-linejoin="miter"/></g>')

# width/height derived from the viewBox so the aspect ratios agree and nothing letterboxes.
_lh = _TILE
write('assaybank-lockup.svg',
      _svg(_lock(INK), round(_lw / 2), round(_lh / 2), f'0 0 {_lw:.0f} {_lh:.0f}', d=_defs()))
write('assaybank-lockup-paper.svg',
      _svg(_lock(PAPER), round(_lw / 2), round(_lh / 2), f'0 0 {_lw:.0f} {_lh:.0f}', d=_defs()))
print(f'icons + lockups written (lockup {_lw:.0f}x96)')
