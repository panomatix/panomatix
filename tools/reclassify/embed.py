"""Step 2 — visual fingerprints (GPU).

Every national sign picture and every official Convention drawing is drawn on white, padded to a square and
turned into a vector by a vision model (DINOv2 by default: made for finding near-identical images). Two
copies of the same sign give two almost identical vectors (cosine similarity close to 1).

Pictures missing from road_sign_images/ (e.g. fetched by the server since) are downloaded from their
Wikimedia Commons link.

Output: work/embeddings.npz  — keys (unit keys, or "VIENNA|<file>") and unit-length float16 vectors.

    python embed.py --model facebook/dinov2-base --batch 128
"""
from __future__ import annotations

import argparse
import io
import re
import sys
import urllib.parse
from pathlib import Path

import numpy as np
from PIL import Image

from common import VIENNA_IMAGES, WORK, ImageIndex, all_units, commons_filename, http_get, load_export

DOWNLOADS = WORK / "downloads"
DOWNLOADS.mkdir(parents=True, exist_ok=True)
SIZE = 224


def inline_entities(raw: bytes) -> bytes:
    """Adobe Illustrator SVGs declare internal entities (<!ENTITY ns_svg "http://…">) that the renderer refuses
    for safety: replace each &name; by its declared text and drop the DOCTYPE (external entities are ignored)."""
    if b"<!ENTITY" not in raw:
        return raw
    text = raw.decode("utf-8", "replace")
    entities = dict(re.findall(r'<!ENTITY\s+(\w+)\s+"([^"]*)"\s*>', text))
    text = re.sub(r"<!DOCTYPE[^\[>]*(\[.*?\])?\s*>", "", text, count=1, flags=re.S)
    for name, value in entities.items():
        text = text.replace(f"&{name};", value)
    return text.encode("utf-8")


def rasterize(path: Path) -> Image.Image | None:
    """Any picture -> RGB, drawn on white, padded to a square SIZE × SIZE."""
    try:
        raw = path.read_bytes()
        if raw.lstrip()[:1] == b"<":  # SVG (recognised by its content: downloaded files carry no extension)
            import cairosvg
            raw = inline_entities(raw)
            png = cairosvg.svg2png(bytestring=raw, output_width=SIZE * 2, unsafe=False)
            img = Image.open(io.BytesIO(png))
        else:
            img = Image.open(io.BytesIO(raw))
            img.seek(0)
        img = img.convert("RGBA")
    except Exception as err:  # noqa: BLE001 — a broken picture is skipped, not fatal
        print(f"  ! {path.name}: {err}", file=sys.stderr)
        return None
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.alpha_composite(img)
    img = bg.convert("RGB")
    bbox = Image.eval(img, lambda v: 255 - v).getbbox()  # trim white margins: the sign fills the frame
    if bbox:
        img = img.crop(bbox)
    side = max(img.size)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return square.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def thumb_url(url: str) -> str | None:
    """Commons' cached 256 px rendering of a file (enough for a 224 px fingerprint, much faster than the original)."""
    m = re.match(r"^https://upload\.wikimedia\.org/wikipedia/commons/([0-9a-f])/([0-9a-f]{2})/([^/?]+)", url)
    if not m:
        return None
    name = m.group(3)
    suffix = ".png" if name.lower().endswith(".svg") else ""
    return f"https://upload.wikimedia.org/wikipedia/commons/thumb/{m.group(1)}/{m.group(2)}/{name}/256px-{name}{suffix}"


def download(url: str) -> Path | None:
    name = commons_filename(url)
    if not name:
        return None
    target = DOWNLOADS / (urllib.parse.quote(name, safe="._-()") + ".thumb")
    if target.exists():
        return target if target.stat().st_size else None
    for candidate in (thumb_url(url), url.split("?")[0]):  # the original when no thumbnail exists (tiny files)
        if not candidate:
            continue
        try:
            target.write_bytes(http_get(candidate))
            return target
        except Exception:  # noqa: BLE001
            continue
    target.write_bytes(b"")  # remembered as unavailable
    print(f"  ! download {name}", file=sys.stderr)
    return None


def picture_path(unit, index) -> Path | None:
    """The picture of a national sign: in road_sign_images/, else its Commons thumbnail (downloaded once)."""
    path = index.for_unit(unit)
    if path is None:
        url = next((s.get("url") for s in unit.sources if commons_filename(s.get("url"))), None)
        path = download(url) if url else None
    return path


def pictures(limit: int = 0, only: str = "") -> list[tuple[str, Path]]:
    export = load_export()
    units = all_units(export)
    if only:  # e.g. "OTHER:H,VIENNA:H": references starting with one of these
        prefixes = tuple(p.strip() for p in only.split(",") if p.strip())
        units = [u for u in units if u.reference.startswith(prefixes)]
    index = ImageIndex({u.country for u in units})
    # pictures not in road_sign_images/: fetched first, 4 at a time (Commons thumbnails are served from cache)
    todo = [u for u in units if index.for_unit(u) is None]
    urls = {u.key: next((s.get("url") for s in u.sources if commons_filename(s.get("url"))), None) for u in todo}
    if limit:
        todo = todo[:limit]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(4) as pool:
        fetched = dict(zip([u.key for u in todo], pool.map(lambda u: download(urls[u.key]) if urls[u.key] else None, todo)))
    out, missing = [], 0
    for u in units:
        if limit and len(out) >= limit:
            break
        path = index.for_unit(u) or fetched.get(u.key)
        if path is None:
            missing += 1
            continue
        out.append((u.key, path))
    for path in sorted(VIENNA_IMAGES.rglob("*.svg")):
        if limit and len(out) >= limit + 50:
            break
        out.append((f"VIENNA|{path.relative_to(VIENNA_IMAGES)}", path))
    print(f"{len(out)} pictures ({missing} national signs have none, even on Commons)")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="facebook/dinov2-base")
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--limit", type=int, default=0, help="only the first N pictures (to try it out)")
    ap.add_argument("--only", default="", help='only these references, e.g. "OTHER:H,VIENNA:H" (to try it out)')
    args = ap.parse_args()

    import torch
    from transformers import AutoImageProcessor, AutoModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    print(f"Model {args.model} on {device}")
    processor = AutoImageProcessor.from_pretrained(args.model)
    model = AutoModel.from_pretrained(args.model, torch_dtype=dtype).to(device).eval()

    items = pictures(args.limit, args.only)
    keys, vectors = [], []
    for start in range(0, len(items), args.batch):
        chunk = [(k, rasterize(p)) for k, p in items[start:start + args.batch]]
        chunk = [(k, im) for k, im in chunk if im is not None]
        if not chunk:
            continue
        inputs = processor(images=[im for _, im in chunk], return_tensors="pt").to(device)
        with torch.no_grad():
            out = model(pixel_values=inputs["pixel_values"].to(dtype))
            # CLS token + mean of the patch tokens: robust to small drawing differences
            hidden = out.last_hidden_state
            vec = torch.cat([hidden[:, 0], hidden[:, 1:].mean(dim=1)], dim=1).float()
            vec = torch.nn.functional.normalize(vec, dim=1)
        keys += [k for k, _ in chunk]
        vectors.append(vec.cpu().numpy().astype(np.float16))
        print(f"  {min(start + args.batch, len(items))}/{len(items)}", flush=True)
    np.savez_compressed(WORK / "embeddings.npz", keys=np.array(keys), vectors=np.concatenate(vectors))
    print(f"{len(keys)} fingerprints → work/embeddings.npz")


if __name__ == "__main__":
    main()
