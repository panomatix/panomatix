"""Step 3 — proposals (CPU; uses the GPU through torch when present for the similarity search).

From the live database, the visual fingerprints (embed.py), the Florence-2 analysis (signs_by_country/)
and the official texts (texts.py), write work/changeset.json:

  merge     an OTHER sign that shows the same sign as another OTHER: its national signs move to the OTHER
            with the lowest number (the reference for classification), into the design with the same labels;
  attach    an OTHER sign that is in fact a Convention sign (often an additional panel, category H): its
            national signs move to that Convention sign, into the design with the same labels;
  describe  empty description fields filled with the official national texts (original language + English).

Every merge/attach carries a confidence and "auto": true only when the pictures are almost identical AND
Florence-2 agrees (shape, colours, text read on the sign, category). The rest waits for review (review.py).

    python propose.py [--auto 0.975] [--review 0.92]
"""
from __future__ import annotations

import argparse
import difflib
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

import numpy as np

from common import (SITE, WORK, Unit, all_units, florence_for, load_export, load_florence, load_versions, sort_key,
                    write_json)

LETTERS_OK = {"SD"}  # an unclassified sign may join any category


# --- what Florence-2 and the data say about a national sign ---------------------------------------------

def signature(u: Unit, fl: dict | None) -> dict:
    labels = (fl or {}).get("labels") or {}
    colors = labels.get("colors") or {}
    measured = colors.get("measured") or {}
    shape = u.labels.get("shape") or labels.get("shape")
    bg = u.labels.get("background_color") or colors.get("background") or measured.get("background")
    border = u.labels.get("border_color") or colors.get("border") or measured.get("border")
    ocr = ((fl or {}).get("description") or {}).get("ai_ocr") or ""
    text = re.sub(r"[^0-9A-Z]", "", ocr.upper())
    tags = set((fl or {}).get("tags") or [])
    has_text = "has_text" in tags or "element:text" in tags
    non_latin = any(t.startswith("script:") and t != "script:latin" for t in tags)
    return {
        "shape": (shape or "").replace("-", "_") or None,
        "bg": bg or None,
        "border": border if border not in (None, "none") else None,
        "text": text,
        "pictograms": tuple(sorted(labels.get("pictograms") or [])),
        "function": ((labels.get("function") or {}).get("vienna_category")),
        # text on the sign that Florence-2 could not read (another script, or nothing read): it cannot vouch for it
        "text_unreadable": bool(fl) and has_text and (non_latin or not text),
    }


