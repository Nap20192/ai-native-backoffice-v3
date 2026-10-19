#!/usr/bin/env python3
"""Create a .pptx presentation from a JSON deck spec.

Spec format (all positions/sizes in inches, colors as RRGGBB hex):
{
  "slide_size": "16:9",              // or "4:3" (default "16:9")
  "slides": [
    {"layout": "title", "title": "My Deck", "subtitle": "Q3 review"},
    {"layout": "title_content", "title": "Agenda",
     "bullets": ["Top item",
                 {"text": "Sub item", "level": 1, "bold": true,
                  "size": 18, "color": "CC0000", "font": "Arial",
                  "italic": false,
                  "link": "https://example.com/agenda"}],
     "background": "1F2937",           // solid slide background (hex)
     "footer": "Confidential",         // footer placeholder text
     "slide_number": true,             // enable slide-number placeholder
     "notes": "Speaker notes for this slide"},
    {"layout": "blank", "title": "Widgets",
     "images":  [{"path": "logo.png", "left": 1, "top": 1, "width": 3}],
     "tables":  [{"left": 1, "top": 2, "width": 6, "height": 2,
                  "rows": [["H1", "H2"], ["a", "b"]]}],
     "shapes":  [{"type": "rounded_rectangle", "left": 8, "top": 1,
                  "width": 3, "height": 1, "fill": "4472C4",
                  "text": "Callout", "text_color": "FFFFFF"}],
     "charts":  [{"type": "bar", "left": 1, "top": 3, "width": 6,
                  "height": 3.5, "title": "Sales",
                  "categories": ["Q1", "Q2"],
                  "series": {"North": [10, 20], "South": [7, 13]}}]}
  ]
}
Layouts: title, title_content, section, two_content, title_only, blank
Chart types: bar, bar_h, line, pie   Shape types: rectangle,
rounded_rectangle, oval, diamond, right_arrow, chevron

OpenMA port: "subtitle" goes to the layout's subtitle placeholder. A layout
without one (title_content, two_content, title_only, blank) gets a text box
under the title, and the bullets stay in the body. The spec is checked
before anything is built: an unknown top-level key, slide key or layout
stops the script with exit code 1, the place and the allowed values.
"""
import argparse
import copy
import json
import sys

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE, PP_PLACEHOLDER
from pptx.util import Inches, Pt

LAYOUTS = {"title": 0, "title_content": 1, "section": 2,
           "two_content": 3, "title_only": 5, "blank": 6}
CHART_TYPES = {"bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
               "bar_h": XL_CHART_TYPE.BAR_CLUSTERED,
               "line": XL_CHART_TYPE.LINE_MARKERS,
               "pie": XL_CHART_TYPE.PIE}
SHAPE_TYPES = {"rectangle": MSO_SHAPE.RECTANGLE,
               "rounded_rectangle": MSO_SHAPE.ROUNDED_RECTANGLE,
               "oval": MSO_SHAPE.OVAL, "diamond": MSO_SHAPE.DIAMOND,
               "right_arrow": MSO_SHAPE.RIGHT_ARROW,
               "chevron": MSO_SHAPE.CHEVRON}
# OpenMA port: allowed spec keys, checked by validate_spec.
TOP_LEVEL_KEYS = ("slide_size", "slides")
SLIDE_KEYS = ("layout", "title", "subtitle", "bullets", "background",
              "footer", "slide_number", "notes", "images", "tables",
              "shapes", "charts")
SUBTITLE_HEIGHT = Inches(0.6)


class SpecError(ValueError):
    """The deck spec has a key or value the script would drop or misread."""


def _unknown(keys, allowed):
    return sorted(repr(key) for key in keys if key not in allowed)


