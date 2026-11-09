#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Verify independent subagent profile generation without package installation."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True


def main() -> None:
    spec = importlib.util.spec_from_file_location("durable_scaffold", Path(__file__).with_name("scaffold.py"))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Keep local verification artifacts in the caller's workspace.
    Path(".cache").mkdir(exist_ok=True)
    checked = []
    with tempfile.TemporaryDirectory(prefix="profile checks ", dir=".cache") as folder:
        for profile in ("service", "supervisor", "map-reduce", "review-refine"):
            destination = Path(folder) / profile
            receipt = module.scaffold(destination, profile=profile)
            assert receipt["profile"] == profile
            manifest = json.loads((destination / "scaffold-manifest.json").read_text())
            assert manifest["runtimeIndependent"] is True
            for name, digest in manifest["files"].items():
                assert hashlib.sha256((destination / name).read_bytes()).hexdigest() == digest, name
            config = json.loads((destination / "config.json").read_text())
            assert config["provider"]["kind"] == "faux"
            agent = config["agents"][0]
            if profile != "service":
                assert 1 <= len(agent["subagents"]["roles"]) <= 8
                for role in agent["subagents"]["roles"]:
                    assert (destination / role["instructionsFile"]).read_text().strip()
                live = json.loads((destination / "config.codex.example.json").read_text())
                assert live["provider"] == {"kind": "openai-codex", "model": "latest", "catalogMode": "refresh"}
                assert (destination / agent["instructionsFile"]).read_text().strip()
                plan = json.loads((destination / "evolution-plans/plan.json").read_text())
                example = json.loads((destination / "evaluation/request.example.json").read_text())
                assert plan["agentId"] == example["agentId"] == agent["id"]
            try:
                module.scaffold(destination, profile=profile)
            except ValueError:
                pass
            else:
                raise AssertionError("A nonempty destination was overwritten.")
            checked.append(profile)
    print(json.dumps({"passed": True, "profiles": checked, "freshHashes": True, "nonemptyRefused": True}))


if __name__ == "__main__":
    main()
