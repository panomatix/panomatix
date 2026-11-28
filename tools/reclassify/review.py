"""Step 4 — review page (CPU).

work/review.html: every merge / attach with the pictures side by side (what moves → where it goes), a
checkbox each (the automatic ones ticked, the others not), filters, and a button that downloads
approved.json (the ticked proposals + all descriptions) for the server: npm run apply-changeset.
Open it in a browser; it needs no network (pictures are embedded).
"""
from __future__ import annotations

import base64
import html
import io
import json
import re

from common import VIENNA_IMAGES, WORK, ImageIndex, all_units, load_export
from embed import picture_path, rasterize

THUMB = 88


def data_uri(path) -> str | None:
    img = rasterize(path) if path else None
    if img is None:
        return None
    buf = io.BytesIO()
    img.resize((THUMB, THUMB)).save(buf, "WEBP", quality=70)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


def main() -> None:
    changeset = json.loads((WORK / "changeset.json").read_text("utf-8"))
    export = load_export()
    units = all_units(export)
    index = ImageIndex({u.country for u in units})
    by_ref: dict[str, list] = {}
    for u in units:
        by_ref.setdefault(u.reference, []).append(u)
    official = {}
    for path in sorted(VIENNA_IMAGES.rglob("*.svg")):
        m = re.match(r"([A-H]-\d{2}\.\d+)", path.name)
        if m:
            official.setdefault(f"VIENNA:{m.group(1)}", path)
    cache: dict[str, str | None] = {}

    def pic_unit(u):
        if u.key not in cache:
            cache[u.key] = data_uri(picture_path(u, index))
        return cache[u.key]

    def figure(src, caption):
        img = f'<img src="{src}" alt="">' if src else '<span class="noimg">no picture</span>'
        return f'<figure>{img}<figcaption>{html.escape(caption)}</figcaption></figure>'

    def side(ref, codes=None, limit=4):
        figs = []
        if ref in official:
            figs.append(figure(data_uri(official[ref]), "official model"))
        for u in by_ref.get(ref, [])[:limit]:
            if codes is None or u.code in codes:
                figs.append(figure(pic_unit(u), u.code))
        return "".join(figs) or '<span class="noimg">—</span>'

    rows = []
    moves = [op for op in changeset["ops"] if op["type"] in ("merge", "attach")]
    moves.sort(key=lambda op: (op["auto"] is False, op["type"], -op["confidence"]))
    for op in moves:
        codes = {u["code"] for u in op["units"]}
        checked = " checked" if op["auto"] else ""
        rows.append(
            f'<tr class="{op["type"]} {"auto" if op["auto"] else "review"}">'
            f'<td><input type="checkbox" value="{op["id"]}"{checked}></td>'
            f'<td><b>{op["type"]}</b><br><span class="badge {"auto" if op["auto"] else "review"}">{"automatic" if op["auto"] else "to review"}</span>'
            f'<br><small>similarity {op["confidence"]:.3f}</small></td>'
            f'<td><a href="{changeset["site"]}/#/sign/{op["from"]}" target="_blank">{op["from"]}</a><div class="pics">{side(op["from"], codes)}</div></td>'
            f'<td class="arrow">→</td>'
            f'<td><a href="{changeset["site"]}/#/sign/{op["into"]}" target="_blank">{op["into"]}</a><div class="pics">{side(op["into"])}</div></td>'
            f'<td class="why">{html.escape(op["reason"])}</td></tr>')
    describes = [op["id"] for op in changeset["ops"] if op["type"] == "describe"]
    n_desc = sum(len(op["items"]) for op in changeset["ops"] if op["type"] == "describe")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Panomatix — review of the reclassification</title>
<style>
body{{font:14px/1.4 system-ui,sans-serif;margin:0;color:#1d2a35}} header{{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:2}}
h1{{font-size:18px;margin:0}} table{{border-collapse:collapse;width:100%}} td{{border-bottom:1px solid #eee;padding:8px;vertical-align:top}}
.pics{{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}} figure{{margin:0;text-align:center;width:{THUMB}px}} figure img{{width:{THUMB}px;height:{THUMB}px;background:#f4f6f8;border-radius:4px}}
figcaption{{font-size:11px;word-break:break-all;color:#555}} .arrow{{font-size:22px;color:#009edb;vertical-align:middle}} .why{{max-width:320px;color:#444}}
.badge{{font-size:11px;padding:1px 6px;border-radius:9px}} .badge.auto{{background:#dff3e4;color:#17643a}} .badge.review{{background:#fff0d9;color:#8a5300}}
.noimg{{color:#999;font-size:12px}} button{{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #009edb;background:#009edb;color:#fff;cursor:pointer}}
button.secondary{{background:#fff;color:#009edb}} tr.hidden{{display:none}} a{{color:#00739f}}
</style></head><body>
<header><h1>Reclassification of the OTHER signs</h1>
<span id="count"></span>
<label><input type="checkbox" id="showAuto" checked> automatic</label>
<label><input type="checkbox" id="showReview" checked> to review</label>
<label><input type="checkbox" id="showMerge" checked> merges</label>
<label><input type="checkbox" id="showAttach" checked> attaches to the Convention</label>
<button class="secondary" id="none">untick shown</button><button class="secondary" id="all">tick shown</button>
<button id="save">Download approved.json</button>
<span>{n_desc} national descriptions to fill (always applied, empty fields only)</span></header>
<table><tbody>{''.join(rows)}</tbody></table>
<script>
const boxes=[...document.querySelectorAll('tbody input')];
const count=()=>document.getElementById('count').textContent=boxes.filter(b=>b.checked).length+' / '+boxes.length+' ticked';
boxes.forEach(b=>b.addEventListener('change',count));count();
const filt=()=>document.querySelectorAll('tbody tr').forEach(tr=>{{const c=tr.classList;
 tr.classList.toggle('hidden',!((c.contains('auto')?showAuto.checked:showReview.checked)&&(c.contains('merge')?showMerge.checked:showAttach.checked)));}});
['showAuto','showReview','showMerge','showAttach'].forEach(id=>document.getElementById(id).addEventListener('change',filt));
const shown=()=>boxes.filter(b=>!b.closest('tr').classList.contains('hidden'));
document.getElementById('none').onclick=()=>{{shown().forEach(b=>b.checked=false);count();}};
document.getElementById('all').onclick=()=>{{shown().forEach(b=>b.checked=true);count();}};
document.getElementById('save').onclick=()=>{{const ids=boxes.filter(b=>b.checked).map(b=>b.value).concat({json.dumps(describes)});
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({{approved:ids}},null,1)],{{type:'application/json'}}));a.download='approved.json';a.click();}};
</script></body></html>"""
    (WORK / "review.html").write_text(page, "utf-8")
    print(f"{len(moves)} proposals ({sum(op['auto'] for op in moves)} automatic) → work/review.html")


if __name__ == "__main__":
    main()
