#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Bounded, explicit development search with one-way independent gates.

Run from the generated project: uv run --script evolution-plans/study.py --help.
This controller never promotes source and does not provide a security sandbox.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local(value, *, existing=True):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("Use an exact project-relative path with forward slashes.")
    candidate = ROOT / value
    if candidate.is_absolute() and not candidate.resolve().is_relative_to(ROOT):
        raise ValueError("Path escaped the generated project.")
    current = ROOT
    for part in Path(value).parts:
        current /= part
        if current.is_symlink():
            raise ValueError("Symlink study inputs and outputs are not supported.")
    if not candidate.resolve().is_relative_to(ROOT):
        raise ValueError("Path escaped the generated project.")
    if existing and not candidate.is_file():
        raise ValueError(f"Expected an existing project file: {value}")
    return candidate


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


def seal(value):
    return {**value, "digest": digest(value)}


def sealed(path):
    value = read(path)
    payload = {k: v for k, v in value.items() if k != "digest"}
    if value.get("digest") != digest(payload):
        raise ValueError("Study artifact digest mismatch.")
    return value


def study_dir(identity):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", identity):
        raise ValueError("Study IDs must be lowercase hyphen-case, at most 48 characters.")
    return ROOT / "evolution-plans" / "runs" / identity


@contextmanager
def mutation_lock(identity, command):
    """Serialize the complete command, including long-running CLI children.

    Interrupted owners leave their lock in place. Never infer that a process is
    dead from the file's age or delete it automatically.
    """
    directory = study_dir(identity)
    path = local(f"evolution-plans/runs/.locks/{identity}.json", existing=False)
    token = uuid.uuid4().hex
    record = {"version": 1, "pid": os.getpid(), "parentPid": os.getppid(), "command": command,
              "createdEpoch": time.time(), "token": token, "study": identity}
    try:
        write_new(path, record)
    except FileExistsError as error:
        raise ValueError("Another command owns this study mutation lock. Inspect its process and child processes before explicit interrupted-lock recovery; locks never expire automatically.") from error
    try:
        yield
    finally:
        # Do not remove a lock replaced by an operator or another owner.
        try:
            owner = read(path)
        except FileNotFoundError:
            raise ValueError("Study lock disappeared while its command was running.")
        if owner.get("token") != token:
            raise ValueError("Study lock owner changed while its command was running.")
        path.unlink()


def check_contract(contract):
    if not isinstance(contract, dict) or set(contract) != {"verifierPath", "fixturePaths"}:
        raise ValueError("A gate contract requires exactly verifierPath and fixturePaths.")
    fixtures = contract["fixturePaths"]
    if not isinstance(fixtures, list) or not 1 <= len(fixtures) <= 32 or len(set(fixtures)) != len(fixtures):
        raise ValueError("Declare 1 to 32 unique fixtures.")
    if not str(contract["verifierPath"]).endswith((".mjs", ".js")):
        raise ValueError("The verifier must be an existing Node .mjs/.js file.")
    return {p: file_hash(local(p)) for p in [contract["verifierPath"], *fixtures]}


def call_cli(config, args, seconds):
    cli = ROOT / "dist/src/evolve-cli.js"
    if not cli.is_file():
        raise ValueError("Build this generated project before using the study runner.")
    result = subprocess.run(["node", str(cli), *args, "--config", str(local(config))], cwd=ROOT,
                            capture_output=True, text=True, encoding="utf-8", timeout=max(1, seconds), shell=False)
    if result.returncode:
        raise ValueError(f"Evolution CLI failed: {result.stderr[-4000:]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Evolution CLI did not return one JSON receipt.") from error


def remaining(study):
    left = study["startedEpoch"] + study["plan"]["maxWallSeconds"] - time.time()
    if left <= 0:
        raise ValueError("The frozen study wall-time budget is exhausted; retain its evidence.")
    return left


