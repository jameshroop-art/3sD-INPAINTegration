"""Build only pinned, trusted local sources with an explicit hashed host recipe."""
from pathlib import Path
import configparser
import re
import subprocess
import sys
from common import WHEELHOUSE_ROOT, audit, digest, environment, exact, fail, hashes, isolated, load, local, parser, policy, requirements, run, snapshot, target_host, trusted
import json


def git(directory, *args):
    env = environment()
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_NO_REPLACE_OBJECTS="1")
    result = subprocess.run(["git", "--no-optional-locks", "-c", "core.fsmonitor=false",
                             "-c", "core.hooksPath=/dev/null", "-C", str(directory), *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True, env=env)
    return result.stdout.strip()


def source_config(directory):
    for file in directory.rglob("*"):
        if file.is_symlink():
            fail("Source checkouts must not contain symlinks.")
    for name in (".git/objects/info/alternates", ".git/objects/info/http-alternates", ".git/info/grafts"):
        if local(directory, name, exists=False).exists():
            fail("Git alternate object stores and grafts are forbidden.")
    config = configparser.ConfigParser(interpolation=None, strict=True)
    try:
        config.read_string(local(directory, ".git/config").read_text(encoding="utf-8"))
    except configparser.Error:
        fail("Invalid local Git configuration.")
    for section in config.sections():
        allowed = None
        if section == "core":
            allowed = {"repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode"}
        elif re.fullmatch(r'remote "[A-Za-z0-9_-]+"', section):
            allowed = {"url", "fetch"}
        elif re.fullmatch(r'branch "[A-Za-z0-9_./-]+"', section):
            allowed = {"remote", "merge"}
        if allowed is None or not set(config[section]) <= allowed:
            fail("Git filters, includes, extensions and custom hooks are forbidden in offline source checkouts.")
    if config.defaults() or config.get("core", "repositoryformatversion", fallback="") != "0":
        fail("Only standard standalone local Git checkouts are supported.")


def sources(root, records, overrides, source_ids=None):
    lock = load(trusted(root, records, "offline/manifests/sources.lock.json"))
    if not isinstance(lock, dict) or not {"schema_version", "sources"} <= set(lock):
        fail("Sources lock requires schema_version and sources metadata.")
    if type(lock["schema_version"]) is not int or lock["schema_version"] != 1 or not isinstance(lock["sources"], list) or not lock["sources"]:
        fail("Pinned source lock is empty or invalid.")
    supplied = {}
    for value in overrides:
        if "=" not in value:
            fail("Use --source REPO=relative-local-path.")
        repo, path = value.split("=", 1)
        if repo in supplied:
            fail("Duplicate source overrides are forbidden.")
        supplied[repo] = path
    found = []
    names = set()
    repos = set()
    selected = source_ids if source_ids is not None else ["sam2", "sapiens", "stable-diffusion.cpp", "llama.cpp"]
    if not isinstance(selected, list) or not selected or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value) for value in selected) or len(set(selected)) != len(selected):
        fail("Recipe source_ids must be a nonempty unique local implementation ID list.")
    index = {}
    for entry in lock["sources"]:
        if not isinstance(entry, dict) or not {"repo", "commit", "license", "status"} <= set(entry):
            fail("Source is missing required pinned provenance metadata.")
        if "id" in entry and (not isinstance(entry["id"], str) or not entry["id"]):
            fail("Source identifier metadata must be a nonempty string.")
        if "direct_urls" in entry and (not isinstance(entry["direct_urls"], list) or any(not isinstance(url, str) for url in entry["direct_urls"])):
            fail("Source direct URL metadata must be a string list.")
        identifier = entry.get("id")
        if not isinstance(identifier, str) or not identifier or identifier in index:
            fail("Sources must contain unique explicit identifiers.")
        index[identifier] = entry
    for identifier in selected:
        if identifier not in index:
            fail("A selected implementation ID is absent from the trusted source lock.")
        entry = index[identifier]
        if not isinstance(entry["repo"], str) or not entry["repo"]:
            fail("Source repository metadata is missing.")
        if entry["repo"] in repos:
            fail("Duplicate source repositories are forbidden.")
        repos.add(entry["repo"])
        if entry["status"] != "ready" or not isinstance(entry["commit"], str) or not re.fullmatch(r"[0-9a-f]{40}", entry["commit"]) or not isinstance(entry["license"], str) or not entry["license"]:
            fail("A source is blocked or lacks an approved pinned commit/license.")
        name = identifier
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) or name in names or name in (".", ".."):
            fail("Invalid or ambiguous source repository name.")
        names.add(name)
        staged = "offline/sources/" + name
        default = staged if local(root, staged, exists=False).exists() else "external/" + name
        directory = local(root, supplied.pop(entry["repo"], default))
        if not directory.is_dir() or not local(directory, ".git").is_dir():
            fail("Each staged source must contain a local Git checkout.")
        source_config(directory)
        if git(directory, "rev-parse", "HEAD") != entry["commit"] or git(directory, "status", "--porcelain", "--untracked-files=all", "--ignored"):
            fail("Sources must be pinned clean commits, without ignored/untracked files.")
        if git(directory, "submodule", "status"):
            fail("Source submodules require a dedicated recipe; unsupported sources are blocked.")
        for file in directory.rglob("*"):
            if file.is_file() and ".git" not in file.relative_to(directory).parts:
                trusted(root, records, file.relative_to(root).as_posix())
        found.append((name, directory, entry["commit"]))
    if supplied:
        fail("A source override is not listed in the trusted lock.")
    return found


