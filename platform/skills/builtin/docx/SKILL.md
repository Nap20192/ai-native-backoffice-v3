---
name: docx
description: Read, edit, fill templates, review changes and comments in Word .docx files; convert to PDF and check pages with LibreOffice.
display_title: Word (docx)
version: 1.2.0
author: Nous Research
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [word, docx, documents, office, templates, revisions, comments]
    category: productivity
    related_skills: [pdf, xlsx, pptx]
---

# Docx Skill

Read, edit, and template Microsoft Word `.docx` files with python-docx via
small CLIs. It handles text, styles, tables, `{{token}}` templating,
tracked changes (list/accept/reject), comments (list/add/delete), TOC and
page-number fields, and package health checks. LibreOffice turns the
document into PDF and page images; python-docx itself renders nothing.

## Platform notes (OpenMA)

- This skill is mounted at `/workspace/.openma/skills/docx/latest/docx/`. Run helpers by full path, for example
  `python3 /workspace/.openma/skills/docx/latest/docx/scripts/<script>.py --help`.
- These paths are for an agent that takes the latest version. If the agent
  pins a version, the skill is at `/workspace/.openma/skills/docx/<version>/docx/`,
  the folder of this SKILL.md. Use that folder in place of
  `/workspace/.openma/skills/docx/latest/docx/` in every command.
- Save every file the user should receive directly in `/mnt/session/outputs/`.
  Do not create subfolders there: the session file list shows top-level files
  only. Keep JSON specs, drafts and page images in `/workspace/`.
- Tools: write specs with `write`, read files with `read` (it also shows PNG
  images), run commands with `bash`.
- Programs. The environment image "Рабочее место с LibreOffice" has python-docx,
  LibreOffice (`soffice`) and poppler (`pdftoppm`, `pdftotext`).
  Check with `command -v soffice` and `python3 -c "import docx"`.
- If `command -v soffice` prints nothing or the import fails, tell the user to pick the image
  "Рабочее место с LibreOffice" on the environment card and start a new session.
  Do not install LibreOffice with apt-get: it is too large for the sandbox.
  Until then read, edit and check the text with `docx_read.py`.

## When to Use

- You need the text, outline, styles, or embedded images of a `.docx`.
- You must change an existing `.docx`: replace text, edit table cells,
  insert/delete paragraphs, apply styles, merge fragmented runs.
- You have a `.docx` template with `{{placeholders}}` to fill from data.
- The document has tracked changes to review, accept, or reject.
- You need to read reviewers' comments, or add/delete comments.
- A `.docx` won't open or behaves oddly and you need corruption triage.
- The document needs a table of contents or "Page X of Y" footers.
- You need a PDF of the document or want to see its pages.
- Not for: `.doc` (legacy) or `.odt`. Convert them first with
  `timeout 180 soffice --headless --convert-to docx --outdir /workspace/ old.doc`.

## How to Run

All helpers live in `scripts/` next to this file. Run them with the
`bash` tool; each supports `--help` and prints JSON to stdout.

```bash
python3 /workspace/.openma/skills/docx/latest/docx/scripts/docx_read.py in.docx --text
python3 /workspace/.openma/skills/docx/latest/docx/scripts/docx_edit.py replace in.docx --find old --replace new -o /mnt/session/outputs/out.docx
python3 /workspace/.openma/skills/docx/latest/docx/scripts/docx_template.py tpl.docx values.json /mnt/session/outputs/filled.docx
python3 /workspace/.openma/skills/docx/latest/docx/scripts/docx_revisions.py list in.docx
python3 /workspace/.openma/skills/docx/latest/docx/scripts/docx_comments.py list in.docx
python3 /workspace/.openma/skills/docx/latest/docx/scripts/docx_validate.py out.docx
```

## Quick Reference

