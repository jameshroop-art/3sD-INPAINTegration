#!/usr/bin/env python3
"""Acquire pinned source for review/building only, never during creation runtime."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

from fetch_models import ROOT, authorize, read_json, safe_target


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=ROOT / "offline/manifests/sources.lock.json")
    parser.add_argument("--destination", type=Path, default=ROOT / "external")
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--policy", type=Path, default=ROOT / "offline/policy.json")
    parser.add_argument("--acquisition-only", action="store_true")
    parser.add_argument("--connected-machine", action="store_true")
    args = parser.parse_args(argv)
    try:
        authorize(args)
        sources = read_json(args.lock)["sources"]
        selected = [item for item in sources if item["id"] in args.source]
        if {item["id"] for item in selected} != set(args.source):
            raise ValueError("Unknown source selection")
        for item in selected:
            if item.get("status") != "ready" or not re.fullmatch(r"[0-9a-f]{40}", item.get("commit") or ""):
                raise ValueError(item["id"] + ": blocked until real source commit is reviewed/pinned")
            if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", item.get("repo") or ""):
                raise ValueError("Only reviewed GitHub HTTPS source repositories are supported")
        root = args.destination.absolute()
        if root.is_symlink() or any(parent.is_symlink() for parent in root.parents):
            raise ValueError("Destination cannot contain symlinks")
        root.mkdir(parents=True, exist_ok=True)
        root = root.resolve()
        environment = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_LFS_SKIP_SMUDGE="1",
                           GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
        for item in selected:
            destination = safe_target(root, item["id"])
            if destination.exists():
                raise ValueError("Existing external destination; refusing overwrite")
            scratch = root / (".source-" + uuid.uuid4().hex)
            scratch.mkdir(mode=0o700)
            try:
                def git(*arguments, capture=False):
                    return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never",
                                           "-c", "filter.lfs.required=false", "-C", str(scratch), *arguments],
                                          check=True, env=environment, text=True,
                                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL)
                git("init", "--quiet")
                git("remote", "add", "origin", "https://github.com/" + item["repo"] + ".git")
                git("fetch", "--quiet", "--depth=1", "origin", item["commit"])
                if git("rev-parse", "FETCH_HEAD", capture=True).stdout.strip() != item["commit"]:
                    raise ValueError("Fetched source differs from pinned commit")
                git("checkout", "--quiet", "--detach", item["commit"])
                os.replace(scratch, destination)
                print(item["id"] + ": source pinned; not installed or executed")
            finally:
                if scratch.exists():
                    shutil.rmtree(scratch)
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
