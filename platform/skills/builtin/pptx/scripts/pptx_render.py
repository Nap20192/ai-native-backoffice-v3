#!/usr/bin/env python3
"""Render every slide of a .pptx to per-slide PNG images.

Pipeline: LibreOffice (soffice --headless --convert-to pdf) turns the deck
into a PDF, then poppler (pdftoppm, or pdftocairo as an alternate) splits
the PDF into one PNG per slide.

Output is JSON. When both tools are present:
  {"rendered": true, "files": ["render/slide-1.png", ...]}
When either tool is missing the script still exits 0 and reports:
  {"rendered": false, "missing": ["soffice"], "guidance": "..."}
so callers can degrade gracefully (fall back to pptx_read.py --outline).

OpenMA port: LibreOffice is found as `soffice` or `libreoffice` and runs
through _soffice.py with its own temporary profile and a --timeout. When it
is missing, the guidance names the environment image that has it. A failed
or hung conversion exits 1 with one line on stderr instead of a traceback.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

from _soffice import MISSING_GUIDANCE, OfficeError, convert, find_soffice


def find_tools():
    """Return (soffice, splitter, missing) using shutil.which."""
    soffice = find_soffice()
    splitter = shutil.which("pdftoppm") or shutil.which("pdftocairo")
    missing = []
    if not soffice:
        missing.append("soffice")
    if not splitter:
        missing.append("pdftoppm (or pdftocairo)")
    return soffice, splitter, missing


def render(pptx_path, out_dir, prefix, dpi, timeout=180):
    soffice, splitter, missing = find_tools()
    if missing:
        return {
            "rendered": False, "missing": missing,
            "guidance": MISSING_GUIDANCE + " Until then, verify decks "
                        "with pptx_read.py --outline.",
        }

    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        pdf = str(convert(soffice, pptx_path, tmp, "pdf", timeout))
        out_prefix = os.path.join(out_dir, prefix)
        try:
            proc = subprocess.run(
                [splitter, "-png", "-r", str(dpi), pdf, out_prefix],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise OfficeError(f"{os.path.basename(splitter)} timed out "
                              f"after {timeout} s") from None
        if proc.returncode != 0:
            raise OfficeError(f"{os.path.basename(splitter)} failed: "
                              f"{proc.stderr.strip()}")

    files = sorted(glob.glob(out_prefix + "*.png"))
    return {"rendered": True, "files": files}


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Render each slide of a .pptx to a PNG via "
                    "soffice + pdftoppm/pdftocairo.",
        epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pptx", help="path to the .pptx file")
    parser.add_argument("--outdir", default="render",
                        help="directory for PNGs (default: ./render)")
    parser.add_argument("--prefix", default="slide",
                        help="PNG filename prefix (default: slide)")
    parser.add_argument("--dpi", type=int, default=80,
                        help="render resolution (default: 80)")
    parser.add_argument("--timeout", type=int, default=180,
                        help="seconds per conversion step (default: 180)")
    args = parser.parse_args(argv)

    try:
        result = render(args.pptx, args.outdir, args.prefix, args.dpi,
                        args.timeout)
    except OfficeError as exc:
        print(f"Render failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
