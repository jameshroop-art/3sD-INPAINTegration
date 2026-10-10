#!/usr/bin/env python3
"""Explicit connected-machine acquisition; never imported by creation adapters."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import time
import urllib.request
import urllib.parse
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key: " + key)
            result[key] = value
        return result
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=unique)


def authorize(args):
    if not args.acquisition_only or not args.connected_machine:
        raise ValueError("Require --acquisition-only and --connected-machine.")
    if not Path(args.policy).is_absolute():
        raise ValueError("Acquisition requires an absolute path to a separate reviewed policy.")
    if Path(args.policy).resolve() == (ROOT / "offline/policy.json").resolve():
        raise ValueError("Creation policy cannot authorize acquisition; provide a separate explicit policy.")
    policy = read_json(args.policy)
    if set(policy) != {"offline_required", "acquisition_only"}:
        raise ValueError("Acquisition policy must be separate and contain only offline_required/acquisition_only.")
    if policy.get("offline_required") is not False or policy.get("acquisition_only") is not True:
        raise ValueError("Separate acquisition policy must set offline_required=false and acquisition_only=true.")


def relative_path(value):
    if not isinstance(value, str) or "\\" in value or "\0" in value:
        raise ValueError("Invalid relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in ("..", ".", "") for part in value.split("/")):
        raise ValueError("Unsafe relative path: " + value)
    if ":" in value:
        raise ValueError("Drive-qualified paths are not allowed")
    return path


def safe_target(root, value):
    path = root.joinpath(*relative_path(value).parts)
    current = root
    for part in path.relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink in destination: " + str(current))
    return path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def trusted(entry):
    if entry.get("status") != "ready":
        raise ValueError(f"{entry['id']}: blocked; human review required")
    if not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256") or ""):
        raise ValueError(f"{entry['id']}: trusted SHA-256 required BEFORE acquisition")
    size = entry.get("size_bytes")
    if type(size) is not int or size <= 0:
        raise ValueError(f"{entry['id']}: positive reviewed size_bytes required")
    relative_path(entry["destination"])
    return size


def validate_destinations(entries):
    destinations = [relative_path(entry["destination"]) for entry in entries]
    if len({entry["id"] for entry in entries}) != len(entries) or len(set(destinations)) != len(destinations):
        raise ValueError("Duplicate model IDs or destinations")
    for index, path in enumerate(destinations):
        for other in destinations[index + 1:]:
            if path in other.parents or other in path.parents:
                raise ValueError("Nested model destinations may overwrite trusted assets")


def deployment_records(entry, destination):
    spec = entry["extraction"]
    if spec["type"] == "none":
        return [entry]
    records = []
    for member in spec["members"]:
        file = safe_target(destination, member)
        expected = spec["member_sha256"][member]
        if not file.is_file() or digest(file) != expected:
            raise ValueError("Deployment member integrity mismatch")
        records.append({
            "id": entry["id"] + ":" + member, "group": entry["group"],
            "source_url": None, "destination": entry["destination"] + "/" + member,
            "extraction": {"type": "none"}, "license": entry["license"],
            "required": entry["required"], "status": "ready",
            "sha256": expected, "size_bytes": file.stat().st_size,
            "parent_id": entry["id"], "parent_sha256": entry["sha256"],
            "parent_source_url": entry["source_url"],
            "acquisition": "deployment-only"
        })
    return records


def write_deployment(path, manifest, replacements):
    records = []
    for entry in manifest["models"]:
        records.extend(replacements.get(entry["id"], [entry]))
    validate_destinations(records)
    output = dict(manifest, models=records,
                  comment="Local deployment records derived from authenticated acquisition. Review and authenticate this manifest before offline use; not an acquisition manifest.")
    staging = path.parent / (".deployment-" + uuid.uuid4().hex)
    try:
        with staging.open("x", encoding="utf-8") as stream:
            json.dump(output, stream, indent=2)
            stream.write("\n")
        # Exclusive publication refuses existing outputs, including concurrent creation.
        os.link(staging, path)
    finally:
        staging.unlink(missing_ok=True)


class HTTPSOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise ValueError("Refusing non-HTTPS redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def obtain(entry, target, local_dir, retries):
    size = trusted(entry)
    candidate = safe_target(local_dir.resolve(), entry["id"]) if local_dir else None
    if candidate and candidate.is_file():
        if candidate.stat().st_size != size or digest(candidate) != entry["sha256"]:
            raise ValueError(entry["id"] + ": local fallback hash/size mismatch")
        shutil.copyfile(candidate, target)
    else:
        url = entry.get("source_url")
        if not isinstance(url, str) or urllib.parse.urlsplit(url).scheme != "https":
            raise ValueError(entry["id"] + ": reviewed HTTPS source_url required")
        opener = urllib.request.build_opener(HTTPSOnly())
        for attempt in range(retries + 1):
            try:
                with opener.open(url, timeout=60) as response, target.open("wb") as stream:
                    count = 0
                    while True:
                        block = response.read(min(1024 * 1024, size - count + 1))
                        if not block:
                            break
                        count += len(block)
                        if count > size:
                            raise ValueError("Download exceeds reviewed size")
                        stream.write(block)
                break
            except (OSError, ValueError):
                target.unlink(missing_ok=True)
                if attempt == retries:
                    raise
                time.sleep(min(2 ** attempt, 8))
    if target.stat().st_size != size or digest(target) != entry["sha256"]:
        raise ValueError(entry["id"] + ": downloaded hash/size mismatch")


def extract(archive, destination, spec):
    kind = spec.get("type")
    if kind not in ("zip", "tar"):
        raise ValueError("Unsupported archive type")
    allowed = {str(relative_path(name)) for name in spec.get("members", [])}
    limit = spec.get("max_size_bytes")
    if not allowed or type(limit) is not int or limit <= 0:
        raise ValueError("Archive requires reviewed members and max_size_bytes")
    member_hashes = spec.get("member_sha256", {})
    if set(member_hashes) != allowed or any(not re.fullmatch(r"[0-9a-f]{64}", value or "") for value in member_hashes.values()):
        raise ValueError("Every archive member requires an individually trusted SHA-256")
    seen = set()
    all_names = set()
    total = 0
    container = zipfile.ZipFile(archive) if kind == "zip" else tarfile.open(archive, "r:*")
    with container:
        members = container.infolist() if kind == "zip" else container.getmembers()
        if len(members) > 10000:
            raise ValueError("Too many archive members")
        for member in members:
            name = member.filename if kind == "zip" else member.name
            directory = member.is_dir() if kind == "zip" else member.isdir()
            normalized = str(relative_path(name.rstrip("/")))
            if normalized in all_names:
                raise ValueError("Duplicate archive path: " + normalized)
            all_names.add(normalized)
            mode = member.external_attr >> 16 if kind == "zip" else member.mode
            if kind == "zip":
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise ValueError("Archive links/special files forbidden")
            elif not (member.isfile() or member.isdir()):
                raise ValueError("Archive links/special files forbidden")
            if directory:
                if not any(item.startswith(normalized + "/") for item in allowed):
                    raise ValueError("Unexpected archive directory")
                continue
            if normalized not in allowed or normalized in seen:
                raise ValueError("Unexpected or duplicate archive path: " + normalized)
            seen.add(normalized)
            size = member.file_size if kind == "zip" else member.size
            total += size
            if size < 0 or total > limit:
                raise ValueError("Oversized extracted archive")
            output = safe_target(destination, normalized)
            output.parent.mkdir(parents=True, exist_ok=True)
            source = container.open(member) if kind == "zip" else container.extractfile(member)
            with source, output.open("xb") as stream:
                count = 0
                while True:
                    block = source.read(min(1024 * 1024, size - count + 1))
                    if not block:
                        break
                    count += len(block)
                    if count > size:
                        raise ValueError("Archive size mismatch")
                    stream.write(block)
                if count != size:
                    raise ValueError("Archive size mismatch")
            if digest(output) != member_hashes[normalized]:
                raise ValueError("Extracted member SHA-256 mismatch: " + normalized)
        if seen != allowed:
            raise ValueError("Archive missing required paths")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "models/manifest.json")
    parser.add_argument("--model-root", type=Path, default=ROOT / "models")
    parser.add_argument("--group", action="append")
    parser.add_argument("--include-optional", action="store_true", help="Explicitly acquire optional assets too")
    parser.add_argument("--deployment-manifest", type=Path,
                        help="Write a new local deployment manifest with trusted archive-member records")
    parser.add_argument("--local-dir", type=Path)
    parser.add_argument("--policy", type=Path, default=ROOT / "offline/policy.json")
    parser.add_argument("--acquisition-only", action="store_true")
    parser.add_argument("--connected-machine", action="store_true")
    parser.add_argument("--retries", type=int, default=2)
    args = parser.parse_args(argv)
    try:
        authorize(args)
        if not 0 <= args.retries <= 5:
            raise ValueError("Retries must be between 0 and 5")
        manifest = read_json(args.manifest)
        entries = [entry for entry in manifest["models"]
                   if (not args.group or entry["group"] in args.group)
                   and (entry.get("required") is True or args.include_optional)]
        if not entries:
            raise ValueError("No models selected")
        validate_destinations(entries)
        errors = []
        for entry in entries:
            try:
                trusted(entry)
            except ValueError as error:
                errors.append(str(error))
        if errors:
            raise ValueError("\n".join(errors))
        root = args.model_root.absolute()
        if root.is_symlink() or any(parent.is_symlink() for parent in root.parents):
            raise ValueError("Model root cannot contain symlinks")
        root.mkdir(parents=True, exist_ok=True)
        root = root.resolve()
        deployment = args.deployment_manifest.absolute() if args.deployment_manifest else None
        if deployment:
            if deployment.exists() or deployment.is_symlink() or any(parent.is_symlink() for parent in deployment.parents):
                raise ValueError("Deployment output must be new and contain no symlinks")
            if not deployment.parent.is_dir() or deployment == root or root in deployment.parents:
                raise ValueError("Deployment output requires an existing parent outside model root")
        replacements = {}
        for entry in entries:
            destination = safe_target(root, entry["destination"])
            spec = entry["extraction"]
            if spec["type"] not in ("none", "zip", "tar"):
                raise ValueError("Unsupported extraction type")
            if spec["type"] != "none":
                if not spec.get("members") or type(spec.get("max_size_bytes")) is not int or spec["max_size_bytes"] <= 0:
                    raise ValueError("Reviewed archive members and size limit required before download")
                for member in spec["members"]:
                    relative_path(member)
                hashes = spec.get("member_sha256", {})
                if set(hashes) != set(spec["members"]) or any(not re.fullmatch(r"[0-9a-f]{64}", value or "") for value in hashes.values()):
                    raise ValueError("Reviewed archive member hashes required before download")
            if destination.exists():
                if spec["type"] == "none" and destination.is_file() and destination.stat().st_size == entry["size_bytes"] and digest(destination) == entry["sha256"]:
                    print(entry["id"] + ": already verified")
                    continue
                raise ValueError("Existing destination differs or is an unverified extracted directory")
            scratch = root / (".acquisition-" + uuid.uuid4().hex)
            scratch.mkdir(mode=0o700)
            try:
                archive = scratch / "payload"
                obtain(entry, archive, args.local_dir, args.retries)
                staged = archive
                if spec["type"] != "none":
                    staged = scratch / "extracted"
                    staged.mkdir()
                    extract(archive, staged, spec)
                destination.parent.mkdir(parents=True, exist_ok=True)
                safe_target(root, entry["destination"])
                os.replace(staged, destination)
                replacements[entry["id"]] = deployment_records(entry, destination)
                print(entry["id"] + ": verified and staged")
            finally:
                shutil.rmtree(scratch)
        if deployment:
            write_deployment(deployment, manifest, replacements)
        return 0
    except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
