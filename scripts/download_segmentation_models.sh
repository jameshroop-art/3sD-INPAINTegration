#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Explicit flags and separate acquisition policy are passed through, never inferred.
exec python3 "$ROOT/scripts/fetch_models.py" --group segmentation "$@"
