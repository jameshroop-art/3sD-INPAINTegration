#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Default inventory intentionally fails until each requested source is approved.
sources=(--source sam2 --source sapiens --source stable-diffusion.cpp --source llama.cpp)
for arg in "$@"; do
  if [[ "$arg" == --source || "$arg" == --source=* ]]; then
    sources=()
    break
  fi
done
exec python3 "$ROOT/scripts/clone_external_repos.py" "${sources[@]}" "$@"
