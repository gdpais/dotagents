import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("inventory", Path(__file__).resolve().parents[1] / "scripts/evidence_inventory.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InventoryTests(unittest.TestCase):
    def test_incremental_and_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / "a", Path(directory) / "b"
            a.write_bytes(b"one")
            b.write_bytes(b"two")
            first = module.inventory([a, b], {"timezone": "UTC"})
            second = module.inventory([a, b], {"timezone": "UTC"}, first)
            self.assertEqual([x["preparation_action"] for x in second["sources"]], ["candidate_reuse"] * 2)
            revised = module.inventory([a, b], {"timezone": "Europe/Lisbon"}, second)
            self.assertEqual([x["preparation_action"] for x in revised["sources"]], ["reprocess"] * 2)
            a.write_bytes(b"changed")
            third = module.inventory([a], {"timezone": "UTC"}, first)
            self.assertEqual([x["change"] for x in third["sources"]], ["changed", "missing"])
            self.assertEqual(first["sources"][0]["source_id"], third["sources"][0]["source_id"])
            self.assertTrue(b.exists())

    def test_duplicates_empty_and_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / "a", Path(directory) / "b"
            a.touch()
            b.touch()
            result = module.inventory([a, b, a, directory, a.parent / "absent"])
            self.assertEqual(len(result["sources"]), 4)
            self.assertEqual(len(result["duplicate_content_groups"]), 1)
            self.assertEqual([s["status"] for s in result["sources"]], ["fingerprinted"] * 2 + ["unreadable"] * 2)

    def test_change_during_read_never_offers_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "a"
            path.write_bytes(b"evidence")
            with patch.object(module, "snapshot", side_effect=[(1,), (1,), (2,)]):
                result = module.inventory([path])
            self.assertEqual(result["sources"][0]["status"], "unstable")
            self.assertIsNone(result["sources"][0]["content_sha256"])
            self.assertEqual(result["sources"][0]["preparation_action"], "retry_inspection")

    def test_reject_inconsistent_previous_config(self):
        prior = module.inventory([], {"timezone": "UTC"})
        prior["configuration"]["timezone"] = "changed"
        with self.assertRaises(ValueError):
            module.inventory([], previous=prior)


if __name__ == "__main__":
    unittest.main()
