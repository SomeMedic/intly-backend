#!/usr/bin/env python3
"""Forced-command deployment gateway for GitHub Actions."""
from __future__ import annotations

import fcntl
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone


COMMAND_RE = re.compile(r"^deploy ([0-9a-f]{40})$")
TOKEN_LIMIT = 4096
ARCHIVE_LIMIT = 250 * 1024 * 1024
ARCHIVE_ENTRY_LIMIT = 20_000
ARCHIVE_EXPANDED_LIMIT = 250 * 1024 * 1024


@dataclass(frozen=True)
class Component:
    name: str
    project: str
    env_file: str
    health_urls: tuple[str, ...]
    image_refs: tuple[tuple[str, str], ...]
    override_services: tuple[tuple[str, str], ...]
    legacy_override: str


def root() -> pathlib.Path:
    return pathlib.Path(os.environ.get("INTLY_ROOT", "/opt/intly"))


def repo_owner() -> str:
    return os.environ.get("INTLY_GHCR_OWNER", "somemedic").lower()


def components(sha: str) -> dict[str, Component]:
    owner = repo_owner()
    return {
        "backend": Component(
            name="backend",
            project="intly-backend",
            env_file="backend.env",
            health_urls=(
                "http://127.0.0.1:3001/api/v1/health/live",
                "http://127.0.0.1:3001/api/v1/health/ready",
            ),
            image_refs=(
                ("backend", f"ghcr.io/{owner}/intly-backend:{sha}"),
                ("minio", f"ghcr.io/{owner}/intly-backend/minio:{sha}"),
            ),
            override_services=(("api", "backend"), ("worker", "backend"), ("minio", "minio")),
            legacy_override="backend.production.json",
        ),
        "frontend": Component(
            name="frontend",
            project="intly-frontend",
            env_file="frontend.env",
            health_urls=("http://127.0.0.1:3000/login",),
            image_refs=(("frontend", f"ghcr.io/{owner}/intly-frontend:sha-{sha}"),),
            override_services=(("frontend", "frontend"),),
            legacy_override="frontend.production.json",
        ),
    }


def fail(message: str, code: int = 2) -> None:
    print(f"github-deploy: {message}", file=sys.stderr)
    raise SystemExit(code)


def parse_args() -> tuple[Component, str]:
    if len(sys.argv) != 2:
        fail("component argument is required")
    match = COMMAND_RE.fullmatch(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    if not match:
        fail("SSH command must be exactly: deploy <40-lowercase-hex-sha>")
    sha = match.group(1)
    component = components(sha).get(sys.argv[1])
    if component is None:
        fail(f"unknown component: {sys.argv[1]}")
    return component, sha


def read_token_and_archive(target: pathlib.Path) -> str:
    token = sys.stdin.buffer.readline(TOKEN_LIMIT + 2)
    if not token.endswith(b"\n") or len(token) > TOKEN_LIMIT + 1:
        fail("missing or oversized GHCR token line")
    token = token[:-1]
    if not token:
        fail("empty GHCR token")
    total = 0
    with target.open("wb") as archive:
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > ARCHIVE_LIMIT:
                fail("git archive stream is too large")
            archive.write(chunk)
    if total == 0:
        fail("empty git archive stream")
    return token.decode("utf-8", "strict")


def safe_extract(archive_path: pathlib.Path, dest: pathlib.Path) -> None:
    dest_resolved = dest.resolve()
    with tarfile.open(archive_path) as archive:
        expanded = 0
        for index, member in enumerate(archive.getmembers(), start=1):
            if index > ARCHIVE_ENTRY_LIMIT:
                fail("git archive has too many entries")
            pure = pathlib.PurePosixPath(member.name)
            if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
                fail(f"unsafe archive path: {member.name}")
            if ".git" in pure.parts or "node_modules" in pure.parts or ".local" in pure.parts:
                fail(f"private or generated archive path is not deployable: {member.name}")
            basename = pure.name
            allow_env = member.name == "operations/environments/compose-ci.env" or basename.endswith(".example")
            if not allow_env and (basename == ".env" or basename.startswith(".env.") or basename.endswith(".env")):
                fail(f"runtime env files are not accepted in deploy archives: {member.name}")
            member_path = (dest / member.name).resolve()
            if not str(member_path).startswith(str(dest_resolved) + os.sep) and member_path != dest_resolved:
                fail(f"unsafe archive path: {member.name}")
            if not (member.isdir() or member.isreg()):
                fail(f"unsafe archive entry: {member.name}")
            if member.isreg():
                expanded += member.size
                if expanded > ARCHIVE_EXPANDED_LIMIT:
                    fail("git archive expanded content is too large")
        archive.extractall(dest)


def run(
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    cwd: pathlib.Path | None = None,
    capture: bool = False,
    scrub_output: bool = False,
) -> str:
    print("+ " + " ".join(args), flush=True)
    stdout = subprocess.PIPE if capture else (subprocess.DEVNULL if scrub_output else None)
    stderr = subprocess.DEVNULL if scrub_output else None
    completed = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        input=input_text,
        text=True,
        stdout=stdout,
        stderr=stderr,
        check=True,
    )
    return completed.stdout if capture and completed.stdout is not None else ""


def docker_login(token: str, docker_config: pathlib.Path) -> None:
    docker_config.mkdir(mode=0o700)
    run(
        ["docker", "--config", str(docker_config), "login", "ghcr.io", "-u", "SomeMedic", "--password-stdin"],
        input_text=token + "\n",
        scrub_output=True,
    )


