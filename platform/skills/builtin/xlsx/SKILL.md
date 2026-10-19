---
name: xlsx
description: Read, edit, restructure Excel .xlsx workbooks and CSVs; recalculate formulas and convert to PDF with LibreOffice.
display_title: Excel (xlsx)
version: 1.2.0
author: Nous Research
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [excel, spreadsheet, xlsx, csv, openpyxl, productivity]
    category: productivity
    related_skills: [docx, pdf, pptx]
---

# Xlsx Skill

Work with Excel .xlsx workbooks using Python and openpyxl: inspect or
dump existing files, edit cells and structure, convert to and from CSV.
LibreOffice recalculates formulas and turns the workbook into PDF. All
helper scripts are argparse CLIs that print JSON and use explicit UTF-8 I/O.

## Platform notes (OpenMA)

- This skill is mounted at `/workspace/.openma/skills/xlsx/latest/xlsx/`. Run helpers by full path, for example
  `python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/<script>.py --help`.
- These paths are for an agent that takes the latest version. If the agent
  pins a version, the skill is at `/workspace/.openma/skills/xlsx/<version>/xlsx/`,
  the folder of this SKILL.md. Use that folder in place of
  `/workspace/.openma/skills/xlsx/latest/xlsx/` in every command.
- Save every file the user should receive directly in `/mnt/session/outputs/`.
  Do not create subfolders there: the session file list shows top-level files
  only. Keep JSON specs, drafts and page images in `/workspace/`.
- Tools: write specs with `write`, read files with `read` (it also shows PNG
  images), run commands with `bash`.
- Programs. The environment image "Рабочее место с LibreOffice" has openpyxl,
  LibreOffice (`soffice`) and poppler (`pdftoppm`, `pdftotext`).
  Check with `command -v soffice` and `python3 -c "import openpyxl"`.
- If `command -v soffice` prints nothing or the import fails, tell the user to pick the image
  "Рабочее место с LibreOffice" on the environment card and start a new session.
  Do not install LibreOffice with apt-get: it is too large for the sandbox.
  Until then formulas stay without results; say so when you hand the file over.

## When to Use

- Reading a workbook: sheet inventory, dumping data as JSON or CSV,
  listing formulas vs cached values, notes, defined names, tables.
- Editing existing files: set cells, append rows, insert/delete
  rows/columns (reference-aware via `xlsx_restructure.py`),
  copy/rename sheets, tables, names, notes, protection.
- Recalculating formulas headlessly via LibreOffice (`xlsx_recalc.py`).
- A PDF of the workbook or a look at how it prints.
- CSV interop with type inference and non-UTF-8 encodings.
- Not for the legacy .xls binary format. Convert it first:
  `timeout 180 soffice --headless --convert-to xlsx --outdir /workspace/ old.xls`.

## How to Run

Run the helper scripts with the `bash` tool from this skill's
`scripts/` directory (every script supports `--help`):

```bash
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_read.py report.xlsx --sheets      # inventory
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_read.py report.xlsx --json --sheet Data
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_read.py report.xlsx --formulas
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_edit.py report.xlsx --sheet Data --set B2=42 --recalc
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_restructure.py report.xlsx --sheet Data --insert-rows 3:2
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_recalc.py report.xlsx
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/csv_to_xlsx.py data.csv /mnt/session/outputs/out.xlsx --encoding utf-8
python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_to_csv.py report.xlsx /mnt/session/outputs/out.csv --sheet Data
```

## Quick Reference

| Task | Command |
|---|---|
| Sheet names + dimensions | `xlsx_read.py f.xlsx --sheets` |
| Dump sheet as JSON | `xlsx_read.py f.xlsx --json --sheet S` |
| Dump sheet as CSV | `xlsx_read.py f.xlsx --csv --out d.csv` |
| List formulas + cached values | `xlsx_read.py f.xlsx --formulas` |
| Set a cell / formula | `xlsx_edit.py f.xlsx --set "A1==SUM(B:B)"` |
| Append a row | `xlsx_edit.py f.xlsx --append '[1,"x",true]'` |
| Insert 2 rows, refs NOT shifted | `xlsx_edit.py f.xlsx --insert-rows 3:2` |
| Insert 2 rows, refs shifted | `xlsx_restructure.py f.xlsx --insert-rows 3:2` |
| Delete a column, refs shifted | `xlsx_restructure.py f.xlsx --delete-cols B` |
| Create a native table | `xlsx_edit.py f.xlsx --add-table Sales:A1:C9` |
| Append inside a table | `--table-append 'Sales=["West",5]'` |
| List tables | `xlsx_edit.py f.xlsx --list-tables` |
| Defined names | `--define-name "Rates='Data'!$B$2:$B$9"` / `--delete-name Rates` / `xlsx_read.py f.xlsx --names` |
| Hyperlink | `--hyperlink "A1=https://example.com|Docs"` |
| Cell note | `--note "B2=Check this|Reviewer"`; read via `xlsx_read.py f.xlsx --notes` |
| Protect sheet (see Pitfalls) | `--protect your-password --unlock B2:B9` |
| Recalculate via LibreOffice | `xlsx_recalc.py f.xlsx` |
| Copy / rename sheet | `--copy-sheet Src:New --rename-sheet Old:New` |
| Force recalc on open | `xlsx_edit.py f.xlsx --recalc` |
| CSV -> styled xlsx | `csv_to_xlsx.py in.csv out.xlsx` |
| xlsx -> CSV | `xlsx_to_csv.py f.xlsx out.csv --encoding utf-8` |
| New workbook from a JSON spec (format in `--help`) | `xlsx_create.py spec.json out.xlsx` |

## Procedure