def load_study(identity, *, development=False):
    directory = study_dir(identity)
    study = sealed(directory / "study.json")
    if study["id"] != identity:
        raise ValueError("Study identity mismatch.")
    if file_hash(local(study["config"])) != study["configHash"]:
        raise ValueError("Service configuration changed after the study opened.")
    if file_hash(Path(__file__).resolve()) != study["controllerHash"]:
        raise ValueError("Study controller changed after the study opened.")
    if any(file_hash(local(record["path"])) != record["sha256"] for record in study["request"]["source"]):
        raise ValueError("Baseline source changed after the study opened.")
    if any(file_hash(local(path)) != sha for path, sha in study["developmentHashes"].items()):
        raise ValueError("Development verifier or fixtures changed after the study opened.")
    if development and (directory / "selection.json").exists():
        raise ValueError("Development is closed after selection; open a new study for changes.")
    return directory, study


def evaluations(directory):
    return [sealed(path) for path in sorted(directory.glob("candidate-*.json"))]


def candidate_patch(value):
    changes = value.get("changes")
    if not isinstance(changes, list) or not changes or any(not isinstance(c, dict) or set(c) != {"path", "beforeHash", "content"} for c in changes):
        raise ValueError("Candidates require complete {path,beforeHash,content} file changes.")
    return digest(sorted(changes, key=lambda change: change["path"]))


def paired_valid(record):
    result = record["evaluation"]
    baseline = result.get("baseline", {}).get("verification")
    candidate = result.get("candidate", {}).get("verification")
    return bool(baseline and candidate and baseline.get("passed") and candidate.get("passed")
                and baseline.get("cases") and candidate.get("cases")
                and all(case.get("passed") for case in [*baseline["cases"], *candidate["cases"]])
                and sorted(case["id"] for case in baseline["cases"]) == sorted(case["id"] for case in candidate["cases"]))


def open_study(args):
    started = time.time()
    plan = read(local(args.plan))
    if plan.get("version") != 1 or plan.get("strategy") not in ("trace-distillation", "population", "pareto"):
        raise ValueError("Select a supported version-1 evolution plan.")
    for key, low, high in (("maxCandidates", 1, 32), ("maxGenerations", 1, 8), ("maxWallSeconds", 30, 86400), ("timeoutMs", 100, 600000)):
        if type(plan.get(key)) is not int or not low <= plan[key] <= high:
            raise ValueError(f"Invalid bounded {key}.")
    if not isinstance(plan.get("minimumImprovement"), (int, float)) or not 0 < plan["minimumImprovement"] <= 1:
        raise ValueError("minimumImprovement must be positive and at most 1.")
    if plan["strategy"] == "trace-distillation" and plan["maxCandidates"] != 1:
        raise ValueError("Trace distillation uses one focused candidate; use population for alternatives.")
    dev_hashes = check_contract(plan["development"])
    commitments = {}
    for stage in ("validation", "holdout"):
        name = plan.get(stage + "Commitment")
        if name:
            commitment = read(local(name))
            if set(commitment) != {"version", "sha256"} or commitment["version"] != 1 or not re.fullmatch(r"[a-f0-9]{64}", commitment["sha256"]):
                raise ValueError("Expected an opaque version-1 gate commitment.")
            commitments[stage] = commitment["sha256"]
    if "validation" not in commitments:
        raise ValueError("A preregistered independent validation commitment is required.")
    directory = study_dir(args.study)
    if directory.exists():
        raise ValueError("Study output already exists; do not reuse a previous study identity.")
    directory.mkdir(parents=True)
    request_input = {key: plan[key] for key in ("agentId", "goal", "allowedPaths", "minimumImprovement", "timeoutMs")}
    request_input.update(plan["development"])
    request_input["id"] = args.study + "-development"
    request_path = directory / "development-request-input.json"
    write_new(request_path, request_input)
    request = call_cli(args.config, ["request", "--input", str(request_path)], plan["maxWallSeconds"])
    if {item["path"]:item["sha256"] for item in request["frozenVerifier"]} != dev_hashes:
        raise ValueError("Development verifier inputs changed during request admission.")
    study = seal({"version": 1, "id": args.study, "startedEpoch": started, "config": args.config,
                  "controllerHash": file_hash(Path(__file__).resolve()),
                  "configHash": file_hash(local(args.config)), "plan": plan, "planHash": digest(plan),
                  "developmentHashes": dev_hashes, "commitments": commitments, "request": request,
                  "scope": "local bounded controller; normal host execution; independent-gate isolation requires a separate trusted curator"})
    write_new(directory / "study.json", study)
    return {"study": args.study, "phase": "development", "requestId": request["id"], "automaticActivation": False}


