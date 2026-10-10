"""Fail-closed primitives shared by the offline commands (Python standard library only)."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import stat
import subprocess
import sys

TARGETS = ("linux-gpu-cuda", "linux-cpu", "macos-m1", "windows-gpu-cuda")
RUNTIME_ROOT = "offline/runtime"
WHEELHOUSE_ROOT = "offline/wheelhouse"
AUDIT_PATH = "offline/logs/audit.jsonl"
POLICY = {
    "policy_version": 1, "offline_required": True, "acquisition_on_creation_device": False,
    "install_from_local_wheels_only": True, "verify_artifact_hashes": True,
    "require_pinned_dependencies": True, "allow_remote_dependency_references": False,
    "allow_runtime_downloads": False, "allow_remote_model_code": False,
    "allow_cloud_inference": False, "allow_telemetry": False, "allow_crash_uploads": False,
    "allow_update_checks": False, "allow_public_share_links": False, "allow_external_ui_assets": False,
    "require_verified_network_isolation": True, "unsupported_platform_action": "refuse",
    "missing_asset_action": "fail", "logs": "local_only", "model_root": "models",
    "work_root": "work", "output_root": "out",
    "comment": "Enforced by launcher. Acquisition-only machine may temporarily disable, but creation device must never connect."
}
MODEL_KEYS = {
    "detection": ("person_detector",),
    "pose": ("wholebody_fallback", "wholebody_3d"),
    "segmentation": ("sam2_checkpoint", "birefnet_package"),
    "face": ("insightface_root", "face_landmarker", "face_parser"),
    "llm": ("text_model", "vision_model", "vision_projector"),
    "inpaint": ("checkpoint", "openpose_control", "depth_control", "hair_lineart_control")
}
HEX = re.compile(r"[0-9a-f]{64}")


class OfflineError(Exception):
    pass


def fail(message):
    raise OfflineError(message)


def local(root, value, exists=True):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        fail("Use a nonempty relative POSIX path.")
    pieces = value.split("/")
    if any(p in ("", ".", "..") for p in pieces) or Path(value).is_absolute() or ":" in value:
        fail("Absolute paths and path traversal are forbidden.")
    root = Path(root)
    if ".." in root.parts:
        fail("Root path traversal is forbidden.")
    if any(parent.is_symlink() for parent in (root, *root.parents)):
        fail("Local root and its ancestors must not be symlinks.")
    result = root
    for piece in pieces:
        result = result / piece
        if result.is_symlink():
            fail("Symlink paths are forbidden.")
    if exists and not result.exists():
        fail("A required local file is missing; stage the trusted offline bundle.")
    return result


def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail("Duplicate JSON keys are forbidden.")
            result[key] = value
        return result
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        fail("Invalid UTF-8 JSON metadata.")


def digest(path):
    if not stat.S_ISREG(path.lstat().st_mode) or path.is_symlink():
        fail("A required artifact is not a regular file.")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def hashes(root):
    path = local(root, "offline/artifacts.sha256")
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([^\r\n]+)", line)
        if not match or match[2] in result:
            fail("artifacts.sha256 must contain unique lowercase SHA-256, two spaces, relative path records.")
        filename = match[2]
        artifact = local(root, filename)
        if filename == "offline/artifacts.sha256":
            fail("The trust manifest cannot hash itself.")
        if digest(artifact) != match[1]:
            fail("Artifact integrity check failed; replace the bundle from a trusted source.")
        result[filename] = match[1]
    if not result:
        fail("The trusted artifact hash manifest is empty.")
    return result


def trusted(root, records, filename):
    path = local(root, filename)
    if filename not in records or digest(path) != records[filename]:
        fail("A required artifact lacks a matching trusted hash.")
    return path


def exact(obj, keys, label):
    if not isinstance(obj, dict) or set(obj) != set(keys):
        fail("Invalid " + label + " fields.")


def policy(root):
    obj = load(local(root, "offline/policy.json"))
    exact(obj, POLICY, "policy")
    for key, expected in POLICY.items():
        if type(obj[key]) is not type(expected) or obj[key] != expected:
            fail("Creation policy requires the exact typed offline-only settings; use a separate policy for connected acquisition.")
    for key in ("model_root", "work_root", "output_root"):
        local(root, obj[key], exists=False)
    return obj


def target_host(target, isolation=False):
    if target not in TARGETS:
        fail("Unsupported target; select a documented target identifier.")
    host = platform.system()
    machine = platform.machine().lower()
    compatible = ((target.startswith("linux-") and host == "Linux" and machine in ("x86_64", "amd64"))
                  or (target == "macos-m1" and host == "Darwin" and machine == "arm64")
                  or (target == "windows-gpu-cuda" and host == "Windows" and machine in ("amd64", "x86_64")))
    if not compatible:
        fail("Target does not match this host; cross-building is not implemented.")
    if isolation and host != "Linux":
        fail("This platform has no implemented isolation backend; execution is blocked.")


def assets(root, records, obj):
    path = trusted(root, records, "models/manifest.json")
    manifest = load(path)
    if not isinstance(manifest, dict) or type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1 or not isinstance(manifest.get("models"), list):
        fail("Invalid model manifest version or assets.")
    if not manifest["models"]:
        fail("No model integration assets have been staged.")
    config_path = trusted(root, records, "config/model_paths.json")
    config = load(config_path)
    if not isinstance(config, dict) or config.get("model_root") != "models":
        fail("Config requires model_root=models and explicit local model mappings.")
    if not set(MODEL_KEYS) <= set(config) or not set(config) <= set(MODEL_KEYS) | {"model_root", "comment", "path_resolution"}:
        fail("Model config must contain all required detection, pose, segmentation, face, llm and inpaint groups.")
    for group, keys in MODEL_KEYS.items():
        exact(config[group], keys, "model config " + group)
    model_dir = local(root, config["model_root"])
    seen = set()
    destinations = set()
    ready_paths = set()
    for asset in manifest["models"]:
        fields = ("id", "group", "source_url", "destination", "extraction", "license", "required", "status", "sha256", "size_bytes")
        if not isinstance(asset, dict) or not set(fields) <= set(asset):
            fail("Model asset is missing required metadata fields.")
        if not isinstance(asset["id"], str) or not asset["id"] or asset["id"] in seen:
            fail("Asset identifiers must be nonempty and unique.")
        seen.add(asset["id"])
        if not isinstance(asset["group"], str) or not asset["group"] or type(asset["required"]) is not bool:
            fail("Invalid asset group or required flag.")
        for key in ("source_url", "license"):
            if asset[key] is not None and (not isinstance(asset[key], str) or not asset[key]):
                fail("Invalid asset metadata.")
        if asset["extraction"] is not None and not isinstance(asset["extraction"], (str, dict)):
            fail("Invalid asset extraction metadata.")
        local(model_dir, asset["destination"], exists=False)
        if asset["destination"] in destinations:
            fail("Asset destinations must be unique.")
        destinations.add(asset["destination"])
        if asset["status"] not in ("ready", "blocked"):
            fail("Asset status must be ready or blocked.")
        if asset["sha256"] is not None and (not isinstance(asset["sha256"], str) or not HEX.fullmatch(asset["sha256"])):
            fail("Asset hash metadata must be null or lowercase SHA-256.")
        if asset["size_bytes"] is not None and (type(asset["size_bytes"]) is not int or asset["size_bytes"] < 0):
            fail("Asset size metadata must be null or a nonnegative integer.")
        if asset["status"] == "blocked":
            if asset["required"]:
                fail("A required asset is blocked; supply verified licensed local assets.")
            continue
        if not isinstance(asset["sha256"], str) or not HEX.fullmatch(asset["sha256"]):
            fail("Ready assets require SHA-256 metadata.")
        if type(asset["size_bytes"]) is not int or asset["size_bytes"] < 0 or not asset["license"]:
            fail("Ready assets require size and license metadata.")
        filename = config["model_root"] + "/" + asset["destination"]
        extraction = asset["extraction"]
        if isinstance(extraction, dict) and extraction.get("type") in ("zip", "tar"):
            members = extraction.get("members")
            member_hashes = extraction.get("member_sha256")
            if not isinstance(members, list) or not members or any(not isinstance(member, str) for member in members) or len(set(members)) != len(members):
                fail("Model packages require a complete unique reviewed member allowlist.")
            if not isinstance(member_hashes, dict) or set(member_hashes) != set(members):
                fail("Model packages require independently reviewed hashes for every extracted member.")
            limit = extraction.get("max_size_bytes")
            if type(limit) is not int or limit <= 0:
                fail("Model packages require a positive reviewed extracted size limit.")
            directory = local(root, filename)
            if not directory.is_dir():
                fail("Extracted model package directory is missing.")
            expected_paths = set()
            size = 0
            for member in members:
                member_path = local(directory, member)
                expected = member_hashes[member]
                if not isinstance(expected, str) or not HEX.fullmatch(expected):
                    fail("Extracted member hashes require lowercase SHA-256.")
                relative = member_path.relative_to(root).as_posix()
                trusted(root, records, relative)
                if digest(member_path) != expected:
                    fail("Extracted model member integrity check failed.")
                size += member_path.stat().st_size
                if size > limit:
                    fail("Extracted model package exceeds its reviewed size limit.")
                ready_paths.add(relative)
                expected_paths.add(relative)
            actual_paths = set()
            for child in directory.rglob("*"):
                if child.is_symlink():
                    fail("Extracted model packages must not contain symlinks.")
                if not child.is_dir():
                    actual_paths.add(child.relative_to(root).as_posix())
            if actual_paths != expected_paths:
                fail("Extracted package contains missing or unexpected members.")
            continue
        if extraction not in (None, {"type": "none"}):
            fail("Unsupported model extraction metadata.")
        file = trusted(root, records, filename)
        if digest(file) != asset["sha256"] or file.stat().st_size != asset["size_bytes"]:
            fail("Model asset integrity check failed.")
        ready_paths.add(filename)
    count = 0
    for group, mappings in config.items():
        if group in ("model_root", "comment", "path_resolution"):
            if not isinstance(mappings, str):
                fail("Invalid model config metadata.")
            continue
        if not isinstance(mappings, dict) or not mappings:
            fail("Config model groups must contain explicit local mappings.")
        for value in mappings.values():
            file = local(model_dir, value)
            if file.is_dir():
                files = [child for child in file.rglob("*") if not child.is_dir()]
                if not files:
                    fail("Model package directory is empty.")
            else:
                files = [file]
            for child in files:
                filename = child.relative_to(root).as_posix()
                if filename not in ready_paths:
                    fail("Config model paths must refer to individually ready manifest assets.")
                trusted(root, records, filename)
            count += 1
    if not count:
        fail("No configured local models.")
    return manifest


def requirements(root, records, target, obj, build=False):
    prefix = "build-requirements" if build else "requirements"
    filename = "offline/" + prefix + "." + target + ".txt"
    text = trusted(root, records, filename).read_text(encoding="utf-8")
    wheelhouse = local(root, WHEELHOUSE_ROOT + "/" + target)
    if not wheelhouse.is_dir():
        fail("The target local wheelhouse is missing.")
    wheel_files = {}
    for wheel in sorted(wheelhouse.iterdir()):
        if wheel.is_symlink() or not wheel.is_file() or not wheel.name.endswith(".whl"):
            fail("The wheelhouse must contain regular local wheels only.")
        trusted(root, records, wheel.relative_to(root).as_posix())
        wheel_files.setdefault(digest(wheel), []).append(wheel)
    selected = []
    names = set()
    pattern = re.compile(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*) --hash=sha256:([0-9a-f]{64})")
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        match = pattern.fullmatch(line)
        if not match:
            fail("Requirements must be name==version --hash=sha256:HASH; URLs, paths, directives and source packages are forbidden.")
        name = re.sub(r"[-_.]+", "-", match[1]).lower()
        if name in names:
            fail("Duplicate pinned requirements are forbidden.")
        names.add(name)
        wheels = wheel_files.get(match[3], [])
        candidates = []
        for wheel in wheels:
            parts = wheel.name[:-4].split("-")
            if len(parts) >= 5 and re.sub(r"[-_.]+", "-", parts[0]).lower() == name and parts[1] == match[2]:
                candidates.append(wheel)
        if len(candidates) != 1:
            fail("Each pinned dependency must match exactly one trusted local wheel.")
        selected.append(candidates[0])
    if not selected:
        fail("Pinned target requirements are empty; installation is blocked.")
    return filename, selected


def snapshot(root, records, source, destination):
    source = local(root, source)
    if destination.exists():
        fail("Staging destination already exists.")
    if source.is_file():
        trusted(root, records, source.relative_to(root).as_posix())
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        if digest(destination) != records[source.relative_to(root).as_posix()]:
            fail("Artifact changed while staging.")
    else:
        destination.mkdir(parents=True)
        for child in sorted(source.rglob("*")):
            if child.is_symlink():
                fail("Source trees must not contain symlinks.")
            relative = child.relative_to(source)
            if child.is_dir():
                (destination / relative).mkdir(parents=True, exist_ok=True)
            else:
                snapshot(root, records, child.relative_to(root).as_posix(), destination / relative)


def environment():
    env = {key: value for key, value in os.environ.items()
           if key in ("PATH", "LANG", "LC_ALL", "SYSTEMROOT")}
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
               HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1", WANDB_DISABLED="true",
               WANDB_MODE="offline", PIP_NO_INDEX="1", PIP_DISABLE_PIP_VERSION_CHECK="1",
               PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
    return env


def isolation_probe(parent_namespace):
    if os.readlink("/proc/self/ns/net") == parent_namespace:
        fail("Network namespace was not created.")
    interfaces = [line.split(":")[0].strip() for line in Path("/proc/net/dev").read_text().splitlines()[2:]]
    if interfaces != ["lo"]:
        fail("Isolation namespace must expose only loopback.")
    for family, address in ((socket.AF_INET, ("1.1.1.1", 443)), (socket.AF_INET6, ("2606:4700:4700::1111", 443))):
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.settimeout(1)
            try:
                sock.connect(address)
            except OSError as error:
                if error.errno not in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EAFNOSUPPORT):
                    fail("External connection blocking could not be verified.")
            else:
                fail("External connectivity detected.")
    try:
        socket.getaddrinfo("example.com", 443)
    except socket.gaierror:
        pass
    else:
        fail("External DNS resolution is available; execution is blocked.")


def isolated(commands, cwd, env=None):
    if platform.system() != "Linux" or not Path("/proc/self/ns/net").exists():
        fail("No verified isolation backend is implemented for this platform.")
    unshare = shutil.which("unshare", path="/usr/bin:/bin")
    if not unshare:
        fail("Install unshare and enable network namespaces before offline execution.")
    payload = {"commands": commands, "cwd": str(cwd), "env": env or environment(),
               "parent": os.readlink("/proc/self/ns/net")}
    command = [unshare, "--user", "--map-root-user", "--net", "--", sys.executable,
               "-I", str(Path(__file__).resolve()), "_isolate"]
    result = subprocess.run(command, input=json.dumps(payload), text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=environment())
    if result.returncode:
        fail("Isolated execution failed. Enable Linux user/network namespaces, or fix the verified local recipe; no online fallback is permitted.")


def audit(root, obj, action, target, outcome):
    path = local(root, AUDIT_PATH, exists=False)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        fail("Audit log must be a regular local file.")
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        stream.write(json.dumps({"action": action, "target": target, "outcome": outcome}, sort_keys=True) + "\n")


def parser(description):
    result = argparse.ArgumentParser(description=description)
    result.add_argument("--root", default=str(Path(__file__).resolve().parent.parent), help="Trusted bundle root")
    result.add_argument("--target", required=True, choices=TARGETS)
    return result


def run(main):
    try:
        main()
    except OfflineError as error:
        print("Blocked: " + str(error), file=sys.stderr)
        sys.exit(2)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("Blocked: invalid or inaccessible local bundle; check required files and permissions.", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    def worker():
        if sys.argv[1:] != ["_isolate"]:
            fail("This module is internal.")
        payload = json.load(sys.stdin)
        isolation_probe(payload["parent"])
        for command in payload["commands"]:
            subprocess.run(command, cwd=payload["cwd"], env=payload["env"], check=True,
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    run(worker)