1. **Formulas and recalculation**: set a formula with
   `xlsx_edit.py f.xlsx --set "C1==SUM(A:A)"` and add `--recalc`, which
   sets the workbook's `fullCalcOnLoad` flag so Excel and LibreOffice
   recompute on open. openpyxl itself NEVER evaluates formulas, so a file
   it wrote has no results yet. Recalculate it with LibreOffice before
   you read numbers back or hand the file over:

   ```bash
   python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_recalc.py /mnt/session/outputs/report.xlsx
   python3 /workspace/.openma/skills/xlsx/latest/xlsx/scripts/xlsx_read.py /mnt/session/outputs/report.xlsx --formulas
   ```

   `xlsx_recalc.py` runs `soffice --headless` with its own temporary
   profile, re-saves the file with fresh cached values and prints
   `formula_cells` and `with_cached_values`. `--formulas` then pairs each
   formula with its result; look for `#DIV/0!`, `#REF!`, `#NAME?` and
   `#VALUE!`. When `soffice` is missing the script exits 0 with
   `{"recalculated": false, ...}` and names the image to pick.
2. **Read**: `--sheets` for inventory (names, dimensions, merged
   ranges, chart count, tables, protection, defined names),
   `--json`/`--csv` for data, `--formulas` to
   pair each formula string with its cached result, `--notes` for
   cell comments, `--names` for defined names. Cached results
   exist only if the file was last saved by a real spreadsheet app;
   files fresh from openpyxl return `null` there. To get the
   results, recalculate with LibreOffice (step 1), then read again.
3. **Edit**: `xlsx_edit.py` applies renames/copies first, then
   structural row/column changes, then `--set`/`--append`. It edits in
   place unless `--out` is given — copy the file first if you need the
   original.
4. **Restructure**: for insert/delete on sheets that have formulas,
   merges, tables, or filters, use `xlsx_restructure.py` instead of
   `xlsx_edit.py`. It rewrites formula references on ALL sheets
   (absolute `$` refs, ranges, cross-sheet refs), shifts merges,
   autofilter, freeze panes, validation and conditional-format
   ranges, table refs, defined names, and row/column dimensions, then
   prints a JSON report including a `not_shifted` list. Rules and
   limits: `references/restructuring.md`.
5. **CSV interop**: `csv_to_xlsx.py` infers int/float/bool/ISO-date
   per cell and styles the header row; `xlsx_to_csv.py` writes ISO
   dates and blank strings for empty cells. Both default to UTF-8 and
   accept `--encoding` (e.g. `utf-8-sig` for Excel-friendly BOM,
   `cp1252` for legacy Windows exports).

## Converting to PDF

```bash
timeout 180 soffice --headless --convert-to pdf --outdir /mnt/session/outputs/ report.xlsx
timeout 180 soffice --headless --convert-to csv --outdir /mnt/session/outputs/ report.xlsx  # 1st sheet only
```

Only the first sheet lands in a CSV; for other sheets use
`xlsx_to_csv.py --sheet NAME`. If the command prints nothing and no file
appears, another LibreOffice holds the default profile: add
`-env:UserInstallation=file:///tmp/lo-profile` right after `soffice`. If
`soffice` is missing, hand the file over unconverted and name the image
from Platform notes.

## Visual check

To see how the sheets print (column widths, cut numbers, page breaks),
convert to PDF in `/workspace/`, turn pages into PNG and look at them
with `read`:

```bash
timeout 180 soffice --headless --convert-to pdf --outdir /workspace/pages /mnt/session/outputs/report.xlsx
pdftoppm -png -r 80 /workspace/pages/report.pdf /workspace/pages/page
```

`###` in a cell on the page means the column is too narrow for the number.

## Pitfalls

- **openpyxl does not calculate.** Formula results are available only
  via `load_workbook(path, data_only=True)` and only when the file was
  previously saved by Excel/LibreOffice. Otherwise you get `None`.
- **`xlsx_edit.py` insert/delete does not shift references** (raw
  openpyxl behavior). Use `xlsx_restructure.py`, which does — but even
  it cannot move chart anchors, images, or conditional-format RULE
  formulas; read its JSON report's `not_shifted` list and
  `references/restructuring.md`.
- **Sheet protection is NOT security.** `--protect` sets the standard
  xlsx sheet-protection hash: it signals "don't edit this" to
  well-behaved apps and nothing more. Anyone can strip it by editing
  the zip's XML or unchecking it in LibreOffice. Never rely on it for
  confidentiality or integrity; it does not encrypt anything.
- **`data_only=True` then save** silently discards all formulas
  (cached values replace them). Never save a workbook loaded that way
  unless that is the goal.
- **Loading strips charts/images**: openpyxl does not round-trip
  charts, so editing a charted workbook and saving drops the charts.
  Re-add charts after editing, or avoid re-saving charted files.
- **CSV locale traps**: always pass explicit encodings (the scripts
  already do) and remember European CSVs often use `;` delimiters and
  decimal commas — use `--delimiter ';'` and expect strings like
  `"12,5"` to stay strings.
- **Dates are datetimes**: Excel stores dates as serial numbers;
  openpyxl returns `datetime`/`date` objects. Dumps here emit ISO
  strings.
- Sheet names are capped at 31 chars and reject `[ ] : * ? / \`.

## Verification

- After edits: re-dump the touched range with `--json`; if formulas were
  written, run `xlsx_recalc.py` and confirm `--formulas` shows results
  and no error values.
- `xlsx_read.py out.xlsx --sheets` confirms sheet names, dimensions,
  merged ranges, and chart counts.
- After `xlsx_restructure.py`: read its JSON report, then re-run
  `--formulas` and `--sheets` to confirm references and ranges landed
  where expected.
- For a full visual check, render the pages (see Visual check).
