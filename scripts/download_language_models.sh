#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# The manifest includes BOTH text shards and the matching vision projector.
exec python3 "$ROOT/scripts/fetch_models.py" --group language "$@"
