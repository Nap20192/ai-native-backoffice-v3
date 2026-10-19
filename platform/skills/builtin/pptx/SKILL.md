---
name: pptx
description: Read, edit, fill templates and check .pptx decks with python-pptx; render slides and convert to PDF with LibreOffice.
display_title: PowerPoint (pptx)
version: 1.2.0
author: Nous Research
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [pptx, powerpoint, presentations, slides, office, python-pptx]
    category: productivity
    related_skills: [docx, xlsx, pdf]
---

# Powerpoint Skill

Inspect, edit and check PowerPoint (.pptx) presentations with python-pptx.
The helper scripts read a deck back as JSON, edit it in place, fill a
brand template, and render slides to PNG through LibreOffice.

## Platform notes (OpenMA)

- This skill is mounted at `/workspace/.openma/skills/pptx/latest/pptx/`. Run helpers by full path, for example
  `python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/<script>.py --help`.
- These paths are for an agent that takes the latest version. If the agent
  pins a version, the skill is at `/workspace/.openma/skills/pptx/<version>/pptx/`,
  the folder of this SKILL.md. Use that folder in place of
  `/workspace/.openma/skills/pptx/latest/pptx/` in every command.
- Save every file the user should receive directly in `/mnt/session/outputs/`.
  Do not create subfolders there: the session file list shows top-level files
  only. Keep JSON specs, drafts and renders in `/workspace/`.
- Tools: write specs with `write`, read files with `read` (it also shows PNG
  images), run commands with `bash`.
- Programs. The environment image "Рабочее место с LibreOffice" has python-pptx,
  LibreOffice (`soffice`) and poppler (`pdftoppm`, `pdftotext`).
  Check with `command -v soffice` and `python3 -c "import pptx"`.
- If `command -v soffice` prints nothing or the import fails, tell the user to pick the image
  "Рабочее место с LibreOffice" on the environment card and start a new session.
  Do not install LibreOffice with apt-get: it is too large for the sandbox.
  Until then read and edit the deck and check it with `pptx_read.py --outline`.

## When to Use

- You need to extract text, notes, tables, chart data, or images from a
  .pptx someone shared.
- You need to update an existing deck: replace text, refresh or patch
  chart data, swap a logo, duplicate/remove/reorder slides, set
  backgrounds, footers, hyperlinks, or speaker notes.
- You must produce an on-brand deck from a company .pptx template.
- You need to see the slides as images or export the deck to PDF.
- Do NOT use this for .ppt (legacy binary) files. Convert them first with
  `timeout 180 soffice --headless --convert-to pptx --outdir /workspace/ old.ppt`.

## How to Run

All scripts live in `scripts/`, take `--help`, print JSON to stdout, and
exit non-zero on failure. Run them with `bash`:

```bash
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_read.py deck.pptx --outline      # full JSON outline
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_read.py deck.pptx --notes        # speaker notes
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_read.py deck.pptx --images ./img # export pictures
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_edit.py deck.pptx --replace-text "Old Corp" "New Corp"
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_edit.py deck.pptx --chart-data update.json
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_edit.py deck.pptx --duplicate-slide 2
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_edit.py deck.pptx --remove-slide 3 --move-slide 2 0
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_from_template.py brand.pptx /mnt/session/outputs/out.pptx --values vals.json
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_render.py deck.pptx --outdir /workspace/render  # slide PNGs
```

## Quick Reference

| Task | Command |
|---|---|
| Outline as JSON | `pptx_read.py deck.pptx --outline` |
| Export images | `pptx_read.py deck.pptx --images DIR` |
| Replace text | `pptx_edit.py deck.pptx --replace-text OLD NEW` |
| Replace chart data | `pptx_edit.py deck.pptx --chart-data spec.json` |
| Patch one series | same flag, spec with `"ops"` (see below) |
| Swap picture | `pptx_edit.py deck.pptx --swap-image N NAME new.png` |
| Duplicate slide | `pptx_edit.py deck.pptx --duplicate-slide N` |
| Remove slide | `pptx_edit.py deck.pptx --remove-slide N` |
| Reorder slide | `pptx_edit.py deck.pptx --move-slide FROM TO` |
| Slide background | `pptx_edit.py deck.pptx --set-background N RRGGBB` |
| Hyperlink runs | `pptx_edit.py deck.pptx --hyperlink N TEXT URL` |
| Slide number on | `pptx_edit.py deck.pptx --enable-slide-number N` |
| Footer text | `pptx_edit.py deck.pptx --set-footer N TEXT` |
| Set notes | `pptx_edit.py deck.pptx --set-notes N TEXT` |
| Append notes | `pptx_edit.py deck.pptx --append-notes N TEXT` |
| Fill template | `pptx_from_template.py tpl.pptx out.pptx --values v.json` |
| Render slide PNGs | `pptx_render.py deck.pptx --outdir DIR` |
| New deck from a JSON spec (format in `--help`) | `pptx_create.py spec.json out.pptx` |

## Procedure

### 1. Read a deck

`pptx_read.py deck.pptx --outline` returns slide size, layout inventory,
and per slide: layout name, all shape texts, table cells, image inventory
(filename/ext/bytes), chart categories/series/values, and speaker notes.
Use `--images DIR` to dump embedded pictures to files, then
`read` on any exported image if you need to see its content.

### 2. Edit a deck

