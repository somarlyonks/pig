#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Operate this generated service using only files and dependencies in the project."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    prepare = actions.add_parser("prepare", help="Install pinned dependencies and build.")
    prepare.add_argument("--skip-install", action="store_true", help="Build using dependencies already installed in this project.")
    actions.add_parser("smoke", help="Exercise offline events, chat and recovery, then close the service.")
    plan = actions.add_parser("plan", help="Render a service installation plan without registration.")
    plan.add_argument("--options", type=Path, required=True, help="Local JSON containing target-OS ServiceOptions.")
    plan.add_argument("--output", type=Path, required=True, help="Exact output path, relative to the caller's current directory.")
    evolve = actions.add_parser("evolve", add_help=False, help="Pass arguments to the local evolution CLI; use evolve -- --help.")
    evolve.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    manifest = project / "package.json"
    if not manifest.is_file() or json.loads(manifest.read_text(encoding="utf-8")).get("name") != "pi-durable-agent-service":
        parser.error("Expected this script inside the generated service project.")
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        parser.error("Node 24+ and npm must be available on PATH.")
    environment = os.environ.copy()
    environment["npm_config_cache"] = str(project / ".cache/npm")
    commands: list[list[str]]
    if args.action == "prepare":
        commands = [] if args.skip_install else [[npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]]
        commands.append([npm, "run", "build"])
    elif args.action == "smoke":
        commands = [[node, "dist/src/smoke.js"]]
    elif args.action == "plan":
        options = args.options.resolve()
        json.loads(options.read_text(encoding="utf-8"))
        commands = [[node, "dist/src/cli.js", "service", "install", "--config", "config.json", "--options", str(options), "--output", str(args.output.resolve())]]
    else:
        forwarded = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
        commands = [[node, "dist/src/evolve-cli.js", *forwarded]]
    try:
        for command in commands:
            subprocess.run(command, cwd=project, env=environment, check=True)
    except subprocess.CalledProcessError as error:
        parser.exit(error.returncode or 1, "Project operation failed; inspect the command output above.\n")


if __name__ == "__main__":
    main()
