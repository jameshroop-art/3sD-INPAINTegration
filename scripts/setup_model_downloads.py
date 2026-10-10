#!/usr/bin/env python3
"""Initialize acquisition directories and an empty no-pip environment."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

from fetch_models import ROOT, authorize, read_json, validate_destinations


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=ROOT / "offline/policy.json")
    parser.add_argument("--manifest", type=Path, default=ROOT / "models/manifest.json")
    parser.add_argument("--model-root", type=Path, default=ROOT / "models")
    parser.add_argument("--venv", type=Path, default=ROOT / ".venv-acquisition")
    parser.add_argument("--acquisition-only", action="store_true")
    parser.add_argument("--connected-machine", action="store_true")
    args = parser.parse_args(argv)
    try:
        authorize(args)
        if sys.version_info[:2] != (3, 12):
            raise ValueError("Acquisition bootstrap requires a trusted Python 3.12 interpreter")
        root = args.model_root.absolute()
        target = args.venv.absolute()
        for path in (root, target):
            if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
                raise ValueError("Setup paths cannot contain symlinks")
        if target.exists():
            raise ValueError("Acquisition venv already exists; refusing overwrite")
        validate_destinations(read_json(args.manifest)["models"])
        # Do not pre-create archive destinations or their descendants.
        root.mkdir(parents=True, exist_ok=True)
        environment = {"PATH": os.defpath, "LANG": "C.UTF-8", "PYTHONNOUSERSITE": "1",
                       "PIP_NO_INDEX": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1"}
        subprocess.run([sys.executable, "-I", "-m", "venv", "--without-pip", str(target)],
                       check=True, env=environment)
        print("Acquisition model root/empty Python 3.12 venv initialized; no pip updates or models installed.")
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
