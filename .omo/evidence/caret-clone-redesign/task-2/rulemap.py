import re,sys,json
def rules(path):
    lines=open(path,encoding='utf-8').read().split('\n')
    out=[];depth=0;buf=[];start=0
    for i,l in enumerate(lines,1):
        s=l.strip()
        if depth==0 and s and not s.startswith('/*') and not s.startswith('*'):
            if not buf: start=i
            buf.append(s)
        o=l.count('{');c=l.count('}')
        if o and depth==0:
            sel=' '.join(buf).split('{')[0].strip()
            depth+=o-c
            if depth<=0:
                out.append((start,i,sel)); buf=[];depth=0
            else:
                cur=(start,sel)
        elif depth>0:
            depth+=o-c
            if depth<=0:
                out.append((cur[0],i,cur[1]));buf=[];depth=0
        if depth==0 and (s.endswith('}') or not s): buf=[]
    return out
for p in sys.argv[1:]:
    print(f"##### {p}")
    for a,b,sel in rules(p):
        print(f"{a}-{b}\t{sel[:150]}")
