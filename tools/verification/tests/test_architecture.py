"""Standard-library tests for the architecture boundary checker."""

from __future__ import annotations

import unittest

from tools.verification.check_architecture import (
    check_boundaries,
    find_import_cycles,
)


class ArchitectureTests(unittest.TestCase):
    def test_clean_graph_has_no_violations(self) -> None:
        graph = {
            "app.main": {"app.chat_api", "app.config"},
            "app.chat_api": {"app.chat.booking_policy", "app.chat.schemas"},
            "app.chat.booking_policy": {"app.config", "app.scheduling"},
            "app.chat.schemas": {"app.call_tracking"},
            "app.scheduling": {"app.config"},
            "app.config": set(),
        }
        self.assertEqual(check_boundaries(graph), [])

    def test_forbidden_dependency_is_reported(self) -> None:
        graph = {
            "app.chat.booking_policy": {"fastapi", "app.config"},
            "app.chat.schemas": {"app.db"},
        }
        violations = check_boundaries(graph)
        self.assertEqual(len(violations), 2)
        self.assertIn("app.chat.booking_policy imports forbidden dependency 'fastapi'", violations)
        self.assertIn("app.chat.schemas imports forbidden dependency 'app.db'", violations)

    def test_submodule_of_forbidden_dependency_is_reported(self) -> None:
        graph = {"app.chat.schemas": {"app.db.models"}}
        violations = check_boundaries(graph)
        self.assertIn("app.chat.schemas imports forbidden dependency 'app.db.models'", violations)

    def test_direct_cycle_is_detected(self) -> None:
        graph = {"app.a": {"app.b"}, "app.b": {"app.a"}}
        cycles = find_import_cycles(graph)
        self.assertEqual(len(cycles), 1)
        self.assertEqual(set(cycles[0]), {"app.a", "app.b"})

    def test_self_import_is_not_a_cycle(self) -> None:
        graph = {"app.a": {"app.a"}}
        self.assertEqual(find_import_cycles(graph), [])

    def test_three_node_cycle_is_detected_once(self) -> None:
        graph = {"app.a": {"app.b"}, "app.b": {"app.c"}, "app.c": {"app.a"}}
        cycles = find_import_cycles(graph)
        self.assertEqual(len(cycles), 1)
        self.assertEqual(set(cycles[0]), {"app.a", "app.b", "app.c"})


if __name__ == "__main__":
    unittest.main()