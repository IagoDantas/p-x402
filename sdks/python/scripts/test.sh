#!/bin/sh
# Runs the Python SDK tests (every case in spec/test-vectors plus the client and server tests).
set -eu
cd "$(dirname "$0")/.."
PY="$(sh scripts/venv.sh)"
exec "$PY" -m pytest "$@"
