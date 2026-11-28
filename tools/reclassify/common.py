"""Shared helpers: paths, the live database export, national signs ("units"), image lookup, Florence-2 data.

A *unit* is one national sign: a jurisdiction (country) inside a design or a related sign of an entry.
Its location follows the site's API: loc "d0", "d1"… for designs, "r0"… for related signs.
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
IMAGES = REPO / "road_sign_images"
VIENNA_IMAGES = REPO / "vienna_convention_images"
SIGNS_BY_COUNTRY = REPO / "signs_by_country"
WORK = Path(os.environ.get("RECLASSIFY_WORK", REPO / "tools" / "reclassify" / "work"))
SITE = os.environ.get("PANOMATIX_SITE", "https://panomatix.tes-maker.eu")
USER_AGENT = "Panomatix-reclassify/1.0 (+https://panomatix.tes-maker.eu; road sign database maintenance)"
IMAGE_EXT = {".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"}

WORK.mkdir(parents=True, exist_ok=True)


def norm(code: str) -> str:
    """Same normalisation as the site (server/images.js): lower case, letters and digits only."""
    return re.sub(r"[^a-z0-9]", "", code.lower())


def http_get(url: str, *, timeout: int = 60, accept: str = "*/*") -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def load_export(refresh: bool = False) -> list[dict]:
    """The live database (GET /api/v1/export), cached in work/export.json. Every proposal is made against it,
    and the versions it holds let the server refuse a change to a sign edited online in the meantime."""
    path = WORK / "export.json"
    if refresh or not path.exists():
        print(f"Downloading the live database from {SITE} …")
        path.write_bytes(http_get(f"{SITE}/api/v1/export", timeout=300, accept="application/json"))
    return json.loads(path.read_text("utf-8"))


def load_versions(refresh: bool = False) -> dict[str, int]:
    """{reference: version} of the live signs, so the server can detect concurrent edits when applying."""
    path = WORK / "versions.json"
    if refresh or not path.exists():
        versions: dict[str, int] = {}
        page = 1
        while True:
            data = json.loads(http_get(f"{SITE}/api/v1/signs?kind=all&per_page=200&page={page}", accept="application/json"))
            for item in data["items"]:
                versions[item["reference"]] = item["version"]
            if page * data["per_page"] >= data["total"]:
                break
            page += 1
            import time
            time.sleep(1.05)  # the API allows scripts one request per second
        path.write_text(json.dumps(versions), "utf-8")
    return json.loads(path.read_text("utf-8"))


DESIGN_LABELS = ["shape", "background_color", "border_color", "symbol_color", "band", "band_color", "prohibition_bar", "bar_continuity"]


@dataclass
class Unit:
    reference: str
    category: str          # e.g. "VIENNA-C", "OTHER-SD"
    loc: str               # "d0", "r1"…
    jur: str               # jurisdiction key, e.g. "france"
    country: str           # country code, e.g. "fr", "ca-on"
    code: str              # main national code, e.g. "fr:B14"
    codes: list[str]
    languages: list[str]
    labels: dict           # design labels (shape, colours…) of the design / related sign holding it
    sources: list[dict]
    data: dict = field(repr=False)

    @property
    def key(self) -> str:
        return f"{self.reference}|{self.loc}|{self.jur}"

    @property
    def letter(self) -> str:
        return self.category.split("-")[-1]

    @property
    def is_other(self) -> bool:
        return self.reference.startswith("OTHER:")


def units_of(entry: dict):
    designs = (entry.get("officialSign") or {}).get("designs") or []
    parts = [(f"d{i}", d) for i, d in enumerate(designs)] + [(f"r{i}", r) for i, r in enumerate(entry.get("relatedSigns") or [])]
    for loc, part in parts:
        labels = {k: part.get(k) for k in DESIGN_LABELS}
        for jur, j in (part.get("jurisdictions") or {}).items():
            langs = j.get("languages") or {}
            codes = list(dict.fromkeys(c for l in langs.values() for c in (l.get("codes") or [])))
            code = next((l.get("code") for l in langs.values() if l.get("code")), codes[0] if codes else "")
            yield Unit(entry["reference"], entry["category"], loc, jur, j.get("countryCode", ""), code, codes,
                       list(langs.keys()), labels, j.get("sources") or [], j)


def all_units(export: list[dict]) -> list[Unit]:
    return [u for e in export for u in units_of(e)]


def sort_key(reference: str) -> tuple:
    """Order of the site: VIENNA, VIENNA2006, OTHER; then the code with numbers compared as numbers."""
    prefix, _, rest = reference.partition(":")
    rank = {"VIENNA": 0, "VIENNA2006": 1, "OTHER": 2}.get(prefix, 9)
    return (rank, re.sub(r"\d+", lambda m: m.group(0).zfill(8), rest.lower()))


class ImageIndex:
    """Python version of the site's image index: road_sign_images/<country>/…/<CC>-<code>.<ext>."""

    def __init__(self, known_countries: set[str]):
        self.exact: dict[str, list[Path]] = {}
        self.loose: dict[str, list[Path]] = {}
        self.by_file: dict[str, list[Path]] = {}
        for path in sorted(IMAGES.rglob("*")):
            if path.suffix.lower() not in IMAGE_EXT or not path.is_file():
                continue
            m = re.match(r"^([A-Z]{2})-(.+)$", path.stem)
            if not m:
                continue
            cc, code = m.group(1).lower(), m.group(2)
            sub = re.match(r"^([A-Z]{2,3})-(.+)$", code)
            if sub and f"{cc}-{sub.group(1).lower()}" in known_countries:
                cc, code = f"{cc}-{sub.group(1).lower()}", sub.group(2)
            self.exact.setdefault(f"{cc}|{norm(code)}", []).append(path)
            for loose in {re.sub(r"_v\d+$", "", code), code.split("_")[0]}:
                if norm(loose) != norm(code):
                    self.loose.setdefault(f"{cc}|{norm(loose)}", []).append(path)
            self.by_file.setdefault(path.name, []).append(path)

    def lookup(self, national_code: str) -> list[Path]:
        cc, _, code = national_code.partition(":")
        for table in (self.exact, self.loose):
            for c in dict.fromkeys([cc, cc.split("-")[0]]):
                hit = table.get(f"{c}|{norm(code)}")
                if hit:
                    return hit
        return []

    def for_unit(self, unit: Unit) -> Path | None:
        for code in unit.codes or [unit.code]:
            hit = self.lookup(code)
            if hit:
                return hit[0]
        for src in unit.sources:  # the file named in the entry's sources
            hit = self.by_file.get(Path(src.get("file", "")).name)
            if hit:
                return hit[0]
        return None


