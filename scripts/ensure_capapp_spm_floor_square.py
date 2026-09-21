#!/usr/bin/env python3
"""Ensure CapApp-SPM/Package.swift links FloorSquarePlugin AND SquareMobilePaymentsSDK.

Cap sync regenerates CapApp-SPM; transitive Square via FloorSquare alone is not enough —
the XCFramework must be a direct CapApp-SPM product so Xcode embeds it in the app binary.

MockReaderUI is optional (--with-mock-reader / FLOOR_INCLUDE_MOCK_READER=1). Square ships it
as an APPL bundle (com.squareup.readersdk.mockreaderui); App Store Connect rejects IPAs that
embed it. Only ad-hoc sandbox builds should include it.

Idempotent. Exits non-zero if the result is invalid.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

FLOOR_DEP = (
    '.package(name: "FloorSquarePlugin", '
    'path: "../../../../../node_modules/@floor/square-plugin")'
)
FLOOR_PROD = '.product(name: "FloorSquarePlugin", package: "FloorSquarePlugin")'
SQUARE_DEP = (
    '.package(url: "https://github.com/square/mobile-payments-sdk-ios", exact: "2.6.0")'
)
SQUARE_PROD = (
    '.product(name: "SquareMobilePaymentsSDK", package: "mobile-payments-sdk-ios")'
)
MOCK_PROD = (
    '.product(name: "MockReaderUI", package: "mobile-payments-sdk-ios")'
)


def find_array_after(src: str, needle: str, start: int = 0) -> tuple[int, int]:
    m = re.search(re.escape(needle) + r"\s*\[", src[start:])
    if not m:
        raise SystemExit(f"CapApp-SPM missing `{needle}: [` block")
    abs_bracket = start + m.end() - 1
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
            if entry.strip() and entry.strip() != ",":
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
    j = inner_end
    while j > 0 and src[j - 1] in " \t":
        j -= 1
    if j > 0 and src[j - 1] == "\n":
        return src[j - 1 : inner_end]
    return default


def ensure_entries(
    src: str,
    *,
    needle: str,
    start: int,
    default_indent: str,
    default_close: str,
    required: list[tuple[str, str]],
    forbidden_tokens: list[str] | None = None,
) -> str:
    """required: list of (name_token, expr) that must appear exactly once each."""
    inner_start, inner_end = find_array_after(src, needle, start)
    entries = split_entries(src[inner_start:inner_end])
    tokens = [t for t, _ in required]
    drop = set(tokens) | set(forbidden_tokens or [])
    kept = [e for e in entries if not any(t in e for t in drop)]
    indent = sibling_indent(kept, default_indent)
    dedup: list[str] = []
    seen: set[str] = set()
    for e in kept:
        key = re.sub(r"\s+", " ", e.strip())
        if key in seen:
            continue
        seen.add(key)
        dedup.append(e)
    for _, expr in required:
        dedup.append(indent + expr.strip())
    body = ",\n".join(dedup) + ","
    close_ws = close_whitespace(src, inner_end, default_close)
    new_inner = "\n" + body + close_ws
    return src[:inner_start] + new_inner + src[inner_end:]


def scrub_double_commas(src: str) -> str:
    prev = None
    while prev != src:
        prev = src
        src = re.sub(r",\s*,+", ",", src)
    return src


def ensure_floor_and_square(src: str, *, with_mock_reader: bool) -> str:
    src = src.replace(".iOS(.v15)", ".iOS(.v16)")
    src = scrub_double_commas(src)
    src = ensure_entries(
        src,
        needle="dependencies:",
        start=0,
        default_indent="        ",
        default_close="\n    ",
        required=[
            ("FloorSquarePlugin", FLOOR_DEP),
            ("mobile-payments-sdk-ios", SQUARE_DEP),
        ],
    )
    tm = re.search(r'\.target\(\s*name:\s*"CapApp-SPM"\s*,', src, re.S)
    if not tm:
        raise SystemExit('CapApp-SPM missing .target(name: "CapApp-SPM"')
    products: list[tuple[str, str]] = [
        ("FloorSquarePlugin", FLOOR_PROD),
        ("SquareMobilePaymentsSDK", SQUARE_PROD),
    ]
    forbidden: list[str] = []
    if with_mock_reader:
        products.append(("MockReaderUI", MOCK_PROD))
    else:
        forbidden.append("MockReaderUI")
    src = ensure_entries(
        src,
        needle="dependencies:",
        start=tm.start(),
        default_indent="                ",
        default_close="\n            ",
        required=products,
        forbidden_tokens=forbidden,
    )
    return scrub_double_commas(src)


def validate_package_swift(path: Path, src: str, *, with_mock_reader: bool) -> None:
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
    if "FloorSquarePlugin" not in src:
        raise SystemExit(f"{path}: missing FloorSquarePlugin")
    if "SquareMobilePaymentsSDK" not in src:
        raise SystemExit(f"{path}: missing SquareMobilePaymentsSDK product")
    if "mobile-payments-sdk-ios" not in src:
        raise SystemExit(f"{path}: missing mobile-payments-sdk-ios package URL")
    if with_mock_reader:
        if "MockReaderUI" not in src:
            raise SystemExit(f"{path}: missing MockReaderUI product (FLOOR_INCLUDE_MOCK_READER=1)")
    elif "MockReaderUI" in src:
        raise SystemExit(
            f"{path}: MockReaderUI must not be linked for App Store / TestFlight builds "
            "(set FLOOR_INCLUDE_MOCK_READER=1 only for ios-square ad-hoc)"
        )
    if src.count("FloorSquarePlugin") < 2:
        raise SystemExit(f"{path}: FloorSquarePlugin must appear in package deps and target products")
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
        dump = proc.stdout
        if "SquareMobilePaymentsSDK" not in dump and "mobile-payments-sdk-ios" not in dump:
            raise SystemExit(f"{path}: dump-package did not mention Square SDK")
        print("PASS  swift package dump-package (includes Square)")
    else:
        print("PASS  Package.swift structural check (swift not installed here)")


def env_wants_mock_reader() -> bool:
    raw = os.environ.get("FLOOR_INCLUDE_MOCK_READER", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("package_swift", type=Path)
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument(
        "--with-mock-reader",
        action="store_true",
        default=None,
        help="Link MockReaderUI (ad-hoc sandbox). Overrides FLOOR_INCLUDE_MOCK_READER when set.",
    )
    ap.add_argument(
        "--without-mock-reader",
        action="store_true",
        help="Omit MockReaderUI (TestFlight / App Store).",
    )
    args = ap.parse_args()
    if args.with_mock_reader and args.without_mock_reader:
        raise SystemExit("pass only one of --with-mock-reader / --without-mock-reader")
    if args.without_mock_reader:
        with_mock = False
    elif args.with_mock_reader:
        with_mock = True
    else:
        with_mock = env_wants_mock_reader()

    path: Path = args.package_swift
    if not path.is_file():
        print(f"skip: {path} missing", file=sys.stderr)
        return 0
    original = path.read_text()
    if args.check_only:
        validate_package_swift(path, original, with_mock_reader=with_mock)
        return 0
    updated = ensure_floor_and_square(original, with_mock_reader=with_mock)
    if updated != original:
        path.write_text(updated)
        mock_msg = "+ MockReaderUI" if with_mock else "(no MockReaderUI)"
        print(f"CapApp-SPM Package.swift ensured FloorSquarePlugin + SquareMobilePaymentsSDK {mock_msg}")
    else:
        print("CapApp-SPM Package.swift already lists FloorSquare + Square")
    validate_package_swift(path, path.read_text(), with_mock_reader=with_mock)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
