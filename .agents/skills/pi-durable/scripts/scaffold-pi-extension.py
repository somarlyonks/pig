#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Copy an independent Pi extension and connect it to a local Durable service."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from pathlib import Path


def read_service_config(path: Path) -> dict:
    """Validate the same loopback connection boundary as the generated client."""
    if path.stat().st_size > 256 * 1024:
        raise ValueError("The service config exceeds the 256 KiB limit.")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("The service config must use version 1.")
    if value.get("host") != "127.0.0.1":
        raise ValueError("The service config must bind to 127.0.0.1.")
    port = value.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("The service port must be an integer from 1 to 65535.")
    data_dir = value.get("dataDir")
    if not isinstance(data_dir, str) or not data_dir.strip() or len(data_dir) > 4096 or any(ord(c) < 32 for c in data_dir):
        raise ValueError("The service config must declare a nonempty dataDir path.")
    if {"url", "baseUrl", "token", "authorization", "username", "password"}.intersection(value):
        raise ValueError("Keep connection credentials in service state, outside the service config.")
    return value


def scaffold(destination: Path, service_config: Path | None = None, *, service_id: str = "local", with_tests: bool = False) -> dict:
    skill = Path(__file__).resolve().parents[1]
    destination = destination.resolve()
    service_config = service_config.resolve(strict=True) if service_config is not None else None
    if destination == skill or skill in destination.parents:
        raise ValueError("Generate the extension outside the read-only skill bundle.")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError("The destination must be absent or an empty directory.")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", service_id):
        raise ValueError("The service ID must start with a lowercase letter and use lowercase letters, digits, or hyphens (64 characters maximum).")
    relative_config = None
    if service_config is not None:
        read_service_config(service_config)
        try:
            relative_config = Path(os.path.relpath(service_config, destination)).as_posix()
        except ValueError as error:
            raise ValueError("Place the extension and service config on the same filesystem volume so their connection path can remain relative.") from error
    template = skill / "assets/templates/pi-extension"
    if not (template / "extension.ts").is_file() or not (template / "package.json").is_file():
        raise ValueError("The Pi extension template is missing from this bundle.")
    service_template = skill / "assets/templates/service"
    if not (service_template / "package-lock.json").is_file():
        raise ValueError("The independent service template is missing from this bundle.")
    tests = skill / "assets/examples/pi-extension-acceptance"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copytree(template, destination, dirs_exist_ok=True)
    # Ship the independent factory payload with the console, rather than linking
    # a running extension back to this skill or to its original checkout.
    shutil.copytree(
        service_template,
        destination / "service-template",
        ignore=shutil.ignore_patterns("node_modules", ".cache", "dist", "state", "*.log"),
    )
    included_tests = with_tests and tests.is_dir()
    if included_tests:
        shutil.copytree(tests, destination / "tests")
    connections = {"version": 1, "services": [{"id": service_id, "configPath": relative_config}] if relative_config else []}
    (destination / "durable-agents.json").write_text(json.dumps(connections, indent=2) + "\n", encoding="utf-8")
    package = json.loads((destination / "package.json").read_text(encoding="utf-8"))
    files = {
        path.relative_to(destination).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(destination.rglob("*"))
        if path.is_file()
    }
    manifest = {
        "schemaVersion": 1,
        "template": "pi-durable-console-pi-1.5.1",
        "runtimeSource": {"package": "@earendil-works/pi-coding-agent", "version": "1.5.1"},
        "runtimeIndependent": True,
        "agentCreationIncluded": True,
        "tests_included": included_tests,
        "dependencies": package.get("dependencies", {}),
        "peerDependencies": package.get("peerDependencies", {}),
        "devDependencies": package.get("devDependencies", {}),
        "files": files,
    }
    (destination / "scaffold-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"destination": str(destination), "template": manifest["template"], "tests_included": included_tests, "serviceId": service_id if relative_config else None}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--service-config", type=Path, help="Optional existing service; omit to create the first agent from Pi.")
    parser.add_argument("--service-id", default="local")
    parser.add_argument("--with-tests", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(scaffold(args.destination, args.service_config, service_id=args.service_id, with_tests=args.with_tests), indent=2))
    except (ValueError, OSError) as error:
        parser.exit(2, f"Scaffold failed: {error}\n")


if __name__ == "__main__":
    main()
