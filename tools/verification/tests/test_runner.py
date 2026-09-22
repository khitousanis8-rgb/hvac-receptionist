"""Standard-library tests for the verification runner; no application imports."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess
from unittest.mock import Mock, patch

from tools.verification.runner import (
    build_test_environment,
    redact_output,
    run_gate,
    stop_process_tree,
    write_reports,
)


class RunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="verification-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def run_python(self, code: str, timeout: int = 10) -> dict[str, object]:
        return run_gate(
            "example", [sys.executable, "-c", code], self.directory,
            build_test_environment(self.directory), self.directory, timeout,
        )

    def test_success_captures_output(self) -> None:
        result = self.run_python("print('synthetic output')")
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("synthetic output", (self.directory / "logs/example.log").read_text())

    def test_nonzero_is_failure_even_with_success_message(self) -> None:
        result = self.run_python("import sys; print('PASSED'); sys.exit(3)")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["exit_code"], 3)

    def test_launch_failure_is_blocked(self) -> None:
        result = run_gate(
            "missing", [str(self.directory / "missing-executable")],
            self.directory, {}, self.directory,
        )
        self.assertEqual(result["status"], "blocked")
        self.assertIsNone(result["exit_code"])
        self.assertTrue((self.directory / "logs/missing.log").is_file())

    def test_timeout_is_not_pass(self) -> None:
        result = self.run_python("import time; print('started', flush=True); time.sleep(30)", 1)
        self.assertEqual(result["status"], "timeout")
        self.assertIn("started", (self.directory / "logs/example.log").read_text())

    def test_cleanup_failure_preserves_timeout_evidence(self) -> None:
        process = Mock()
        process.returncode = None
        process.poll.return_value = None
        process.communicate.side_effect = [
            subprocess.TimeoutExpired("synthetic", 1, output=b"partial evidence"),
            subprocess.TimeoutExpired("synthetic", 15),
        ]
        with patch("tools.verification.runner.subprocess.Popen", return_value=process), patch(
            "tools.verification.runner.stop_process_tree", return_value="termination unconfirmed"
        ):
            result = run_gate("cleanup", ["synthetic"], self.directory, {}, self.directory, 1)
        self.assertEqual(result["status"], "timeout")
        self.assertIn("cleanup incomplete", result["reason"])
        self.assertIn("output drain incomplete", result["reason"])
        self.assertIn("partial evidence", (self.directory / "logs/cleanup.log").read_text())
        self.assertIsNotNone(result["finished_at"])

    def test_successful_drain_does_not_duplicate_partial_output(self) -> None:
        process = Mock()
        process.returncode = -1
        process.poll.return_value = -1
        process.communicate.side_effect = [
            subprocess.TimeoutExpired("synthetic", 1, output=b"partial"),
            ("partial and complete", None),
        ]
        with patch("tools.verification.runner.subprocess.Popen", return_value=process), patch(
            "tools.verification.runner.stop_process_tree", return_value=None
        ):
            result = run_gate("drain", ["synthetic"], self.directory, {}, self.directory, 1)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual((self.directory / "logs/drain.log").read_text().count("partial"), 1)

    def test_environment_does_not_forward_credentials(self) -> None:
        with patch.dict(os.environ, {
            "LLM_API_KEY": "private-provider-value",
            "DATABASE_URL": "postgresql://private-server/production",
            "ADMIN_API_KEY": "private-admin-value",
            "PYTHONSTARTUP": "untrusted.py",
        }):
            env = build_test_environment(self.directory)
        for key in ("LLM_API_KEY", "ADMIN_API_KEY", "PYTHONSTARTUP"):
            self.assertNotIn(key, env)
        self.assertEqual(env["APP_ENV"], "test")
        self.assertEqual(env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"], "1")
        self.assertIn(self.directory.as_posix(), env["DATABASE_URL"])
        self.assertEqual(env["LLM_BASE_URL"], "http://127.0.0.1:9/v1")

    def test_log_redacts_assignments_and_url_credentials(self) -> None:
        text = (
            'Authorization: Bearer test-auth-value\n'
            '{"call_secret": "test-call-value", "password": "test-password-value"}\n'
            'postgresql://user:test-db-value@localhost/test'
        )
        redacted = redact_output(text)
        for value in ("test-auth-value", "test-call-value", "test-password-value", "test-db-value"):
            self.assertNotIn(value, redacted)
        self.assertIn("localhost/test", redacted)

    def test_redacts_quoted_authorization_and_admin_headers(self) -> None:
        samples = [
            '{"Authorization": "Bearer synthetic-bearer-value"}',
            "{'Authorization': 'Basic synthetic-basic-value'}",
            '{"X-Admin-Key": "synthetic-admin-value"}',
            "{'x-admin-key': 'synthetic-lowercase-value'}",
            "X-Admin-Key: synthetic-plain-value",
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                redacted = redact_output(sample)
                self.assertNotIn("synthetic-", redacted)
                self.assertIn("[REDACTED]", redacted)

    def test_failed_taskkill_is_reported_even_when_parent_exited(self) -> None:
        process = Mock()
        process.pid = 12345
        process.wait.return_value = 0
        failed_kill = subprocess.CompletedProcess(["taskkill"], returncode=1)
        with patch("tools.verification.runner.os.name", "nt"), patch(
            "tools.verification.runner.subprocess.run", return_value=failed_kill
        ):
            failure = stop_process_tree(process)
        self.assertIsNotNone(failure)
        self.assertIn("taskkill", str(failure))
        self.assertIn("1", str(failure))

    def test_successful_taskkill_and_parent_exit_have_no_cleanup_error(self) -> None:
        process = Mock()
        process.pid = 12345
        process.wait.return_value = 0
        successful_kill = subprocess.CompletedProcess(["taskkill"], returncode=0)
        with patch("tools.verification.runner.os.name", "nt"), patch(
            "tools.verification.runner.subprocess.run", return_value=successful_kill
        ):
            failure = stop_process_tree(process)
        self.assertIsNone(failure)

    def test_child_header_credentials_are_redacted_in_saved_log(self) -> None:
        headers = {
            "Authorization": "Bearer synthetic-child-bearer",
            "X-Admin-Key": "synthetic-child-admin",
        }
        result = self.run_python(
            f"print({json.dumps(headers)!r}); print({str(headers)!r})"
        )
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["exit_code"], 0)
        log = (self.directory / "logs/example.log").read_text(encoding="utf-8")
        self.assertNotIn("synthetic-child-", log)
        self.assertEqual(log.count("[REDACTED]"), 4)
        structured = json.loads(log.splitlines()[0])
        self.assertEqual(structured["Authorization"], "[REDACTED]")
        self.assertEqual(structured["X-Admin-Key"], "[REDACTED]")

    @unittest.skipUnless(os.name == "nt", "Windows process-tree integration")
    def test_gate_records_failed_taskkill_after_timeout(self) -> None:
        process = Mock()
        process.pid = 12345
        process.returncode = 0
        process.poll.return_value = 0
        process.wait.return_value = 0
        process.communicate.side_effect = [
            subprocess.TimeoutExpired("synthetic", 1, output=b"partial evidence"),
            ("partial evidence and final output", None),
        ]
        failed_kill = subprocess.CompletedProcess(["taskkill"], returncode=1)
        with patch(
            "tools.verification.runner.subprocess.Popen", return_value=process
        ), patch(
            "tools.verification.runner.subprocess.run", return_value=failed_kill
        ) as taskkill:
            result = run_gate(
                "failed-tree", ["synthetic"], self.directory, {}, self.directory, 1
            )
        taskkill.assert_called_once()
        self.assertEqual(taskkill.call_args.args[0], [
            "taskkill", "/PID", "12345", "/T", "/F",
        ])
        self.assertEqual(result["status"], "timeout")
        self.assertIn("cleanup incomplete", result["reason"])
        self.assertIn("taskkill exited with code 1", result["reason"])
        log = (self.directory / "logs/failed-tree.log").read_text(encoding="utf-8")
        self.assertIn("partial evidence and final output", log)
        self.assertIn("descendant termination unconfirmed", log)

    def test_reports_are_readable_and_review_is_not_invented(self) -> None:
        manifest = {
            "run_id": "unit-run", "overall_status": "blocked", "gates": [],
            "agent_reviews": {"independent": "pending"},
        }
        write_reports(manifest, self.directory)
        saved = json.loads((self.directory / "manifest.json").read_text())
        self.assertEqual(saved["agent_reviews"]["independent"], "pending")
        self.assertIn("not full campaign acceptance", (self.directory / "report.md").read_text())
        self.assertFalse((self.directory / "manifest.json.tmp").exists())


if __name__ == "__main__":
    unittest.main()