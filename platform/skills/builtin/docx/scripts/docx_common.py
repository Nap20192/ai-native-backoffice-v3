#!/usr/bin/env python3
# MIT License. Shared helpers for the docx skill scripts.
"""Shared helpers: paragraph iteration and run-preserving text replacement."""
from __future__ import annotations


def iter_all_paragraphs(doc, include_headers_footers: bool = True):
    """Yield every paragraph in body, tables (recursively), headers, footers."""
    yield from _iter_container(doc)
    if include_headers_footers:
        for section in doc.sections:
            for part in (
                section.header, section.footer,
                section.first_page_header, section.first_page_footer,
                section.even_page_header, section.even_page_footer,
            ):
                if part is not None:
                    yield from _iter_container(part)


def _iter_container(container):
    yield from container.paragraphs
    for table in container.tables:
        yield from _iter_table(table)


def _iter_table(table):
    for row in table.rows:
        for cell in row.cells:
            yield from cell.paragraphs
            for nested in cell.tables:
                yield from _iter_table(nested)


def iter_part_roots(doc):
    """Yield the XML root of the body plus every header/footer part."""
    yield doc.element.body
    seen = set()
    for section in doc.sections:
        for part in (
            section.header, section.footer,
            section.first_page_header, section.first_page_footer,
            section.even_page_header, section.even_page_footer,
        ):
            if part is not None and id(part._element) not in seen:
                seen.add(id(part._element))
                yield part._element


def replace_in_paragraph(para, old: str, new: str) -> int:
    """Replace `old` with `new` in a paragraph, preserving run formatting.

    Strategy: find non-overlapping occurrences in the run text, left to
    right, then replace them right to left. An occurrence inside a single
    run keeps that run's formatting. If the needle spans multiple runs, the
    matched runs are collapsed: the replacement inherits the formatting of
    the run where the match starts. Returns number of replacements made.
    """
    if not old or old not in para.text:
        return 0
    # OpenMA port: the source re-scanned the paragraph after every
    # replacement and looped forever when `new` contains `old` ("Acme" ->
    # "Acme Ltd"). Matches are now found once in the original text and
    # applied right to left, so inserted text is never searched again.
    runs = para.runs
    bounds = []  # original (start, end) offsets of each run
    pos = 0
    for r in runs:
        bounds.append((pos, pos + len(r.text)))
        pos += len(r.text)
    full = "".join(r.text for r in runs)
    starts = []
    found = full.find(old)
    while found >= 0:
        starts.append(found)
        found = full.find(old, found + len(old))
    for start in reversed(starts):
        end = start + len(old)
        # (run_idx, cut_start, cut_end) portions inside the match. Later
        # matches only changed text after `end`, so the cuts stay valid.
        spans = [(i, max(start, r_start) - r_start, min(end, r_end) - r_start)
                 for i, (r_start, r_end) in enumerate(bounds)
                 if r_end > start and r_start < end]
        first = True
        for i, cs, ce in spans:
            t = runs[i].text
            if first:
                # A match inside one run keeps that run's formatting; a
                # match across runs takes the formatting of its first run.
                runs[i].text = t[:cs] + new + t[ce:]
                first = False
            else:
                runs[i].text = t[:cs] + t[ce:]
    return len(starts)
