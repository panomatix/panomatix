"""Step 1 — official texts of the national signs (CPU, network).

For each national sign, its official name in the country's language(s) and in English, from:
  1. the captions of the national sign catalogues on Wikipedia / the OSM wiki (the pages the pictures were
     downloaded from: road_sign_images/images_links.json and data_to_help/links_road_signs.txt) — a caption
     next to a picture is the sign's name as the national regulation gives it;
  2. otherwise the description of the picture on Wikimedia Commons, which is multilingual.
Only texts found in those sources are kept: nothing is invented or machine-translated.

Output: work/texts.json  {unit key: {"native": {lang: text}, "en": text, "sources": [...]}}
"""
from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
from pathlib import Path

from common import IMAGES, REPO, WORK, all_units, commons_filename, http_get, load_export, write_json

CACHE = WORK / "texts_cache"
CACHE.mkdir(parents=True, exist_ok=True)
PAUSE = 0.5  # seconds between two requests to a Wikimedia API


def api_json(endpoint: str, params: dict) -> dict:
    url = f"{endpoint}?{urllib.parse.urlencode({**params, 'format': 'json', 'formatversion': 2})}"
    key = CACHE / (re.sub(r"[^A-Za-z0-9]+", "_", url)[:180] + ".json")
    if key.exists():
        return json.loads(key.read_text("utf-8"))
    for attempt in range(4):
        try:
            data = json.loads(http_get(url, accept="application/json"))
            key.write_text(json.dumps(data), "utf-8")
            time.sleep(PAUSE)
            return data
        except Exception as err:  # noqa: BLE001 — network: retry, then give up on this page
            if attempt == 3:
                print(f"  ! {url[:120]}: {err}")
                return {}
            time.sleep(5 * (attempt + 1))
    return {}


# --- 1. catalogue pages ---------------------------------------------------------------------------

def catalogue_pages() -> list[tuple[str, str, str]]:
    """[(api endpoint, page title, language)] of the Wikipedia / OSM wiki pages listing national signs."""
    urls = set()
    links = IMAGES / "images_links.json"
    if links.exists():
        urls |= {p["url"] for p in json.loads(links.read_text("utf-8")).get("pages", [])}
    extra = REPO / "data_to_help" / "links_road_signs.txt"
    if extra.exists():
        text = extra.read_text("utf-8")
        for lang, title in re.findall(r"\{\{Wikipedia\|([a-z]{2,3})\|([^|}]+)", text):
            urls.add(f"https://{lang}.wikipedia.org/wiki/{title.replace(' ', '_')}")
        for title in re.findall(r"\[\[([A-Z]{2}:[^|\]]+)", text):
            urls.add(f"https://wiki.openstreetmap.org/wiki/{title.replace(' ', '_')}")
    pages = []
    for url in sorted(urls):
        u = urllib.parse.urlparse(url)
        title = urllib.parse.unquote(u.path.split("/wiki/", 1)[-1]).replace("_", " ")
        if u.netloc.endswith("wikipedia.org"):
            lang = u.netloc.split(".")[0]
            m = re.match(r"^([a-z]{2,3}):(.+)$", title)  # interwiki link written on en.wikipedia: "de:Bildtafel…"
            if m and m.group(1) != "commons":
                lang, title = m.group(1), m.group(2)
            elif m:
                continue  # Commons categories: no captions
            pages.append((f"https://{lang}.wikipedia.org/w/api.php", title, lang))
        elif u.netloc == "wiki.openstreetmap.org":
            m = re.match(r"^([A-Z]{2}):(.+)$", title)
            lang = m.group(1).lower() if m else "en"
            pages.append(("https://wiki.openstreetmap.org/w/api.php", title, lang))
    return sorted(set(pages))


FILE_RE = r"(?:[^\s:|\[\]{}]+:)?([^|\[\]{}\n]+?\.(?:svg|png|jpe?g|gif|webp))"