def commons_filename(url: str | None) -> str | None:
    """'https://upload.wikimedia.org/wikipedia/commons/4/47/France_road_sign_B0.svg?…' -> 'France_road_sign_B0.svg'."""
    if not url or "upload.wikimedia.org" not in url:
        return None
    path = urllib.parse.urlparse(url).path
    if "/thumb/" in path:
        path = path.split("/thumb/", 1)[1].rsplit("/", 1)[0]
    return urllib.parse.unquote(path.rsplit("/", 1)[-1]).replace(" ", "_")


def load_florence() -> dict[str, dict]:
    """Florence-2 analysis of every picture (signs_by_country/<CC>.json), keyed by national code ("fr:b14" normalised)."""
    out: dict[str, dict] = {}
    for path in sorted(SIGNS_BY_COUNTRY.glob("*.json")):
        data = json.loads(path.read_text("utf-8"))
        for sign in data.get("signs") or []:
            tag = sign.get("osm_tag") or ""
            if ":" in tag:
                cc, code = tag.split(":", 1)
                out.setdefault(f"{cc.lower()}:{norm(code)}", sign)
    return out


def florence_for(unit: Unit, florence: dict[str, dict]) -> dict | None:
    for code in unit.codes or [unit.code]:
        cc, _, c = code.partition(":")
        hit = florence.get(f"{cc.split('-')[0]}:{norm(c)}") or florence.get(f"{cc}:{norm(c)}")
        if hit:
            return hit
    return None


def write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)