def pull_images(component: Component, docker_config: pathlib.Path) -> dict[str, str]:
    image_ids: dict[str, str] = {}
    for key, ref in component.image_refs:
        run(["docker", "--config", str(docker_config), "pull", ref])
        image_id = run(
            ["docker", "--config", str(docker_config), "image", "inspect", "--format", "{{.Id}}", ref],
            capture=True,
        ).strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            fail(f"unexpected docker image id for {ref}: {image_id}")
        image_ids[key] = image_id
    return image_ids


def current_dir(component: Component) -> pathlib.Path:
    return root() / "current" / component.name


def release_dir(component: Component, sha: str) -> pathlib.Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return root() / "releases" / component.name / f"{sha}-{stamp}-{uuid.uuid4().hex[:8]}"


def legacy_override(component: Component) -> pathlib.Path:
    return root() / "releases" / "20261009-ssh" / component.legacy_override


def source_override(component: Component) -> pathlib.Path:
    current = current_dir(component) / "production.override.json"
    if current.exists():
        return current
    legacy = legacy_override(component)
    if legacy.exists():
        return legacy
    fail(f"no production override found for {component.name}")


def write_override(component: Component, release: pathlib.Path, image_ids: dict[str, str]) -> None:
    data = json.loads(source_override(component).read_text())
    services = data.setdefault("services", {})
    for service, key in component.override_services:
        services.setdefault(service, {})["image"] = image_ids[key]
    target = release / "production.override.json"
    target.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.chmod(target, 0o600)


def compose_args(component: Component, release: pathlib.Path) -> list[str]:
    return [
        "docker",
        "compose",
        "--env-file",
        str(root() / "secrets" / component.env_file),
        "-f",
        str(release / "compose.yaml"),
        "-f",
        str(release / "production.override.json"),
        "-p",
        component.project,
    ]


def compose_env(component: Component) -> dict[str, str]:
    env = os.environ.copy()
    if component.name == "backend":
        env["INTLY_DEPLOY_ENV_FILE"] = str(root() / "secrets" / component.env_file)
        env["COMPOSE_PROFILES"] = env.get("COMPOSE_PROFILES", "firecrawl,embedding")
    else:
        env["INTLY_FRONTEND_ENV_FILE"] = str(root() / "secrets" / component.env_file)
    return env


def deploy_release(component: Component, release: pathlib.Path) -> None:
    compose = compose_args(component, release)
    env = compose_env(component)
    wait_timeout = os.environ.get("INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS", "600")
    if not re.fullmatch(r"[1-9][0-9]*", wait_timeout):
        fail("INTLY_COMPOSE_WAIT_TIMEOUT_SECONDS must be a positive integer")
    run(compose + ["config", "--quiet"], cwd=release, env=env)
    run(compose + ["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", wait_timeout], cwd=release, env=env)
    for url in component.health_urls:
        wait_for_url(url, timeout=int(os.environ.get("INTLY_HEALTH_TIMEOUT_SECONDS", "120")))


def wait_for_url(url: str, *, timeout: int) -> None:
    if timeout <= 0:
        fail("INTLY_HEALTH_TIMEOUT_SECONDS must be a positive integer")
    deadline = time.monotonic() + timeout
    while True:
        result = subprocess.run(["curl", "--connect-timeout", "2", "--max-time", "5", "-fsS", "-o", "/dev/null", url])
        if result.returncode == 0:
            return
        if time.monotonic() >= deadline:
            fail(f"health check did not pass before {timeout}s: {url}", code=1)
        time.sleep(3)


def promote(component: Component, release: pathlib.Path) -> None:
    current_parent = current_dir(component).parent
    current_parent.mkdir(parents=True, exist_ok=True)
    tmp_link = current_parent / f".{component.name}.{os.getpid()}.tmp"
    if tmp_link.exists() or tmp_link.is_symlink():
        tmp_link.unlink()
    tmp_link.symlink_to(release)
    os.replace(tmp_link, current_dir(component))


def rollback(component: Component, release: pathlib.Path | None) -> None:
    if release is None or not (release / "compose.yaml").exists():
        return
    try:
        run(
            compose_args(component, release) + ["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "600"],
            cwd=release,
            env=compose_env(component),
        )
    except Exception as error:
        print(f"github-deploy: rollback failed: {error}", file=sys.stderr)


def write_receipt(component: Component, sha: str, image_ids: dict[str, str], success: bool) -> None:
    target = root() / "operations" / f"deploy-{component.name}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({
        "component": component.name,
        "sha": sha,
        "images": image_ids,
        "success": success,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, indent=2, sort_keys=True) + "\n")


def main() -> None:
    component, sha = parse_args()
    lock_path = root() / "operations" / "github-deploy.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix="github-deploy-") as temp:
            temp_path = pathlib.Path(temp)
            archive_path = temp_path / "source.tar"
            token = read_token_and_archive(archive_path)
            staging = temp_path / "release"
            staging.mkdir()
            safe_extract(archive_path, staging)
            docker_config = temp_path / "docker-config"
            docker_login(token, docker_config)
            image_ids = pull_images(component, docker_config)
            old_release = current_dir(component).resolve(strict=False) if current_dir(component).exists() else None
            release = release_dir(component, sha)
            release.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(staging), release)
            write_override(component, release, image_ids)
            try:
                deploy_release(component, release)
            except (Exception, SystemExit):
                write_receipt(component, sha, image_ids, success=False)
                rollback(component, old_release)
                raise
            promote(component, release)
            write_receipt(component, sha, image_ids, success=True)
            print(f"{component.name} deployment is healthy at {sha}")


if __name__ == "__main__":
    main()
