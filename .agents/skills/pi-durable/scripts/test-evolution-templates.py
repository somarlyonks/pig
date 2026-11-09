#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Exercise portable evolution generation and state-machine boundary behavior.

Run from a caller workspace. Temporary copies are created below the explicit
--output directory, never outside the caller's authorized workspace.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Templates(unittest.TestCase):
    output: Path
    scaffolder = load("evolution_scaffold", Path(__file__).with_name("scaffold-evolution.py"))

    def make(self, strategy="trace-distillation"):
        path = Path(tempfile.mkdtemp(prefix="evolution-", dir=self.output)) / "portable project"
        self.scaffolder.scaffold_evolution(path, strategy)
        return path, load("study_" + path.parent.name.replace("-", "_"), path / "evolution-plans/study.py")

    def test_all_strategies_have_exact_initial_hashes_and_local_runner(self):
        for strategy in ("trace-distillation", "population", "pareto"):
            path, runner = self.make(strategy)
            manifest = json.loads((path / "scaffold-manifest.json").read_text())
            self.assertEqual(manifest["evolutionStrategy"], strategy)
            for name, expected in manifest["files"].items():
                self.assertEqual(hashlib.sha256((path / name).read_bytes()).hexdigest(), expected)
            self.assertEqual(runner.ROOT, path)
            self.assertEqual(json.loads((path / "evolution-plans/plan.json").read_text())["strategy"], strategy)
            with self.assertRaises(ValueError):
                self.scaffolder.scaffold_evolution(path, strategy)

    def test_path_escape_and_symlink_inputs_rejected(self):
        path, runner = self.make()
        for value in ("../escape", "/absolute", "C:/escape", "one\\two", "one/../two"):
            with self.assertRaises(ValueError):
                runner.local(value, existing=False)
        self.assertEqual(runner.local("evolution-plans/plan.json"), path / "evolution-plans/plan.json")

    def test_gate_commitment_detects_input_changes(self):
        path, runner = self.make()
        contract = json.loads((path / "evolution-plans/validation-gate.json").read_text())
        old = runner.digest({"contract": contract, "files": runner.check_contract(contract)})
        fixture = path / contract["fixturePaths"][0]
        fixture.write_text(fixture.read_text() + "\n")
        new = runner.digest({"contract": contract, "files": runner.check_contract(contract)})
        self.assertNotEqual(old, new)

    def test_pareto_vectors_require_comparable_finite_case_scores(self):
        _, runner = self.make("pareto")
        self.assertEqual(runner.metrics({"evaluation":{"candidate":{"verification":{"cases":[{"id":"one","score":0.4}]}}}}), {"one":0.4})
        for value in ({"id":"one"}, {"id":"one","score":float("nan")}):
            with self.assertRaises(ValueError):
                runner.metrics({"evaluation":{"candidate":{"verification":{"cases":[value]}}}})

    def test_seals_and_candidate_patch_identity(self):
        path, runner = self.make()
        file = path / "receipt.json"
        runner.write_new(file, runner.seal({"value":1}))
        self.assertEqual(runner.sealed(file)["value"], 1)
        file.write_text('{"value":2,"digest":"tampered"}')
        with self.assertRaises(ValueError):
            runner.sealed(file)
        a = {"changes":[{"path":"scripts/a.mjs","beforeHash":"abc","content":"one"}]}
        b = {"requestId":"other", **a}
        self.assertEqual(runner.candidate_patch(a), runner.candidate_patch(b))

    def test_pareto_keeps_complementary_tie_without_qualifying_activation(self):
        path, runner = self.make("pareto")
        baseline = {"passed":True,"score":0.5,"cases":[{"id":"a","passed":True,"score":1},{"id":"b","passed":True,"score":0}]}
        candidate = {"passed":True,"score":0.5,"cases":[{"id":"a","passed":True,"score":0},{"id":"b","passed":True,"score":1}]}
        record = {"id":"candidate-001","patchDigest":"tie","evaluation":{"passed":False,"baseline":{"verification":baseline},"candidate":{"verification":candidate}}}
        frontier, control = runner.pareto_archive([record])
        self.assertEqual({item["id"] for item in frontier}, {"baseline","candidate-001"})
        self.assertEqual(control["evaluation"]["candidate"]["verification"], baseline)
        directory = path / "evolution-plans/runs/test-tie"
        directory.mkdir(parents=True)
        runner.write_new(directory / "candidate-001.json",runner.seal(record))
        runner.load_study = lambda identity, development: (directory,{"digest":"frozen","plan":{"strategy":"pareto"}})
        result = runner.freeze(type("Args",(),{"study":"test-tie"})())
        self.assertIsNone(result["winner"])
        self.assertEqual(set(runner.sealed(directory / "selection.json")["archive"]), {"baseline","candidate-001"})

    def test_study_lock_rejects_contention_and_cleans_after_success_or_error(self):
        path, runner = self.make()
        lock = path / "evolution-plans/runs/.locks/test-lock.json"
        with runner.mutation_lock("test-lock", "develop"):
            self.assertTrue(lock.is_file())
            with self.assertRaisesRegex(ValueError, "Another command owns"):
                with runner.mutation_lock("test-lock", "freeze"):
                    self.fail("A concurrent freeze entered the locked study.")
        self.assertFalse(lock.exists())
        with self.assertRaisesRegex(RuntimeError, "simulated command failure"):
            with runner.mutation_lock("test-lock", "validation"):
                raise RuntimeError("simulated command failure")
        self.assertFalse(lock.exists())
        with runner.mutation_lock("test-lock", "freeze"):
            self.assertTrue(lock.exists())
        self.assertFalse(lock.exists())

    def test_interrupted_lock_is_never_automatically_replaced(self):
        path, runner = self.make()
        lock = path / "evolution-plans/runs/.locks/interrupted.json"
        owner = {"version":1,"pid":99999999,"createdEpoch":0,"token":"interrupted-owner","command":"develop"}
        runner.write_new(lock, owner)
        with self.assertRaisesRegex(ValueError, "never expire automatically"):
            with runner.mutation_lock("interrupted", "freeze"):
                self.fail("An interrupted lock was automatically removed.")
        self.assertEqual(runner.read(lock), owner)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    Templates.output = args.output.resolve()
    Templates.output.mkdir(parents=True, exist_ok=True)
    unittest.main(argv=[__file__])
