#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Default inventory intentionally fails until each requested source is approved.
exec python3 "$ROOT/scripts/clone_external_repos.py" \
  --source sam2 --source sapiens --source stable-diffusion.cpp --source llama.cpp "$@"
