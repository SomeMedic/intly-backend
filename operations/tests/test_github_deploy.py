import io
import json
import os
import pathlib
import stat
import subprocess
import tarfile
import tempfile
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "operations" / "scripts" / "github-deploy.py"
SHA = "0123456789abcdef0123456789abcdef01234567"


class TestGithubDeploy(unittest.TestCase):
    def make_root(self):
        temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(temp.name)
        (root / "secrets").mkdir()
        (root / "operations").mkdir()
        (root / "releases" / "20261009-ssh").mkdir(parents=True)
        (root / "secrets" / "backend.env").write_text("COMPOSE_PROFILES=firecrawl,embedding\n")
        (root / "secrets" / "frontend.env").write_text("NEXT_PUBLIC_API_URL=https://api.intly.tech/api/v1\n")
        (root / "releases" / "20261009-ssh" / "backend.production.json").write_text(
            '{"services":{"api":{"image":"sha256:' + "1" * 64 + '"},"worker":{"image":"sha256:' + "1" * 64 + '"},"minio":{"image":"sha256:' + "2" * 64 + '"},"mongo":{"image":"sha256:' + "3" * 64 + '"}}}\n'
        )
        (root / "releases" / "20261009-ssh" / "frontend.production.json").write_text(
            '{"services":{"frontend":{"image":"sha256:' + "4" * 64 + '"}}}\n'
        )
        return temp, root

    def make_archive(self, files, symlink=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, content in files.items():
                data = content.encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
            if symlink:
                info = tarfile.TarInfo(symlink)
                info.type = tarfile.SYMTYPE
                info.linkname = "/etc/passwd"
                archive.addfile(info)
        return buffer.getvalue()

    def make_bin(self, root, fail_new_backend_up=False, fail_health=False):
        bin_dir = root / "bin"
        bin_dir.mkdir()
        log = root / "calls.log"
        state = root / "state.json"
        docker = bin_dir / "docker"
        docker.write_text(
            "#!/usr/bin/env python3\n"
            "import json, pathlib, sys\n"
            f"log = pathlib.Path({str(log)!r})\n"
            f"state = pathlib.Path({str(state)!r})\n"
            f"fail_new_backend_up = {str(fail_new_backend_up)!r} == 'True'\n"
            "args = sys.argv[1:]\n"
            "log.write_text((log.read_text() if log.exists() else '') + 'docker ' + ' '.join(args) + '\\n')\n"
            "if args[:2] == ['--config', pathlib.Path(args[1]).as_posix()]:\n"
            "    pass\n"
            "if '--password-stdin' in args:\n"
            "    sys.stdin.read()\n"
            "    raise SystemExit(0)\n"
            "if 'image' in args and 'inspect' in args:\n"
            "    image = args[-1]\n"
            "    suffix = 'b' if 'minio' in image else ('c' if 'frontend' in image else 'a')\n"
            "    print('sha256:' + suffix * 64)\n"
            "    raise SystemExit(0)\n"
            "if len(args) >= 2 and args[0] == 'compose' and 'up' in args:\n"
            "    f_arg = args[args.index('-f') + 1] if '-f' in args else ''\n"
            "    if fail_new_backend_up and '/releases/backend/' in f_arg and '/old/' not in f_arg:\n"
            "        data = json.loads(state.read_text()) if state.exists() else {'failed': False}\n"
            "        if not data['failed']:\n"
            "            data['failed'] = True\n"
            "            state.write_text(json.dumps(data))\n"
            "            raise SystemExit(17)\n"
            "raise SystemExit(0)\n"
        )
        curl = bin_dir / "curl"
        curl.write_text("#!/usr/bin/env bash\nexit " + ("1" if fail_health else "0") + "\n")
        docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
        curl.chmod(curl.stat().st_mode | stat.S_IXUSR)
        return bin_dir, log

    def run_deploy(self, component, root, archive, fail_new_backend_up=False, command=f"deploy {SHA}", fail_health=False):
        bin_dir, log = self.make_bin(root, fail_new_backend_up=fail_new_backend_up, fail_health=fail_health)
        env = {
            **os.environ,
            "INTLY_ROOT": str(root),
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "SSH_ORIGINAL_COMMAND": command,
            "INTLY_HEALTH_TIMEOUT_SECONDS": "1",
            "INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS": "1",
        }
        result = subprocess.run(
            ["python3", str(SCRIPT), component],
            input=b"ghp_testtoken\n" + archive,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        return result, log

    def test_backend_deploy_extracts_archive_updates_only_app_images_and_promotes_unique_release(self):
        temp, root = self.make_root()
        with temp:
            archive = self.make_archive({"compose.yaml": "services: {}\n", "src/main.ts": "export {}\n"})
            result, log = self.run_deploy("backend", root, archive)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            current = (root / "current" / "backend").resolve()
            self.assertTrue(current.name.startswith(SHA + "-"))
            override = json.loads((current / "production.override.json").read_text())
            self.assertEqual(override["services"]["api"]["image"], "sha256:" + "a" * 64)
            self.assertEqual(override["services"]["worker"]["image"], "sha256:" + "a" * 64)
            self.assertEqual(override["services"]["minio"]["image"], "sha256:" + "b" * 64)
            self.assertEqual(override["services"]["mongo"]["image"], "sha256:" + "3" * 64)
            calls = log.read_text()
            self.assertIn("docker --config", calls)
            self.assertIn("pull ghcr.io/somemedic/intly-backend:" + SHA, calls)
            self.assertIn("pull ghcr.io/somemedic/intly-backend/minio:" + SHA, calls)
            self.assertIn("--pull never", calls)
            receipt = json.loads((root / "operations" / "deploy-backend.json").read_text())
            self.assertTrue(receipt["success"])
            self.assertEqual(receipt["sha"], SHA)

    def test_frontend_deploy_uses_sha_prefixed_image_and_promotes_unique_release(self):
        temp, root = self.make_root()
        with temp:
            archive = self.make_archive({"compose.yaml": "services: {}\n", "app/page.tsx": "export default function Page(){}\n"})
            result, log = self.run_deploy("frontend", root, archive)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            current = (root / "current" / "frontend").resolve()
            self.assertTrue(current.name.startswith(SHA + "-"))
            override = json.loads((current / "production.override.json").read_text())
            self.assertEqual(override["services"]["frontend"]["image"], "sha256:" + "c" * 64)
            self.assertIn("pull ghcr.io/somemedic/intly-frontend:sha-" + SHA, log.read_text())

    def test_rejects_private_paths_links_and_unsafe_commands_before_deploy(self):
        rejected_archives = [
            self.make_archive({".env": "SECRET=1\n", "compose.yaml": "services: {}\n"}),
            self.make_archive({".git/config": "private\n", "compose.yaml": "services: {}\n"}),
            self.make_archive({"node_modules/pkg/index.js": "generated\n", "compose.yaml": "services: {}\n"}),
            self.make_archive({"../compose.yaml": "services: {}\n"}),
            self.make_archive({"compose.yaml": "services: {}\n"}, symlink="public/link"),
        ]
        for archive in rejected_archives:
            temp, root = self.make_root()
            with temp:
                result, log = self.run_deploy("frontend", root, archive)
                self.assertEqual(result.returncode, 2, result.stderr.decode())
                self.assertFalse(log.exists())

        temp, root = self.make_root()
        with temp:
            archive = self.make_archive({"compose.yaml": "services: {}\n"})
            result, log = self.run_deploy("backend", root, archive, command="whoami")
            self.assertEqual(result.returncode, 2)
            self.assertIn(b"SSH command must be exactly", result.stderr)
            self.assertFalse(log.exists())

    def test_failed_backend_up_rolls_back_old_release_and_keeps_pointer(self):
        temp, root = self.make_root()
        with temp:
            old = root / "releases" / "backend" / "old"
            old.mkdir(parents=True)
            (old / "compose.yaml").write_text("services: {}\n")
            (old / "production.override.json").write_text('{"services":{"api":{"image":"sha256:' + "9" * 64 + '"}}}\n')
            (root / "current").mkdir()
            (root / "current" / "backend").symlink_to(old)
            archive = self.make_archive({"compose.yaml": "services: {}\n", "src/main.ts": "export {}\n"})
            result, log = self.run_deploy("backend", root, archive, fail_new_backend_up=True)
            self.assertEqual(result.returncode, 1, result.stderr.decode())
            self.assertEqual((root / "current" / "backend").resolve(), old.resolve())
            calls = log.read_text()
            rollback_lines = [line for line in calls.splitlines() if "compose" in line and " up " in line and "/old/" in line]
            self.assertEqual(len(rollback_lines), 1)
            receipt = json.loads((root / "operations" / "deploy-backend.json").read_text())
            self.assertFalse(receipt["success"])


    def test_failed_health_rolls_back_and_does_not_promote(self):
        temp, root = self.make_root()
        with temp:
            old = root / "releases" / "frontend" / "old"
            old.mkdir(parents=True)
            (old / "compose.yaml").write_text("services: {}\n")
            (old / "production.override.json").write_text('{"services":{"frontend":{"image":"sha256:' + "9" * 64 + '"}}}\n')
            (root / "current").mkdir()
            (root / "current" / "frontend").symlink_to(old)
            archive = self.make_archive({"compose.yaml": "services: {}\n"})
            result, log = self.run_deploy("frontend", root, archive, fail_health=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual((root / "current" / "frontend").resolve(), old.resolve())
            rollback_lines = [line for line in log.read_text().splitlines() if " up " in line and "/old/" in line]
            self.assertEqual(len(rollback_lines), 1)
            self.assertFalse(json.loads((root / "operations" / "deploy-frontend.json").read_text())["success"])
            self.assertNotIn(b"ghp_testtoken", result.stdout + result.stderr)

if __name__ == "__main__":
    unittest.main()
