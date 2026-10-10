"""Cold, standard-library wheel review gate; never imports wheel contents."""
from email.parser import BytesParser
from email.policy import compat32
import itertools
from pathlib import Path
import platform
import re
import stat
import sys
import zipfile

from common import digest, exact, fail, HEX, load, local

RULES_PATH = "offline/manifests/wheel_rules.json"
PROFILES = ("linux-cpu", "linux-gpu-cuda", "windows-gpu-cuda")
ENVIRONMENT = {
    "local_machine_only": True, "no_external_sidecars": True,
    "allow_dns": False, "allow_tcp": False, "allow_http": False,
    "allow_https": False, "allow_ipv4": False, "allow_ipv6": False,
    "allow_telemetry": False, "allow_crash_uploads": False,
    "allow_update_checks": False, "allow_public_share_links": False,
    "allow_external_ui_assets": False,
    "local_paths": {"models": "models", "work": "work", "output": "out", "logs": "offline/logs"}
}


def require_python312():
    if sys.version_info[:2] != (3, 12) or sys.implementation.name != "cpython":
        fail("Execution requires CPython 3.12; no interpreter fallback is permitted.")


def environment_rule(root, value):
    exact(value, ENVIRONMENT, "wheel environment")
    for key, expected in ENVIRONMENT.items():
        if key == "local_paths":
            exact(value[key], expected, "wheel local paths")
            for name, path in value[key].items():
                if path != expected[name] or type(path) is not str:
                    fail("Wheel environment requires fixed local paths, not secret or environment profiles.")
                local(root, path, exists=False)
        elif type(value[key]) is not type(expected) or value[key] != expected:
            fail("Wheel environment must forbid networking, telemetry and external sidecars.")


