# Reclassification of the OTHER signs

The 17,763 national signs with no Vienna equivalent (`OTHER:…`) were grouped automatically and are messy: the
same sign of several countries sits on several OTHER pages, some are in the wrong category, and some are in
fact Convention signs (often additional panels, category H). Their national descriptions are also empty.

This tool proposes the fixes; the server applies them as ordinary, versioned edits.

| Step | Where | What |
|---|---|---|
| `texts.py` | CPU, network | Official name of each national sign in its language(s) and English: captions of the national catalogues on Wikipedia / the OSM wiki (`road_sign_images/images_links.json`, `data_to_help/`), then the multilingual descriptions on Wikimedia Commons. Nothing invented or machine-translated. |
| `embed.py` | **GPU** | Visual fingerprint of every picture (DINOv2) and of the official Convention drawings. |
| `propose.py` | CPU/GPU | `merge` (same sign on two OTHER pages → into the **lowest number**, the reference for classification), `attach` (OTHER that is a Convention sign → into it), `describe` (empty description fields). |
| `review.py` | CPU | `review.html`: every proposal with the pictures side by side, a checkbox each. |
| `npm run apply-changeset` | server | Applies the automatic proposals, or those ticked in the review page. |

**Automatic only when certain**: near-identical fingerprints **and** Florence-2 (`signs_by_country/`) agrees on
shape, colours and the text read on the sign **and** the two pictures overlap pixel for pixel (not mirrored)
**and** they come from different countries (one country never uses two codes for one sign). Text Florence-2
cannot read (another script) is never taken as equal. Everything else goes to review; signs whose readable texts
clearly differ ("100 m" / "200 m") are not even proposed.

**Safe to apply**: the proposals are made against the live database (`/api/v1/export`) and carry each sign's
version; a sign edited on the site since is left alone. A national sign landing where its country already has
one is merged into it (codes, OSM tags, sources). An OTHER sign left with no country is deleted (restorable),
its reference kept in the target's `legacyReferences`. Descriptions only fill empty fields.

## On RunPod

A pod with the PyTorch image and any RTX card (8 GB is plenty):

```sh
apt-get update && apt-get install -y libcairo2          # SVG rendering
git clone --depth 1 https://github.com/tes-maker/panomatix.git && cd panomatix
pip install -r tools/reclassify/requirements.txt
sh tools/reclassify/run.sh                               # ≈ 30–60 min, mostly texts (polite to Wikimedia)
```

The repository's `signs_by_country/` (Florence-2 analysis) must be there: commit it, or copy it to the pod
(`scp -r signs_by_country root@<pod>:panomatix/`). Then copy the results back:

```sh
scp root@<pod>:panomatix/tools/reclassify/work/{changeset.json,review.html} .
```

Thresholds: `python propose.py --auto 0.975 --review 0.92 --attach-auto 0.95` (similarities, 0–1).

## Review and apply

1. Open `review.html` in a browser: automatic proposals are ticked, the others not. Tick / untick, then
   **Download approved.json**.
2. On the server (dry run first, then for real):

```sh
scp changeset.json approved.json root@<server>:/tmp/
ssh root@<server> 'cd /opt/panomatix/website && runuser -u panomatix -- /opt/node-24/bin/node server/cli.js apply-changeset /tmp/changeset.json --approved=/tmp/approved.json --dry-run'
ssh root@<server> 'cd /opt/panomatix/website && runuser -u panomatix -- /opt/node-24/bin/node server/cli.js apply-changeset /tmp/changeset.json --approved=/tmp/approved.json'
```

Without `--approved`, only the automatic proposals are applied. Every change is in the history of the signs
and can be reverted there.
