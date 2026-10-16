#!/bin/sh
set -eu
# CPython loses the venv when invoked through a symlink outside the venv.
export VIRTUAL_ENV=/opt/venv
exec "$VIRTUAL_ENV/bin/$(basename "$0")" "$@"
