#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# No network bootstrap or pip update: a mutable upgrade conflicts with pinned wheels.
exec python3 "$ROOT/scripts/setup_model_downloads.py" "$@"
