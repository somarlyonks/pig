#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Copy the self-contained Pi Durable service template to an exact destination."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def scaffold(destination: Path, *, with_tests: bool = False, profile: str = "service") -> dict:
    skill = Path(__file__).resolve().parents[1]
    destination = destination.resolve()
    if destination == skill or skill in destination.parents:
        raise ValueError("Generate the service outside the read-only skill bundle.")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError("The destination must be absent or an empty directory.")
    template = skill / "assets/templates/service"
    profiles = {"service", "supervisor", "map-reduce", "review-refine"}
    if profile not in profiles:
        raise ValueError(f"Unknown profile: {profile}")
    if not (template / "package.json").is_file():
        raise ValueError("The service template is missing from this bundle.")
    tests = skill / "assets/examples/service-acceptance"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copytree(template, destination, dirs_exist_ok=True)
    if profile != "service":
        resources = skill / "assets/templates/subagents"
        overlay = json.loads((resources / f"{profile}.json").read_text(encoding="utf-8"))
        config = json.loads((destination / "config.json").read_text(encoding="utf-8"))
        config["agents"] = [overlay]
        (destination / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        shutil.copytree(resources / "prompts", destination / "prompts", dirs_exist_ok=True)
        plan_path = destination / "evolution-plans/plan.json"
        if plan_path.is_file():
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            plan["agentId"] = overlay["id"]
            plan_path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
            example = {key: plan[key] for key in ("agentId", "goal", "allowedPaths", "minimumImprovement", "timeoutMs")}
            example.update(plan["development"])
            (destination / "evaluation/request.example.json").write_text(json.dumps(example, indent=2) + "\n", encoding="utf-8")
    config = json.loads((destination / "config.json").read_text(encoding="utf-8"))
    live_config = {**config, "provider": {"kind": "openai-codex", "model": "latest", "catalogMode": "refresh"}}
    (destination / "config.codex.example.json").write_text(json.dumps(live_config, indent=2) + "\n", encoding="utf-8")
    included_tests = with_tests and tests.is_dir()
    if included_tests:
        shutil.copytree(tests, destination / "tests")
    package = json.loads((destination / "package.json").read_text(encoding="utf-8"))
    files = {
        path.relative_to(destination).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(destination.rglob("*"))
        if path.is_file()
    }
    manifest = {
        "schemaVersion": 1,
        "template": "pi-durable-service-1.5.0",
        "runtimeSource": {
            "package": "@earendil-works/pi-durable",
            "version": "1.5.0",
            "upstreamCommit": "f9a26365568127461c47a07a37dcb42c140a3ac5",
        },
        "runtimeIndependent": True,
        "profile": profile,
        "tests_included": included_tests,
        "dependencies": package.get("dependencies", {}),
        "devDependencies": package.get("devDependencies", {}),
        "files": files,
    }
    (destination / "scaffold-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    result = {"destination": str(destination), "template": manifest["template"], "profile": profile, "tests_included": included_tests}
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--with-tests", action="store_true")
    parser.add_argument("--profile", choices=["service", "supervisor", "map-reduce", "review-refine"], default="service")
    args = parser.parse_args()
    try:
        print(json.dumps(scaffold(args.destination, with_tests=args.with_tests, profile=args.profile), indent=2))
    except (ValueError, OSError) as error:
        parser.exit(2, f"Scaffold failed: {error}\n")


if __name__ == "__main__":
    main()
