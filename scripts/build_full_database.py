"""Build full_database.json (+ full_database.meta.json) following template.json.

Inputs:
  comparison_2006-2023.json          2023 <-> 2006 mapping and rendering variants (labels)
  road_signs_all.json                national codes per country, with declinations
  scripts/2023_signs_extracted.json  2023 descriptions (parsed Annex 1)
  scripts/translations.py            FR / DE names
  scripts/osm_tags.py                OSM tags implied by each sign
"""
import json, re, collections, sys
P='/home/paul/Documents/panomatix/'
S=P+'scripts/'
sys.path.insert(0,S)
from translations import FR, DE
from osm_tags import IMPLIED, GENERIC

SCHEMA_VERSION='1.0.0'
DATA_VERSION='2026-09-17'

cmp=json.load(open(P+'comparison_2006-2023.json'))
db=json.load(open(P+'road_signs_all.json'))
s23={s['id']:s for s in json.load(open(S+'2023_signs_extracted.json'))}

COUNTRIES={  # cc: (jurisdiction key, OSM prefix, languages, confidence of the OSM code format)
 'at':('austria','AT',['de'],'low'), 'be':('belgium','BE',['fr','nl','de'],'high'), 'bg':('bulgaria','BG',['bg'],'low'),
 'cz':('czechia','CZ',['cs'],'low'), 'de':('germany','DE',['de'],'high'), 'dk':('denmark','DK',['da'],'medium'),
 'ee':('estonia','EE',['et'],'medium'), 'es':('spain','ES',['es'],'high'), 'fi':('finland','FI',['fi','sv'],'medium'),
 'fr':('france','FR',['fr'],'high'), 'hu':('hungary','HU',['hu'],'low'), 'lt':('lithuania','LT',['lt'],'medium'),
 'lv':('latvia','LV',['lv'],'medium'), 'nl':('netherlands','NL',['nl'],'medium'), 'pl':('poland','PL',['pl'],'medium'),
 'pt':('portugal','PT',['pt'],'medium'), 'ro':('romania','RO',['ro'],'low'), 'se':('sweden','SE',['sv'],'medium'),
 'si':('slovenia','SI',['sl'],'low'), 'sk':('slovakia','SK',['sk'],'low'),
}
TEXT={'fr':FR,'de':DE}

# Signs whose declination value in road_signs_all.json really is the parameter shown on the sign.
# (A-02/A-03 gradient and H-01/H-02/H-10 distance carry sub-variant numbers instead: no parameters.)
PARAMS={
 'C-14':('maxspeed','km/h','Maximum speed shown on the sign.'), 'D-06':('minspeed','km/h','Minimum speed shown on the sign.'),
 'G-17':('speed','km/h','Advisory speed shown on the sign.'),
 'C-05':('width','m','Maximum overall width.'), 'C-06':('height','m','Maximum overall height.'), 'C-07':('weight','t','Maximum laden mass.'),
 'C-08':('axleload','t','Maximum mass per axle.'), 'C-09':('length','m','Maximum overall length.'), 'C-10':('distance','m','Minimum distance between vehicles.'),
}
def pkey_of(sid): return sid[:4] if sid else None
def param_value(v): return float(v) if v and re.fullmatch(r'\d+(\.\d+)?', v) else None

def osm_code(cc, code):
    body=re.sub(r'^[A-Z]{2}-','',code)
    if cc=='pl':                                   # Polish official codes are A-1, B-33...
        if not re.match(r'^[A-Z]',body): return None
        body=re.sub(r'^([A-Z]+)(\d)',r'\1-\2',body)
    return f'{COUNTRIES[cc][1]}:{body}'
