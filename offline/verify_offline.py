"""Cold verification only: never imports models or installs packages."""
from pathlib import Path
from common import assets, audit, hashes, parser, policy, run, target_host, trusted


def verify(root, target):
    obj = policy(root)
    target_host(target)
    records = hashes(root)
    trusted(root, records, "offline/policy.json")
    trusted(root, records, "offline/common.py")
    trusted(root, records, "offline/verify_offline.py")
    assets(root, records, obj)
    return obj, records


def main():
    args = parser(__doc__).parse_args()
    root = Path(args.root).absolute()
    obj, _ = verify(root, args.target)
    audit(root, obj, "verify", args.target, "verified")
    print("Verified local assets; platform execution/isolation has not been asserted.")


if __name__ == "__main__":
    run(main)
