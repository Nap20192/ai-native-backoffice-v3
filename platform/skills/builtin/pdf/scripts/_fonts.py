"""Unicode TTF font registration for reportlab (OpenMA platform port).

reportlab's built-in Helvetica covers Latin-1 only: Cyrillic and other
scripts come out as black boxes. ``unicode_fonts()`` registers DejaVu Sans
(regular and bold) when it is installed and returns the font names to use,
falling back to Helvetica with a one-line hint on stderr.

Lookup order: ``PDF_FONT_PATH`` / ``PDF_FONT_BOLD_PATH`` environment
variables, then the usual Debian, Arch and macOS locations.
"""
from __future__ import annotations

import os
import sys

_REGULAR = "DejaVuSans"
_BOLD = "DejaVuSans-Bold"
_DIRS = (
    "/usr/share/fonts/truetype/dejavu",  # Debian/Ubuntu: fonts-dejavu-core
    "/usr/share/fonts/TTF",  # Arch: ttf-dejavu
    "/usr/share/fonts/dejavu",  # Fedora, Alpine
    "/Library/Fonts",
    os.path.expanduser("~/Library/Fonts"),
)
_cache: tuple[str, str] | None = None


def _find(env_name: str, filename: str) -> str | None:
    explicit = os.environ.get(env_name)
    if explicit and os.path.isfile(explicit):
        return explicit
    for directory in _DIRS:
        path = os.path.join(directory, filename)
        if os.path.isfile(path):
            return path
    return None


def unicode_fonts() -> tuple[str, str]:
    """Return ``(regular, bold)`` font names registered with reportlab."""
    global _cache
    if _cache is not None:
        return _cache
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    regular = _find("PDF_FONT_PATH", "DejaVuSans.ttf")
    if regular is None:
        print("Warning: DejaVuSans.ttf not found, non-Latin text will not render. "
              "Install it with 'apt-get install fonts-dejavu-core' or set PDF_FONT_PATH.",
              file=sys.stderr)
        _cache = ("Helvetica", "Helvetica-Bold")
        return _cache
    bold = _find("PDF_FONT_BOLD_PATH", "DejaVuSans-Bold.ttf") or regular
    pdfmetrics.registerFont(TTFont(_REGULAR, regular))
    pdfmetrics.registerFont(TTFont(_BOLD, bold))
    pdfmetrics.registerFontFamily(_REGULAR, normal=_REGULAR, bold=_BOLD,
                                  italic=_REGULAR, boldItalic=_BOLD)
    _cache = (_REGULAR, _BOLD)
    return _cache