def nat_code(cc, code): return f'{cc}:{re.sub(r"^[A-Z]{2}-","",code)}'
def parse_decl(code):
    """VIENNA-A2a-Aa-V1-3-10-LHT-EA -> model Aa, variant 1, value '3-10', left-hand traffic, European Agreement."""
    m=re.match(r'^(VIENNA|OTHER)-([A-Z]+\d+[a-z]*)(?:-([A-Za-z]+))?-V(\d+)(.*)$',code)
    if not m: return {'code':code,'model':None,'variant':None,'lht':False,'ea':False,'value':None}
    rest=m.group(5); val=re.sub(r'-LHT|-EA','',rest).strip('-_') or None
    return {'code':code,'model':m.group(3),'variant':int(m.group(4)),'lht':'-LHT' in rest,'ea':'-EA' in rest,'value':val}

# ---- national design conventions (heuristic, documented in meta 'designAssignment')
YELLOW_GROUND={'A':{'se','fi','pl'}, 'B':{'se','fi','pl'}, 'C':{'se','fi'}}
SINGLE_BAND={'fr','es','pt'}
WITH_BAR={'fr','be','es','pt'}
def national_design(sid, cc, nat, pd):
    sec=sid[0] if sid else None
    want={'symbol_color':'black'}
    if sec=='A':
        want['shape']='diamond' if pd['model']=='Ab' else 'triangle'
        yellow = cc in YELLOW_GROUND['A'] or (cc=='es' and re.match(r'ES-TP',nat)) or pd['model']=='Ab'
        want['background_color']='yellow' if yellow else 'white'
    elif sec in ('B','C') and sid not in ('B-02.1','B-03.1','B-03.2','B-05.1','B-05.2'):
        want['background_color']='yellow' if cc in YELLOW_GROUND[sec] else 'white'
    want['band']='single_band' if cc in SINGLE_BAND else 'parallel_lines'
    want['prohibition_bar']='with_bar' if cc in WITH_BAR else 'without_bar'
    want['bar_continuity']='interrupted' if cc in WITH_BAR else None
    return want
def pick_design(designs, want):
    best=None
    for k,d in enumerate(designs):
        if '2023' not in d['versions']: continue
        score=sum(1 for lab,val in want.items() if d.get(lab)==val) - sum(10 for lab in ('shape','background_color') if lab in want and d.get(lab)!=want[lab])
        if best is None or score>best[0]: best=(score,k)
    return best[1] if best else 0

# ---- DB index and link DB refs -> 2023 ids
dbsigns={}
for c in db['categories']:
    for s in c['signs']: s['_cat']=c['category']; dbsigns[s['reference']]=s
link=collections.defaultdict(set)
for c in cmp['categories']:
    for s in c['signs']:
        for l in s['legacy_ids']: link['VIENNA-'+re.sub(r'^([A-H])[ab]?,',r'\1',l)].add(s['id'])
ALIAS={'VIENNA-A3c':['A-03.1'],'VIENNA-A17a':['A-17.1'],'VIENNA-A17b':['A-17.1'],'VIENNA-A18d':['A-18.2'],'VIENNA-A18e':['A-18.2'],
 'VIENNA-A18f':['A-18.2'],'VIENNA-A19c':['A-19.2'],'VIENNA-A20':['B-01.1'],'VIENNA-A21':['B-02.1','H-10.1'],'VIENNA-A33':['A-12.2'],
 'VIENNA-A34':['A-09.1','H-09.1'],'VIENNA-A35':['A-29.1'],'VIENNA-A36':['A-29.1'],'VIENNA-B2b':['B-02.1'],'VIENNA-C1':['C-01.1','C-01.2'],
 'VIENNA-D1':['D-01.1','D-01.3','D-01.4','D-01.5','D-01.7','D-01.8'],'VIENNA-D10b':['D-08.1'],'VIENNA-D10c':['D-08.1'],'VIENNA-D11':['D-05.1','D-05.3'],
 'VIENNA-E7d':['E-07.5'],'VIENNA-E8d':['E-07.6'],'VIENNA-E12':['E-10.1'],'VIENNA-E12b':['E-10.1'],'VIENNA-E14b':['E-12.1'],'VIENNA-E14c':['E-12.1'],
 'VIENNA-F1b':['F-01.1'],'VIENNA-F1c':['F-01.1'],'VIENNA-G23b':['G-23.1']}
