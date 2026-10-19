---
name: pdf
description: "Create PDF reports with Russian text: DejaVu Sans font, tables, a page check after writing. Other helpers read, merge, split, stamp, secure PDFs and fill forms."
display_title: PDF
version: 1.3.0
author: Nous Research
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [pdf, documents, forms, reportlab, pypdf, pdfplumber]
    category: productivity
    related_skills: [docx, xlsx, pptx]
---

# PDF

## Paths

- The skill folder is `/workspace/.openma/skills/pdf/latest/pdf/`. An agent that
  pins a version finds it at `/workspace/.openma/skills/pdf/<version>/pdf/`, the
  folder of this SKILL.md. Use that folder in every command below.
- Save the file for the user directly in `/mnt/session/outputs/`, without
  subfolders. Keep specs and drafts in `/workspace/`.

## 1. Russian text needs DejaVu Sans

The reportlab fonts Helvetica, Times and Courier have no Cyrillic. Every Russian
letter prints as a box, digits stay readable, and nothing fails.

- `pdf_create.py` loads DejaVu Sans by itself. If it prints
  `Warning: DejaVuSans.ttf not found`, run `apt-get install -y fonts-dejavu-core`
  and build again.
- In your own reportlab code, register the font and set it on every style and
  table:

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("DejaVuSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DejaVuSans-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
```

## 2. Create with pdf_create.py

Write the spec with `write`, then run:

```bash
python3 /workspace/.openma/skills/pdf/latest/pdf/scripts/pdf_create.py /workspace/spec.json -o /mnt/session/outputs/report.pdf
```

Example spec:

```json
{
  "title": "Отчёт о расходах",
  "page_number_format": "Страница {page}",
  "elements": [
    {"type": "heading", "text": "Отчёт о расходах", "level": 1},
    {"type": "paragraph", "text": "Расходы за месяц составили 131 700 руб."},
    {"type": "table", "headers": ["Статья", "Сумма, руб."],
     "rows": [["Аренда", "120 000"], ["Связь", "11 700"], ["Итого", "131 700"]]}
  ]
}
```

- Element types: `heading` (`text`, `level` 1 to 3), `paragraph` (`text`),
  `table`, `image` (`path`, `width`, `height`), `pagebreak`.
- A table takes its header row from `headers`. Without `headers` the first row of
  `rows` is the header. Every row has as many cells as the header.
- The script stops with an error on an unknown key or element type. Fix the spec
  and run it again. `pdf_create.py --help` shows every key.

## 3. Check the file after writing

`ls` only shows that the file exists. Check the text and the page:

```bash
python3 /workspace/.openma/skills/pdf/latest/pdf/scripts/pdf_read.py /mnt/session/outputs/report.pdf --text
python3 /workspace/.openma/skills/pdf/latest/pdf/scripts/pdf_page_image.py /mnt/session/outputs/report.pdf --pages 1 --out-dir /workspace/pages/
```

- The Russian words must come back exactly as written. Letters turned into
  `nnnnn` mean the font has no Cyrillic, see step 1.
- Open the page PNG with `read`. Check the page count, the table header row, and
  that no text runs off the page.
- poppler gives the same checks from the shell, for any PDF, also one you
  got from the user: `pdftotext -layout file.pdf -` prints the text in page
  order, `pdfinfo file.pdf` the page count, and
  `pdftoppm -png -r 80 -f 1 -l 1 file.pdf /workspace/pages/page` a PNG of page 1.
  poppler is in the images "Рабочее место агента" and "Рабочее место с LibreOffice".

## Other helpers

Each script in `scripts/` takes `--help`: `pdf_read.py` (text, tables, metadata,
form fields), `pdf_merge.py`, `pdf_split.py` (pages, rotation), `pdf_stamp.py`,
`pdf_watermark.py`, `pdf_meta.py`, `pdf_secure.py` (passwords), and for forms
`pdf_form_layout.py`, `pdf_make_form.py`, `pdf_fill_form.py` with
`references/forms.md`.