def validate_spec(spec):
    """Raise SpecError when the spec holds anything build_slide would drop."""
    if not isinstance(spec, dict):
        raise SpecError("the spec must be a JSON object")
    unknown = _unknown(spec, TOP_LEVEL_KEYS)
    if unknown:
        raise SpecError(f"unknown top-level key {', '.join(unknown)}; "
                        f"allowed: {', '.join(TOP_LEVEL_KEYS)}")
    slides = spec.get("slides", [])
    if not isinstance(slides, list):
        raise SpecError('"slides" must be a list of slide objects')
    for number, slide in enumerate(slides, start=1):
        where = f"slide {number}"
        if not isinstance(slide, dict):
            raise SpecError(f"{where}: a slide must be a JSON object")
        unknown = _unknown(slide, SLIDE_KEYS)
        if unknown:
            raise SpecError(f"{where}: unknown key {', '.join(unknown)}; "
                            f"allowed: {', '.join(SLIDE_KEYS)}")
        layout = slide.get("layout", "title_content")
        if layout not in LAYOUTS:
            raise SpecError(f"{where}: unknown layout {layout!r}; "
                            f"allowed: {', '.join(LAYOUTS)}")


def style_run(run, spec):
    """Apply font styling from a bullet/text spec dict to a run."""
    font = run.font
    if spec.get("size"):
        font.size = Pt(spec["size"])
    if spec.get("bold") is not None:
        font.bold = spec["bold"]
    if spec.get("italic") is not None:
        font.italic = spec["italic"]
    if spec.get("font"):
        font.name = spec["font"]
    if spec.get("color"):
        font.color.rgb = RGBColor.from_string(spec["color"])
    if spec.get("link"):
        run.hyperlink.address = spec["link"]


def add_bullets(text_frame, bullets):
    text_frame.clear()
    for i, item in enumerate(bullets):
        if isinstance(item, str):
            item = {"text": item}
        para = text_frame.paragraphs[0] if i == 0 else text_frame.add_paragraph()
        para.level = int(item.get("level", 0))
        run = para.add_run()
        run.text = item.get("text", "")
        style_run(run, item)


def copy_layout_placeholder(slide, ph_idx):
    """Copy a layout placeholder (footer=11, slide number=12) onto the
    slide so it actually renders; returns the shape or None if the layout
    does not provide it."""
    for ph in slide.slide_layout.placeholders:
        if ph.placeholder_format.idx == ph_idx:
            slide.shapes._spTree.append(copy.deepcopy(ph._element))
            for shape in slide.placeholders:
                if shape.placeholder_format.idx == ph_idx:
                    return shape
    return None


def place_subtitle(slide, text, has_bullets):
    """Write the subtitle and return the placeholder it took, or None.

    OpenMA port: the source wrote the subtitle into placeholder 1 and the
    bullets then cleared that same placeholder, so the subtitle vanished.
    """
    for ph in slide.placeholders:
        if ph.placeholder_format.type == PP_PLACEHOLDER.SUBTITLE:
            ph.text = text
            return ph
    if not has_bullets:
        for ph in slide.placeholders:
            if ph.placeholder_format.idx == 1:
                ph.text = text
                return ph
    title = slide.shapes.title
    if title is not None:
        left, top, width = title.left, title.top + title.height, title.width
        title_top = title.top
    else:
        left, top, width = Inches(0.5), Inches(0.3), Inches(9)
        title_top = 0
    box = slide.shapes.add_textbox(left, top, width, SUBTITLE_HEIGHT)
    box.text_frame.word_wrap = True
    run = box.text_frame.paragraphs[0].add_run()
    run.text = text
    run.font.size = Pt(20)
    # Move the body down so the subtitle and the first bullet do not overlap.
    for ph in slide.placeholders:
        if ph.placeholder_format.idx in (0, 10, 11, 12):
            continue
        # Read all four first: the slide placeholder inherits its geometry
        # from the layout until every value is set on the slide itself.
        x, y, w, h = ph.left, ph.top, ph.width, ph.height
        # Only a body below the title moves; the section layout keeps its
        # body above the title.
        if title_top <= y < top + SUBTITLE_HEIGHT:
            shift = top + SUBTITLE_HEIGHT - y
            ph.left, ph.top, ph.width = x, y + shift, w
            ph.height = max(h - shift, Inches(1))
    return None