def main():
    cli = parser(__doc__)
    cli.add_argument("--source", action="append", default=[], help="Locked REPO=local-relative-checkout")
    args = cli.parse_args()
    root = Path(args.root).absolute()
    obj = policy(root)
    target_host(args.target, isolation=True)
    records = hashes(root)
    trusted(root, records, "offline/policy.json")
    trusted(root, records, "offline/common.py")
    trusted(root, records, "offline/build_offline.py")
    recipe = load(trusted(root, records, "offline/recipes/" + args.target + ".json"))
    if not isinstance(recipe, dict) or not {"version", "target", "patches", "commands"} <= set(recipe) or not set(recipe) <= {"version", "target", "patches", "commands", "source_ids"}:
        fail("Invalid build recipe fields.")
    if type(recipe["version"]) is not int or recipe["version"] != 1 or recipe["target"] != args.target:
        fail("Build recipe does not match the selected target.")
    if not isinstance(recipe["commands"], list) or not recipe["commands"]:
        fail("Missing implemented build recipe; this target is blocked.")
    if not isinstance(recipe["patches"], list):
        fail("Invalid deterministic patch list.")
    pinned = sources(root, records, args.source, recipe.get("source_ids"))
    for command in recipe["commands"]:
        if not isinstance(command, list) or not command or any(not isinstance(arg, str) or not arg or "\x00" in arg for arg in command):
            fail("Build commands must be explicit argument arrays.")
    patches = []
    previous = ""
    for patch in recipe["patches"]:
        exact(patch, ("source", "path"), "patch")
        if patch["source"] not in [item[0] for item in pinned] or not isinstance(patch["path"], str) or patch["path"] <= previous:
            fail("Trusted patches must have unique lexically sorted paths and locked sources.")
        previous = patch["path"]
        trusted(root, records, patch["path"])
        patches.append(patch)
    filename, _ = requirements(root, records, args.target, obj, build=True)
    stage = local(root, "offline/staging-build-" + args.target, exists=False)
    if stage.exists():
        fail("Immutable build staging already exists; choose a fresh trusted bundle.")
    stage.mkdir(parents=True)
    snapshot(root, records, filename, stage / "requirements.txt")
    snapshot(root, records, WHEELHOUSE_ROOT + "/" + args.target, stage / "wheels")
    for name, directory, commit in pinned:
        dest = stage / "sources" / name
        dest.mkdir(parents=True)
        for file in sorted(directory.rglob("*")):
            relative = file.relative_to(directory)
            if ".git" in relative.parts:
                continue
            if file.is_dir():
                (dest / relative).mkdir(parents=True, exist_ok=True)
            else:
                snapshot(root, records, file.relative_to(root).as_posix(), dest / relative)
        if git(directory, "rev-parse", "HEAD") != commit or git(directory, "status", "--porcelain", "--untracked-files=all", "--ignored"):
            fail("Source checkout changed during immutable staging.")
    commands = []
    for index, patch in enumerate(patches):
        dest = stage / ("patch-" + str(index) + ".patch")
        snapshot(root, records, patch["path"], dest)
        commands.append(["git", "apply", "--no-unsafe-paths", "--directory=sources/" + patch["source"], str(dest)])
    venv = stage / "venv"
    python = venv / "bin/python"
    commands.extend([
        [sys.executable, "-I", "-m", "venv", "--copies", str(venv)],
        [str(python), "-I", "-m", "pip", "--isolated", "install", "--no-index", "--require-hashes",
         "--only-binary=:all:", "--no-deps", "--no-cache-dir", "--find-links", str(stage / "wheels"),
         "-r", str(stage / "requirements.txt")],
        [str(python), "-I", "-m", "pip", "--isolated", "check"]
    ])
    for command in recipe["commands"]:
        executable = command[0]
        if executable != "venv/bin/python":
            fail("Recipes currently support only the staged venv/bin/python entrypoint.")
        commands.append([str(python), *command[1:]])
    env = environment()
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_CEILING_DIRECTORIES=str(stage.parent))
    isolated(commands, stage, env)
    output_inventory(stage, args.target)
    audit(root, obj, "build", args.target, "built")
    print("Build completed in immutable staging under verified Linux namespace isolation; outputs are not automatically trusted.")


def output_inventory(stage, target):
    wheels = []
    for file in sorted(stage.rglob("*")):
        if file.is_symlink():
            fail("Build outputs must not contain symlinks.")
        relative = file.relative_to(stage)
        if relative.parts[0] in ("wheels", "venv", "sources"):
            continue
        if file.is_file() and file.suffix == ".whl":
            wheels.append({"path": relative.as_posix(), "sha256": digest(file), "size_bytes": file.stat().st_size})
    if not wheels:
        fail("Recipe produced no local wheel outputs; target remains blocked.")
    for name in ("artifacts.sha256", "sbom.json"):
        if local(stage, name, exists=False).exists():
            fail("Build output inventory paths must not already exist.")
    with (stage / "artifacts.sha256").open("x", encoding="utf-8") as stream:
        stream.write("".join(item["sha256"] + "  " + item["path"] + "\n" for item in wheels))
    with (stage / "sbom.json").open("x", encoding="utf-8") as stream:
        stream.write(json.dumps({"version": 1, "target": target, "authenticated": False,
                                 "review_required": True, "wheels": wheels}, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    run(main)
