#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Récupère la légende anglaise de chaque image de panneau sur les pages Wikipédia « Road signs in … ».

Les pages viennent de traffic_sign_links_by_country.json (liens « wikipedia_en ») ; à défaut on essaie
« Road signs in <pays> ». Résultat : databases_from_web/wikipedia_en_captions.json
    { "files": { clé de fichier Wikimedia : [{"caption": "W2-6 Roundabout", "page": "...", "prefix": "US"}] } }

Ces légendes servent à link_by_meaning.py pour relier les panneaux nationaux aux concepts de Vienne.

Usage :
    python3 fetch_wikipedia_captions.py            # télécharge (pages déjà en cache non retéléchargées)
    python3 fetch_wikipedia_captions.py --refresh
"""

import argparse
import html
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
LINKS = BASE_DIR / 'traffic_sign_links_by_country.json'
CACHE_DIR = BASE_DIR / 'databases_from_web' / 'wikipedia_en'
OUT = BASE_DIR / 'databases_from_web' / 'wikipedia_en_captions.json'
API = 'https://en.wikipedia.org/w/api.php'
USER_AGENT = 'road-signs-dataset/1.0 (research script; python-urllib)'

FILE_RE = re.compile(r'href="[^"]*?/wiki/(?:File|Image):([^"#?&]+)"')


def file_key(name):
    name = unicodedata.normalize('NFC', html.unescape(urllib.parse.unquote(name))).replace(' ', '_')
    return name.lower()


def clean(fragment):
    text = re.sub(r'<(sup|style|script)\b.*?</\1>', ' ', fragment, flags=re.S)
    text = re.sub(r'<br\s*/?>', ' ', text)
    text = re.sub(r'<[^>]+>', ' ', text)
    return re.sub(r'\s+', ' ', html.unescape(text)).strip()


def page_titles(entry):
    titles = []
    for url in entry.get('links', {}).get('wikipedia_en', []):
        path = urllib.parse.unquote(url.split('/wiki/', 1)[-1])
        if path.startswith('en:'):
            path = path[3:]
        if ':' not in path:
            titles.append(path)
    if not titles:
        titles.append(f"Road signs in {entry['country'].split(',')[0]}")
    return list(dict.fromkeys(titles))


def fetch(title, refresh):
    cache = CACHE_DIR / (re.sub(r'[^\w.-]+', '_', title) + '.html')
    if cache.exists() and not refresh:
        return cache.read_text(encoding='utf-8')
    params = urllib.parse.urlencode({'action': 'parse', 'page': title, 'prop': 'text', 'redirects': 1,
                                     'format': 'json', 'formatversion': 2})
    req = urllib.request.Request(f'{API}?{params}', headers={'User-Agent': USER_AGENT})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 5:      # trop de requêtes : on attend puis on réessaie
                raise
            time.sleep(15 * (attempt + 1))
    text = data.get('parse', {}).get('text', '')
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(text, encoding='utf-8')
    time.sleep(2)
    return text


def captions(page):
    """[(clé de fichier, légende)] : galeries, puis tableaux, puis vignettes, puis texte alternatif."""
    found = []
    seen = set()

    def add(fragment, caption):
        for m in FILE_RE.finditer(fragment):
            key = file_key(m.group(1))
            if caption and (key, caption) not in seen:
                seen.add((key, caption))
                found.append((key, caption))

    for box in re.findall(r'<li class="gallerybox".*?</li>', page, re.S):
        text = re.search(r'<div class="gallerytext">(.*?)</div>', box, re.S)
        add(box, clean(text.group(1)) if text else '')
    for fig in re.findall(r'<figure\b.*?</figure>', page, re.S):
        text = re.search(r'<figcaption>(.*?)</figcaption>', fig, re.S)
        add(fig, clean(text.group(1)) if text else '')
    for tr in re.findall(r'<tr\b.*?</tr>', page, re.S):
        cells = re.findall(r'<t[hd]\b[^>]*>(.*?)</t[hd]>', tr, re.S)
        for i, cell in enumerate(cells):
            if not FILE_RE.search(cell):
                continue
            text = clean(cell)
            if not text:      # image seule dans sa cellule : la légende est dans une cellule voisine
                text = next((clean(c) for c in cells[i + 1:] + cells[:i][::-1]
                             if clean(c) and not FILE_RE.search(c)), '')
            add(cell, text[:200])
    for m in re.finditer(r'<a href="[^"]*?/wiki/(?:File|Image):([^"#?&]+)"[^>]*>\s*<img[^>]*alt="([^"]+)"', page):
        key, alt = file_key(m.group(1)), clean(m.group(2))
        if alt and not any(k == key for k, _ in found):
            found.append((key, alt))
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()

    files, pages = {}, {}
    for entry in json.loads(LINKS.read_text(encoding='utf-8')):
        for title in page_titles(entry):
            if title in pages:
                continue
            try:
                page = fetch(title, args.refresh)
            except Exception as exc:                       # page absente, réseau...
                print(f'  {entry["prefix"]:6s} {title} : {exc}')
                continue
            found = captions(page)
            pages[title] = {'prefix': entry['prefix'], 'captions': len(found)}
            for key, caption in found:
                files.setdefault(key, []).append({'caption': caption, 'page': title, 'prefix': entry['prefix']})
            print(f'  {entry["prefix"]:6s} {title} : {len(found)} légendes')
    OUT.write_text(json.dumps({'pages': pages, 'files': files}, ensure_ascii=False, indent=1) + '\n',
                   encoding='utf-8')
    print(f'{len(files)} fichiers légendés, {len(pages)} pages -> {OUT.relative_to(BASE_DIR)}')


if __name__ == '__main__':
    main()
