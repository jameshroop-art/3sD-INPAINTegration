"""Focused stdlib tests using synthetic local fixtures only."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fetch_models as fetch
import clone_external_repos
import setup_model_downloads

MEMBER_HASH = hashlib.sha256(b"x").hexdigest()


def archive_spec(kind="zip", members=None, limit=1):
    members = members or ["wanted"]
    return {"type": kind, "members": members, "max_size_bytes": limit,
            "member_sha256": {name: MEMBER_HASH for name in members}}


class AcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.root = fetch.ROOT / (".acquisition-test-" + uuid.uuid4().hex)
        self.root.mkdir()
        self.policy = self.root / "policy.json"
        self.policy.write_text(json.dumps({"offline_required": False, "acquisition_only": True}))
        self.payload = b"synthetic fixture"
        self.local = self.root / "local"
        self.local.mkdir()
        (self.local / "fixture").write_bytes(self.payload)
        self.entry = {"id": "fixture", "group": "test", "source_url": None,
                      "destination": "group/payload", "extraction": {"type": "none"},
                      "license": "test", "required": True, "status": "ready",
                      "sha256": hashlib.sha256(self.payload).hexdigest(), "size_bytes": len(self.payload)}
        self.manifest = self.root / "manifest.json"

    def tearDown(self):
        shutil.rmtree(self.root)

    def run_fetch(self, entry=None, authorized=True, entries=None, extra=None):
        self.manifest.write_text(json.dumps({"models": entries or [entry or self.entry]}))
        args = ["--manifest", str(self.manifest), "--model-root", str(self.root / "models"),
                "--local-dir", str(self.local), "--policy", str(self.policy)]
        if authorized:
            args += ["--acquisition-only", "--connected-machine"]
        args += extra or []
        with patch("urllib.request.build_opener", side_effect=AssertionError("Network forbidden in tests")):
            return fetch.main(args)

    def test_verified_local_fallback_and_idempotence(self):
        self.assertEqual(self.run_fetch(), 0)
        self.assertEqual(self.run_fetch(), 0)
        self.assertEqual((self.root / "models/group/payload").read_bytes(), self.payload)

    def test_optional_blocked_assets_skipped_unless_explicit(self):
        optional = self.entry | {"id": "optional", "destination": "group/optional", "required": False,
                                 "status": "blocked", "sha256": None}
        self.assertEqual(self.run_fetch(entries=[self.entry, optional]), 0)
        self.assertEqual(self.run_fetch(entries=[self.entry, optional], extra=["--include-optional"]), 2)

    def test_duplicate_and_nested_destinations_refused(self):
        for destination in ("group/payload", "group/payload/child", "group"):
            second = self.entry | {"id": "second", "destination": destination}
            with self.subTest(destination=destination):
                self.assertEqual(self.run_fetch(entries=[self.entry, second]), 2)

    def test_setup_does_not_create_asset_dirs_or_overwrite_venv(self):
        self.manifest.write_text(json.dumps({"models": [self.entry]}))
        target = self.root / "venv"
        args = ["--policy", str(self.policy), "--manifest", str(self.manifest),
                "--model-root", str(self.root / "models"), "--venv", str(target),
                "--acquisition-only", "--connected-machine"]
        with patch("subprocess.run") as command:
            self.assertEqual(setup_model_downloads.main(args), 0)
            command.assert_called_once()
            arguments = command.call_args
            self.assertEqual(arguments.args[0][-3:], ["venv", "--without-pip", str(target)])
            self.assertNotIn("PYTHONPATH", arguments.kwargs["env"])
            self.assertNotIn("LD_PRELOAD", arguments.kwargs["env"])
            self.assertFalse((self.root / "models/group").exists())
        target.mkdir()
        with patch("subprocess.run") as command:
            self.assertEqual(setup_model_downloads.main(args), 2)
            command.assert_not_called()

    def test_setup_requires_python312(self):
        args = ["--policy", str(self.policy), "--acquisition-only", "--connected-machine"]
        with patch.object(setup_model_downloads.sys, "version_info", (3, 11, 0)), patch("subprocess.run") as command:
            self.assertEqual(setup_model_downloads.main(args), 2)
            command.assert_not_called()

    def test_offline_and_missing_authorization_refused(self):
        self.assertEqual(self.run_fetch(authorized=False), 2)
        self.policy.write_text(json.dumps({"offline_required": True, "acquisition_only": True}))
        self.assertEqual(self.run_fetch(), 2)
        self.assertFalse((self.root / "models").exists())

    def test_missing_hash_refused_before_local_or_network(self):
        self.entry["sha256"] = None
        self.assertEqual(self.run_fetch(), 2)
        self.assertFalse((self.root / "models").exists())

    def test_conflicting_policy_and_duplicate_json_refused(self):
        self.policy.write_text('{"offline_required":false,"acquisition_only":true,"offline":true}')
        self.assertEqual(self.run_fetch(), 2)
        self.policy.write_text('{"offline_required":true,"offline_required":false,"acquisition_only":true}')
        self.assertEqual(self.run_fetch(), 2)

    def test_relative_acquisition_policy_refused(self):
        from argparse import Namespace
        with self.assertRaises(ValueError):
            fetch.authorize(Namespace(acquisition_only=True, connected_machine=True, policy=Path("offline/policy.json")))

    def test_unsafe_destination_and_unknown_archive_spec_refused(self):
        self.entry["destination"] = "../escape"
        self.assertEqual(self.run_fetch(), 2)
        self.entry["destination"] = "payload"
        self.entry["extraction"] = {"type": "zip", "members": [], "max_size_bytes": None}
        self.assertEqual(self.run_fetch(), 2)

    def test_wrong_hash_and_symlink_refused(self):
        self.entry["sha256"] = "0" * 64
        self.assertEqual(self.run_fetch(), 2)
        self.entry["sha256"] = hashlib.sha256(self.payload).hexdigest()
        models = self.root / "models"
        (models / "group").symlink_to(self.local, target_is_directory=True)
        self.assertEqual(self.run_fetch(), 2)
        self.assertFalse((self.local / "payload").exists())

    def zip_case(self, name, payload=b"x", mode=0):
        archive = self.root / (uuid.uuid4().hex + ".zip")
        with zipfile.ZipFile(archive, "w") as container:
            member = zipfile.ZipInfo(name)
            member.external_attr = mode << 16
            container.writestr(member, payload)
        target = self.root / uuid.uuid4().hex
        target.mkdir()
        return archive, target

    def test_zip_traversal_links_unexpected_and_oversized(self):
        for name, mode, payload in [("../escape", 0, b"x"), ("/absolute", 0, b"x"),
                                    ("wanted", 0o120777, b"x"), ("unexpected", 0, b"x"),
                                    ("wanted", 0, b"xx"), ("C:/drive", 0, b"x")]:
            with self.subTest(name=name, mode=mode, payload=payload):
                archive, target = self.zip_case(name, payload, mode)
                with self.assertRaises(ValueError):
                    fetch.extract(archive, target, archive_spec())

    def test_valid_zip_and_missing_member(self):
        archive, target = self.zip_case("wanted")
        fetch.extract(archive, target, archive_spec())
        self.assertEqual((target / "wanted").read_bytes(), b"x")
        with self.assertRaises(ValueError):
            fetch.extract(archive, self.root / "new", archive_spec(members=["wanted", "missing"], limit=2))

    def test_tar_links_traversal_and_safe_file(self):
        for name, kind in [("wanted", tarfile.SYMTYPE), ("wanted", tarfile.LNKTYPE),
                           ("../escape", tarfile.REGTYPE), ("wanted", tarfile.REGTYPE)]:
            archive = self.root / (uuid.uuid4().hex + ".tar")
            with tarfile.open(archive, "w") as container:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = "elsewhere" if kind != tarfile.REGTYPE else ""
                member.size = 1 if kind == tarfile.REGTYPE else 0
                container.addfile(member, io.BytesIO(b"x") if member.size else None)
            target = self.root / uuid.uuid4().hex
            target.mkdir()
            if name == "wanted" and kind == tarfile.REGTYPE:
                fetch.extract(archive, target, archive_spec("tar"))
                self.assertEqual((target / "wanted").read_bytes(), b"x")
            else:
                with self.assertRaises(ValueError):
                    fetch.extract(archive, target, archive_spec("tar"))

    def test_archive_member_hashes_required_and_checked(self):
        archive, target = self.zip_case("wanted")
        spec = archive_spec()
        spec["member_sha256"] = {}
        with self.assertRaises(ValueError):
            fetch.extract(archive, target, spec)
        spec["member_sha256"] = {"wanted": "0" * 64}
        with self.assertRaises(ValueError):
            fetch.extract(archive, target, spec)

    def test_deployment_manifest_expands_trusted_archive(self):
        archive, _ = self.zip_case("wanted")
        payload = archive.read_bytes()
        (self.local / "fixture").write_bytes(payload)
        entry = self.entry | {"destination": "package", "extraction": archive_spec(),
                              "sha256": hashlib.sha256(payload).hexdigest(), "size_bytes": len(payload)}
        output = self.root / "deployment.json"
        self.assertEqual(self.run_fetch(entry=entry, extra=["--deployment-manifest", str(output)]), 0)
        record = json.loads(output.read_text())["models"][0]
        self.assertEqual(record["destination"], "package/wanted")
        self.assertEqual(record["sha256"], MEMBER_HASH)
        self.assertEqual(record["size_bytes"], 1)
        self.assertEqual(record["parent_sha256"], entry["sha256"])
        self.assertEqual(record["extraction"], {"type": "none"})
        self.assertIsNone(record["source_url"])
        with self.assertRaises(ValueError):
            fetch.trusted(record)

    def test_deployment_output_refuses_overwrite_and_model_root(self):
        output = self.root / "existing.json"
        output.write_text("retain")
        self.assertEqual(self.run_fetch(extra=["--deployment-manifest", str(output)]), 2)
        self.assertEqual(output.read_text(), "retain")
        self.assertEqual(self.run_fetch(extra=["--deployment-manifest", str(self.root / "models/output.json")]), 2)

    def test_download_retry_and_https_guard_with_synthetic_response(self):
        class Response(io.BytesIO):
            pass
        opener = unittest.mock.Mock()
        opener.open.side_effect = [OSError("synthetic transient"), Response(self.payload)]
        with patch("urllib.request.build_opener", return_value=opener), patch("time.sleep"):
            fetch.obtain(self.entry | {"source_url": "https://example.invalid/fixture"},
                         self.root / "download", None, 1)
        self.assertEqual(opener.open.call_count, 2)
        with self.assertRaises(ValueError):
            fetch.HTTPSOnly().redirect_request(None, None, 302, "", {}, "http://example.invalid/file")
        with self.assertRaises(ValueError):
            fetch.obtain(self.entry | {"source_url": "http://example.invalid/fixture"}, self.root / "bad", None, 0)

    def test_setup_and_clone_fail_closed(self):
        with patch("subprocess.run") as command:
            self.assertEqual(setup_model_downloads.main(["--policy", str(self.policy)]), 2)
            command.assert_not_called()
        lock = self.root / "sources.json"
        lock.write_text(json.dumps({"sources": [{"id": "fixture", "repo": "example/project",
                                                 "commit": None, "status": "blocked"}]}))
        with patch("subprocess.run", side_effect=AssertionError("No Git or pip allowed")):
            self.assertEqual(clone_external_repos.main(["--lock", str(lock), "--source", "fixture",
                                                       "--policy", str(self.policy), "--acquisition-only", "--connected-machine"]), 2)

    def run_clone_wrapper(self, args):
        stub = self.root / "python3"
        stub.write_text('#!/bin/bash\nprintf "%s\\0" "$@"\n')
        stub.chmod(0o755)
        result = subprocess.run(
            ["bash", str(fetch.ROOT / "scripts/clone_model_implementations.sh"), *args],
            env={**os.environ, "PATH": str(self.root) + os.pathsep + os.environ.get("PATH", "")},
            capture_output=True, check=True)
        return result.stdout.decode().split("\0")[:-1]

    def test_clone_wrapper_defaults_preserve_arguments(self):
        args = ["--policy", str(self.root / "policy with spaces.json"), "--connected-machine"]
        self.assertEqual(self.run_clone_wrapper(args),
                         [str(fetch.ROOT / "scripts/clone_external_repos.py"),
                          "--source", "sam2", "--source", "sapiens",
                          "--source", "stable-diffusion.cpp", "--source", "llama.cpp", *args])

    def test_clone_wrapper_explicit_sources_replace_defaults(self):
        for selection in (["--source", "sam2"], ["--source=sam2"],
                          ["--source", "sam2", "--source=llama.cpp"]):
            with self.subTest(selection=selection):
                args = ["--policy", str(self.root / "policy with spaces.json"), *selection]
                self.assertEqual(self.run_clone_wrapper(args),
                                 [str(fetch.ROOT / "scripts/clone_external_repos.py"), *args])


if __name__ == "__main__":
    unittest.main()
