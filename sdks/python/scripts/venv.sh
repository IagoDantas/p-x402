#!/bin/sh
# Creates sdks/python/.venv on first use and installs the SDK with its dev extras (pytest, FastAPI,
# uvicorn). Needs only python3 (3.9 or later) and pip. Prints the venv's python path.
set -eu
cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  "$PYTHON" -m venv .venv >&2
  .venv/bin/python -m pip install --quiet --upgrade pip >&2
fi
.venv/bin/python -m pip install --quiet -e '.[dev]' >&2
echo "$(pwd)/.venv/bin/python"
