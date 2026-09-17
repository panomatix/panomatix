import json, re, itertools, copy
P='/home/paul/Documents/panomatix/'
S='/home/paul/Documents/panomatix/scripts/'
v1=json.load(open(S+'comparison_v1.json'))  # first-generation comparison (shape-grouped); kept in scripts/ as the mapping source
s23={s['id']:s for s in json.load(open(S+'2023_signs_extracted.json'))}

# ---- collect mapping data from v1: per id -> name, note, legacy per model
info={}
for c in v1['categories']:
    for sh in c['shapes']:
        for r in sh['reference']:
            e=info.setdefault(r['id'],{'name':r['name'],'note':r.get('note'),'legacy':{}})
            e['legacy'][sh.get('legacy_model') or '_']=r['legacy_id']
            if 'cancellation_band' in r: e['band']=r['cancellation_band']
            if 'prohibition_bar' in r: e['pbar']=r['prohibition_bar']
removed={c['category']:c['removed'] for c in v1['categories']}
catnames={c['category']:c['categoryName'] for c in v1['categories']}

BOTH=['2006','2023']
def V(**kw):
    d={'versions':BOTH,'model':None,'legacy_model':None,'legacy_id':None,'shape':None,
       'background_color':None,'border_color':None,'symbol_color':None,
       'band':'none','band_color':None,'prohibition_bar':None,'bar_continuity':None,'note':None}
    d.update(kw); return d
def prod(**axes):
    """cartesian product over list-valued axes -> list of dicts"""
    keys=[k for k,v in axes.items() if isinstance(v,list) and k!='versions']
    fixed={k:v for k,v in axes.items() if not isinstance(v,list) or k=='versions'}
    out=[]
    for combo in itertools.product(*[axes[k] for k in keys]):
        d=dict(fixed); d.update(dict(zip(keys,combo))); out.append(V(**d))
    return out

def sign(i, variants, extra=None):
    e=info[i]
    d={'id':i,'name':e['name'],'legacy_ids':sorted({v for v in e['legacy'].values() if v} | set()) ,
       'note':e['note'],
       'symbol_may_be_reversed': bool(re.search(r'may be reversed|shall be reversed', s23.get(i,{}).get('desc',''))),
       'variants':variants}
    if extra: d.update(extra)
    # drop empty note
    if not d['note']: del d['note']
    for v in variants:
        if v['note'] is None: del v['note']
    return d

cats=[]
# ================================================================== A
A=[]
for i in sorted(info, key=lambda x:(x[0],int(x[2:4]),int(x.split('.')[1]))):
    if i[0]!='A': continue
    e=info[i]
    if i.startswith('A-25'):
        if i in ('A-25.1','A-25.3'):
            vs=prod(shape='cross',background_color=['white','yellow'],border_color=['red','black'],symbol_color='black',legacy_id=e['legacy']['_'])
            vs+=prod(shape='cross',background_color=['white','yellow'],border_color=None,symbol_color='red',legacy_id=e['legacy']['_'],note='Red stripes variant.')
        else:
            vs=prod(shape='cross',background_color=['white','yellow'],border_color='black',symbol_color='black',legacy_id=e['legacy']['_'])
        A.append(sign(i,vs)); continue
    if i.startswith('A-26'):
        vs=prod(shape='rectangle',background_color=['white','yellow'],border_color=None,symbol_color='red',legacy_id=e['legacy']['_'])
        A.append(sign(i,vs)); continue
    aa=e['legacy'].get('Aa'); ab=e['legacy'].get('Ab')
    vs=prod(model='one',legacy_model='Aa',legacy_id=aa,shape='triangle',background_color=['white','yellow'],border_color='red',symbol_color=['black','dark blue'])
    vs+=prod(model='two',legacy_model='Ab',legacy_id=ab,shape='diamond',background_color='yellow',border_color='black',symbol_color=['black','dark blue'])
    vs+=prod(model='two',legacy_model='Ab',legacy_id=ab,shape='diamond',background_color='yellow',border_color='dark blue',symbol_color=['black','dark blue'],versions=['2023'],note='Dark blue rim introduced in 2023.')
    A.append(sign(i,vs))
cats.append({'category':'A','categoryName':catnames['A'],'signs':A,'removed':removed['A']})