direct=set(link)
for k,v in ALIAS.items(): link[k]|=set(v)
by2023=collections.defaultdict(list)
for ref,ids in link.items():
    if ref in dbsigns:
        for i in ids: by2023[i].append(ref)

# ---- jurisdictions (template structure) from DB localizations
def jurisdictions(refs, sid, name_en, keep=None):
    jur={}
    for ref in refs:
        for de in dbsigns[ref]['declinations']:
            pd=parse_decl(de['code'])
            for cc,loc in de.get('localizations',{}).items():
                jkey,pref,langs,conf=COUNTRIES[cc]
                nat=loc['position']['center']
                if keep and not keep(cc,nat,pd): continue
                j=jur.setdefault(jkey,{'countryCode':cc,'languages':{},'additional':{'bottom':[]},'osm':{'traffic_sign':[]}})
                code=nat_code(cc,nat)
                for lg in langs:
                    L=j['languages'].setdefault(lg,{'code':None,'codes':[],'text':TEXT.get(lg,{}).get(name_en),'description':None})
                    if code not in L['codes']: L['codes'].append(code)
                    base=code
                    if pkey_of(sid) in PARAMS and param_value(pd['value']) is not None:
                        v=pd['value']; base=re.sub(r'[-_(]?('+re.escape(v)+'|'+re.escape(v.replace('.',','))+r')\)?$','',code)
                    rank=(base!=code, pd['lht'], pd['ea'], pd['variant'] or 99, pd['value'] is not None, len(base))
                    if L.get('_rank') is None or rank<L['_rank']: L['code']=base; L['_rank']=rank
                oc=osm_code(cc,nat)
                if oc and oc not in j['osm']['traffic_sign']: j['osm']['traffic_sign'].append(oc)
                if pd['lht']: j['leftHandTrafficVariant']=True
                for pos,val in loc['position'].items():            # bottom1, bottom2... -> stacked panels
                    m=re.match(r'bottom(\d+)$',pos)
                    if not m: continue
                    idx=int(m.group(1)); pc=nat_code(cc,val)
                    slot=next((b for b in j['additional']['bottom'] if b['index']==idx),None)
                    if slot is None: slot={'index':idx,'reference':[]}; j['additional']['bottom'].append(slot)
                    pc in slot['reference'] or slot['reference'].append(pc)
                pkey=pkey_of(sid)
                if pkey in PARAMS and param_value(pd['value']) is not None:
                    n=param_value(pd['value']); n=int(n) if n==int(n) else n
                    pn,unit,desc=PARAMS[pkey]
                    pr=j.setdefault('parameters',{}).setdefault(pn,{'type':'number','unit':unit,'description':desc,'values':[]})
                    n not in pr['values'] and pr['values'].append(n)
    for j in jur.values():
        j['additional']['bottom'].sort(key=lambda b:b['index'])
        for L in j['languages'].values():
            if L['code'] not in L['codes']: L['codes'].insert(0,L['code'])
            L.pop('_rank',None)
        for pr in j.get('parameters',{}).values(): pr['values'].sort()
        j['osm']['traffic_sign'].sort()
    return dict(sorted(jur.items()))

