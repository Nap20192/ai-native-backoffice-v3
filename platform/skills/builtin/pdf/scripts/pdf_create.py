#!/usr/bin/env python3
"""Create a PDF from a JSON spec using reportlab platypus.

Spec format (UTF-8 JSON):
{
  "title": "Example Report",
  "author": "example-author",
  "page_size": "A4",            // or "letter" (default: A4)
  "page_numbers": true,          // default true
  "page_number_format": "Page {page}",  // e.g. "Страница {page}"
  "elements": [
    {"type": "heading", "text": "Section 1", "level": 1},
    {"type": "paragraph", "text": "Body text..."},
    {"type": "table", "headers": ["H1", "H2"], "rows": [["a", "b"]]},
    {"type": "table", "rows": [["H1", "H2"], ["a", "b"]], "header": true},
    {"type": "image", "path": "chart.png", "width": 400},
    {"type": "pagebreak"}
  ]
}

A table takes its header row from "headers", or else from the first row of
"rows" ("header": true, the default); "header": false draws no header row.
Every row has as many cells as the header row.

OpenMA port: the spec is checked before anything is drawn. An unknown key or
element type, a row that is not a list, or a row of the wrong width stops the
script with exit code 1 and a message naming the element, so a misspelt key
is not dropped silently.
"""
from __future__ import annotations

import argparse
import json
import sys


def _reconfigure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


TOP_LEVEL_KEYS = ("title", "author", "page_size", "page_numbers", "page_number_format",
                  "elements")
ELEMENT_KEYS = {
    "heading": ("text", "level"),
    "paragraph": ("text",),
    "table": ("rows", "headers", "header"),
    "image": ("path", "width", "height"),
    "pagebreak": (),
}
TABLE_EXAMPLE = '{"type": "table", "headers": ["Item", "Sum"], "rows": [["Rent", "120 000"]]}'


class SpecError(ValueError):
    """The spec has a key, type or shape this script would misread."""


def _unknown(keys, allowed) -> list[str]:
    return sorted(repr(key) for key in keys if key not in allowed)


def _check_table(el: dict, where: str) -> None:
    rows = el.get("rows", [])
    if not isinstance(rows, list) or not all(isinstance(row, list) for row in rows):
        raise SpecError(f'{where}: "rows" must be a list of rows, each row a list of cells, '
                        f"e.g. {TABLE_EXAMPLE}")
    headers = el.get("headers")
    if headers is not None:
        if not isinstance(headers, list) or not headers:
            raise SpecError(f'{where}: "headers" must be a non-empty list of cells, '
                            f"e.g. {TABLE_EXAMPLE}")
        if el.get("header") is False:
            raise SpecError(f'{where}: "headers" draws a header row, remove "header": false')
    header = el.get("header", True)
    if not isinstance(header, bool):
        raise SpecError(f'{where}: "header" must be true or false')
    table_rows = ([headers] if headers is not None else []) + rows
    if not table_rows:
        return
    width = len(table_rows[0])
    first = "the header row" if headers is not None or header else "the first row"
    for number, row in enumerate(table_rows[1:], start=1):
        if len(row) != width:
            raise SpecError(f"{where}: table row {number} has {len(row)} cells, "
                            f"{first} has {width}")


def check_spec(spec) -> None:
    """Raise SpecError when ``spec`` holds anything build_pdf would drop or misread."""
    if not isinstance(spec, dict):
        raise SpecError("the spec must be a JSON object")
    unknown = _unknown(spec, TOP_LEVEL_KEYS)
    if unknown:
        raise SpecError(f"unknown top-level key {', '.join(unknown)}; "
                        f"allowed: {', '.join(TOP_LEVEL_KEYS)}")
    elements = spec.get("elements", [])
    if not isinstance(elements, list):
        raise SpecError('"elements" must be a list')
    for index, el in enumerate(elements):
        where = f"elements[{index}]"
        etype = el.get("type") if isinstance(el, dict) else None
        if etype not in ELEMENT_KEYS:
            raise SpecError(f"{where}: unknown element type {etype!r}; "
                            f"use one of {', '.join(ELEMENT_KEYS)}")
        allowed = ("type", *ELEMENT_KEYS[etype])
        unknown = _unknown(el, allowed)
        if unknown:
            hint = f", e.g. {TABLE_EXAMPLE}" if etype == "table" else ""
            raise SpecError(f"{where} ({etype}): unknown key {', '.join(unknown)}; "
                            f"allowed: {', '.join(allowed)}{hint}")
        if etype == "table":
            _check_table(el, where)


