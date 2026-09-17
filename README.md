<img src="panomatix_logo.svg" alt="Panomatix logo" width="200">

# Panomatix — international cross-reference database of road signs

Panomatix maps every road sign of the **Vienna Convention on Road Signs and Signals** to its national
equivalents, its rendering variants, its 2006 numbering and its OpenStreetMap tags. It is built from the
two official texts of the Convention and from a per-country catalogue of national sign codes, and it is
regenerated entirely by scripts, so that every fact can be traced back to a source.

```
VIENNA:C-14.1  Maximum speed limit
  ├─ 2006:     VIENNA:C,14
  ├─ designs:  circle / white / red border / black symbol   → fr:B14, de:274, be:C43, es:R-301 …
  │            circle / yellow / red border / black symbol  → fi:C32, se:C31
  └─ OSM:      traffic_sign=maxspeed · maxspeed=*
```

## Contents

| File | What it is |
|---|---|
| `full_database.json` | **The deliverable.** One entry per sign — 247 Vienna 2023 signs, 653 national signs, 12 Vienna 2006 signs dropped in 2023 — following `template.json`. |
| `template.json` | Two fully worked entries (`VIENNA:A-23.1`, `VIENNA:H-01.1`) showing the complete structure, including illustrative Swiss and MUTCD jurisdictions. |
| `comparison_2006-2023.json` | Intermediate product: the 2006 ↔ 2023 correspondence, with every rendering variant expressed as uniform labels. |
`full_database.json` was generated from it but the file itself needs to be restored before the pipeline can be re-run. |
| `pictures_of_road_signs/` | Source: sign images per country (27 folders; several — Croatia, Cyprus, Greece, Ireland, Italy, Luxembourg, Malta — are not covered by `road_signs_all.json`). |
| `Conv_road_signs_2006v_EN.pdf`, `ECE-TRANS-WP1-2023-2-Rev2e.pdf` | Sources: the 2006 consolidated Convention and the 2023 revision (ECE/TRANS/WP.1/2023/2/Rev.2). |
| `scripts/` | Build pipeline (see below). |

## Data model

An entry is identified by its **2023 Vienna number** (`VIENNA:A-23.1`). National-only signs use `OTHER:*`;
2006 signs without a 2023 successor use `VIENNA2006:*`.

```jsonc
{
  "reference": "VIENNA:A-23.1",
  "legacyReferences": ["VIENNA:A,25"],          // generic 2006 symbol number (union of the designs)
  "name": { "en": "…", "fr": "…", "de": "…" },
  "description": { "en": "…" },                  // 2023 text
  "symbolMayBeReversed": true,
  "officialSign": {
    "designs": [                                 // one entry per distinct rendering, no duplicates
      {
        "shape": "triangle", "background_color": "white", "border_color": "red", "symbol_color": "black",
        "band": "none", "prohibition_bar": null, "model": "one",
        "versions": ["2006", "2023"],            // which text(s) allow this rendering
        "legacyReferences": ["VIENNA:Aa,25"],    // model-specific 2006 number: Aa on triangles, Ab on diamonds
        "jurisdictions": {                       // the countries that use THIS design
          "germany": {
            "countryCode": "de",
            "languages": { "de": { "code": "de:151", "codes": ["de:151"], "text": "…", "description": null } },
            "parameters": { … },                 // numeric values found in the national declinations
            "additional": { "bottom": [ { "index": 1, "reference": ["de:1004-30"] } ] },
            "osm": { "traffic_sign": ["DE:151"] }
          }
        }
      }
    ],
    "additional": { "bottom": [ { "index": 1, "reference": ["VIENNA:H-01.1"] } ] }
  },
  "osm": { "traffic_sign_generic": "hazard", "implied_tags": { "railway": "level_crossing" } },
  "relatedSigns": [ … ]                          // other catalogue entries attached to this sign
}
```

A sign appears **once**; what varies between countries is which *design* they use, so national codes
hang off the design, not off the sign. Design labels are closed vocabularies (`shape`, `background_color`,
`border_color`, `symbol_color`, `band`, `band_color`, `prohibition_bar`, `bar_continuity`, `model`); the
list of values is in `comparison_2006-2023.json` → `labels`. Two labels deserve a word:

- **`band`** — the cancellation band of "end of …" signs: `single_band` (one oblique band, e.g. France)
  or `parallel_lines` (several parallel lines, e.g. Germany). Both texts allow both; the 2023 text
  states the parallel lines are *preferable*, and for `D-06.2` the 2006 text allowed the single bar only.