# ---- Vienna 2023 entries
KEYS=('shape','background_color','border_color','symbol_color','band','band_color','prohibition_bar','bar_continuity','model')
BAR_MODELS={'C-13.1':('C,13aa','C,13ab'),'C-13.3':('C,13ba','C,13bb')}   # 2006 models differing by the red bar
entries=[]
for c in cmp['categories']:
    for s in c['signs']:
        i=s['id']; desc=s23.get(i,{}).get('desc')
        refs=sorted(by2023.get(i,[]))
        direct_refs=[r for r in refs if r in direct]; alias_refs=[r for r in refs if r not in direct]
        # designs = deduplicated variants, each with its own legacy refs, versions and jurisdictions
        designs=[]; idx={}
        for v in s['variants']:
            k=tuple(v[lab] for lab in KEYS)
            if k not in idx:
                idx[k]=len(designs)
                designs.append({**{lab:v[lab] for lab in KEYS},'legacyModel':v['legacy_model'],
                    'versions':list(v['versions']),'legacyReferences':[],'notes':[],
                    'mirrored':False,'wikidata':'QXXXXXXX','toBeAdded':True,'jurisdictions':{}})
            d=designs[idx[k]]
            for ver in v['versions']: ver in d['versions'] or d['versions'].append(ver)
            if v['legacy_id'] and 'VIENNA:'+v['legacy_id'] not in d['legacyReferences']: d['legacyReferences'].append('VIENNA:'+v['legacy_id'])
            if v.get('note') and v['note'] not in d['notes']: d['notes'].append(v['note'])
        for d in designs:
            d['versions'].sort()
            if i in BAR_MODELS and d['prohibition_bar'] in ('with_bar','without_bar'):
                d['legacyReferences']=['VIENNA:'+BAR_MODELS[i][0 if d['prohibition_bar']=='with_bar' else 1]]
                d['notes'].append('2006 model assignment (aa/ba = with bar, ab/bb = without bar) follows the order of Annex 3; to be checked against the drawings.')
            if not d['notes']: del d['notes']
        for k,d in enumerate(designs):
            d['jurisdictions']=jurisdictions(direct_refs,i,s['name'],keep=lambda cc,nat,pd,k=k: pick_design(designs,national_design(i,cc,nat,pd))==k)
        sign_legacy=sorted({re.sub(r'^VIENNA:([A-H])[ab],',r'VIENNA:\1,',l) for d in designs for l in d['legacyReferences']}) or ['VIENNA:'+l for l in s['legacy_ids']]
        bottom=sorted({'VIENNA:'+m for m in re.findall(r'\bH-\d{2}\.\d\b',desc or '') if m!=i})
        e={'reference':'VIENNA:'+i,'category':c['category'],'categoryName':c['categoryName'],
           'legacyReferences':sign_legacy,'wikidata':'QXXXXXXX',
           'name':{'en':s['name'],'fr':FR[s['name']],'de':DE[s['name']]},
           'description':{'en':desc},'note':s.get('note'),'symbolMayBeReversed':s['symbol_may_be_reversed'],
           'officialSign':{'designs':designs,'additional':{'bottom':([{'index':1,'reference':bottom}] if bottom else [])}},
           'osm':{'traffic_sign_generic':GENERIC.get(i),'implied_tags':IMPLIED.get(i)},
           'relatedSigns':[]}
        for r in alias_refs:
            e['relatedSigns'].append({'reference':'DB:'+r,'name':{'en':dbsigns[r]['name']},'description':{'en':dbsigns[r]['description']},
                                      'shape':None,'background_color':None,'border_color':None,'symbol_color':None,'mirrored':False,'wikidata':'QXXXXXXX','toBeAdded':False,
                                      'jurisdictions':jurisdictions([r],i,dbsigns[r]['name'])})
        if not e['note']: del e['note']
        entries.append(e)

# ---- national-only signs (OTHER-*) and 2006 Vienna signs dropped in 2023
linked={r for e in entries for r in by2023.get(e['reference'][7:],[])}
for ref,s in dbsigns.items():
    if ref.startswith('VIENNA') and ref in linked: continue
    other=ref.startswith('OTHER')
    entries.append({'reference':ref.replace('OTHER-','OTHER:').replace('VIENNA-','VIENNA2006:'),
                    'category':s['_cat'],'legacyReferences':[],'wikidata':'QXXXXXXX',
                    'name':{'en':s['name']},'description':{'en':s['description']},
                    'note':'National sign without a Vienna 2023 equivalent.' if other else '2006 Vienna sign without a 2023 counterpart.',
                    'officialSign':{'designs':[{'shape':None,'background_color':None,'border_color':None,'symbol_color':None,
                                    'versions':[],'legacyReferences':[],'mirrored':False,'wikidata':'QXXXXXXX','toBeAdded':True,
                                    'jurisdictions':jurisdictions([ref],None,s['name'])}],'additional':{'bottom':[]}},
                    'relatedSigns':[]})

