"""Install trusted wheel-only dependencies inside mandatory verified isolation."""
from pathlib import Path
import shutil
import sys
from common import RUNTIME_ROOT, WHEELHOUSE_ROOT, audit, fail, isolated, local, parser, requirements, run, snapshot, target_host, trusted
from verify_offline import verify


def main():
    args = parser(__doc__).parse_args()
    root = Path(args.root).absolute()
    obj, records = verify(root, args.target)
    target_host(args.target, isolation=True)
    filename, _ = requirements(root, records, args.target, obj)
    trusted(root, records, "offline/install_offline.py")
    trusted(root, records, "offline/common.py")
    stage = local(root, "offline/staging-install-" + args.target, exists=False)
    if stage.exists():
        fail("Installation staging already exists; remove the incomplete staging directory explicitly.")
    stage.mkdir(parents=True)
    success = False
    try:
        snapshot(root, records, filename, stage / "requirements.txt")
        snapshot(root, records, WHEELHOUSE_ROOT + "/" + args.target, stage / "wheels")
        runtime = local(root, RUNTIME_ROOT, exists=False)
        runtime.mkdir(parents=True, exist_ok=True)
        venv = local(root, RUNTIME_ROOT + "/venv-" + args.target, exists=False)
        if venv.exists():
            fail("Runtime venv already exists; immutable installation refuses to overwrite it.")
        python = venv / "bin/python"
        commands = [
            [sys.executable, "-I", "-m", "venv", "--copies", str(venv)],
            [str(python), "-I", "-m", "pip", "--isolated", "install", "--no-index",
             "--require-hashes", "--only-binary=:all:", "--no-deps", "--no-cache-dir",
             "--find-links", str(stage / "wheels"), "-r", str(stage / "requirements.txt")],
            [str(python), "-I", "-m", "pip", "--isolated", "check"]
        ]
        isolated(commands, stage)
        success = True
        audit(root, obj, "install", args.target, "installed")
        print("Installed trusted local wheels in a verified Linux network namespace.")
    finally:
        if success:
            shutil.rmtree(stage)


if __name__ == "__main__":
    run(main)
