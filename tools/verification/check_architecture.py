"""Architecture boundary checker: AST-based import graph and rule validation.

Standard library only. Fails on new forbidden dependencies or import cycles
among application modules. Run: python tools/verification/check_architecture.py
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "referenced-chatgpt-conversation-this-is-an" / "backend"
FRONTEND_SRC = ROOT / "frontend" / "src"


def _local_module_name(path: Path) -> str | None:
    """Map a file under app/ to its dotted module name."""
    try:
        relative = path.relative_to(BACKEND)
    except ValueError:
        return None
    parts = list(relative.with_suffix("").parts)
    if not parts or parts[0] != "app":
        return None
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def collect_python_imports(root: Path) -> dict[str, set[str]]:
    """Collect local application imports per module using AST, not regex."""
    graph: dict[str, set[str]] = {}
    for path in sorted(root.rglob("*.py")):
        module = _local_module_name(path)
        if module is None:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as exc:
            print(f"SYNTAX ERROR in {path.relative_to(ROOT)}: {exc}", file=sys.stderr)
            sys.exit(2)
        imports: set[str] = graph.setdefault(module, set())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.add(alias.name)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imports.add(node.module)
    return graph


def _resolve_local(name: str, modules: dict[str, set[str]]) -> str | None:
    """Resolve a dotted import to the nearest existing local module."""
    parts = name.split(".")
    while parts:
        candidate = ".".join(parts)
        if candidate in modules:
            return candidate
        parts.pop()
    return None


def find_import_cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    """Detect cycles among local application modules."""
    local: dict[str, set[str]] = {}
    for module, imports in graph.items():
        resolved = {
            target
            for name in imports
            if (target := _resolve_local(name, graph)) is not None and target != module
        }
        if resolved:
            local[module] = resolved

    cycles: list[list[str]] = []
    seen: set[frozenset[str]] = set()

    def visit(node: str, stack: list[str], visiting: set[str]) -> None:
        for target in sorted(local.get(node, ())):
            if target in visiting:
                index = stack.index(target)
                cycle = stack[index:] + [target]
                key = frozenset(cycle)
                if key not in seen:
                    seen.add(key)
                    cycles.append(cycle)
            elif target not in stack:
                visiting.add(target)
                visit(target, stack + [target], visiting)
                visiting.discard(target)

    for module in sorted(local):
        visit(module, [module], {module})
    return cycles


FORBIDDEN: dict[str, set[str]] = {
    "app.chat.booking_policy": {"fastapi", "app.db", "app.chat_api", "app.main", "openai"},
    "app.chat.schemas": {"fastapi", "app.db", "app.chat_api", "app.main", "openai"},
    # Pure intent detectors: settings and stdlib only. No request handling,
    # no persistence, no provider clients, no route orchestration.
    "app.chat.intent": {
        "fastapi", "app.db", "app.chat_api", "app.main", "openai",
        "app.scheduling", "app.security", "app.call_tracking",
    },
    # Slot extraction is pure text/slot math: may use intent detection and
    # phone normalization, but no framework, persistence, or provider code.
    "app.chat.slot_extraction": {
        "fastapi", "app.db", "app.chat_api", "app.main", "openai",
        "app.security", "app.call_tracking",
    },
}


def check_boundaries(graph: dict[str, set[str]]) -> list[str]:
    """Return human-readable violations of the documented dependency rules."""
    violations: list[str] = []
    for module, forbidden in FORBIDDEN.items():
        imports = graph.get(module, set())
        for name in sorted(imports):
            parts = name.split(".")
            prefixes = {".".join(parts[: index + 1]) for index in range(len(parts))}
            if prefixes & forbidden:
                violations.append(
                    f"{module} imports forbidden dependency '{name}'"
                )
    for cycle in find_import_cycles(graph):
        violations.append("import cycle: " + " -> ".join([*cycle, cycle[0]]))
    return violations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(argv)

    graph = collect_python_imports(BACKEND / "app")
    violations = check_boundaries(graph)
    if violations:
        for violation in violations:
            print(f"VIOLATION: {violation}", file=sys.stderr)
        return 1
    print(
        f"Architecture boundaries OK: {len(graph)} modules, "
        "no forbidden imports, no import cycles."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())