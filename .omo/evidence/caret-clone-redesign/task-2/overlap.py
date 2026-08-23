import re,collections
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
files=['public/style.css','public/workspace-shell.css','public/operational-liquid.css','public/caret-shell.css']
own=collections.defaultdict(set)
for f in files:
    for a,b,sel in rules(f):
        if sel.startswith('@') or sel==':root': continue
        for part in sel.split(','):
            key=re.sub(r'^body\.caret-shell\s+','',part.strip())
            key=re.sub(r'\s+',' ',key).strip()
            if key: own[key].add(f.split('/')[-1])
multi={k:v for k,v in own.items() if len(v)>1}
print(f"total distinct selectors: {len(own)}   styled by >1 layer: {len(multi)}")
cnt=collections.Counter(frozenset(v) for v in multi.values())
for combo,n in cnt.most_common():
    print(f"  {n:3d}  {' + '.join(sorted(combo))}")
print("\n--- selectors touched by 3+ layers ---")
for k,v in sorted(multi.items()):
    if len(v)>=3: print(f"  {k}   <- {', '.join(sorted(v))}")