# ================================================================== B
B=[]
B.append(sign('B-01.1',prod(shape='inverted_triangle',background_color=['white','yellow'],border_color='red',symbol_color=None,legacy_id='B,1')))
B.append(sign('B-02.1',prod(shape='octagon',background_color='red',border_color='white',symbol_color='white',legacy_id='B,2a')
                     +prod(shape='circle',background_color='red',border_color='white',symbol_color='white',legacy_id='B,2b',versions=['2006'],note='Circular model of the STOP sign, 2006 only.')))
B.append(sign('B-03.1',prod(shape='diamond',background_color='white',border_color='black',symbol_color=['yellow'],legacy_id='B,3')
                     +prod(shape='diamond',background_color='white',border_color='black',symbol_color='orange',legacy_id='B,3',versions=['2006'],note='2006 allowed the centre square to be yellow or orange.')))
B.append(sign('B-03.2',prod(shape='diamond',background_color='white',border_color='black',symbol_color='yellow',legacy_id='B,4',band=['single_band','parallel_lines'],band_color=['black','grey'])))
for i in ('B-04.1','B-04.2'):
    B.append(sign(i,prod(shape='circle',background_color=['white','yellow'],border_color='red',symbol_color='black',legacy_id='B,5',note='Priority arrow black, the other arrow red.')))
for i in ('B-05.1','B-05.2'):
    B.append(sign(i,prod(shape='rectangle',background_color='blue',border_color=None,symbol_color='white',legacy_id='B,6',note='Upward arrow white, the other arrow red.')))
cats.append({'category':'B','categoryName':catnames['B'],'signs':B,'removed':removed['B']})

# ================================================================== C
C=[]
def c_general(i, bar=False, bar13=False):
    lid=info[i]['legacy']['_']
    base=dict(shape='circle',background_color=['white','yellow'],border_color='red',symbol_color=['black','dark blue'],legacy_id=lid)
    if bar:
        return (prod(**base,prohibition_bar='with_bar',bar_continuity='interrupted')
               +prod(**base,prohibition_bar='with_bar',bar_continuity='continuous',versions=['2006'],note='2006 allowed the bar not to be interrupted where it crosses the symbol.')
               +prod(**base,prohibition_bar='without_bar'))
    if bar13:
        return prod(**base,prohibition_bar=['with_bar','without_bar'])
    return prod(**base)
for i in sorted(info, key=lambda x:(x[0],int(x[2:4]),int(x.split('.')[1]))):
    if i[0]!='C': continue
    lid=info[i]['legacy']['_']
    if i in ('C-01.1','C-01.2','C-16.1'):
        vs=prod(shape='circle',background_color='red',border_color='white',symbol_color='white',legacy_id=lid)
    elif i in ('C-13.2','C-13.4','C-14.2','C-17.1'):
        vs=prod(shape='circle',background_color=['white','yellow'],border_color=[None,'black'],symbol_color='light grey',legacy_id=lid,band=['single_band','parallel_lines'],band_color='black')
        vs+=prod(shape='circle',background_color=['white','yellow'],border_color=[None,'black'],symbol_color='light grey',legacy_id=lid,band=['single_band','parallel_lines'],band_color='dark grey',versions=['2006'],note='2006 also allowed a dark grey band.')
    elif i in ('C-18.1','C-19.1','C-20.1','C-20.2','C-20.3'):
        vs=prod(shape='circle',background_color='blue',border_color='red',symbol_color='red',legacy_id=lid,prohibition_bar='with_bar')
        if i=='C-18.1':
            vs+=prod(shape='circle',background_color=['white','yellow'],border_color='red',symbol_color=['black','dark blue'],legacy_id=lid,prohibition_bar='with_bar',note='Alternative: letter "P" on a white or yellow ground with a red oblique bar.')
    elif i.startswith('C-03.') or i.startswith('C-04.'):
        vs=c_general(i,bar=True)
    elif i in ('C-13.1','C-13.3'):
        vs=c_general(i,bar13=True)
    else:
        vs=c_general(i)
    C.append(sign(i,vs))
cats.append({'category':'C','categoryName':catnames['C'],'signs':C,'removed':removed['C']})