def clean(text: str) -> str:
    text = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", text, flags=re.S)
    text = re.sub(r"<br\s*/?>", " ", text)
    for _ in range(3):
        text = re.sub(r"\{\{[^{}]*\}\}", "", text)  # templates
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)  # [[link|label]] -> label
    text = re.sub(r"\[https?://\S+\s*([^\]]*)\]", r"\1", text)
    text = re.sub(r"'{2,}", "", text)
    text = text.replace("[[", "").replace("]]", "")
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"^\s*[!|]+\s*", "", text)
    text = re.sub(r"\b(?:style|class|align|width|rowspan|colspan)\s*=\s*\"[^\"]*\"\s*\|?", "", text)
    return re.sub(r"\s+", " ", text).strip(" |:–-")


def file_key(name: str) -> str:
    name = urllib.parse.unquote(name).strip().replace(" ", "_")
    return (name[:1].upper() + name[1:]).lower()


def captions_of(wikitext: str) -> dict[str, str]:
    """{file key: caption} from <gallery> blocks and from table rows holding a picture and text."""
    out: dict[str, str] = {}
    for block in re.findall(r"<gallery[^>]*>(.*?)</gallery>", wikitext, flags=re.S | re.I):
        for line in block.splitlines():
            m = re.match(rf"^\s*{FILE_RE}\s*\|(.*)$", line, flags=re.I)
            if m:
                cap = clean(m.group(2).split("|")[-1])
                if len(cap) > 2:
                    out.setdefault(file_key(m.group(1)), cap)
    # stand-alone pictures: [[File:X.svg|thumb|upright|A33 Muu vaara.]] -> the last parameter, if it is text
    options = re.compile(r"^(thumb|thumbnail|frame|frameless|border|upright(=.*)?|left|right|center|centre|none|baseline|middle|\d+(x\d+)?px|(alt|link|class|lang|page)=.*)$", re.I)
    for m in re.finditer(rf"\[\[{FILE_RE}((?:\|[^\[\]]*(?:\[\[[^\]]*\]\][^\[\]]*)*)*)\]\]", wikitext, flags=re.I):
        params = [p.strip() for p in m.group(2).split("|") if p.strip()]
        if params and not options.match(params[-1]):
            cap = clean(params[-1])
            if len(cap) > 2:
                out.setdefault(file_key(m.group(1)), cap)
    for row in re.split(r"\n\|-", wikitext):
        files = re.findall(rf"\[\[{FILE_RE}[^\]]*\]\]", row, flags=re.I)
        if len(files) != 1:
            continue
        text = clean(re.sub(rf"\[\[{FILE_RE}[^\]]*\]\]", " ", row, flags=re.I))
        if 2 < len(text) < 400:
            out.setdefault(file_key(files[0]), text)
    return out


def catalogue_captions() -> dict[str, dict[str, str]]:
    """{language: {file key: caption}}"""
    out: dict[str, dict[str, str]] = {}
    pages = catalogue_pages()
    print(f"Reading {len(pages)} catalogue pages …")
    for endpoint, title, lang in pages:
        data = api_json(endpoint, {"action": "parse", "page": title, "prop": "wikitext", "redirects": 1})
        text = (data.get("parse") or {}).get("wikitext") or ""
        if isinstance(text, dict):
            text = text.get("*", "")
        caps = captions_of(text)
        out.setdefault(lang, {}).update({k: v for k, v in caps.items() if k not in out.get(lang, {})})
        print(f"  {lang:3} {len(caps):5} captions  {title}")
    return out


# --- 2. Commons descriptions ------------------------------------------------------------------------

def commons_descriptions(files: list[str]) -> dict[str, dict[str, str]]:
    """{file key: {language: description}} for Commons files, 50 per request."""
    out: dict[str, dict[str, str]] = {}
    files = sorted(set(files))
    print(f"Reading the Commons descriptions of {len(files)} files …")
    for i in range(0, len(files), 50):
        batch = files[i:i + 50]
        data = api_json("https://commons.wikimedia.org/w/api.php", {
            "action": "query", "prop": "imageinfo", "iiprop": "extmetadata", "iiextmetadatamultilang": 1,
            "iiextmetadatafilter": "ImageDescription", "titles": "|".join(f"File:{f}" for f in batch)})
        for page in (data.get("query") or {}).get("pages", []):
            meta = ((page.get("imageinfo") or [{}])[0].get("extmetadata") or {}).get("ImageDescription") or {}
            value = meta.get("value")
            if isinstance(value, str):
                value = {"und": value}  # no language given: never taken for English (it is often not)
            if isinstance(value, dict):
                texts = {lang: clean(v) for lang, v in value.items() if isinstance(v, str) and lang != "_type"}
                texts = {k: v for k, v in texts.items() if 2 < len(v) < 600}
                if texts:
                    out[file_key(page["title"].split(":", 1)[1])] = texts
        if i and i % 2000 == 0:
            print(f"  {i}/{len(files)}")
    return out


