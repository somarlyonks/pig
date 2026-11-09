#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Prepare, smoke-test, or render a plan for a generated service without shell quoting."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("action", choices=["prepare", "smoke", "plan"])
    parser.add_argument("--options", type=Path, help="Local JSON containing target-OS ServiceOptions.")
    parser.add_argument("--output", type=Path, help="Exact output path, relative to the caller's current directory.")
    args = parser.parse_args()
    project = args.project.resolve()
    skill = Path(__file__).resolve().parents[1]
    if project == skill or skill in project.parents:
        parser.error("Operate a generated project outside the read-only skill bundle.")
    manifest = project / "package.json"
    if not manifest.is_file() or json.loads(manifest.read_text(encoding="utf-8")).get("name") != "pi-durable-agent-service":
        parser.error("Expected the generated service package at the exact project path.")
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        parser.error("Node 24+ and npm must be available on PATH.")
    environment = os.environ.copy()
    environment["npm_config_cache"] = str(project / ".cache/npm")
    commands: list[list[str]]
    if args.action == "prepare":
        commands = [[npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], [npm, "run", "build"]]
    elif args.action == "smoke":
        commands = [[node, "dist/src/smoke.js"]]
    else:
        if args.options is None or args.output is None:
            parser.error("plan requires --options and --output.")
        options = args.options.resolve()
        json.loads(options.read_text(encoding="utf-8"))
        commands = [[node, "dist/src/cli.js", "service", "install", "--config", "config.json", "--options", str(options), "--output", str(args.output.resolve())]]
    try:
        for command in commands:
            subprocess.run(command, cwd=project, env=environment, check=True)
    except subprocess.CalledProcessError as error:
        parser.exit(error.returncode or 1, "Generated project operation failed; inspect the command output above.\n")


if __name__ == "__main__":
    main()
