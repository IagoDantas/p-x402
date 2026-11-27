#!/bin/sh
# Runs the Python SDK tests (every case in spec/test-vectors plus the client tests).
# Creates sdks/python/.venv on first use; needs only python3 (3.9 or later) and pip.
set -eu
cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  "$PYTHON" -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade pip
fi
.venv/bin/python -m pip install --quiet -e '.[dev]'
exec .venv/bin/python -m pytest "$@"