# ================================================================== D
D=[]
for i in sorted(info, key=lambda x:(x[0],int(x[2:4]),int(x.split('.')[1]))):
    if i[0]!='D': continue
    lid=info[i]['legacy']['_']
    if i in ('D-01.2','D-01.6'):
        vs=prod(shape='circle',background_color='black',border_color='white',symbol_color='white',legacy_id=lid)
    elif i=='D-08.1':
        vs=prod(shape='rectangle',background_color='white',border_color=None,symbol_color='black',legacy_id=lid)
    else:
        band='none'; extra=[]
        blue=dict(shape='circle',background_color='blue',border_color=None,symbol_color='white',legacy_id=lid)
        alt =dict(shape='circle',background_color='white',border_color='red',symbol_color='black',legacy_id=lid,versions=['2006'],note='2006 alternative colouring for mandatory signs (white with red rim), dropped in 2023.')
        if i in ('D-04.2','D-04.4','D-04.6','D-05.2','D-05.4','D-07.2'):
            vs=prod(**blue,band=['single_band','parallel_lines'],band_color='red',versions=['2023'])
        elif i=='D-06.2':
            vs=prod(**blue,band='single_band',band_color='red')+prod(**blue,band='parallel_lines',band_color='red',versions=['2023'],note='Parallel lines added (and preferred) in 2023; 2006 D, 8 allowed a single bar only.')
            vs+=prod(**alt,band='single_band',band_color='red')
        else:
            vs=prod(**blue)+prod(**alt)
    D.append(sign(i,vs))
cats.append({'category':'D','categoryName':catnames['D'],'signs':D,'removed':removed['D']})

# ================================================================== E
E=[]
for i in sorted(info, key=lambda x:(x[0],int(x[2:4]),int(x.split('.')[1]))):
    if i[0]!='E': continue
    lid=info[i]['legacy']['_']
    blue=dict(background_color='blue',border_color=None,symbol_color='white',legacy_id=lid)
    light=dict(background_color='white',border_color=None,symbol_color='black',legacy_id=lid)
    shp=['square','rectangle']
    if i=='E-04.2': shp='rectangle'
    if i in ('E-05.2','E-06.2','E-07.2','E-07.4','E-07.6','E-14.2'):
        vs=prod(shape=shp,**blue,band=['single_band','parallel_lines'],band_color='red')+prod(shape=shp,**light,band=['single_band','parallel_lines'],band_color='red')
    elif i=='E-08.2':
        vs=prod(shape='rectangle',background_color='white',border_color=None,symbol_color='grey',legacy_id=lid,band=['single_band','parallel_lines'],band_color='black')
        vs+=prod(shape='rectangle',background_color='white',border_color=None,symbol_color='grey',legacy_id=lid,band=['single_band','parallel_lines'],band_color='dark grey',versions=['2006'])
    elif i=='E-10.1':
        vs=prod(shape=shp,background_color='blue',border_color=None,symbol_color=['black','dark blue'],legacy_id='E,12a',note='White or yellow triangle on the blue ground.')
        vs+=prod(shape='pentagon',background_color='blue',border_color=None,symbol_color='white',legacy_id='E,12b',versions=['2006'])
        vs+=prod(shape=shp,background_color='dark',border_color=None,symbol_color='white',legacy_id='E,12c',versions=['2006'])
    elif i in ('E-05.1','E-05.2','E-06.1','E-06.2'):
        vs=prod(shape=shp,background_color=['blue','green'],border_color=None,symbol_color='white',legacy_id=lid,band=('none' if i.endswith('.1') else ['single_band','parallel_lines']),band_color=(None if i.endswith('.1') else 'red'))
    else:
        vs=prod(shape=shp,**blue)+prod(shape=shp,**light)
    E.append(sign(i,vs))
cats.append({'category':'E','categoryName':catnames['E'],'signs':E,'removed':removed['E']})

# ================================================================== F
F=[]
for i in sorted(info, key=lambda x:(x[0],int(x[2:4]),int(x.split('.')[1]))):
    if i[0]!='F': continue
    lid=info[i]['legacy']['_']
    sym=['black','dark blue']
    if i=='F-01.1': sym='red'
    vs=prod(shape=['square','rectangle'],background_color=['blue','green'],border_color='white',symbol_color=sym,legacy_id=lid,note='border_color = white square in the centre carrying the symbol.')
    F.append(sign(i,vs))
cats.append({'category':'F','categoryName':catnames['F'],'signs':F,'removed':removed['F']})

# ================================================================== G
G=[]
for i in sorted(info, key=lambda x:(x[0],int(x[2:4]),int(x.split('.')[1]))):
    if i[0]!='G': continue
    lid=info[i]['legacy']['_']
    if i in ('G-23.1','G-24.1','G-24.2','G-24.3'):
        vs=prod(shape=('arrow_rectangle' if i.startswith('G-24') else 'rectangle'),background_color='green',border_color=None,symbol_color='white',legacy_id=lid)
    elif i=='G-08.1':
        vs=prod(shape='rectangle',background_color=['blue','white','red'],border_color=None,symbol_color=['white','black'],legacy_id=lid)
        vs=[v for v in vs if (v['background_color']=='white')==(v['symbol_color']=='black')]
    else:
        shp='rectangle'
        if i.startswith(('G-05','G-06','G-24','G-26','G-27','G-28')): shp=['rectangle','arrow_rectangle']
        vs=prod(shape=shp,background_color='blue',border_color=None,symbol_color='white',legacy_id=lid)+prod(shape=shp,background_color='white',border_color=None,symbol_color='black',legacy_id=lid)
    G.append(sign(i,vs))
