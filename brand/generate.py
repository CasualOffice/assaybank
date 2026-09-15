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
write('assaybank-mark.svg',        svg('0 0 100 100',256,256,mark(18,8),'Assaybank'))
write('assaybank-mark-compact.svg',svg('0 0 100 100',32,32,mark(17,12),'Assaybank'))
write('favicon.svg',               svg('0 0 100 100',32,32,mark(17,12,col=INK),'Assaybank'))
write('assaybank-mark-ink.svg',    svg('0 0 100 100',256,256,mark(18,8,col=INK),'Assaybank'))
write('assaybank-mark-paper.svg',  svg('0 0 100 100',256,256,mark(18,8,col=PAPER),'Assaybank'))
# --- wordmark
pad=10; vbw=f'{-pad} {ASC-pad} {WW+2*pad} {DESC-ASC+2*pad}'
write('assaybank-wordmark.svg',        svg(vbw,round(WW/4),round((DESC-ASC)/4),wm(INK),'assaybank'))
write('assaybank-wordmark-paper.svg',  svg(vbw,round(WW/4),round((DESC-ASC)/4),wm(PAPER),'assaybank'))
# --- lockup: mark 100 tall, wordmark x-height 62, optical baseline align
S=62.0/H; gap=34.0; wmw=WW*S
lw=100+gap+wmw
ty=50+ (H*S)/2
def lockup(c):
    return (f'{mark(18,8,col=c)}'
            f'<g transform="translate({100+gap},{ty:.1f}) scale({S:.4f})">'
            f'<path d="{WD}" fill="none" stroke="{c}" stroke-width="{W}" stroke-linecap="butt"/></g>')
write('assaybank-lockup.svg',       svg(f'0 0 {lw:.0f} 100',round(lw/2),50,lockup(INK),'Assaybank'))
write('assaybank-lockup-paper.svg', svg(f'0 0 {lw:.0f} 100',round(lw/2),50,lockup(PAPER),'Assaybank'))
sw=max(100.0,wmw)
write('assaybank-lockup-stacked.svg',
      svg(f'0 0 {sw:.0f} {100+30+H*S+abs(DESC-H)*S:.0f}',round(sw/2),
          round((100+30+H*S+abs(DESC-H)*S)/2),
          f'<g transform="translate({(sw-100)/2:.1f},0)">{mark(18,8,col=INK)}</g>'
          f'<g transform="translate({(sw-wmw)/2:.1f},{100+30+H*S:.1f}) scale({S:.4f})">'
          f'<path d="{WD}" fill="none" stroke="{INK}" stroke-width="{W}" stroke-linecap="butt"/></g>','Assaybank'))
print(f'wordmark={WW:.0f} lockup={lw:.0f}')
