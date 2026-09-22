"""Local verification entry point with isolated pytest execution and durable evidence.

Run with the backend virtual environment's Python. No application imports occur
in this module. Test/check commands are fixed here, never supplied by reviewers.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from typing import cast
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "referenced-chatgpt-conversation-this-is-an" / "backend"
SYSTEM_ENV = {
    "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT",
    "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS",
}


def redact_output(text: str) -> str:
    """Remove credential-bearing assignments and URL passwords from test output."""
    # Consume the whole header value, including quoted JSON/dict values.
    # Preserve quoting so redacted structured output remains readable.
    text = re.sub(
        r"""(?i)((?:authorization|x-admin-key)['"]?\s*[:=]\s*)"""
        r"""("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)""",
        lambda match: match[1] + (
            match[2][0] + "[REDACTED]" + match[2][0]
            if match[2][0] in "\"'" else "[REDACTED]"
        ),
        text,
    )
    text = re.sub(
        r"(?i)((?:api[_-]?key|api[_-]?secret|call_secret|password|access_token)"
        r"""['"]?\s*[:=]\s*['"]?)[^\s,'"}]+""",
        r"\1[REDACTED]",
        text,
    )
    return re.sub(r"(://[^/\s:@]+:)[^@\s/]+@", r"\1[REDACTED]@", text)


def build_test_environment(sandbox: Path) -> dict[str, str]:
    """Do not forward developer credentials, database URLs, or dotenv files."""
    env = {key: value for key, value in os.environ.items() if key.upper() in SYSTEM_ENV}
    env.update(
        APP_ENV="test",
        DATABASE_URL=f"sqlite:///{(sandbox / 'baseline.db').as_posix()}",
        ENABLE_LIVEKIT_WORKER="false",
        LLM_BASE_URL="http://127.0.0.1:9/v1",
        PYTHONPATH=str(BACKEND),
        PYTHONIOENCODING="utf-8",
        PYTHONUTF8="1",
        PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
        VITE_API_BASE="http://127.0.0.1:9",
        CI="true",
        NO_COLOR="1",
    )
    return env


def _as_text(value: object) -> str:
    """Coerce subprocess output to text regardless of stream configuration."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def stop_process_tree(process: subprocess.Popen[str]) -> str | None:
    """Terminate only the process tree owned by this gate.

    Returns a failure description when termination could not be confirmed;
    it never raises and never converts an unconfirmed kill into a pass.
    """
    failure: str | None = None
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                check=False,
            )
            if result.returncode != 0:
                failure = (
                    f"taskkill exited with code {result.returncode}; "
                    "descendant termination unconfirmed"
                )
        except (subprocess.TimeoutExpired, OSError) as exc:
            failure = f"taskkill did not finish: {exc}"
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError as exc:
            failure = f"kill failed: {exc}"
    try:
        process.wait(timeout=15)
    except (subprocess.TimeoutExpired, OSError) as exc:
        failure = (failure + "; " if failure else "") + f"termination unconfirmed: {exc}"
    return failure


def run_gate(
    gate_id: str,
    argv: list[str],
    cwd: Path,
    env: dict[str, str],
    destination: Path,
    timeout_seconds: int = 600,
) -> dict[str, object]:
    """Capture a check; a launch failure or timeout is never a passing result."""
    started_at = datetime.now(UTC).isoformat()
    start = time.monotonic()
    status = "blocked"
    code: int | None = None
    reason: str | None = None
    output = ""
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        cleanup_error: str | None = None
        try:
            try:
                output, _ = process.communicate(timeout=timeout_seconds)
                code = process.returncode
                status = "passed" if code == 0 else "failed"
            except subprocess.TimeoutExpired as exc:
                status = "timeout"
                reason = f"Exceeded {timeout_seconds} seconds"
                # Retain whatever the child produced before the timeout.
                output = _as_text(exc.stdout)
                cleanup_error = stop_process_tree(process)
                try:
                    drained, _ = process.communicate(timeout=15)
                    output = _as_text(drained)
                    code = process.returncode
                except (subprocess.TimeoutExpired, OSError) as drain_error:
                    reason += f"; output drain incomplete: {drain_error}"
            except KeyboardInterrupt:
                status = "cancelled"
                reason = "Interrupted by user"
                cleanup_error = stop_process_tree(process)
                try:
                    drained, _ = process.communicate(timeout=15)
                    output = _as_text(drained)
                    code = process.returncode
                except (subprocess.TimeoutExpired, OSError) as drain_error:
                    reason += f"; output drain incomplete: {drain_error}"
        except OSError as exc:
            reason = f"{type(exc).__name__}: {exc}"
        finally:
            if process is not None and process.poll() is None:
                cleanup_error = stop_process_tree(process) or cleanup_error

        if cleanup_error:
            reason = (reason + "; " if reason else "") + f"cleanup incomplete: {cleanup_error}"
            if status == "passed":
                status = "blocked"
    except OSError as exc:
        reason = f"{type(exc).__name__}: {exc}"

    log_path = destination / "logs" / f"{gate_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(redact_output(output + (f"\n{reason}\n" if reason else "")), encoding="utf-8")
    return {
        "gate_id": gate_id,
        "status": status,
        "exit_code": code,
        "started_at": started_at,
        "finished_at": datetime.now(UTC).isoformat(),
        "duration_ms": round((time.monotonic() - start) * 1000),
        "log_path": f"logs/{gate_id}.log",
        "reason": reason,
    }


def git_metadata() -> dict[str, object]:
    """Record a read-only snapshot without changing the index or worktree."""
    result: dict[str, object] = {}
    for name, args in (
        ("git_head", ["rev-parse", "HEAD"]),
        ("dirty_paths", ["status", "--short"]),
    ):
        try:
            completed = subprocess.run(
                ["git", *args], cwd=ROOT, capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=15, check=False,
            )
            result[name] = completed.stdout.strip() if completed.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            result[name] = None
    return result


def write_reports(manifest: dict[str, object], destination: Path) -> None:
    """Persist after every gate so interrupted campaigns retain their evidence."""
    json_path = destination / "manifest.json"
    temporary = destination / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(json_path)
    lines = [
        "# Verification run", "", f"Run: `{manifest['run_id']}`",
        f"Overall status: **{manifest['overall_status']}**", "",
        "## Deterministic checks", "",
    ]
    for gate in cast(list[dict[str, object]], manifest["gates"]):
        lines.append(
            f"- **{gate['gate_id']}**: {gate['status']} "
            f"(exit {gate['exit_code']}); [log]({gate['log_path']})"
        )
    findings_path = ROOT / "tools" / "verification" / "findings.json"
    try:
        findings = json.loads(findings_path.read_text(encoding="utf-8"))["findings"]
    except (OSError, ValueError, KeyError):
        findings = None
    if findings is None:
        lines.extend([
            "", "## Findings", "",
            "- findings.json is missing or unreadable; finding status is not reported.",
        ])
    else:
        lines.extend([
            "", "## Findings", "",
            "| ID | Severity | Status | Title |",
            "| --- | --- | --- | --- |",
        ])
        for finding in findings:
            lines.append(
                f"| {finding['id']} | {finding['severity']} | {finding['status']} "
                f"| {finding['title']} |"
            )
    lines.extend([
        "", "## Scope limits", "",
        "- IDE specialist and independent reviews have not been run by this command.",
        "- Browser E2E, real PostgreSQL, and physical-device acceptance are not yet implemented here.",
        "- Passing selected checks is not full campaign acceptance.",
        "- No deployment, commit, or production-provider request is performed by the runner.",
        "",
    ])
    (destination / "report.md").write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=["fast", "full"], default="fast")
    parser.add_argument(
        "--gate", choices=["backend", "frontend", "build", "ruff", "mypy", "arch"]
    )
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args(argv)
    selected = [args.gate] if args.gate else (
        ["frontend", "build", "ruff", "mypy", "arch"] if args.profile == "fast"
        else ["backend", "frontend", "build", "ruff", "mypy", "arch"]
    )
    if args.list:
        print("\n".join(selected))
        return 0
    python = args.python.resolve()
    if not python.is_file():
        parser.error("--python must point to an existing interpreter")

    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    destination = ROOT / "artifacts" / "verification" / run_id
    destination.mkdir(parents=True, exist_ok=False)
    manifest: dict[str, object] = {
        "schema_version": 1, "run_id": run_id,
        "started_at": datetime.now(UTC).isoformat(), "finished_at": None,
        **git_metadata(),
        "runtime_versions": {"runner_python": sys.version},
        "profile": args.profile, "gates": [], "findings": [],
        "agent_reviews": {role: "pending" for role in (
            "backend", "frontend", "architecture", "quality", "independent",
        )},
        "overall_status": "blocked",
    }
    write_reports(manifest, destination)
    print(f"Evidence: {destination}", flush=True)
    with tempfile.TemporaryDirectory(prefix="hvac-verification-") as temporary:
        sandbox = Path(temporary)
        env = build_test_environment(sandbox)
        # Calling npm's JavaScript entry directly avoids Windows .cmd shell quoting.
        # Resolve it from the node installation rather than using shell=True.
        import shutil
        node = shutil.which("node")
        npm = shutil.which("npm")
        npm_cli = Path(npm).resolve().parent / "node_modules/npm/bin/npm-cli.js" if npm else None
        if os.name == "nt" and node and npm_cli and npm_cli.is_file():
            npm_command = [node, str(npm_cli)]
        else:
            npm_command = [npm or "npm"]
        commands = {
            "backend": ([str(python), "-m", "pytest", "-p", "pytest_asyncio.plugin",
                         str(BACKEND / "tests"), "-c", str(BACKEND / "pyproject.toml"),
                         "-q", "--tb=short", "-o", f"cache_dir={sandbox / 'pytest-cache'}"], sandbox),
            "frontend": ([*npm_command, "--prefix", str(ROOT / "frontend"), "test"], sandbox),
            "build": ([*npm_command, "--prefix", str(ROOT / "frontend"), "run", "build"], sandbox),
            "ruff": ([str(python), "-m", "ruff", "check", "app", "tests"], BACKEND),
            "mypy": ([str(python), "-m", "mypy", "app"], BACKEND),
            "arch": ([str(python), str(ROOT / "tools" / "verification" / "check_architecture.py")], ROOT),
        }
        for gate_id in selected:
            command, cwd = commands[gate_id]
            print(f"Running {gate_id}...", flush=True)
            result = run_gate(gate_id, command, cwd, env, destination)
            cast(list[dict[str, object]], manifest["gates"]).append(result)
            print(f"{gate_id}: {result['status']} (exit {result['exit_code']})", flush=True)
            write_reports(manifest, destination)
            if result["status"] == "cancelled":
                break
    statuses = [gate["status"] for gate in cast(list[dict[str, object]], manifest["gates"])]
    manifest["overall_status"] = (
        "cancelled" if "cancelled" in statuses else
        "blocked" if "blocked" in statuses else
        "failed" if any(value != "passed" for value in statuses) else "passed"
    )
    manifest["finished_at"] = datetime.now(UTC).isoformat()
    write_reports(manifest, destination)
    return {"passed": 0, "failed": 1, "blocked": 2, "cancelled": 130}[manifest["overall_status"]]


if __name__ == "__main__":
    raise SystemExit(main())