#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Buffalo-L is installed only after whole-archive hash and reviewed member checks.
exec python3 "$ROOT/scripts/fetch_models.py" --group face "$@"
