#!/usr/bin/env python3
"""Ensure CapApp-SPM/Package.swift lists FloorSquarePlugin with valid Swift commas.

Idempotent: safe to re-run. Repairs mangled injects (double commas, missing commas).
Exits non-zero if the result is not valid Package.swift.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

DEP_LINE = (
    '.package(name: "FloorSquarePlugin", '
    'path: "../../../../../node_modules/@floor/square-plugin")'
)
PROD_LINE = '.product(name: "FloorSquarePlugin", package: "FloorSquarePlugin")'


def find_array_after(src: str, needle: str, start: int = 0) -> tuple[int, int]:
    """Return (inner_start, inner_end) for the `[...]` that follows `needle` at/after start."""
    m = re.search(re.escape(needle) + r"\s*\[", src[start:])
    if not m:
        raise SystemExit(f"CapApp-SPM missing `{needle}: [` block")
    abs_bracket = start + m.end() - 1  # index of '['
    i = abs_bracket + 1
    depth = 1
    while i < len(src) and depth:
        ch = src[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
        i += 1
    if depth != 0:
        raise SystemExit(f"unbalanced brackets after `{needle}`")
    return abs_bracket + 1, i - 1


def split_entries(inner: str) -> list[str]:
    """Split array body into top-level call entries; strip trailing commas."""
    # Repair ,, before parsing so entry boundaries stay correct.
    inner = re.sub(r",\s*,+", ",", inner)
    entries: list[str] = []
    buf: list[str] = []
    depth_paren = 0
    for line in inner.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        depth_paren += stripped.count("(") - stripped.count(")")
        buf.append(line.rstrip())
        if depth_paren == 0 and re.search(r"\)\s*,?\s*$", stripped):
            entry = "\n".join(buf).rstrip().rstrip(",").rstrip()
            # Drop empty / orphan commas
            if entry.strip() and not entry.strip() == ",":
                entries.append(entry)
            buf = []
    if buf:
        entry = "\n".join(buf).rstrip().rstrip(",").rstrip()
        if entry.strip():
            entries.append(entry)
    return entries


def sibling_indent(entries: list[str], default: str) -> str:
    for e in entries:
        if e.strip():
            return e[: len(e) - len(e.lstrip())]
    return default


def close_whitespace(src: str, inner_end: int, default: str) -> str:
    """Whitespace immediately before the array's closing `]` (newline + indent)."""
    j = inner_end
    while j > 0 and src[j - 1] in " \t":
        j -= 1
    if j > 0 and src[j - 1] == "\n":
        return src[j - 1 : inner_end]
    return default


def ensure_in_array(
    src: str,
    *,
    needle: str,
    ensure_expr: str,
    name_token: str,
    start: int = 0,
    default_indent: str,
    default_close: str,
) -> tuple[str, int]:
    """Rewrite one array so it contains exactly one ensure_expr line mentioning name_token."""
    inner_start, inner_end = find_array_after(src, needle, start)
    entries = split_entries(src[inner_start:inner_end])
    kept = [e for e in entries if name_token not in e]
    indent = sibling_indent(kept, default_indent)
    ensure_full = indent + ensure_expr.strip()
    # Dedupe normalized entries, then append FloorSquare once at end.
    dedup: list[str] = []
    seen: set[str] = set()
    for e in kept:
        key = re.sub(r"\s+", " ", e.strip())
        if key in seen:
            continue
        seen.add(key)
        dedup.append(e)
    dedup.append(ensure_full)
    body = ",\n".join(dedup) + ","
    close_ws = close_whitespace(src, inner_end, default_close)
    new_inner = "\n" + body + close_ws
    return src[:inner_start] + new_inner + src[inner_end:], inner_end


def scrub_double_commas(src: str) -> str:
    prev = None
    while prev != src:
        prev = src
        src = re.sub(r",\s*,+", ",", src)
    return src


def ensure_floor_square(src: str) -> str:
    src = src.replace(".iOS(.v15)", ".iOS(.v16)")
    src = scrub_double_commas(src)
    # Package-level dependencies: [ ... ]
    src, _ = ensure_in_array(
        src,
        needle="dependencies:",
        ensure_expr=DEP_LINE,
        name_token="FloorSquarePlugin",
        start=0,
        default_indent="        ",
        default_close="\n    ",
    )
    # CapApp-SPM target product dependencies.
    tm = re.search(r'\.target\(\s*name:\s*"CapApp-SPM"\s*,', src, re.S)
    if not tm:
        raise SystemExit('CapApp-SPM missing .target(name: "CapApp-SPM"')
    src, _ = ensure_in_array(
        src,
        needle="dependencies:",
        ensure_expr=PROD_LINE,
        name_token="FloorSquarePlugin",
        start=tm.start(),
        default_indent="                ",
        default_close="\n            ",
    )
    return scrub_double_commas(src)


def validate_package_swift(path: Path, src: str) -> None:
    if re.search(r",\s*,", src):
        raise SystemExit(f"{path}: double comma in Package.swift")
    for open_c, close_c in (("(", ")"), ("[", "]"), ("{", "}")):
        depth = 0
        for ch in src:
            if ch == open_c:
                depth += 1
            elif ch == close_c:
                depth -= 1
                if depth < 0:
                    raise SystemExit(f"{path}: unbalanced {open_c}{close_c}")
        if depth != 0:
            raise SystemExit(f"{path}: unbalanced {open_c}{close_c}")
    if src.count("FloorSquarePlugin") < 2:
        raise SystemExit(f"{path}: FloorSquarePlugin must appear in dependencies and products")
    # Between two adjacent .product / .package lines there must be a comma on the prior line.
    lines = [ln.rstrip() for ln in src.splitlines()]
    for i, ln in enumerate(lines[:-1]):
        cur = ln.strip()
        nxt = lines[i + 1].strip()
        if re.match(r"^\.product\(|^\.package\(", cur) and re.match(r"^\.product\(|^\.package\(", nxt):
            if not cur.endswith(","):
                raise SystemExit(f"{path}:{i + 1}: missing trailing comma before next entry")
    swift = subprocess.run(["bash", "-lc", "command -v swift"], capture_output=True, text=True)
    if swift.returncode == 0 and swift.stdout.strip():
        proc = subprocess.run(
            ["swift", "package", "dump-package", "--package-path", str(path.parent)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            sys.stderr.write(proc.stdout)
            sys.stderr.write(proc.stderr)
            raise SystemExit(f"{path}: swift package dump-package failed")
        print("PASS  swift package dump-package")
    else:
        print("PASS  Package.swift structural check (swift not installed here)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("package_swift", type=Path)
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args()
    path: Path = args.package_swift
    if not path.is_file():
        print(f"skip: {path} missing", file=sys.stderr)
        return 0
    original = path.read_text()
    if args.check_only:
        validate_package_swift(path, original)
        return 0
    updated = ensure_floor_square(original)
    if updated != original:
        path.write_text(updated)
        print("CapApp-SPM Package.swift ensured FloorSquarePlugin (idempotent)")
    else:
        print("CapApp-SPM Package.swift already lists FloorSquarePlugin")
    validate_package_swift(path, path.read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