# --- 3. per national sign ---------------------------------------------------------------------------

def strip_code(text: str, codes: list[str]) -> str:
    """'B14 – Limitation de vitesse' / 'E 12 Jízda…' -> the text without the code (already shown elsewhere)."""
    for code in codes:
        chars = re.sub(r"[^0-9A-Za-z]", "", code.split(":", 1)[-1])
        if not chars:
            continue
        loose = r"[\s._\-/]*".join(re.escape(c) for c in chars)  # "E12" also matches "E 12", "E-12", "E.12"
        text = re.sub(rf"^\s*(?:{loose})(?![0-9A-Za-z])\s*[:–\-—.)]?\s*", "", text, flags=re.I)
    return text.strip()


GENERIC = re.compile(
    r"\b(road|traffic|street|sign|signs|signal|panel|plate|board|diagram|image|picture|svg|png|file|version|old|new|"
    r"mandatory|warning|prohibitory|prohibition|regulatory|information|informative|direction|guide|priority|danger|"
    r"additional|supplementary|of|the|a|an|in|for|from|and|to|on|with|used|national|official)\b", re.I)


def meaningful(text: str, country_words: set[str]) -> bool:
    """False for empty shells such as 'Turkish mandatory road sign' or a bare code: they say nothing."""
    rest = GENERIC.sub(" ", text)
    rest = " ".join(w for w in re.findall(r"[^\W\d_]{2,}", rest) if w.lower() not in country_words)
    return len(rest) >= 3


def main() -> None:
    export = load_export()
    units = all_units(export)
    caps = catalogue_captions()
    files = {u.key: [f for f in (commons_filename(s.get("url")) for s in u.sources) if f] for u in units}
    commons = commons_descriptions([f for fs in files.values() for f in fs])
    country_words = {w.lower() for u in units for w in re.findall(r"[a-z]+", u.jur)}
    country_words |= {"turkish", "german", "french", "italian", "spanish", "russian", "polish", "czech", "slovak",
                      "finnish", "swedish", "norwegian", "danish", "dutch", "belgian", "austrian", "swiss", "british",
                      "irish", "american", "canadian", "australian", "japanese", "chinese", "korean", "indonesian",
                      "malaysian", "mexican", "brazilian", "argentine", "chilean", "colombian", "icelandic", "greek",
                      "hungarian", "romanian", "bulgarian", "ukrainian", "belarusian", "portuguese", "croatian",
                      "slovenian", "serbian", "estonian", "latvian", "lithuanian", "indian", "thai", "vietnamese"}
    keep = lambda txt: txt if txt and meaningful(txt, country_words) else None  # noqa: E731
    result = {}
    for u in units:
        keys = [file_key(f) for f in files[u.key]]
        keys += [file_key(Path(s.get("file", "")).name) for s in u.sources if s.get("file")]
        native, en, sources = {}, None, []
        for lang in u.languages:
            base = lang.split("-")[0]
            for k in keys:
                txt = caps.get(base, {}).get(k) or (commons.get(k) or {}).get(base)
                txt = keep(strip_code(txt, u.codes)) if txt else None
                if txt:
                    native[lang] = txt
                    sources.append(f"{base}:{k}")
                    break
        for k in keys:
            txt = caps.get("en", {}).get(k) or (commons.get(k) or {}).get("en")
            txt = keep(strip_code(txt, u.codes)) if txt else None
            if txt:
                en = txt
                break
        native = {k: v for k, v in native.items() if v}
        if native or en:
            result[u.key] = {"native": native, "en": en or None, "sources": sources}
    write_json(WORK / "texts.json", result)
    both = sum(1 for v in result.values() if v["native"] and v["en"])
    print(f"Texts found for {len(result)} of {len(units)} national signs ({both} with both the original language and English) → work/texts.json")


if __name__ == "__main__":
    main()
