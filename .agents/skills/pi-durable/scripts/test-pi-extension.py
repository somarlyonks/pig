#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check independent console generation and its first-agent resource payload."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


class ConsoleGenerationTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("console_scaffold", Path(__file__).with_name("scaffold-pi-extension.py"))
        assert spec and spec.loader
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_first_agent_console_has_empty_registry_and_independent_factory(self):
        destination = self.root / "console with spaces"
        receipt = self.module.scaffold(destination)
        self.assertIsNone(receipt["serviceId"])
        self.assertEqual(json.loads((destination / "durable-agents.json").read_text()), {"version": 1, "services": []})
        manifest = json.loads((destination / "scaffold-manifest.json").read_text())
        self.assertTrue(manifest["agentCreationIncluded"])
        for name in ("src/agent-creation.ts", "src/creation-ui.ts", "service-template/package-lock.json", "service-template/src/tools/workspace.ts"):
            self.assertIn(name, manifest["files"])
        self.assertFalse(any("node_modules/" in name or "/tests/" in name for name in manifest["files"]))
        for name, expected in manifest["files"].items():
            self.assertEqual(hashlib.sha256((destination / name).read_bytes()).hexdigest(), expected, name)
        relocated = self.root / "relocated console"
        destination.rename(relocated)
        self.assertTrue((relocated / "service-template/src/cli.ts").is_file())

    def test_existing_service_remains_a_relative_connection(self):
        service = self.root / "service.json"
        service.write_text(json.dumps({"version": 1, "host": "127.0.0.1", "port": 4798, "dataDir": "state"}))
        destination = self.root / "console"
        self.module.scaffold(destination, service)
        entry = json.loads((destination / "durable-agents.json").read_text())["services"][0]
        self.assertEqual((destination / entry["configPath"]).resolve(), service)
        self.assertNotIn("token", entry)

    def test_nonempty_destination_and_invalid_connection_are_preserved(self):
        destination = self.root / "existing"
        destination.mkdir()
        sentinel = destination / "keep.txt"
        sentinel.write_text("Preserve this file.")
        with self.assertRaises(ValueError):
            self.module.scaffold(destination)
        self.assertEqual(sentinel.read_text(), "Preserve this file.")
        bad = self.root / "bad.json"
        bad.write_text(json.dumps({"version": 1, "host": "0.0.0.0", "port": 4798, "dataDir": "state"}))
        with self.assertRaises(ValueError):
            self.module.scaffold(self.root / "unused", bad)
        self.assertFalse((self.root / "unused").exists())


if __name__ == "__main__":
    unittest.main()