| Task | Command |
| --- | --- |
| Full text (body+tables+headers/footers) | `docx_read.py f.docx --text` |
| Heading outline + table shapes | `docx_read.py f.docx --structure` |
| Styles actually used | `docx_read.py f.docx --styles` |
| Extract embedded images | `docx_read.py f.docx --images outdir/` |
| Detect tracked changes/comments | `docx_read.py f.docx --revisions` |
| Find/replace (formatting kept) | `docx_edit.py replace f.docx --find A --replace B -o out.docx` |
| Set a table cell | `docx_edit.py set-cell f.docx --table 0 --row 1 --col 2 --text X` |
| Insert paragraph before index N | `docx_edit.py insert f.docx --index N --text X --style Normal` |
| Delete paragraph N | `docx_edit.py delete f.docx --index N` |
| Apply style to paragraph N | `docx_edit.py style f.docx --index N --style "Heading 1"` |
| Merge equal-format adjacent runs | `docx_edit.py normalize f.docx -o out.docx` |
| Insert TOC field before para N | `docx_edit.py toc f.docx --index N -o out.docx` |
| "Page X of Y" footer fields | `docx_edit.py page-numbers f.docx` |
| Fill `{{tokens}}` | `docx_template.py tpl.docx values.json out.docx --strict` |
| List revisions (id/author/date/text) | `docx_revisions.py list f.docx` |
| Accept / reject all revisions | `docx_revisions.py accept-all f.docx -o out.docx` (or `reject-all`) |
| Accept / reject one revision | `docx_revisions.py accept f.docx --id 3 -o out.docx` |
| List comments (+anchored text) | `docx_comments.py list f.docx` |
| Add comment anchored to text | `docx_comments.py add f.docx --target "phrase" --text "note" --author You` |
| Delete comment by id | `docx_comments.py delete f.docx --id 0` |
| Health-check the package | `docx_validate.py f.docx` (exit 1 on errors) |
| New document from a JSON spec (format in `--help`) | `docx_create.py spec.json out.docx` |

## Procedure

1. **Read.** Use `scripts/docx_read.py` with exactly one mode flag.
   `--text` returns body paragraphs, all table cell text, and
   header/footer text as JSON. `--structure` returns the heading outline
   plus paragraph/table/section counts. `--images DIR` copies every file
   under `word/media/` out of the package.
2. **Edit.** Use `scripts/docx_edit.py`. `replace` walks body, tables
   (nested included), headers and footers, and preserves run formatting;
   add `--body-only` to skip headers/footers. Pass `-o out.docx` to keep
   the original; omit it to edit in place. Paragraph indices for
   `insert`/`delete`/`style`/`toc` refer to `--structure`/`--text` body
   order. Run `normalize` first on documents that came out of heavy Word
   editing — it merges adjacent runs with identical formatting so later
   find-replace matches reliably.
3. **Review revisions.** `docx_revisions.py list` reports every `w:ins`
   and `w:del` (id, author, date, affected text) anywhere in body,
   tables, headers, or footers. `accept-all` / `reject-all` resolve them
   in bulk; `accept`/`reject --id N` handles a single revision. Accept
   keeps insertions and drops deleted text; reject does the reverse.
4. **Comments.** `docx_comments.py list` returns each comment's id,
   author, date, body text, and the document text it is anchored to.
   `add --target "some phrase"` anchors a new comment to the first
   occurrence of that phrase (runs are split as needed; formatting is
   preserved). `delete --id N` removes the comment and its markers
   without touching document text.
5. **Template.** Put `{{name}}`-style tokens in the document. Run
   `scripts/docx_template.py` with a JSON object of values. Use
   `--strict` to fail when tokens remain unfilled; the JSON output lists
   `filled` counts and `unfilled_tokens` either way.
6. **Verify** (always): re-read the output with `--text` or
   `--structure`, and run `docx_validate.py` on anything you produced
   via revision/comment surgery. When layout matters (tables, page
   breaks, headers), render the pages and look at them, see Visual check.