def develop(args):
    directory, study = load_study(args.study, development=True)
    records = evaluations(directory)
    if not isinstance(args.operator, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", args.operator):
        raise ValueError("Operator IDs must use bounded lowercase hyphen-case.")
    # Each started attempt consumes budget, including a crash or CLI failure.
    attempts = list(directory.glob("attempt-*.json"))
    if len(attempts) >= study["plan"]["maxCandidates"]:
        raise ValueError("The frozen candidate budget is exhausted.")
    if not 0 <= args.generation < study["plan"]["maxGenerations"]:
        raise ValueError("Generation exceeds the frozen study limit.")
    if args.generation > 0:
        if not args.parent:
            raise ValueError("Later generations require an evaluated parent candidate ID.")
        parent = next((r for r in records if r["id"] == args.parent), None)
        eligible_parent = parent and (paired_valid(parent) if study["plan"]["strategy"] == "pareto" else parent["evaluation"]["passed"])
        if not eligible_parent or parent["generation"] != args.generation - 1:
            raise ValueError("Parent must be a qualified or Pareto-valid previous-generation candidate.")
        if study["plan"]["strategy"] == "pareto" and parent["id"] not in {record["id"] for record in pareto_archive(records)[0]}:
            raise ValueError("The Pareto parent must belong to the current nondominated archive.")
    elif args.parent:
        raise ValueError("Generation zero uses the frozen baseline, not a candidate parent.")
    value = read(local(args.candidate))
    if value.get("requestId") != study["request"]["id"]:
        raise ValueError("Candidate belongs to a different development request.")
    patch = candidate_patch(value)
    if args.parent:
        inherited = {change["path"] for change in parent["candidate"]["changes"]}
        if not inherited.issubset({change["path"] for change in value["changes"]}):
            raise ValueError("A complete child patch must include every changed parent path.")
    if any(r["patchDigest"] == patch for r in records):
        raise ValueError("An identical candidate patch was already evaluated.")
    index = len(attempts) + 1
    attempt = {"id": f"candidate-{index:03}", "generation": args.generation, "operator": args.operator,
               "parent": args.parent or "baseline", "patchDigest": patch, "candidate": value}
    write_new(directory / f"attempt-{index:03}.json", seal(attempt))
    snapshot = directory / "inputs" / f"candidate-{index:03}.json"
    write_new(snapshot, value)
    imported = call_cli(study["config"], ["propose", "--request", study["request"]["id"], "--input", str(snapshot)], remaining(study))
    if candidate_patch(imported) != patch:
        raise ValueError("Imported proposal differs from the exact candidate snapshot.")
    result = call_cli(study["config"], ["evaluate", "--proposal", imported["id"]], remaining(study))
    record = seal({**attempt, "proposal": imported, "evaluation": result})
    write_new(directory / f"candidate-{index:03}.json", record)
    return {"candidate": attempt["id"], "qualified": result["passed"], "patchDigest": patch, "automaticActivation": False}


def metrics(record):
    verification = record["evaluation"].get("candidate", {}).get("verification", {})
    values = verification.get("cases", [])
    if not values or any(type(v.get("score")) not in (int, float) or not math.isfinite(v["score"]) for v in values):
        raise ValueError("Pareto search requires a finite score on every comparable case.")
    return {v["id"]: v["score"] for v in values}


def pareto_archive(records):
    eligible = [record for record in records if paired_valid(record)]
    baseline = None
    if eligible:
        baseline = {"id": "baseline", "evaluation": {"candidate": {"verification": eligible[0]["evaluation"]["baseline"]["verification"]}}}
    options = ([baseline] if baseline else []) + eligible
    vectors = {record["id"]: metrics(record) for record in options}
    cases = set(next(iter(vectors.values()))) if vectors else set()
    if any(set(vector) != cases for vector in vectors.values()):
        raise ValueError("Pareto candidates must use exactly matching case identities.")
    frontier = [record for record in options if not any(
        all(vectors[other["id"]][key] >= vectors[record["id"]][key] for key in cases)
        and any(vectors[other["id"]][key] > vectors[record["id"]][key] for key in cases)
        for other in options if other["id"] != record["id"])]
    return frontier, baseline


def freeze(args):
    directory, study = load_study(args.study, development=True)
    records = evaluations(directory)
    qualified = [r for r in records if r["evaluation"]["passed"]]
    baseline = None
    for record in records:
        verification = record["evaluation"].get("baseline", {}).get("verification")
        if verification and verification.get("passed"):
            baseline = {"id": "baseline", "evaluation": {"candidate": {"verification": verification}}}
            break
    if study["plan"]["strategy"] == "pareto":
        frontier, baseline = pareto_archive(records)
    else:
        frontier = qualified
    # Frozen tie-breaker: scalar candidate score, then patch digest. No gate data.
    ordered = sorted([r for r in frontier if r["id"] != "baseline" and r["evaluation"]["passed"]], key=lambda r: (-r["evaluation"]["candidate"]["verification"]["score"], r["patchDigest"]))
    winner = ordered[0] if ordered else None
    result = seal({"version": 1, "studyDigest": study["digest"], "winner": winner,
                   "archive": [r["id"] for r in frontier], "retainedBaseline": winner is None,
                   "baselineControl": baseline, "baselineRetainedAsControl": True,
                   "selectionRule": "qualified development candidates; Pareto case frontier when selected; highest scalar score then patch digest",
                   "candidateReceipts": {r["id"]: r["digest"] for r in records}})
    write_new(directory / "selection.json", result)
    return {"phase": "selected" if winner else "baseline-retained", "winner": winner["id"] if winner else None,
            "patchDigest": winner["patchDigest"] if winner else None, "automaticActivation": False}


def gate(args):
    directory, study = load_study(args.study)
    selection = sealed(directory / "selection.json")
    winner = selection["winner"]
    if not winner:
        raise ValueError("No qualified development finalist; retain baseline without opening a gate.")
    stage = args.command
    if stage not in study["commitments"]:
        raise ValueError("This independent gate was not preregistered.")
    if stage == "holdout" and not sealed(directory / "validation-result.json").get("passed"):
        raise ValueError("Holdout requires passed independent validation.")
    # Create before reading private gate paths. A failed or interrupted release is
    # terminal for this study; a new claim requires a new study and fresh gate.
    write_new(directory / f"{stage}-released.json", seal({"studyDigest": study["digest"], "patchDigest": winner["patchDigest"], "releasedEpoch": time.time()}))
    try:
        contract = read(local(args.gate))
        hashes = check_contract(contract)
        if digest({"contract": contract, "files": hashes}) != study["commitments"][stage]:
            raise ValueError("Gate inputs do not match the preregistered opaque commitment.")
        if set(contract["fixturePaths"]) & set(study["plan"]["development"]["fixturePaths"]):
            raise ValueError("Independent gate fixtures must differ from development fixtures.")
        fixture_hashes = {hashes[path] for path in contract["fixturePaths"]}
        development_hashes = {study["developmentHashes"][path] for path in study["plan"]["development"]["fixturePaths"]}
        if fixture_hashes & development_hashes:
            raise ValueError("Independent gate fixture bytes duplicate development inputs.")
        if stage == "holdout":
            validation = sealed(directory / "validation-result.json")["request"]
            validation_hashes = {item["sha256"] for item in validation["frozenVerifier"] if item["path"] in validation["fixturePaths"]}
            if set(contract["fixturePaths"]) & set(validation["fixturePaths"]) or fixture_hashes & validation_hashes:
                raise ValueError("Holdout fixture paths and bytes must differ from validation inputs.")
        request_input = {key: study["plan"][key] for key in ("agentId", "goal", "allowedPaths", "minimumImprovement", "timeoutMs")}
        request_input.update(contract)
        request_input["id"] = args.study + "-" + stage
        request_path = directory / f"{stage}-request-input.json"
        write_new(request_path, request_input)
        request = call_cli(study["config"], ["request", "--input", str(request_path)], remaining(study))
        if {item["path"]:item["sha256"] for item in request["frozenVerifier"]} != hashes:
            raise ValueError("Independent gate inputs changed during request admission.")
        if request["source"] != study["request"]["source"]:
            raise ValueError("Baseline source changed during independent request admission.")
        candidate = {**winner["candidate"], "requestId": request["id"], "evidenceIds": [ref["id"] for ref in request["evidence"]]}
        if candidate_patch(candidate) != winner["patchDigest"]:
            raise ValueError("Frozen finalist patch changed before independent evaluation.")
        candidate_path = directory / f"{stage}-candidate.json"
        write_new(candidate_path, candidate)
        proposal = call_cli(study["config"], ["propose", "--request", request["id"], "--input", str(candidate_path)], remaining(study))
        if candidate_patch(proposal) != winner["patchDigest"]:
            raise ValueError("Imported independent proposal differs from the frozen finalist.")
        result = call_cli(study["config"], ["evaluate", "--proposal", proposal["id"]], remaining(study))
        receipt = seal({"version": 1, "stage": stage, "studyDigest": study["digest"], "patchDigest": winner["patchDigest"],
                        "passed": result["passed"], "request": request, "proposal": proposal, "evaluation": result})
        write_new(directory / f"{stage}-result.json", receipt)
    except Exception as error:
        write_new(directory / f"{stage}-failure.json", seal({"errorCategory": type(error).__name__, "message": str(error), "baselineRetained": True}))
        raise
    final = stage == "holdout" or "holdout" not in study["commitments"]
    return {"phase": stage + ("-passed" if result["passed"] else "-failed"), "passed": result["passed"],
            "qualifiedForRequestedActivationReview": final and result["passed"], "proposalId": proposal["id"],
            "automaticActivation": False, "next": "Review evidence; explicit stopped-service promote/build/smoke remains a separate operator action." if final and result["passed"] else "Retain baseline or continue only to the preregistered unopened holdout."}


def dispatch(args):
    if args.command == "commit-gate":
        contract = read(local(args.input))
        hashes = check_contract(contract)
        commitment = {"version": 1, "sha256": digest({"contract": contract, "files": hashes})}
        write_new(local(args.output, existing=False), commitment)
        result = commitment
    elif args.command == "open":
        result = open_study(args)
    elif args.command == "develop":
        result = develop(args)
    elif args.command == "freeze":
        result = freeze(args)
    elif args.command in ("validation", "holdout"):
        result = gate(args)
    else:
        directory, study = load_study(args.study, development=args.command in ("reflect", "operators"))
        if args.command == "reflect":
            result = call_cli(study["config"], ["reflect", "--request", study["request"]["id"], *(["--generate"] if args.generate else [])], remaining(study))
        elif args.command == "operators":
            # Development-only attribution aid, never an automatic causal claim
            # or an authority to launch another generation or change the budget.
            records = evaluations(directory)
            by_id = {r["id"]: r for r in records}
            credits = []
            for record in records:
                result = record["evaluation"]
                if not result.get("passed"):
                    continue
                parent = by_id.get(record["parent"])
                baseline = parent["evaluation"]["candidate"]["verification"]["score"] if parent else result["baseline"]["verification"]["score"]
                credits.append({"candidate": record["id"], "operator": record["operator"], "parent": record["parent"], "patchDigest": record["patchDigest"], "developmentDelta": result["candidate"]["verification"]["score"] - baseline})
            result = {"credits": credits, "scope": "development-only hypotheses; distinct children and parent/family coverage are needed before attributing operator quality", "nextStudy": "Freeze a new budget/operator contract; never use validation or holdout feedback for breeding."}
        else:
            result = {"study": study["id"], "candidateAttempts": len(list(directory.glob("attempt-*.json"))),
                      "candidatesCompleted": len(evaluations(directory)), "selectionFrozen": (directory / "selection.json").exists(),
                      "gates": {stage: {"released": (directory / f"{stage}-released.json").exists(), "completed": (directory / f"{stage}-result.json").exists()} for stage in ("validation", "holdout")}, "automaticActivation": False}
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["commit-gate", "open", "reflect", "develop", "freeze", "validation", "holdout", "status", "operators"])
    parser.add_argument("--study", default="example-study")
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--plan", default="evolution-plans/plan.json")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--gate")
    parser.add_argument("--candidate")
    parser.add_argument("--generation", type=int, default=0)
    parser.add_argument("--operator", default="focused-reflection")
    parser.add_argument("--parent")
    parser.add_argument("--generate", action="store_true")
    args = parser.parse_args()
    guard = nullcontext() if args.command in ("commit-gate", "status") else mutation_lock(args.study, args.command)
    with guard:
        dispatch(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        sys.exit(f"Evolution study failed: {error}")