cats.append({'category':'G','categoryName':catnames['G'],'signs':G,'removed':removed['G']})

# ================================================================== H
H=[]
for i in sorted(info, key=lambda x:(x[0],int(x[2:4]),int(x.split('.')[1]))):
    if i[0]!='H': continue
    lid=info[i]['legacy']['_']
    vs=prod(shape='rectangle',background_color=['white','yellow'],border_color=['black','dark blue'],symbol_color=['black','dark blue'],legacy_id=lid)
    vs+=prod(shape='rectangle',background_color=['white','yellow'],border_color='red',symbol_color=['black','dark blue'],legacy_id=lid,versions=['2006'],note='2006 also allowed a red rim.')
    vs+=prod(shape='rectangle',background_color=['black','dark blue'],border_color=['white','yellow','red'],symbol_color=['white','yellow'],legacy_id=lid,versions=['2006'],note='2006 dark-ground model.')
    vs+=prod(shape='rectangle',background_color=['green','blue'],border_color=None,symbol_color='white',legacy_id=lid,versions=['2023'],note='2023: only for panels used with mandatory, special regulation and informative signs.')
    H.append(sign(i,vs))
cats.append({'category':'H','categoryName':catnames['H'],'signs':H,'removed':removed['H']})

# ================================================================== labels enumeration
labels={}
for c in cats:
    for sg in c['signs']:
        for v in sg['variants']:
            for k in ('model','legacy_model','shape','background_color','border_color','symbol_color','band','band_color','prohibition_bar','bar_continuity'):
                labels.setdefault(k,set()).add(v[k])
labels={k:sorted(x if x is not None else 'null' for x in s) for k,s in labels.items()}
labels['versions']=['2006','2023']

out={
 'title':v1['title'],
 'sources':v1['sources'],
 'legend':{
  'id':'Sign number in the 2023 revision.',
  'legacy_ids':'All 2006 numbers the sign corresponds to (model-specific numbers appear per variant in legacy_id).',
  'symbol_may_be_reversed':'True when the 2023 text allows the symbol to be reversed (e.g. for traffic keeping to the left).',
  'variants':'One entry per distinct rendering allowed by the texts. Every entry carries the same set of labels so variants can be filtered uniformly.',
  'variant.versions':'Which version(s) of the Convention allow this rendering.',
  'variant.model':'Danger warning signs only: model "one" (triangle) or "two" (square on a diagonal); 2006 names them Aa / Ab (legacy_model).',
  'variant.legacy_id':'2006 number for this rendering; null when there is no 2006 equivalent.',
  'variant.shape':'Outline of the sign.',
  'variant.background_color':'Ground colour.',
  'variant.border_color':'Border or rim colour; null when there is none. For F signs it is the white inner square.',
  'variant.symbol_color':'Colour of the symbol or inscription; null when the sign bears none.',
  'variant.band':'Cancellation band (end of a prohibition / obligation / area): "none", "single_band" (one oblique band, e.g. France) or "parallel_lines" (several parallel lines forming the band, e.g. Germany; stated as preferable in 2023). Slopes downwards from right to left.',
  'variant.band_color':'Colour of the cancellation band.',
  'variant.prohibition_bar':'Red oblique bar marking a prohibition (slopes downwards from left to right): "with_bar", "without_bar", or null when not applicable.',
  'variant.bar_continuity':'"interrupted" (bar broken where it crosses the symbol) or "continuous" (2006 option); null when not applicable.',
  'removed':'2006 signs that have no counterpart in the 2023 revision.'
 },
 'labels':labels,
 'categories':cats,
}
json.dump(out,open('/home/paul/Documents/panomatix/comparison_2006-2023.json','w'),indent=2,ensure_ascii=False)
ns=sum(len(c['signs']) for c in cats); nv=sum(len(s['variants']) for c in cats for s in c['signs'])
print('signs',ns,'variants',nv)
print(json.dumps(labels,indent=1))