def load_wheel_rules(root, expected_sha256, target):
    if target not in PROFILES:
        fail("No reviewed wheel environment profile exists for this target.")
    path = local(root, RULES_PATH)
    if not isinstance(expected_sha256, str) or not HEX.fullmatch(expected_sha256) or digest(path) != expected_sha256:
        fail("Wheel rules require a matching trusted artifact hash.")
    obj = load(path)
    exact(obj, ("schema_version", "python_version", "defaults", "rules"), "wheel rules")
    if type(obj["schema_version"]) is not int or obj["schema_version"] != 1 or obj["python_version"] != "3.12":
        fail("Wheel rules require schema version 1 and Python 3.12.")
    exact(obj["defaults"], PROFILES, "wheel target defaults")
    for value in obj["defaults"].values():
        environment_rule(root, value)
    if not isinstance(obj["rules"], list) or not obj["rules"]:
        fail("Empty wheel rules block deployment; every wheel requires reviewed approval.")
    seen = set()
    for rule in obj["rules"]:
        exact(rule, ("name", "version", "sha256", "target", "python_version", "status", "environment", "review"), "wheel approval")
        if not isinstance(rule["name"], str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", rule["name"]):
            fail("Wheel names must be canonical distribution names.")
        if not isinstance(rule["version"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.!+_]*", rule["version"]):
            fail("Invalid wheel version.")
        if not isinstance(rule["sha256"], str) or not HEX.fullmatch(rule["sha256"]):
            fail("Wheel approval requires lowercase SHA-256.")
        if rule["target"] not in PROFILES or rule["python_version"] != "3.12" or rule["status"] not in ("approved", "blocked"):
            fail("Invalid wheel approval target, interpreter or status.")
        environment_rule(root, rule["environment"])
        identity = tuple(rule[key] for key in ("name", "version", "sha256", "target", "python_version"))
        if identity in seen:
            fail("Duplicate wheel approvals are forbidden.")
        seen.add(identity)
        review = rule["review"]
        if rule["status"] == "approved":
            exact(review, ("path", "sha256"), "wheel review evidence")
            if not isinstance(review["sha256"], str) or not HEX.fullmatch(review["sha256"]):
                fail("Approved wheel requires hashed local review evidence.")
            evidence = local(root, review["path"])
            if digest(evidence) != review["sha256"]:
                fail("Wheel review evidence hash does not match.")
        elif review is not None:
            fail("Blocked proposals must not claim review approval.")
    return obj


def compatible_tag(tag, target):
    parts = tag.split("-")
    if len(parts) != 3:
        return False
    python, abi, wheel_platform = parts
    pure = python in ("py3", "py312") and abi == "none"
    stable = re.fullmatch(r"cp3([0-9]+)", python)
    interpreter = python == "cp312" and abi in ("cp312", "none")
    stable = bool(stable and 2 <= int(stable[1]) <= 12 and abi == "abi3")
    if not (pure or interpreter or stable):
        return False
    if wheel_platform == "any":
        return pure
    if target == "windows-gpu-cuda":
        return wheel_platform == "win_amd64"
    if target not in ("linux-cpu", "linux-gpu-cuda"):
        return False
    if wheel_platform == "linux_x86_64":
        return True
    legacy = {"manylinux1_x86_64": (2, 5), "manylinux2010_x86_64": (2, 12),
              "manylinux2014_x86_64": (2, 17)}
    match = re.fullmatch(r"manylinux_2_([0-9]+)_x86_64", wheel_platform)
    minimum = (2, int(match[1])) if match else legacy.get(wheel_platform)
    libc, version = platform.libc_ver()
    if minimum is None or libc != "glibc" or not re.fullmatch(r"[0-9]+\.[0-9]+", version):
        return False
    return tuple(map(int, version.split("."))) >= minimum


def wheel_identity(path, target):
    path = Path(path)
    digest(path)
    parts = path.name[:-4].split("-") if path.name.endswith(".whl") else []
    if len(parts) not in (5, 6) or not re.fullmatch(r"[A-Za-z0-9_]+", parts[0]) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.!+_]*", parts[1]):
        fail("Invalid wheel filename.")
    if len(parts) == 6 and not re.fullmatch(r"[0-9][A-Za-z0-9_]*", parts[2]):
        fail("Invalid wheel build tag.")
    tags = {"-".join(tag) for tag in itertools.product(*(value.split(".") for value in parts[-3:]))}
    if not tags or any(not compatible_tag(tag, target) for tag in tags):
        fail("Wheel tags are incompatible with Python 3.12 or the selected target.")
    name = re.sub(r"[-_.]+", "-", parts[0]).lower()
    prefix = parts[0] + "-" + parts[1] + ".dist-info/"
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            names = [member.filename for member in members]
            if len(names) != len(set(names)) or len(names) > 100000 or sum(member.file_size for member in members) > 8 * 1024 ** 3:
                fail("Invalid or oversized wheel member inventory.")
            for member in members:
                local(path.parent, member.filename.rstrip("/"), exists=False)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or member.flag_bits & 1:
                    fail("Wheel contains a link, special file or encrypted member.")
            for filename in ("METADATA", "WHEEL", "RECORD"):
                if prefix + filename not in names:
                    fail("Wheel is missing matching distribution metadata.")
            if any(".dist-info/" in value and not value.startswith(prefix) for value in names):
                fail("Wheel contains foreign distribution metadata.")
            def metadata(filename):
                member = archive.getinfo(prefix + filename)
                if member.file_size > 1024 * 1024:
                    fail("Oversized wheel metadata.")
                return BytesParser(policy=compat32).parsebytes(archive.read(member))
            package = metadata("METADATA")
            wheel = metadata("WHEEL")
            for field in ("Name", "Version"):
                if len(package.get_all(field, [])) != 1:
                    fail("Ambiguous wheel package metadata.")
            if re.sub(r"[-_.]+", "-", package["Name"]).lower() != name or package["Version"] != parts[1]:
                fail("Wheel metadata disagrees with its filename.")
            if wheel.get_all("Wheel-Version") != ["1.0"] or wheel.get_all("Root-Is-Purelib") not in (["true"], ["false"]):
                fail("Unsupported wheel metadata version or library placement.")
            metadata_tags = wheel.get_all("Tag", [])
            if len(metadata_tags) != len(set(metadata_tags)) or set(metadata_tags) != tags:
                fail("Wheel metadata tags disagree with its filename.")
            if any(tag.endswith("-any") for tag in tags) and wheel["Root-Is-Purelib"] != "true":
                fail("Platform-independent wheels must be pure Python.")
            if any(tag.endswith("-any") for tag in tags) and any(
                    value.lower().endswith((".so", ".pyd", ".dll", ".dylib", ".exe")) for value in names):
                fail("Pure Python wheels cannot contain native binaries.")
    except (zipfile.BadZipFile, UnicodeError, RuntimeError, EOFError):
        fail("Wheel is not a valid local ZIP archive.")
    return {"name": name, "version": parts[1], "sha256": digest(path),
            "target": target, "python_version": "3.12"}


def validate_wheel(path, target, rules):
    if not isinstance(rules, dict) or not isinstance(rules.get("rules"), list):
        fail("A validated trusted wheel rules inventory is required.")
    identity = wheel_identity(path, target)
    matching = [rule for rule in rules["rules"] if all(rule[key] == value for key, value in identity.items())]
    if len(matching) != 1 or matching[0]["status"] != "approved":
        fail("Wheel lacks an exact reviewed name/version/hash/target/Python 3.12 approval.")
    return identity


def proposed_rule(path, target):
    return {**wheel_identity(path, target), "status": "blocked",
            "environment": ENVIRONMENT, "review": None}
