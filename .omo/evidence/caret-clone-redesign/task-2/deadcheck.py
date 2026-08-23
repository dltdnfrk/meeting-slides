import re,sys,os
os.chdir('/Users/hyunjun/Documents/MUNI/meeting-slides')
srcs=['public/index.html','public/app.js','public/operator-surface.js','public/workspace-split.js','public/transcript-resize.js','public/review-panel.js','public/review-panel-render.js']
blob=''.join(open(s,encoding='utf-8').read() for s in srcs)
def tokens(sel):
    return set(re.findall(r'[.#]([A-Za-z0-9_-]+)',sel))
sys.path.insert(0,'/tmp')
import importlib.util
spec=importlib.util.spec_from_file_location('rm','/tmp/rulemap.py')
# re-implement rules here
def rules(path):
    lines=open(path,encoding='utf-8').read().split('\n')
    out=[];depth=0;buf=[];start=0;cur=None
    for i,l in enumerate(lines,1):
        s=l.strip()
        if depth==0 and s and not s.startswith('/*') and not s.startswith('*'):
            if not buf: start=i
            buf.append(s)
        o=l.count('{');c=l.count('}')
        if o and depth==0:
            sel=' '.join(buf).split('{')[0].strip(); depth+=o-c
            if depth<=0: out.append((start,i,sel)); buf=[];depth=0
            else: cur=(start,sel)
        elif depth>0:
            depth+=o-c
            if depth<=0: out.append((cur[0],i,cur[1]));buf=[];depth=0
        if depth==0 and (s.endswith('}') or not s): buf=[]
    return out
for p in sys.argv[1:]:
    for a,b,sel in rules(p):
        if sel.startswith('@') or sel==':root': continue
        t=tokens(sel)
        if not t: continue
        missing=sorted(x for x in t if x not in blob)
        if missing:
            print(f"{p}\t{a}-{b}\tDEAD-TOKENS={','.join(missing)}\t{sel[:110]}")
