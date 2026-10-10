"""Launch only an explicit trusted local integration adapter, never a shell command."""
from pathlib import Path
import os
from common import RUNTIME_ROOT, audit, environment, fail, isolated, local, parser, requirements, run, target_host, trusted
from verify_offline import verify
from wheel_rules import require_python312


def main():
    cli = parser(__doc__)
    cli.add_argument("--adapter", help="Hashed executable adapter relative to offline/runtime/")
    args = cli.parse_args()
    require_python312()
    root = Path(args.root).absolute()
    obj, records = verify(root, args.target)
    target_host(args.target, isolation=True)
    requirements(root, records, args.target, obj)
    if not args.adapter:
        fail("No integration adapter selected; supply --adapter with a trusted local runtime executable.")
    runtime = local(root, RUNTIME_ROOT)
    adapter = local(runtime, args.adapter)
    trusted(root, records, adapter.relative_to(root).as_posix())
    trusted(root, records, "offline/common.py")
    trusted(root, records, "offline/launch_offline.py")
    if not adapter.is_file() or not os.access(adapter, os.X_OK):
        fail("The local integration adapter must be an executable regular file.")
    env = environment()
    model_dir = local(root, "models")
    env.update(HF_HOME=str(model_dir), HF_HUB_CACHE=str(model_dir), TRANSFORMERS_CACHE=str(model_dir),
               INPAINTEGRATION_MODEL_ROOT=str(model_dir))
    audit(root, obj, "launch", args.target, "starting")
    python = local(root, RUNTIME_ROOT + "/venv-" + args.target + "/bin/python")
    trusted(root, records, python.relative_to(root).as_posix())
    isolated([[str(python), "-I", "-c",
               "import sys; assert sys.version_info[:2] == (3, 12) and sys.implementation.name == 'cpython'"],
              [str(adapter)]], runtime, env)
    audit(root, obj, "launch", args.target, "completed")
    print("Local adapter completed under verified Linux network namespace isolation.")


if __name__ == "__main__":
    run(main)