def same_text(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def compatible(sa: dict, sb: dict, *, strict: bool) -> tuple[bool, list[str]]:
    """Do two national signs agree on what Florence-2 / the data say? Returns (ok, reasons against)."""
    against = []
    for k in ("shape", "bg", "border"):
        if sa[k] and sb[k] and sa[k] != sb[k]:
            against.append(f"{k}: {sa[k]} ≠ {sb[k]}")
        elif strict and (not sa[k] or not sb[k]):
            against.append(f"{k} unknown")
    if strict and (sa["text_unreadable"] or sb["text_unreadable"]):
        against.append("text on the sign not readable by Florence-2")
    elif same_text(sa["text"], sb["text"]) < (0.8 if strict else 0.5):
        against.append(f"text: {sa['text'] or '∅'} ≠ {sb['text'] or '∅'}")
    if strict and sa["pictograms"] and sb["pictograms"] and sa["pictograms"] != sb["pictograms"]:
        against.append("pictograms differ")
    return not against, against


def norm_code(code: str) -> str:
    cc, _, c = code.partition(":")
    return f"{cc}:{re.sub(r'[^a-z0-9]', '', c.lower())}"


def letters_ok(a: str, b: str) -> bool:
    return a == b or a in LETTERS_OK or b in LETTERS_OK


# --- similarity search ------------------------------------------------------------------------------

def load_vectors():
    data = np.load(WORK / "embeddings.npz")
    keys = [str(k) for k in data["keys"]]
    return keys, data["vectors"].astype(np.float32)


def top_k(queries: np.ndarray, base: np.ndarray, k: int, chunk: int = 2048):
    """For each query row: the k most similar base rows (indexes, similarities). Torch on GPU when present."""
    if not len(queries) or not len(base):
        return np.zeros((len(queries), 0), dtype=int), np.zeros((len(queries), 0), dtype=np.float32)
    try:
        import torch
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        b = torch.from_numpy(base).to(dev)
        idx, sim = [], []
        for s in range(0, len(queries), chunk):
            q = torch.from_numpy(queries[s:s + chunk]).to(dev)
            v, i = torch.topk(q @ b.T, min(k, len(base)), dim=1)
            idx.append(i.cpu().numpy())
            sim.append(v.cpu().numpy())
        return np.concatenate(idx), np.concatenate(sim)
    except ImportError:
        idx, sim = [], []
        for s in range(0, len(queries), chunk):
            m = queries[s:s + chunk] @ base.T
            i = np.argsort(-m, axis=1)[:, :k]
            idx.append(i)
            sim.append(np.take_along_axis(m, i, axis=1))
        return np.concatenate(idx), np.concatenate(sim)


# --- pixel check: same drawing, not mirrored ------------------------------------------------------------

class Pixels:
    """Small renderings of the national sign pictures, to confirm that two pictures really are the same
    drawing (an arrow to the left and one to the right have close fingerprints)."""

    def __init__(self, units):
        from embed import picture_path, rasterize  # noqa: PLC0415
        from common import ImageIndex  # noqa: PLC0415
        self.rasterize, self.picture_path = rasterize, picture_path
        self.index = ImageIndex({u.country for u in units})
        self.cache: dict[str, np.ndarray | None] = {}

    def get(self, u: Unit):
        if u.key not in self.cache:
            path = self.picture_path(u, self.index)
            img = self.rasterize(path) if path else None
            self.cache[u.key] = None if img is None else np.asarray(img.resize((64, 64)), dtype=np.float32) / 255
        return self.cache[u.key]

    def same_drawing(self, a: Unit, b: Unit, tol: float = 0.05) -> tuple[bool, str]:
        pa, pb = self.get(a), self.get(b)
        if pa is None or pb is None:
            return False, "picture missing"
        diff = float(np.abs(pa - pb).mean())
        flipped = float(np.abs(pa - pb[:, ::-1]).mean())
        if flipped + 0.01 < diff:
            return False, "mirrored drawing"
        return diff <= tol, f"pixel difference {diff:.3f}"


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb, key=sort_key)] = min(ra, rb, key=sort_key)


def unit_ref(u: Unit) -> dict:
    return {"reference": u.reference, "loc": u.loc, "jur": u.jur, "country": u.country, "code": u.code, "codes": u.codes}


def design_for(entry: dict, labels: dict) -> int | None:
    """Index of the design of `entry` carrying the same shape and colours, if any."""
    keys = ("shape", "background_color", "border_color")
    for i, d in enumerate(entry["officialSign"]["designs"]):
        if all((d.get(k) or None) == (labels.get(k) or None) for k in keys):
            return i
    return None


