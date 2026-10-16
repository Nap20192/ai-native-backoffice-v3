#!/bin/sh
set -eu
tag=${1:?Usage: smoke.sh IMAGE}
docker run --rm --entrypoint /bin/bash "$tag" -euc '
  test -x /bin/bash
  python --version
  python -c "import pptx, docx, openpyxl, pypdf, pdfplumber, reportlab, pandas, matplotlib, bs4, lxml, requests"
  python -c "import sys; assert sys.prefix == \"/opt/venv\""
  python -m pip install --no-cache-dir tomli-w==1.2.0
  python -c "import tomli_w; assert tomli_w.__file__.startswith(\"/opt/venv/\")"
  test -n "$(fc-list :lang=ru)"
  python /opt/oma/selftest/render-ru.py --json
'