## Converting to PDF

```bash
timeout 180 soffice --headless --convert-to pdf --outdir /mnt/session/outputs/ file.docx
```

The PDF lands at `/mnt/session/outputs/file.pdf`. If the command prints
nothing and no PDF appears, another LibreOffice holds the default profile: add
`-env:UserInstallation=file:///tmp/lo-profile` right after `soffice`. If
`soffice` is missing, say so and name the image from Platform notes;
python-docx cannot render PDFs.

## Visual check

Convert to PDF in `/workspace/`, then turn pages into PNG and look at them
with `read`:

```bash
timeout 180 soffice --headless --convert-to pdf --outdir /workspace/pages /mnt/session/outputs/file.docx
pdftoppm -png -r 80 /workspace/pages/file.pdf /workspace/pages/page
pdftotext -layout /workspace/pages/file.pdf -
```

80 dpi is enough to see broken tables, cut text and wrong page breaks.
`pdftotext` shows the text in page order, a quick check that nothing went
missing. Fonts that are not installed are substituted, so the pages can
differ a little from Word.

## Pitfalls

- **Tokens split across runs.** Word often fragments text into several
  runs. The replace helpers collapse matched runs (replacement inherits
  the first run's formatting); running `docx_edit.py normalize` first
  reduces fragmentation for all later edits.
- **Revision coverage.** `docx_revisions.py` resolves run-level
  insertions and deletions (the overwhelming majority). Paragraph-mark
  and table-row revisions, format-change records, and moves are detected
  by `--revisions` but not auto-resolved — see
  `references/revisions-and-comments.md` and hand those to Word.
- **Comment threading.** Replies and "resolved" status live in
  `commentsExtended.xml`, which this skill ignores; comments it adds are
  plain top-level comments.
- **Field results are computed by Word.** `toc`, `page-numbers`, and the
  `toc`/`footer_page_numbers` spec options write *field codes*.
  Word/LibreOffice populates the actual entries and numbers when the
  file is opened (Word may prompt to update fields); python-docx never
  computes them, so placeholder text shows until then.
- **Validation is a health check, not schema validation.**
  `docx_validate.py` verifies the zip, required parts, relationship
  targets, image magic bytes, and referenced styles. It is NOT XSD
  validation — a file can pass and still contain XML Word dislikes.
- **Style names must exist.** Applying a style that isn't defined in the
  document raises `KeyError`. Built-ins like `Heading 1`, `List Bullet`,
  `List Number`, `Table Grid` exist in the default template; custom
  styles must be declared in the create spec first.
- **Numbered lists restart.** `List Number` relies on Word's default
  numbering; separate lists in one document may continue numbering
  instead of restarting. Warn users needing precise multi-list numbering.
- **Cell writes replace formatting.** `set-cell` uses `cell.text = ...`,
  which resets runs in that cell to plain formatting.
- **Encoding.** All JSON specs/values files are read as UTF-8 explicitly;
  never rely on locale defaults when writing your own glue code.
- **Don't unzip-and-sed the XML.** Edit through the scripts (or
  python-docx); raw text substitution in `document.xml` corrupts files
  easily. Use `edit`/`write` only for the JSON inputs, never on the
  `.docx` itself.

## Verification

- After create/edit/template, run `docx_read.py out.docx --text` and
  check the expected strings appear (and old strings are gone).
- After accept/reject, `docx_revisions.py list` should return `[]` (or
  only the ids you intentionally left); after comment surgery,
  `docx_comments.py list` should reflect the change and `--text` output
  must be unchanged.
- `docx_validate.py out.docx` exits 0 with `"ok": true` on a healthy
  package — run it after any revision/comment/field manipulation.
- For templates run with `--strict`, or check `unfilled_tokens == []`.
- Structure checks: `--structure` should show the expected heading
  outline and table shapes; `--styles` confirms custom styles applied.