# --- proposals ----------------------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--auto", type=float, default=0.975, help="similarity above which a merge with full agreement is automatic")
    ap.add_argument("--review", type=float, default=0.92, help="similarity above which a pair is proposed for review")
    ap.add_argument("--attach-auto", type=float, default=0.95)
    args = ap.parse_args()

    export = load_export()
    entries = {e["reference"]: e for e in export}
    versions = load_versions()
    units = all_units(export)
    florence = load_florence()
    sig = {u.key: signature(u, florence_for(u, florence)) for u in units}
    keys, vectors = load_vectors()
    pos = {k: i for i, k in enumerate(keys)}
    by_key = {u.key: u for u in units}
    ops: list[dict] = []

    # 1. duplicates among OTHER signs ------------------------------------------------------------------
    pixels = Pixels(units)
    others = [u for u in units if u.is_other and u.key in pos]
    o_vec = vectors[[pos[u.key] for u in others]]
    idx, sim = top_k(o_vec, o_vec, 16)
    auto_uf, review_pairs = UnionFind(), []
    for i, u in enumerate(others):
        for j, s in zip(idx[i], sim[i]):
            v = others[j]
            if v.reference == u.reference or s < args.review or u.key >= v.key:
                continue
            if not letters_ok(u.letter, v.letter):
                continue
            ok, against = compatible(sig[u.key], sig[v.key], strict=True)
            # one country never uses two codes for the same sign: two codes of a country are two signs
            same_country_other_code = u.country == v.country and not ({norm_code(c) for c in u.codes} & {norm_code(c) for c in v.codes})
            if s >= args.auto and ok and not same_country_other_code:
                same, why = pixels.same_drawing(u, v)
                if same:
                    auto_uf.union(u.reference, v.reference)
                    continue
                against.append(why)
            # clearly different readable texts ("100 m" / "200 m"): different signs, not even worth a look
            ta, tb = sig[u.key], sig[v.key]
            if not ta["text_unreadable"] and not tb["text_unreadable"] and (ta["text"] or tb["text"]) and same_text(ta["text"], tb["text"]) < 0.5:
                continue
            if same_country_other_code:
                same, why = pixels.same_drawing(u, v, tol=0.02)  # only a copy of the very same picture is worth a look
                if not same:
                    continue
                against.append(f"same country, codes {u.code} / {v.code}")
            loose_ok, _ = compatible(ta, tb, strict=False)
            if loose_ok or s >= args.auto:
                review_pairs.append((u, v, float(s), against))

    groups = defaultdict(set)
    for ref in list(auto_uf.parent):
        groups[auto_uf.find(ref)].add(ref)
    for target, refs in groups.items():
        for ref in sorted(refs - {target}, key=sort_key):
            moved = [u for u in units if u.reference == ref]
            ops.append({
                "type": "merge", "auto": True, "confidence": 1.0, "from": ref, "into": target,
                "reason": "same picture (near-identical fingerprint) and Florence-2 agrees on shape, colours and text",
                "units": [{**unit_ref(u), "design": design_for(entries[target], u.labels), "labels": u.labels} for u in moved],
            })
    auto_refs = {r for refs in groups.values() for r in refs}
    seen = set()
    for u, v, s, against in sorted(review_pairs, key=lambda p: -p[2]):
        a, b = sorted((u.reference, v.reference), key=sort_key)
        if (a, b) in seen or (a in auto_refs and b in auto_refs and auto_uf.find(a) == auto_uf.find(b)):
            continue
        seen.add((a, b))
        moved = [w for w in units if w.reference == b]
        ops.append({
            "type": "merge", "auto": False, "confidence": round(s, 4), "from": b, "into": a,
            "reason": "similar pictures" + (f"; to check: {', '.join(against)}" if against else ""),
            "units": [{**unit_ref(w), "design": design_for(entries[a], w.labels), "labels": w.labels} for w in moved],
        })

    # 2. OTHER signs that are Convention signs ----------------------------------------------------------
    vienna_units = [u for u in units if not u.is_other and u.key in pos and u.loc.startswith("d")]
    official = [(k, k.split("|", 1)[1]) for k in keys if k.startswith("VIENNA|")]
    base_keys = [u.key for u in vienna_units] + [k for k, _ in official]
    base_ref = [u.reference for u in vienna_units] + [f"VIENNA:{re.match(r'.*/([A-H]-\d{2}\.\d+)', '/' + f).group(1)}" for _, f in official]
    base = vectors[[pos[k] for k in base_keys]]
    merged_away = {op["from"] for op in ops if op["type"] == "merge" and op["auto"]}
    candidates = [u for u in others if u.reference not in merged_away]
    if candidates and len(base):
        q = vectors[[pos[u.key] for u in candidates]]
        nidx, nsim = top_k(q, base, 10)
        per_sign = defaultdict(list)
        for i, u in enumerate(candidates):
            votes = Counter(base_ref[j] for j in nidx[i])
            if not votes:
                continue
            best, n = votes.most_common(1)[0]
            sims = [float(s) for j, s in zip(nidx[i], nsim[i]) if base_ref[j] == best]
            per_sign[u.reference].append((u, best, n / len(nidx[i]), float(np.mean(sims))))
        for ref, rows in per_sign.items():
            bests = Counter(b for _, b, _, _ in rows)
            target, _ = bests.most_common(1)[0]
            rows = [r for r in rows if r[1] == target]
            share = float(np.mean([r[2] for r in rows]))
            score = float(np.mean([r[3] for r in rows]))
            if score < args.review or share < 0.5:
                continue
            t_entry = entries.get(target)
            if not t_entry:
                continue
            src_letter = entries[ref]["category"].split("-")[-1]
            dst_letter = t_entry["category"].split("-")[-1]
            dests = [design_for(t_entry, u.labels) for u, *_ in rows]
            vienna_sig = [sig[w.key] for w in vienna_units if w.reference == target]
            agree = all(any(compatible(sig[u.key], vs, strict=False)[0] for vs in vienna_sig) for u, *_ in rows) if vienna_sig else False
            auto = (score >= args.attach_auto and share >= 0.7 and letters_ok(src_letter, dst_letter)
                    and None not in dests and agree and bests[target] == len(per_sign[ref]))
            ops.append({
                "type": "attach", "auto": auto, "confidence": round(score, 4), "share": round(share, 3), "from": ref, "into": target,
                "reason": f"{round(share * 100)}% of its nearest pictures are {target}"
                          + ("" if letters_ok(src_letter, dst_letter) else f"; category {src_letter} → {dst_letter} to check")
                          + ("" if None not in dests else "; no design of the same shape and colours: to place by hand"),
                "units": [{**unit_ref(u), "design": design_for(t_entry, u.labels), "labels": u.labels} for u, *_ in rows],
            })

    # 3. official descriptions --------------------------------------------------------------------------
    texts_path = WORK / "texts.json"
    texts = {} if not texts_path.exists() else __import__("json").loads(texts_path.read_text("utf-8"))
    describe = defaultdict(list)
    for key, t in texts.items():
        u = by_key.get(key)
        if not u:
            continue
        native = {lang: txt for lang, txt in t["native"].items() if not (u.data["languages"].get(lang) or {}).get("description")}
        en = t.get("en") if not (u.data.get("description") or {}).get("en") else None
        if native or en:
            describe[u.reference].append({"code": u.code, "country": u.country, "native": native, "en": en})
    for ref, items in describe.items():
        ops.append({"type": "describe", "auto": True, "confidence": 1.0, "reference": ref, "items": items,
                    "reason": "official national texts (Wikipedia catalogues / Wikimedia Commons), empty fields only"})

    for n, op in enumerate(ops, 1):
        op["id"] = f"{op['type'][0]}{n:05d}"
    changeset = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "site": SITE,
        "versions": {ref: versions.get(ref) for ref in {r for op in ops for r in (op.get("from"), op.get("into"), op.get("reference")) if r}},
        "ops": ops,
    }
    write_json(WORK / "changeset.json", changeset)
    kinds = Counter((op["type"], op["auto"]) for op in ops)
    print("Proposals → work/changeset.json")
    for (kind, auto), n in sorted(kinds.items()):
        print(f"  {kind:8} {'auto  ' if auto else 'review'} {n}")


if __name__ == "__main__":
    main()
