#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate an independent Pi Durable project with a selected evolution plan."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def scaffold_evolution(destination: Path, strategy: str, *, with_tests=False, profile="service"):
    module_path = Path(__file__).with_name("scaffold.py")
    spec = importlib.util.spec_from_file_location("durable_scaffold", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.scaffold(destination, with_tests=with_tests, profile=profile)
    destination = destination.resolve()
    catalog = json.loads((destination / "evolution-plans/catalog.json").read_text(encoding="utf-8"))
    selected = catalog["strategies"][strategy]
    plan_path = destination / "evolution-plans/plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    config = json.loads((destination / "config.json").read_text(encoding="utf-8"))
    plan["agentId"] = config["agents"][0]["id"]
    plan.update({"strategy": strategy, "maxCandidates": selected["maxCandidates"], "maxGenerations": selected["maxGenerations"]})
    plan_path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    manifest_path = destination / "scaffold-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["evolutionStrategy"] = strategy
    manifest["files"] = {p.relative_to(destination).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in sorted(destination.rglob("*")) if p.is_file() and p != manifest_path}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {**result, "evolutionStrategy": strategy, "plan": "evolution-plans/plan.json",
            "runner": "evolution-plans/study.py", "automaticActivation": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--strategy", choices=["trace-distillation", "population", "pareto"], default="trace-distillation")
    parser.add_argument("--with-tests", action="store_true")
    parser.add_argument("--profile", choices=["service", "supervisor", "map-reduce", "review-refine"], default="service")
    args = parser.parse_args()
    try:
        print(json.dumps(scaffold_evolution(args.destination, args.strategy, with_tests=args.with_tests, profile=args.profile), indent=2))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(2, f"Evolution scaffold failed: {error}\n")


if __name__ == "__main__":
    main()