json.dump(entries,open(P+'full_database.json','w'),indent=2,ensure_ascii=False)
meta={
 'schemaVersion':SCHEMA_VERSION,'dataVersion':DATA_VERSION,'template':'template.json','entries':len(entries),
 'countries':{cc:{'jurisdiction':j,'osm_prefix':p,'languages':l,'osm_code_confidence':conf,
                  'osm_wiki':'https://wiki.openstreetmap.org/wiki/Road_signs_in_'+j.capitalize()} for cc,(j,p,l,conf) in sorted(COUNTRIES.items())},
 'legend':{
  'reference':'VIENNA:<2023 id> for Convention signs; OTHER:<id> for national signs of road_signs_all.json; VIENNA2006:<id> for 2006 signs dropped in 2023.',
  'legacyReferences':'Generic 2006 symbol number (VIENNA:A,1a), union of the designs. The model-specific numbers (VIENNA:Aa,1a for triangle designs, VIENNA:Ab,1a for diamond designs, VIENNA:C,13aa / C,13ab with / without bar...) are in officialSign.designs[].legacyReferences.',
  'name / description':'en from the 2023 text; fr and de names translated for this database (not official translations).',
  'officialSign.designs':'One entry per distinct design (shape / background_color / border_color / symbol_color / band / prohibition_bar / model), deduplicated. Each design carries its own legacyReferences, the Convention versions allowing it, and the jurisdictions (national codes) that use this design.',
  'designAssignment':'National codes are attached to a design by: Vienna model of the declination (Aa=triangle, Ab=diamond); yellow ground for se, fi (A/B/C) and pl (A/B) and for Spanish TP- temporary codes; single cancellation band for fr, es, pt (parallel lines elsewhere); red bar on "no entry for..." signs kept for fr, be, es, pt (omitted elsewhere); black symbols. These national conventions are heuristics, to be verified per country.',
  'officialSign.additional.bottom':'Additional panels placed under the sign, at Convention level: one entry per stacking slot, "index" = position from the top (1 = directly under the sign), "reference" = the panels allowed in that slot (VIENNA:H-xx.x, from the 2023 text). Always present (possibly empty) so panels can be added.',
  'jurisdictions.<country>.additional.bottom':'Same structure with national panel codes (cc:code); filled from the bottom1/bottom2... positions of road_signs_all.json. Always present so national panels can be added per country.',
  'jurisdictions.<country>.languages.<lang>.code':'Primary national code (cc:code); codes lists every national code of road_signs_all.json for this sign (values, mirrored and European Agreement variants).',
  'jurisdictions.<country>.languages.<lang>.text':'National name; filled for fr and de only, null otherwise.',
  'jurisdictions.<country>.parameters':'Numeric values (speed, dimensions) found in the national declinations.',
  'jurisdictions.<country>.osm.traffic_sign':'OSM traffic_sign values (<ISO prefix>:<national code>); see countries.<cc>.osm_code_confidence.',
  'osm.traffic_sign_generic':'Country-independent OSM traffic_sign value when one exists (city_limit, stop, give_way, maxspeed, hazard...).',
  'osm.implied_tags':'Tags the sign usually implies on the affected way or node; "*" = value to fill in; null = no established tagging.',
  'relatedSigns':'Other entries of road_signs_all.json attached to this sign (older or alternative numbering), with their own jurisdictions.',
  'wikidata / toBeAdded':'Placeholders kept from the template, to be filled.',
 }}
json.dump(meta,open(P+'full_database.meta.json','w'),indent=2,ensure_ascii=False)
v=[e for e in entries if e['reference'].startswith('VIENNA:')]
print('entries',len(entries),'| vienna 2023',len(v),
      '| designs with jurisdictions',sum(1 for e in v for d in e['officialSign']['designs'] if d['jurisdictions']),
      '| signs with panels',sum(1 for e in v if e['officialSign']['additional']['bottom']))