`pptx_edit.py` combines operations in one pass; use `--output` to keep the
original. Text replacement scans slide shapes, table cells, and notes.
Image swap retargets the picture's relationship id so position and size
are preserved. Slide removal drops the relationship and the `<p:sldId>`
entry; reorder moves the `<p:sldId>` element within `<p:sldIdLst>`
(python-pptx has no public API for either — the script does the XML-level
work). `--duplicate-slide N` appends an independent deep copy of slide N:
shape XML plus image/media/hyperlink relationships are cloned and rIds
remapped, so editing the copy never touches the original. Chart slides
are refused (see Pitfalls). `--set-notes`/`--append-notes` edit speaker
notes; `--set-background`, `--hyperlink`, `--enable-slide-number`, and
`--set-footer` handle deck polish.

Chart updates take a JSON spec via `--chart-data`. Full replace:
`{"slide": 0, "chart": 0, "categories": [...], "series": {...}}`. For
surgical edits, pass `"ops"` instead — a list of
`{"op": "update_series", "name": ..., "values": [...]}`,
`add_series`, `remove_series`, `rename_category` (`from`/`to` or
`index`), and `set_title`. python-pptx can only swap a chart's entire
dataset (`replace_data`), so ops are implemented as read-existing →
modify → replace; the per-part UX is a wrapper, and any chart data not
expressible as categories + numeric series will be normalized by the
round-trip.

### 3. Build from a template

`pptx_from_template.py` opens a brand .pptx, replaces every
`{{token}}` from a values JSON across slides/tables/notes, and can append
new slides that use the template's own layouts (by layout name or index)
so they inherit the master's fonts and colors. Tip: to start from a
template with zero slides, delete existing ones afterward with
`pptx_edit.py --remove-slide`.

### 4. Visual check

Render every slide to PNG and look at each one with `read`:

```bash
python3 /workspace/.openma/skills/pptx/latest/pptx/scripts/pptx_render.py /mnt/session/outputs/deck.pptx --outdir /workspace/render
```

The script runs the same two steps you can run by hand:

```bash
timeout 180 soffice --headless --convert-to pdf --outdir /workspace/render /mnt/session/outputs/deck.pptx
pdftoppm -png -r 80 /workspace/render/deck.pdf /workspace/render/slide
```

80 dpi is enough to see overlapping shapes, cut text and wrong colors. The
script gives LibreOffice its own temporary profile, so it works while
another LibreOffice runs, and stops after `--timeout` seconds (180 by
default). When `soffice` is missing it exits 0 with
`{"rendered": false, ...}` and names the image to pick; fall back to
`pptx_read.py --outline`, which checks content but not looks.

## Converting to PDF

```bash
timeout 180 soffice --headless --convert-to pdf --outdir /mnt/session/outputs/ deck.pptx
```

The output lands at `/mnt/session/outputs/deck.pdf`. If the command prints
nothing and no PDF appears, another LibreOffice holds the default
profile: add `-env:UserInstallation=file:///tmp/lo-profile` right after
`soffice`. Fonts that are not installed are substituted, so render the
PDF pages (step 4) before you hand it over. There is no pure-Python
.pptx to PDF path; if `soffice` is missing, say so and name the image.

## Pitfalls

- **Run splitting**: PowerPoint fragments paragraph text into runs at
  spell-check and edit boundaries. `--replace-text` first merges adjacent
  runs whose formatting is identical, so matches split across such runs
  are replaced with formatting fully preserved. Only when a match spans
  *genuinely differently-formatted* runs is the paragraph rewritten with
  the first run's formatting — verify those slides after replacement.
- **Chart slides cannot be duplicated**: each chart relationship embeds a
  separate XLSX workbook part; cloning that graph reliably is not
  supported, so `--duplicate-slide` refuses chart slides cleanly instead
  of corrupting the deck. Rebuild the chart on a new slide instead.
  External-hyperlink and image/media rels are carried over; layout and
  notes rels are recreated fresh.
- **Chart ops are a wrapper**: python-pptx replaces the whole dataset;
  `"ops"` round-trips existing plot data through `replace_data`, and
  changing chart *type* is not possible.
- **Reordering is XML-level**: python-pptx has no supported reorder API.
  `--move-slide` manipulates `<p:sldIdLst>` directly; safe for ordinary
  decks but re-read the deck afterward to confirm.
- **Copying slides between decks is unsupported** — duplication works
  only within one deck, where layouts and masters are shared.
- Footer/slide-number enablement copies the placeholder from the slide's
  layout; on layouts without those placeholders, `--set-footer` fails
  with a clear message (add a textbox instead).
- Hyperlinks apply to whole runs; `--hyperlink` links every run
  containing the given text on that slide.
- The default python-pptx template is 4:3. In your own python-pptx code
  set `prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)`
  for 16:9. Custom templates keep their own size.
- Layout indexes vary by template. For brand templates, list layout names
  first: `pptx_read.py template.pptx --outline` (`layouts_available`).
- `slide.shapes.title` is None on blank layouts; check it in ad-hoc
  python-pptx code.
- Always pass `encoding="utf-8"` when writing spec files; tokens like
  `{{city}}` may be filled with non-ASCII values.

## Verification

1. After any edit, run `pptx_read.py OUT.pptx --outline` and check
   slide count, texts, tables, notes, and chart values match intent.
2. `--images DIR` then file-size check confirms pictures embedded.
3. Render every slide (step 4) and review each PNG with `read`. This
   catches overlapping shapes, truncated text, and color problems the
   outline cannot.
4. The bundled test suite is the full contract:
   `python3 -m pytest tests/ -q` (requires python-pptx + pytest).