def build_pdf(spec: dict, out_path: str) -> int:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, letter
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import (
            Image,
            PageBreak,
            Paragraph,
            SimpleDocTemplate,
            Spacer,
            Table,
            TableStyle,
        )
    except ImportError:
        print("Missing dependency: install with 'python3 -m pip install reportlab'", file=sys.stderr)
        return 2

    import _fonts  # OpenMA port: Unicode font so Cyrillic text renders

    font, bold_font = _fonts.unicode_fonts()
    page_size = letter if str(spec.get("page_size", "A4")).lower() == "letter" else A4
    styles = getSampleStyleSheet()
    for style in styles.byName.values():
        if hasattr(style, "fontName"):
            style.fontName = bold_font if "Bold" in style.fontName else font
    story = []
    for el in spec.get("elements", []):
        etype = el.get("type")
        if etype == "heading":
            level = min(max(int(el.get("level", 1)), 1), 3)
            story.append(Paragraph(el.get("text", ""), styles[f"Heading{level}"]))
        elif etype == "paragraph":
            story.append(Paragraph(el.get("text", ""), styles["BodyText"]))
            story.append(Spacer(1, 6))
        elif etype == "table":
            headers = el.get("headers")
            rows = ([headers] if headers else []) + el.get("rows", [])
            if not rows:
                continue
            header = bool(headers) or el.get("header", True)
            table = Table(rows, repeatRows=1 if header else 0)
            style = [
                ("FONTNAME", (0, 0), (-1, -1), font),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
            if header:
                style += [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                    ("FONTNAME", (0, 0), (-1, 0), bold_font),
                ]
            table.setStyle(TableStyle(style))
            story.append(table)
            story.append(Spacer(1, 10))
        elif etype == "image":
            kwargs = {}
            if el.get("width"):
                kwargs["width"] = float(el["width"])
            if el.get("height"):
                kwargs["height"] = float(el["height"])
            img = Image(el["path"], **kwargs)
            if "width" in kwargs and "height" not in kwargs:
                # keep aspect ratio
                ratio = img.imageHeight / img.imageWidth
                img.drawWidth = kwargs["width"]
                img.drawHeight = kwargs["width"] * ratio
            story.append(img)
            story.append(Spacer(1, 10))
        elif etype == "pagebreak":
            story.append(PageBreak())

    def draw_page_number(canvas, doc):
        if spec.get("page_numbers", True):
            canvas.saveState()
            canvas.setFont(font, 9)
            label = str(spec.get("page_number_format", "Page {page}")).format(page=doc.page)
            canvas.drawCentredString(page_size[0] / 2.0, 0.5 * inch, label)
            canvas.restoreState()

    doc = SimpleDocTemplate(
        out_path,
        pagesize=page_size,
        title=spec.get("title", ""),
        author=spec.get("author", ""),
    )
    doc.build(story, onFirstPage=draw_page_number, onLaterPages=draw_page_number)
    print(json.dumps({"output": out_path, "elements": len(spec.get("elements", []))}))
    return 0


def main() -> int:
    _reconfigure_stdio()
    parser = argparse.ArgumentParser(
        description="Create a PDF from a JSON spec (reportlab).",
        epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec", help="Path to UTF-8 JSON spec file")
    parser.add_argument("-o", "--output", required=True, help="Output PDF path")
    args = parser.parse_args()
    with open(args.spec, encoding="utf-8") as fh:
        spec = json.load(fh)
    try:
        check_spec(spec)
    except SpecError as exc:
        print(f"Spec error in {args.spec}: {exc}", file=sys.stderr)
        return 1
    return build_pdf(spec, args.output)


if __name__ == "__main__":
    sys.exit(main())