- **`prohibition_bar`** — the red oblique bar of "no entry for …" signs, which Contracting Parties may
  omit. It slopes the opposite way to a cancellation band.

Additional panels use a stacking **`index`** (1 = directly under the sign, 2 below it, …) and a list of
admissible `reference`s per slot, both at Convention level and per country. The slot is always present,
possibly empty, so that panels can be added.

## How it is built

```
scripts/build_comparison_variants.py   → comparison_2006-2023.json
scripts/build_full_database.py         → full_database.json, full_database.meta.json
scripts/translations.py                  English → French / German sign names
scripts/osm_tags.py                      OSM tags implied by each sign
scripts/2023_signs_extracted.json        Annex 1 of the 2023 PDF, parsed (id, heading, description)
scripts/comparison_v1.json               first-generation 2006 ↔ 2023 mapping (the source of the correspondence)
```

The 2006 ↔ 2023 correspondence was established sign by sign from the two texts — no official concordance
table exists.

> **Status:** `road_signs_all.json` is currently missing from the working tree. `full_database.json` in
> this folder is the last build made from it and stays valid to read, but `full_database.meta.json` was
> lost with it and `scripts/build_full_database.py` cannot be re-run until the source file is restored.

**What is derived and what is asserted.** Numbers, names, descriptions, models, colours, band and bar
rules come from the Convention texts. National codes come from `road_signs_all.json`. Three things are
*heuristics*, flagged as such in `full_database.meta.json`:

1. the attachment of a country to a design (yellow ground for SE, FI, PL; single band for FR, ES, PT;
   red bar kept for FR, BE, ES, PT; …) — `designAssignment`;
2. the OSM `traffic_sign` values, built as `<ISO prefix>:<national code>`; the format is verified
   against the OSM convention only for countries marked `high` — `countries.<cc>.osm_code_confidence`;
3. the French and German names, translated for this database; they are not official translations.

`wikidata` and `toBeAdded` are placeholders kept from the template.

## Name, licence, versioning

A reviewer made the point that three things should be settled at the earliest stage of a project like
this — a name, a licence and a versioning strategy. Here is where the project stands on each.

### Name

The project is called **Panomatix**. It is short, unique, pronounceable in the languages of the countries
covered, and it promises nothing that could become false — not "Europe", not "Vienna", not "2023".
Identifiers inside the data are deliberately *not* branded: a sign is `VIENNA:C-14.1`, a national code
is `de:274`, an OSM value is `DE:274`. Anyone can quote a Panomatix identifier without quoting Panomatix,
which is what a cross-reference database is for.

### Licence

The repository is dedicated to the public domain under **CC0 1.0 Universal**, see the `LICENSE` file.
This applies to everything in the repository that the project itself can license — data
(`full_database.json`, `comparison_2006-2023.json`, `template.json`) and scripts alike — with no
attribution requirement and no share-alike obligation, for any purpose including commercial use and
import into OpenStreetMap, Panoramax, or any other project.

**Sources** are the exception: the Convention texts are United Nations documents, and
`road_signs_all.json` and the pictures keep whatever licence they were obtained under. Neither is
relicensed here, and the origin and licence of the two source catalogues should be recorded before the
data is published.

### Versioning

Two version numbers travel with the data, in `full_database.meta.json`:

- **`schemaVersion`** (semantic versioning, currently `1.0.0`) describes the *shape* of the JSON.
  - *Patch*: documentation and legend changes only.
  - *Minor*: additive changes — a new optional field, a new label value, a new country. A consumer
    written for 1.x keeps working on any later 1.y; within a major, fields are never renamed or removed
    and label vocabularies only grow.
  - *Major*: anything else. Removing `designId`, moving `jurisdictions` under `designs` and adding the
    panel `index` were exactly this kind of change; they were made before 1.0 so that 1.0 does not carry
    them as debt.
- **`dataVersion`** (ISO date, currently `2026-09-17`) describes the *content*. It changes whenever a
  sign, a code or a mapping is added or corrected, with no compatibility promise beyond the schema.

Two conventions follow. The top-level container is a flat array, to match the original template; moving
the version numbers inline, in a wrapper object, would be a 2.0 change and is the first candidate for
it. And identifiers are stable: a `VIENNA:*` reference is never reassigned to a different sign; if the
Convention renumbers again, the current numbers move to `legacyReferences` exactly as the 2006 numbers did.