def build_slide(prs, spec):
    layout_idx = LAYOUTS.get(spec.get("layout", "title_content"), 1)
    slide = prs.slides.add_slide(prs.slide_layouts[layout_idx])

    if spec.get("background"):
        fill = slide.background.fill
        fill.solid()
        fill.fore_color.rgb = RGBColor.from_string(spec["background"])
    if spec.get("slide_number"):
        copy_layout_placeholder(slide, 12)
    if spec.get("footer"):
        shape = copy_layout_placeholder(slide, 11)
        if shape is not None:
            shape.text_frame.text = spec["footer"]

    if spec.get("title") is not None and slide.shapes.title is not None:
        slide.shapes.title.text = spec["title"]
    subtitle_ph = None
    if spec.get("subtitle") is not None:
        subtitle_ph = place_subtitle(slide, spec["subtitle"],
                                     bool(spec.get("bullets")))
    if spec.get("bullets"):
        body = next((ph for ph in slide.placeholders
                     if ph.placeholder_format.idx not in (0, 11, 12)
                     and ph is not subtitle_ph), None)
        if body is None:
            body = slide.shapes.add_textbox(Inches(0.5), Inches(1.5),
                                            Inches(9), Inches(5))
        add_bullets(body.text_frame, spec["bullets"])

    for img in spec.get("images", []):
        kwargs = {}
        if img.get("width"):
            kwargs["width"] = Inches(img["width"])
        if img.get("height"):
            kwargs["height"] = Inches(img["height"])
        slide.shapes.add_picture(img["path"], Inches(img.get("left", 1)),
                                 Inches(img.get("top", 1)), **kwargs)

    for tbl in spec.get("tables", []):
        rows = tbl["rows"]
        shape = slide.shapes.add_table(
            len(rows), len(rows[0]), Inches(tbl.get("left", 1)),
            Inches(tbl.get("top", 2)), Inches(tbl.get("width", 6)),
            Inches(tbl.get("height", 2)))
        for r, row in enumerate(rows):
            for c, val in enumerate(row):
                shape.table.cell(r, c).text = str(val)

    for shp in spec.get("shapes", []):
        shape = slide.shapes.add_shape(
            SHAPE_TYPES.get(shp.get("type", "rectangle"), MSO_SHAPE.RECTANGLE),
            Inches(shp.get("left", 1)), Inches(shp.get("top", 1)),
            Inches(shp.get("width", 2)), Inches(shp.get("height", 1)))
        if shp.get("fill"):
            shape.fill.solid()
            shape.fill.fore_color.rgb = RGBColor.from_string(shp["fill"])
        if shp.get("text"):
            shape.text_frame.text = shp["text"]
            if shp.get("text_color"):
                run = shape.text_frame.paragraphs[0].runs[0]
                run.font.color.rgb = RGBColor.from_string(shp["text_color"])

    for cht in spec.get("charts", []):
        data = CategoryChartData()
        data.categories = cht["categories"]
        for name, values in cht["series"].items():
            data.add_series(name, values)
        frame = slide.shapes.add_chart(
            CHART_TYPES.get(cht.get("type", "bar"),
                            XL_CHART_TYPE.COLUMN_CLUSTERED),
            Inches(cht.get("left", 1)), Inches(cht.get("top", 2)),
            Inches(cht.get("width", 6)), Inches(cht.get("height", 4)), data)
        if cht.get("title"):
            frame.chart.has_title = True
            frame.chart.chart_title.text_frame.text = cht["title"]

    if spec.get("notes"):
        slide.notes_slide.notes_text_frame.text = spec["notes"]
    return slide


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Create a .pptx deck from a JSON spec.",
        epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec", help="path to JSON deck spec")
    parser.add_argument("output", help="output .pptx path")
    args = parser.parse_args(argv)

    with open(args.spec, encoding="utf-8") as fh:
        spec = json.load(fh)
    try:
        validate_spec(spec)
    except SpecError as exc:
        print(f"Spec error in {args.spec}: {exc}", file=sys.stderr)
        return 1

    prs = Presentation()
    if spec.get("slide_size", "16:9") == "16:9":
        prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    else:
        prs.slide_width, prs.slide_height = Inches(10), Inches(7.5)

    for slide_spec in spec.get("slides", []):
        build_slide(prs, slide_spec)

    prs.save(args.output)
    print(json.dumps({"ok": True, "output": args.output,
                      "slides": len(prs.slides._sldIdLst)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
